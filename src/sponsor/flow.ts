/**
 * Pure decision logic for `sponsor:onboard` and `sponsor:go` (no chain, no filesystem), so the "what should
 * happen next" rules are unit-tested offline. The commands read the state, ask these functions for a plan,
 * then execute it.
 */
export const ZERO_HASH = "0x" + "00".repeat(32);

export const STATUS_UNVERIFIED = 0;
export const STATUS_PENDING = 1;
export const STATUS_VERIFIED = 2;
export const STATUS_REVOKED = 3;
const LABELS = ["UNVERIFIED", "PENDING", "VERIFIED", "REVOKED"];
export const statusLabel = (s: number | null) => (s === null ? "NOT REGISTERED" : (LABELS[s] ?? String(s)));

/**
 * True when this process can upload sponsor metadata. IPFS is the default and needs a thirdweb key.
 * Fil One is opt-in via METADATA_STORAGE=filone.
 */
export function metadataStorageReady(env: {
  metadataStorage?: string;
  thirdwebSecret?: string;
  thirdwebClientId?: string;
  filBucket?: string;
  accessKey?: string;
  secretKey?: string;
}): boolean {
  const provider = env.metadataStorage || "ipfs";
  if (provider === "ipfs") return Boolean(env.thirdwebSecret || env.thirdwebClientId);
  if (provider === "filone") return Boolean(env.filBucket && env.accessKey && env.secretKey);
  return false;
}

/** Base URL of the node (what serves /health) from PUBLIC_RELAYER_URL, which usually ends in /relay. */
export function healthBaseUrl(publicUrl: string): string {
  return publicUrl.replace(/\/relay\/?$/, "").replace(/\/$/, "");
}

// ───────────────────────────── onboard ─────────────────────────────

export interface OnboardState {
  registryOk: boolean;
  balanceWei: bigint;
  /** relayerToSponsor(relayer) on-chain; 0 = this relayer is not registered yet. */
  chainSponsorId: bigint;
  /** SPONSOR_ID currently in .env. */
  envSponsorId: bigint;
  /** null when not registered. */
  status: number | null;
  onchainHash: string;
  /** Hash of the metadata we would publish now; null when it cannot be computed yet (not registered). */
  freshHash: string | null;
  storageConfigured: boolean;
  /** sponsorEndpoint(id) on-chain; null when the registry has no endpoint (older build) or it could not be read. */
  onchainEndpoint?: string | null;
  /** PUBLIC_RELAYER_URL: what this node would publish. */
  publicUrl?: string;
  /** True when the payout address is the relayer key itself (test setups): then this process can send setEndpoint. */
  payoutIsRelayerKey?: boolean;
}

export type OnboardStep =
  | { kind: "register" }
  | { kind: "write-env" } // set SPONSOR_ID in .env to the on-chain id
  | { kind: "publish-metadata" }
  // The public URL on chain, set by the PAYOUT key. `viaPayout`: this process does not hold that key, so the step prints
  // the command (or a Safe batch) instead of sending.
  | { kind: "publish-endpoint"; viaPayout: boolean };

/** Why a URL cannot be published on chain as the relay endpoint, or null when it can. */
export function endpointProblem(url: string): string | null {
  if (!url) return "PUBLIC_RELAYER_URL is not set";
  if (url.includes("example")) return "PUBLIC_RELAYER_URL is still a placeholder";
  if (!url.startsWith("https://")) return "the relay endpoint must be https";
  if (endsInRelayPath(url)) return "the relay endpoint must not end in /relay: the wallet adds /relay, /subscribe and /health itself";
  if (new TextEncoder().encode(url).length > 256) return "the relay endpoint is longer than 256 bytes";
  return null;
}

/** The wallet appends its routes to the published URL, so a URL that already ends in /relay sends every request to /relay/relay. */
const endsInRelayPath = (url: string) => /\/relay\/?$/i.test(url);

/**
 * Why a relay URL must not go into the published metadata, or null when it can. The metadata is what the curator
 * reviews and pins, so a placeholder published by mistake costs a re-publish and a new review.
 */
export function publishedUrlProblem(url: string): string | null {
  if (!url) return "the relay URL is empty";
  if (url.includes("example")) return `the relay URL is still the placeholder ${url}`;
  if (!url.startsWith("https://")) return "the relay URL must be https";
  if (endsInRelayPath(url)) return "the relay URL must not end in /relay: the wallet adds /relay, /subscribe and /health itself";
  return null;
}

/** A leftover template value such as ipfs://<pin-your-metadata.json> is not a URI to put on chain. */
export function isPlaceholderUri(uri: string): boolean {
  return /[<>]/.test(uri);
}

const sameUrl = (a: string, b: string) => a.replace(/\/$/, "").toLowerCase() === b.replace(/\/$/, "").toLowerCase();

