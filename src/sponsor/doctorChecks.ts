import { toFunctionSelector } from "viem";

export type Level = "ok" | "warn" | "fail";
export interface Finding {
  level: Level;
  msg: string;
}

const ok = (msg: string): Finding => ({ level: "ok", msg });
const warn = (msg: string): Finding => ({ level: "warn", msg });
const fail = (msg: string): Finding => ({ level: "fail", msg });

/** The EIP-1967 slot where a proxy keeps the address of its implementation. */
export const IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as const;

/** Reads an address out of a 32-byte storage word; undefined when it is empty or malformed. */
export function addressFromSlot(word: string | undefined | null): `0x${string}` | undefined {
  if (!word || !/^0x[0-9a-fA-F]{64}$/.test(word)) return undefined;
  const addr = `0x${word.slice(26)}`;
  return /^0x0{40}$/.test(addr) ? undefined : (addr as `0x${string}`);
}

/** True if deployed bytecode contains the dispatcher entry for `signature` (a PUSH4 of its selector).
 *  A selector that starts with zero bytes is pushed with a shorter PUSH (0x00923e46 becomes PUSH3 923e46), so the leading
 *  zero bytes are dropped from the search; matching all four bytes would wrongly report such a function as missing. */
export function hasSelector(code: string | undefined, signature: string): boolean {
  if (!code || code === "0x") return false;
  const hex = toFunctionSelector(signature).slice(2).toLowerCase();
  const needle = hex.replace(/^(00)+/, "") || hex;
  return code.toLowerCase().includes(needle);
}

/** The registry must be the user-authorized charging build: it has chargeUsage and no relayer-reported usage. */
export function checkRegistryBuild(code: string | undefined): Finding[] {
  if (!code || code === "0x") return [fail("FEE_MARKET_REGISTRY has no contract code on this chain (wrong address or chain?)")];
  const out: Finding[] = [];
  out.push(
    hasSelector(code, "chargeUsage(uint256,uint256)")
      ? ok("registry has chargeUsage (user-authorized charging build)")
      : fail("registry has no chargeUsage: it is an older build, point FEE_MARKET_REGISTRY at the current deployment"),
  );
  if (hasSelector(code, "reportUsage(uint256,uint256)")) {
    out.push(fail("registry still has reportUsage (relayer-reported usage): old build"));
  }
  out.push(
    hasSelector(code, "verifySponsor(uint256,bytes32,bytes32)")
      ? ok("registry has verifySponsor (the curator verifies a reviewed hash and caveat set)")
      : fail("registry has no verifySponsor(uint256,bytes32,bytes32): it predates the plan-set pin, point FEE_MARKET_REGISTRY at the current deployment"),
  );
  return out;
}

export interface PolicyInput {
  dashboardToken: string;
  corsOrigins: readonly string[];
  maxGasWei: bigint;
  publicRelayerUrl: string;
  requireRedeemerRestriction: boolean;
  simulateBeforeSend: boolean;
  trustProxy: number;
  maxDelegationTtlSeconds: number;
  // Added with the relayer hardening; optional so older callers and fixtures keep working.
  maxGasUnits?: bigint;
  minRelayerBalanceWei?: bigint;
  alertWebhookUrl?: string;
  maxFeePerGasGwei?: number;
  rpcUrls?: readonly string[];
  stateDir?: string;
  clientIpHeader?: string;
  rateLimitDelegatorMax?: number;
  maxConcurrentSponsored?: number;
  signerSource?: "env" | "keystore" | "remote";
  metricsToken?: string;
  watchIntervalMs?: number;
  host?: string;
}

