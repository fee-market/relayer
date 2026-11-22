/**
 * Go live once the curator has verified you: list plans (idempotent), start the node, wait for /health.
 *
 *   npm run sponsor:go                       # docker compose if available + PUBLIC_DOMAIN set, else run the node here
 *   npm run sponsor:go -- --mode docker|node
 *   npm run sponsor:go -- --no-start         # only list plans
 *   npm run sponsor:go -- --dry-run          # print the plan
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { config } from "../config.js";
import { feeMarketRegistryAbi } from "../abi.js";
import { publicClient, relayerAddress } from "../lib/clients.js";
import { runSponsorScript } from "./child.js";
import { chooseMode, healthBaseUrl, planGo, statusLabel, type GoMode } from "./flow.js";

const argv = process.argv.slice(2);
const flag = (n: string) => argv.includes(`--${n}`);
const opt = (n: string) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const read = (functionName: string, args: unknown[]) =>
  publicClient.readContract({ address: config.feeMarketRegistry, abi: feeMarketRegistryAbi, functionName, args } as never);

async function waitForHealth(baseUrl: string, seconds = 60): Promise<boolean> {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(4000) });
      const body = (await res.json()) as { relayer?: string };
      if (body.relayer?.toLowerCase() === relayerAddress.toLowerCase()) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

async function main() {
  const chainSponsorId = (await read("relayerToSponsor", [relayerAddress])) as bigint;
  let status: number | null = null;
  let metadataInSync: boolean | undefined;
  if (chainSponsorId !== 0n) {
    status = ((await read("sponsors", [chainSponsorId])) as readonly [string, string, string, number, boolean])[3];
    const onchainHash = (await read("metadataHash", [chainSponsorId])) as string;
    const res = runSponsorScript("publishMetadata.ts", ["hash"], { SPONSOR_ID: chainSponsorId.toString() }, true);
    const fresh = /^HASH (0x[0-9a-fA-F]{64})$/m.exec(res.stdout)?.[1];
    if (fresh) metadataInSync = fresh.toLowerCase() === onchainHash.toLowerCase();
  }

  const modeOpt = opt("mode");
  if (modeOpt && modeOpt !== "docker" && modeOpt !== "node") throw new Error("--mode must be docker or node");
  const state = {
    status,
    hasDocker: spawnSync("docker", ["--version"]).status === 0,
    hasCompose: existsSync(new URL("../../docker-compose.yml", import.meta.url)),
    hasDomain: Boolean(process.env.PUBLIC_DOMAIN),
    publicUrl: config.publicRelayerUrl,
    mode: modeOpt as GoMode | undefined,
    noStart: flag("no-start"),
    metadataInSync,
  };
  const plan = planGo(state);
  console.log(`sponsor:go  sponsor #${chainSponsorId || "?"} (${statusLabel(status)})  mode ${state.noStart ? "(no start)" : plan.mode}\n`);
  if (chainSponsorId !== 0n && chainSponsorId !== config.sponsorId) {
    plan.blockers.push(`.env SPONSOR_ID=${config.sponsorId} but this relayer is sponsor #${chainSponsorId}; run \`npm run sponsor:onboard\` to fix it.`);
  }
  for (const b of plan.blockers) console.log(` ✗ ${b}`);
  if (plan.blockers.length) return void (process.exitCode = 1, console.log(`\n${plan.next}`));
  console.log("Steps:");
  for (const s of plan.steps) console.log(` • ${s.kind}${s.kind === "start" ? ` (${s.mode})` : ""}`);
  if (flag("dry-run")) return void console.log("\nDry run: nothing sent.");

  console.log("\n▶ list-plans");
  if (!runSponsorScript("register.ts", ["list"], { SPONSOR_ID: chainSponsorId.toString() }).ok) throw new Error("listing plans failed");
  if (state.noStart) return void console.log(`\n${plan.next}`);

  const mode = chooseMode(state);
  if (mode === "docker") {
    console.log("\n▶ docker compose up -d --build");
    const up = spawnSync("docker", ["compose", "up", "-d", "--build"], { stdio: "inherit" });
    if (up.status !== 0) throw new Error("docker compose failed");
    const base = healthBaseUrl(config.publicRelayerUrl);
    if (!base || base.includes("example")) {
      console.log("PUBLIC_RELAYER_URL is not your real URL; skipping the public health check.");
    } else {
      console.log(`▶ waiting for ${base}/health`);
      console.log((await waitForHealth(base)) ? " ✓ node is up and reports this relayer" : " ✗ not reachable after 60s: check `docker compose logs` and your DNS");
    }
    return void console.log(`\n${plan.next}`);
  }

  console.log("\n▶ npm run build");
  if (spawnSync("npm", ["run", "build"], { stdio: "inherit" }).status !== 0) throw new Error("build failed");
  console.log("▶ starting the node in this terminal (use systemd/tmux/pm2 to keep it running)");
  const node = spawn("node", ["dist/index.js"], { stdio: "inherit", env: { ...process.env, SPONSOR_ID: chainSponsorId.toString() } });
  process.on("SIGINT", () => node.kill("SIGINT"));
  process.on("SIGTERM", () => node.kill("SIGTERM"));
  const up = await waitForHealth(`http://127.0.0.1:${config.port}`);
  console.log(up ? ` ✓ node is up on :${config.port} and reports this relayer` : " ✗ node did not become healthy in 60s");
  node.on("exit", (code) => process.exit(code ?? 0));
}

main().catch((e) => {
  console.error("✗", (e as Error).message);
  process.exit(1);
});