/** True when the on-chain endpoint should be (re)published: the registry supports it, our URL is publishable and differs. */
export function endpointNeedsPublishing(onchain: string | null | undefined, publicUrl: string | undefined): boolean {
  if (onchain === null || onchain === undefined || publicUrl === undefined) return false;
  return endpointProblem(publicUrl) === null && !sameUrl(onchain, publicUrl);
}

export interface Plan<S> {
  blockers: string[];
  steps: S[];
  next: string;
}

export function planOnboard(s: OnboardState): Plan<OnboardStep> {
  const blockers: string[] = [];
  const steps: OnboardStep[] = [];

  if (!s.registryOk) blockers.push("FEE_MARKET_REGISTRY is not the current chargeUsage build (run `npm run sponsor:doctor`).");
  if (s.status === STATUS_REVOKED) blockers.push("This sponsor is REVOKED; the curator must reinstate it before anything else works.");

  const registered = s.chainSponsorId !== 0n;
  if (!registered) steps.push({ kind: "register" });
  if (!registered || s.envSponsorId !== s.chainSponsorId) steps.push({ kind: "write-env" });

  const needsMetadata = !registered || s.onchainHash === ZERO_HASH || s.freshHash === null || s.freshHash.toLowerCase() !== s.onchainHash.toLowerCase();
  if (needsMetadata) steps.push({ kind: "publish-metadata" });

  if (registered && endpointNeedsPublishing(s.onchainEndpoint, s.publicUrl)) {
    steps.push({ kind: "publish-endpoint", viaPayout: !s.payoutIsRelayerKey });
  }

  const sendsTx = steps.some((x) => x.kind === "register" || x.kind === "publish-metadata" || (x.kind === "publish-endpoint" && !x.viaPayout));
  if (sendsTx && s.balanceWei === 0n) blockers.push("The relayer has no gas: send some POL to the relayer address first.");
  if (steps.some((x) => x.kind === "publish-metadata") && !s.storageConfigured) {
    blockers.push("Metadata storage is not configured. IPFS (the default) needs THIRDWEB_SECRET_KEY or THIRDWEB_CLIENT_ID. Fil One needs METADATA_STORAGE=filone plus FIL_BUCKET, STORAGE_ACCESS_KEY_ID and STORAGE_SECRET_ACCESS_KEY. Or publish from the web panel.");
  }

  let next: string;
  if (blockers.length) next = "Fix the items above and run `npm run sponsor:onboard` again.";
  else if (s.status === STATUS_VERIFIED && steps.length === 0) next = "You are VERIFIED. Run `npm run sponsor:go`.";
  else if (steps.length === 0) next = `Nothing left to do on your side. Waiting for the curator to verify you (status ${statusLabel(s.status)}); re-run this command to check.`;
  else next = "After these steps, ask the curator to verify you, then run `npm run sponsor:go`.";
  return { blockers, steps, next };
}

// ───────────────────────────── go ─────────────────────────────

export type GoMode = "docker" | "node";

export interface GoState {
  status: number | null;
  hasDocker: boolean;
  hasCompose: boolean; // docker-compose.yml present
  hasDomain: boolean; // PUBLIC_DOMAIN set
  publicUrl: string;
  mode?: GoMode; // explicit --mode
  noStart: boolean;
}

export type GoStep = { kind: "list-plans" } | { kind: "start"; mode: GoMode } | { kind: "wait-health" };

export function chooseMode(s: Pick<GoState, "mode" | "hasDocker" | "hasCompose" | "hasDomain">): GoMode {
  if (s.mode) return s.mode;
  return s.hasDocker && s.hasCompose && s.hasDomain ? "docker" : "node";
}

export function planGo(s: GoState): Plan<GoStep> & { mode: GoMode } {
  const mode = chooseMode(s);
  const blockers: string[] = [];
  if (s.status !== STATUS_VERIFIED) {
    blockers.push(`Sponsor is ${statusLabel(s.status)}: only a VERIFIED sponsor can list plans. Run \`npm run sponsor:onboard\` and ask the curator to verify you.`);
  }
  if (!s.noStart && mode === "docker") {
    if (!s.hasDocker) blockers.push("--mode docker needs Docker installed.");
    if (!s.hasCompose) blockers.push("docker-compose.yml not found; run from the relayer directory.");
    if (!s.hasDomain) blockers.push("Docker mode needs PUBLIC_DOMAIN in .env (the domain Caddy gets a certificate for).");
  }

  const steps: GoStep[] = [{ kind: "list-plans" }];
  if (!s.noStart) {
    steps.push({ kind: "start", mode }, { kind: "wait-health" });
  }
  const next = blockers.length
    ? "Fix the items above and run `npm run sponsor:go` again."
    : s.noStart
      ? "Plans are listed. Start the node yourself when ready."
      : "Your node is starting; watch /admin and `npm run sponsor:doctor`.";
  return { blockers, steps, next, mode };
}