/** Free shared endpoints: fine for a test node, unreliable for production (rate limits, shallow log queries, outages). */
const PUBLIC_RPC = /publicnode\.com|drpc\.org|llamarpc|1rpc\.io|polygon-rpc\.com|rpc\.ankr\.com|public\.blastapi|onfinality\.io\/public|gateway\.tatum|nodies\.app|merkle\.io|meowrpc|rpc\.flashbots|mevblocker|gateway\.tenderly\.co\/public|blockpi\.network\/v1\/rpc\/public|subquery\.network\/public|gateway\.fm|zan\.top|lava\.build|polygon\.rpc\.subquery/i;
export const isPublicRpc = (url: string): boolean => PUBLIC_RPC.test(url);

/** Operator settings that are safe to leave at their defaults for a test node but not for production. */
export function lintPolicy(p: PolicyInput): Finding[] {
  const out: Finding[] = [];
  if (!p.requireRedeemerRestriction) out.push(fail("REQUIRE_REDEEMER_RESTRICTION=false: delegations not locked to your relayer would be accepted"));
  else out.push(ok("delegations must be locked to this relayer"));
  if (!p.simulateBeforeSend) out.push(warn("SIMULATE_BEFORE_SEND=false: reverting redemptions will cost you gas"));
  else out.push(ok("redemptions are simulated before sending"));
  if (p.maxGasWei === 0n) out.push(warn("MAX_GAS_WEI=0: no cap on what one redemption can cost you; set one from your fee math"));
  else out.push(ok(`gas cap set (${p.maxGasWei} wei per redemption)`));
  if (p.maxGasUnits !== undefined) {
    if (p.maxGasUnits === 0n) out.push(fail("MAX_GAS_UNITS=0: nothing bounds the gas one user-built batch may burn; set a limit (default 600000)"));
    else out.push(ok(`gas limit per redemption is capped at ${p.maxGasUnits} units`));
  }
  if (p.rpcUrls !== undefined) {
    const published = !!p.publicRelayerUrl && !p.publicRelayerUrl.includes("example");
    if (p.rpcUrls.length === 0) out.push(fail("no RPC URL configured"));
    else {
      if (p.rpcUrls.length === 1) out.push(warn("only one RPC provider: if it has an outage your node cannot sponsor anything. Add fallbacks with RPC_URLS=url2,url3 (a transaction is sent to all of them)"));
      else out.push(ok(`${p.rpcUrls.length} RPC providers (reads fail over, sends go to all)`));
      if (p.rpcUrls.every(isPublicRpc)) {
        out.push(published
          ? fail("every RPC provider is a free public endpoint, and your node is published: use a paid plan (Alchemy, QuickNode, ...) as RPC_URL and keep the public ones only as RPC_URLS fallbacks")
          : warn("every RPC provider is a free public endpoint: fine for testing, use a paid plan before you publish your node"));
      }
    }
  }
  if (p.stateDir !== undefined) {
    if (!p.stateDir) out.push(warn("STATE_DIR is empty: transactions in flight and the dashboard's history are lost on every restart (a stuck transaction would never be replaced)"));
    else out.push(ok(`state is kept in ${p.stateDir} (mount a volume there in Docker)`));
  }
  if (p.rateLimitDelegatorMax !== undefined && p.rateLimitDelegatorMax === 0) out.push(warn("RATE_LIMIT_DELEGATOR_MAX=0: one user can spend your gas by sending from many IPs; set a per-account budget"));
  if (p.maxConcurrentSponsored !== undefined && p.maxConcurrentSponsored === 0) out.push(warn("MAX_CONCURRENT_SPONSORED=0: unbounded concurrency; a burst can pile up requests and RPC calls without limit"));
  if (p.maxFeePerGasGwei !== undefined && p.maxFeePerGasGwei === 0) out.push(warn("MAX_FEE_PER_GAS_GWEI=0: the node will pay any network fee during a spike; set a ceiling"));
  if (p.minRelayerBalanceWei !== undefined) {
    if (p.minRelayerBalanceWei === 0n) out.push(warn("MIN_RELAYER_BALANCE_WEI=0: the node keeps accepting sponsored sends with an empty relayer"));
    else out.push(ok("the node pauses sponsored sends when the relayer balance runs low"));
  }
  if (p.alertWebhookUrl !== undefined && !p.alertWebhookUrl) out.push(warn("ALERT_WEBHOOK_URL is empty: nobody is told when the relayer runs low or a transaction gets stuck"));
  if (p.signerSource !== undefined) {
    const published = !!p.publicRelayerUrl && !p.publicRelayerUrl.includes("example");
    if (p.signerSource === "env") {
      out.push(published
        ? warn("the relayer key is a raw RELAYER_PRIVATE_KEY in the environment: anyone who can read the process or its .env can spend the gas wallet. Move it to an encrypted keystore (npm run key:encrypt) or a remote signer (RELAYER_KEY_SOURCE)")
        : ok("relayer key is a raw env key (fine for a test node; use a keystore or remote signer when you publish)"));
    } else out.push(ok(`relayer key is not a raw env key (${p.signerSource})`));
  }
  if (p.metricsToken !== undefined) {
    if (!p.metricsToken) out.push(warn("METRICS_TOKEN is empty: /metrics is off, so nothing can scrape the node's health; set a long random token"));
    else if (p.metricsToken.length < 16) out.push(fail("METRICS_TOKEN is shorter than 16 characters; use a long random secret"));
    else out.push(ok("/metrics is on and token-protected"));
  }
  if (p.watchIntervalMs !== undefined) {
    if (p.watchIntervalMs <= 0) out.push(warn("WATCH_INTERVAL_MS=0: the node does not watch the registry for halts, insolvency or scheduled upgrades"));
    else out.push(ok(`the node watches the registry every ${Math.round(p.watchIntervalMs / 1000)} s`));
  }
  if (p.host !== undefined && p.clientIpHeader && p.host !== "127.0.0.1" && p.host !== "::1" && p.host !== "localhost") {
    out.push(warn(`CLIENT_IP_HEADER=${p.clientIpHeader} is trusted, but the node listens on ${p.host}: anyone who can reach the port directly can forge that header and dodge the per-IP limits. Set HOST=127.0.0.1 so only the tunnel or proxy on this machine can reach it`));
  }
  if (!p.dashboardToken) out.push(ok("dashboard disabled (DASHBOARD_TOKEN empty)"));
  else if (p.dashboardToken.length < 16) out.push(fail("DASHBOARD_TOKEN is shorter than 16 characters; use a long random secret"));
  else out.push(ok("dashboard token is set"));
  if (p.corsOrigins.includes("*")) {
    const published = !!p.publicRelayerUrl && !p.publicRelayerUrl.includes("example");
    out.push(
      published
        ? fail("CORS_ORIGINS=* and your node is published: any website may call it from a browser. List your web origins (the native wallet does not need CORS)")
        : warn("CORS_ORIGINS=*: fine for testing, but restrict it to your web origins before you publish your node"),
    );
  }
  if (p.maxDelegationTtlSeconds > 3600) out.push(warn(`MAX_DELEGATION_TTL_SECONDS=${p.maxDelegationTtlSeconds}: the wallet signs 600; a long window lets a relayer sit on a signed delegation`));
  if (p.publicRelayerUrl) {
    if (!p.publicRelayerUrl.startsWith("https://")) out.push(warn("PUBLIC_RELAYER_URL is not https; wallets on mobile will refuse plain http"));
    if (p.trustProxy === 0 && !p.clientIpHeader) out.push(warn("TRUST_PROXY=0 but you publish a URL: behind a reverse proxy or tunnel every user shares one rate-limit bucket. Set TRUST_PROXY=1 (Caddy/nginx) or CLIENT_IP_HEADER=cf-connecting-ip (Cloudflare tunnel)"));
    else if (p.clientIpHeader) out.push(ok(`per-IP limits use the ${p.clientIpHeader} header (make sure ALL traffic comes through that edge)`));
  }
  return out;
}

