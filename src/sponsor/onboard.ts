/**
 * One re-runnable command that gets a sponsor from a funded relayer to "waiting for the curator".
 *
 *   npm run sponsor:onboard              # do it
 *   npm run sponsor:onboard -- --dry-run # print what it would do
 *
 * Idempotent: it reuses an existing registration (looked up by the relayer address), only writes SPONSOR_ID
 * when it differs, and only publishes metadata when the bytes it would publish differ from what is committed
 * on-chain. Verification is done by the curator; run it again to check where you are.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";
import { feeMarketRegistryAbi } from "../abi.js";
import { publicClient, relayerAddress } from "../lib/clients.js";
import { checkRegistryBuild } from "./doctorChecks.js";
import { registryBuildCode } from "./registryCode.js";
import { writeEnvKey } from "./envFile.js";
import { runSponsorScript } from "./child.js";
import { metadataStorageReady, planOnboard, statusLabel, type OnboardState } from "./flow.js";

const RELAYER_DIR = fileURLToPath(new URL("../..", import.meta.url));

/** Start (or restart) the node in the background so the curator can hit /health while you wait. */
function ensureNodeRunning(): void {
  console.log("\n▶ ensure node running (background service)");
  const script = fileURLToPath(new URL("../../scripts/ensure-node-running.sh", import.meta.url));
  const res = spawnSync("bash", [script], { cwd: RELAYER_DIR, stdio: "inherit", env: process.env });
  if (res.status !== 0) {
    console.log("  ! could not auto-start the node — run: npm run sponsor:ensure-running");
    console.log("  ! or:     npm run sponsor:serve");
  }
}

const dryRun = process.argv.includes("--dry-run");
const read = (functionName: string, args: unknown[] = []) =>
  publicClient.readContract({ address: config.feeMarketRegistry, abi: feeMarketRegistryAbi, functionName, args } as never);

function freshMetadataHash(sponsorId: bigint): string | null {
  const res = runSponsorScript("publishMetadata.ts", ["hash"], { SPONSOR_ID: sponsorId.toString() }, true);
  if (!res.ok) throw new Error("could not build valid metadata (see the error above); fix PLANS / SPONSOR_PROFILE and re-run");
  return /^HASH (0x[0-9a-fA-F]{64})$/m.exec(res.stdout)?.[1] ?? null;
}

async function gather(): Promise<OnboardState> {
  const [code, balanceWei, chainSponsorId] = await Promise.all([
    registryBuildCode(publicClient, config.feeMarketRegistry),
    publicClient.getBalance({ address: relayerAddress }),
    read("relayerToSponsor", [relayerAddress]) as Promise<bigint>,
  ]);
  let status: number | null = null;
  let onchainHash = "0x" + "00".repeat(32);
  let freshHash: string | null = null;
  let onchainEndpoint: string | null = null;
  let payoutIsRelayerKey = false;
  if (chainSponsorId !== 0n) {
    const sponsor = (await read("sponsors", [chainSponsorId])) as readonly [string, string, string, number, boolean];
    status = sponsor[3];
    onchainHash = (await read("metadataHash", [chainSponsorId])) as string;
    freshHash = freshMetadataHash(chainSponsorId);
    payoutIsRelayerKey = sponsor[0].toLowerCase() === relayerAddress.toLowerCase();
    // null (not "") when the registry has no endpoint: an older build must not get an endpoint step.
    onchainEndpoint = await read("sponsorEndpoint", [chainSponsorId]).then((v) => v as string, () => null);
  }
  return {
    registryOk: !checkRegistryBuild(code.code).some((f) => f.level === "fail"),
    balanceWei,
    chainSponsorId,
    envSponsorId: config.sponsorId,
    status,
    onchainHash,
    freshHash,
    onchainEndpoint,
    publicUrl: config.publicRelayerUrl,
    payoutIsRelayerKey,
    storageConfigured: metadataStorageReady({
      metadataStorage: process.env.METADATA_STORAGE,
      thirdwebSecret: process.env.THIRDWEB_SECRET_KEY,
      thirdwebClientId: process.env.THIRDWEB_CLIENT_ID,
      filBucket: process.env.FIL_BUCKET,
      accessKey: process.env.STORAGE_ACCESS_KEY_ID,
      secretKey: process.env.STORAGE_SECRET_ACCESS_KEY,
    }),
  };
}

async function main() {
  console.log(`sponsor:onboard  relayer ${relayerAddress}  registry ${config.feeMarketRegistry}${dryRun ? "  (dry run)" : ""}\n`);
  const state = await gather();
  console.log(`  registered sponsor id : ${state.chainSponsorId === 0n ? "none" : state.chainSponsorId}   status: ${statusLabel(state.status)}`);
  console.log(`  .env SPONSOR_ID       : ${state.envSponsorId}`);
  console.log(`  relayer balance       : ${state.balanceWei} wei\n`);

  const plan = planOnboard(state);
  for (const b of plan.blockers) console.log(` ✗ ${b}`);
  if (plan.blockers.length) return void (process.exitCode = 1, console.log(`\n${plan.next}`));
  if (plan.steps.length === 0) {
    console.log(plan.next);
    if (!dryRun && state.status !== 2 && state.status !== 3) ensureNodeRunning();
    return;
  }
  console.log("Steps:");
  for (const s of plan.steps) console.log(` • ${s.kind}`);
  if (dryRun) return void console.log(`\n${plan.next}`);

  let sponsorId = state.chainSponsorId;
  for (const step of plan.steps) {
    console.log(`\n▶ ${step.kind}`);
    if (step.kind === "register") {
      if (!runSponsorScript("register.ts", ["register"]).ok) throw new Error("registration failed");
      sponsorId = (await read("relayerToSponsor", [relayerAddress])) as bigint;
      if (sponsorId === 0n) throw new Error("registration did not appear on-chain; re-run to retry");
      console.log(`  registered as sponsor #${sponsorId}`);
    } else if (step.kind === "write-env") {
      writeEnvKey("SPONSOR_ID", sponsorId.toString());
      console.log(`  SPONSOR_ID=${sponsorId} written to .env`);
    } else if (step.kind === "publish-metadata") {
      if (!runSponsorScript("publishMetadata.ts", ["publish"], { SPONSOR_ID: sponsorId.toString() }).ok) throw new Error("metadata publish failed");
    } else if (step.kind === "publish-endpoint") {
      if (step.viaPayout) {
        console.log("  The endpoint is set by the PAYOUT key, which this node does not hold. Run one of:");
        console.log("    SPONSOR_ADMIN_PRIVATE_KEY=0x… npm run sponsor:endpoint");
        console.log("    npm run sponsor:endpoint -- --safe-batch endpoint.json     (payout wallet is a Safe)");
      } else if (!runSponsorScript("endpoint.ts", [], { SPONSOR_ID: sponsorId.toString() }).ok) throw new Error("publishing the endpoint failed");
    }
  }

  const sponsor = (await read("sponsors", [sponsorId])) as readonly [string, string, string, number, boolean];
  console.log(`\nStatus now: ${statusLabel(sponsor[3])}`);
  const after = planOnboard({ ...state, chainSponsorId: sponsorId, envSponsorId: sponsorId, status: sponsor[3], onchainHash: "x", freshHash: "x" });
  console.log(after.next);

  // Curator review needs a live public URL — do not leave the sponsor with only an on-chain PENDING row.
  if (sponsor[3] !== 2 /* VERIFIED */ && sponsor[3] !== 3 /* REVOKED */) {
    ensureNodeRunning();
  }
}

main().catch((e) => {
  console.error("✗", (e as Error).message);
  process.exit(1);
});