/** The relay URL on chain (setEndpoint) against the one this node publishes. `onchain` null = the registry has no endpoint. */
export function checkEndpoint(onchain: string | null, publicUrl: string): Finding[] {
  if (onchain === null) return [];
  const problem = !publicUrl || publicUrl.includes("example") ? "PUBLIC_RELAYER_URL is not set to a real URL" : null;
  if (problem) return [warn(`${problem}, so the on-chain endpoint cannot be checked`)];
  const same = onchain.replace(/\/$/, "").toLowerCase() === publicUrl.replace(/\/$/, "").toLowerCase();
  if (same) return [ok("the relay URL on chain matches PUBLIC_RELAYER_URL")];
  return [warn(onchain ? `the relay URL on chain (${onchain}) differs from PUBLIC_RELAYER_URL: run \`npm run sponsor:endpoint\` (payout key)` : "no relay URL is published on chain: run `npm run sponsor:endpoint` (payout key) so wallets can find the node without a metadata change")];
}

export const STATUS_LABELS = ["UNVERIFIED", "PENDING", "VERIFIED", "REVOKED"] as const;

export function checkSponsor(args: {
  registered: boolean;
  relayerMatches: boolean;
  status: number;
  metadataCommitted: boolean;
  /** This key is in the sponsor's relayer set but is not the primary (a standby node). */
  standby?: boolean;
}): Finding[] {
  if (!args.registered) return [fail("SPONSOR_ID is not registered on this registry: run `npm run sponsor:register`, then set SPONSOR_ID")];
  const out: Finding[] = [];
  out.push(
    args.relayerMatches
      ? ok(args.standby ? "this key is a standby relayer of SPONSOR_ID (in its relayer set, not the primary)" : "SPONSOR_ID belongs to this relayer key")
      : fail("SPONSOR_ID is registered to a different relayer address than RELAYER_PRIVATE_KEY"),
  );
  out.push(
    args.metadataCommitted
      ? ok("metadata hash is committed on-chain")
      : warn("no metadata hash committed: run `npm run sponsor:metadata:publish`"),
  );
  const label = STATUS_LABELS[args.status] ?? String(args.status);
  if (args.status === 2) out.push(ok("sponsor is VERIFIED: you can list plans and serve users"));
  else if (args.status === 3) out.push(fail("sponsor is REVOKED: users cannot be charged through you"));
  else out.push(warn(`sponsor is ${label}: ask the curator to verify before listing plans`));
  return out;
}

/** The payout wallet receives the earnings and can rotate the relayer key: it should be a multisig, not one key. */
export function checkPayoutWallet(kind: "eoa" | "delegated-eoa" | "contract", published: boolean): Finding {
  if (kind === "contract") return ok("the payout address is a contract (a Safe?): earnings and key rotation need its owners");
  const what = kind === "eoa" ? "a single key (EOA)" : "a single key with an EIP-7702 delegation (still one key, not a multisig)";
  return published
    ? warn(`the payout address is ${what}: whoever holds it can take all earnings and rotate the relayer. Make it a Safe (npm run sponsor:rotate -- payout 0xSafe)`)
    : ok(`the payout address is ${what} (fine for a test node; make it a Safe before you publish)`);
}

export function checkBalance(wei: bigint): Finding {
  if (wei === 0n) return fail("relayer balance is 0: fund it with native gas token (POL on Polygon)");
  if (wei < 500_000_000_000_000_000n) return warn(`relayer balance is low (${wei} wei): top it up`);
  return ok(`relayer balance ${wei} wei`);
}

/** The framework manager can be paused by its owner, which halts every redemption (and so every sponsor). */
export function checkManagerState(paused: boolean | undefined, owner: string | undefined): Finding[] {
  if (paused === undefined) return [warn("could not read paused() on DelegationManager (not the expected framework build?)")];
  const who = owner ? ` (owner ${owner})` : "";
  return [
    paused
      ? fail(`DelegationManager is PAUSED${who}: no delegation can be redeemed until the owner unpauses it`)
      : ok(`DelegationManager is not paused${who}`),
  ];
}
