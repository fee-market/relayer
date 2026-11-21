/**
 * Interactive builder for sponsor.plans.json — profile, plans, and (optionally) the public
 * HTTPS endpoint on this VPS (Caddy via Docker Compose — not Apache/nginx).
 *
 *   npm run sponsor:plans:configure
 *
 * Writes sponsor.plans.json, syncs PUBLIC_DOMAIN / PUBLIC_RELAYER_URL into .env, then can start
 * `docker compose` so wallets reach this machine at that URL.
 */
import "dotenv/config";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { isAddress } from "viem";
import { writeEnvKey } from "../src/sponsor/envFile.js";
import { PLAN_CONFIG_PATH, type PlanConfigFile } from "../src/sponsor/planConfig.js";
import { publishedUrlProblem } from "../src/sponsor/flow.js";

const USDC_POLYGON = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENV_PATH = join(ROOT, ".env");
const rl = createInterface({ input: process.stdin, output: process.stdout });

const ask = async (q: string, def = "") => {
  const a = (await rl.question(def ? `${q} [${def}]: ` : `${q}: `)).trim();
  return a || def;
};
const askYesNo = async (q: string, def: boolean) => {
  const a = (await ask(`${q} (y/n)`, def ? "y" : "n")).toLowerCase();
  return a.startsWith("y");
};
const askNumber = async (q: string, def: string) => {
  while (true) {
    const a = await ask(q, def);
    if (!Number.isNaN(Number(a))) return a;
    console.log("  please enter a number");
  }
};
const askAddress = async (q: string, def: string) => {
  while (true) {
    const a = await ask(q, def);
    if (isAddress(a)) return a;
    console.log("  not a valid address");
  }
};

/** Normalize to https://host — strip path and a mistaken trailing /relay (wallet adds routes). */
function normalizePublicBase(raw: string): string {
  let u = raw.trim().replace(/\/$/, "");
  u = u.replace(/\/relay$/i, "");
  if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
  const parsed = new URL(u);
  return `https://${parsed.host}`;
}

function syncPublicEnv(baseUrl: string): { domain: string; url: string } {
  const domain = new URL(baseUrl).hostname;
  if (!existsSync(ENV_PATH)) {
    console.log("  ! no .env yet — skipping env sync (run npm run sponsor:init first)");
    return { domain, url: baseUrl };
  }
  writeEnvKey("PUBLIC_DOMAIN", domain);
  writeEnvKey("PUBLIC_RELAYER_URL", baseUrl);
  writeEnvKey("TRUST_PROXY", "1");
  console.log(`  ✓ .env PUBLIC_DOMAIN=${domain}`);
  console.log(`  ✓ .env PUBLIC_RELAYER_URL=${baseUrl}`);
  return { domain, url: baseUrl };
}

function dockerReady(): boolean {
  if (spawnSync("docker", ["--version"], { stdio: "ignore" }).status !== 0) return false;
  return spawnSync("docker", ["compose", "version"], { stdio: "ignore" }).status === 0;
}

function startPublicEndpoint(): void {
  const script = join(ROOT, "scripts/serve-public.sh");
  const r = spawnSync("bash", [script], { stdio: "inherit", cwd: ROOT });
  if (r.status !== 0) throw new Error("could not start the public endpoint (see above)");
}

async function main() {
  const existing: PlanConfigFile | null = existsSync(PLAN_CONFIG_PATH) ? JSON.parse(readFileSync(PLAN_CONFIG_PATH, "utf8")) : null;
  if (existing) console.log(`Found an existing ${PLAN_CONFIG_PATH.pathname} — editing it.\n`);

  console.log("── Sponsor profile ──");
  const name = await ask("Sponsor name", existing?.profile.name ?? "My Gas Co");
  const region = await ask("Region (e.g. eu-west, us-east)", existing?.profile.region ?? "eu-west");

  const envUrl = (process.env.PUBLIC_RELAYER_URL ?? "").replace(/\/$/, "").replace(/\/relay$/i, "");
  const usableEnvUrl = publishedUrlProblem(envUrl) === null ? envUrl : "";
  const saved = existing?.profile.relayerEndpoint?.replace(/\/$/, "").replace(/\/relay$/i, "");
  if (saved && usableEnvUrl && saved !== usableEnvUrl) {
    console.log(`  note: the saved URL is ${saved}, but PUBLIC_RELAYER_URL in .env is ${usableEnvUrl}`);
  }

  console.log("  This host's public HTTPS name (DNS A record → this VPS). No path; wallets add /relay themselves.");
  let relayerEndpoint = "";
  while (true) {
    const raw = await ask(
      "Public URL of your node (https://relay.example.com)",
      saved && publishedUrlProblem(saved) === null ? saved : usableEnvUrl,
    );
    try {
      relayerEndpoint = normalizePublicBase(raw);
    } catch {
      console.log("  not a valid URL");
      continue;
    }
    const problem = publishedUrlProblem(relayerEndpoint);
    if (!problem) break;
    console.log(`  ${problem}`);
  }

  const plans: PlanConfigFile["plans"] = [];
  if (existing?.plans.length) {
    console.log(`\n── Existing plans (${existing.plans.length}) ──`);
    for (const p of existing.plans) {
      if (await askYesNo(`Keep "${p.name}"?`, true)) plans.push(p);
    }
  }

  console.log("\n── Add plans ──");
  while (true) {
    const addMore = plans.length === 0 ? true : await askYesNo("Add another plan?", false);
    if (!addMore) break;

    const planName = await ask("Plan name", `${name} — Plan ${plans.length + 1}`);
    console.log("  Pricing model: 1) Per transaction  2) Bulk bundle  3) Subscription");
    const modelChoice = await ask("  Choose 1-3", "1");
    const model: PlanConfigFile["plans"][number]["model"] =
      modelChoice === "2" ? "BULK" : modelChoice === "3" ? "SUBSCRIPTION" : "PER_TXN";

    const paymentToken = await askAddress("  Payment token address", USDC_POLYGON);
    let priceUsd: string,
      quota = "0",
      periodDays = "0";
    if (model === "PER_TXN") {
      priceUsd = await askNumber("  Price per transaction, in USD", "0.01");
    } else if (model === "BULK") {
      quota = await askNumber("  Bundle size (number of transactions)", "1000");
      priceUsd = await askNumber(`  Price for the whole bundle of ${quota}, in USD`, "10");
    } else {
      periodDays = await askNumber("  Period length, in days", "30");
      priceUsd = await askNumber(`  Price per ${periodDays}-day period, in USD`, "25");
      quota = await askNumber("  Max transactions per period (0 = unlimited)", "0");
    }
    const priceBaseUnits = String(Math.round(Number(priceUsd) * 1e6));
    const periodSeconds = String(Number(periodDays) * 86400);

    console.log("  Caveats (what the relayer requires on every delegation):");
    const exactBatch = await askYesNo("  Pin the exact batch (recommended)?", true);
    const maxCallsStr = await askNumber("  Max calls per delegation (1 = no replay)", "1");
    const addSpendCap = await askYesNo("  Add a per-token spend cap?", false);
    const caveats: PlanConfigFile["plans"][number]["caveats"] = {
      restrictToRelayer: true,
      maxCalls: Number(maxCallsStr),
      ...(exactBatch ? { exactBatch: true } : {}),
    };
    if (addSpendCap) {
      const token = await askAddress("    Spend-cap token address", paymentToken);
      const maxAmountUsd = await askNumber("    Max amount, in USD", "50");
      caveats.spendCaps = [{ token, maxAmount: String(Math.round(Number(maxAmountUsd) * 1e6)) }];
    }

    plans.push({
      name: planName,
      region,
      supportedChains: [137],
      paymentToken,
      model,
      priceBaseUnits,
      quota,
      periodSeconds,
      caveats,
    });
    console.log(`  ✓ added "${planName}"\n`);
  }

  if (plans.length === 0) {
    rl.close();
    console.log("\nNo plans defined — nothing written.");
    return;
  }

  const out: PlanConfigFile = { profile: { name, region, relayerEndpoint }, plans };
  writeFileSync(PLAN_CONFIG_PATH, JSON.stringify(out, null, 2) + "\n");
  console.log(`\n✓ wrote ${PLAN_CONFIG_PATH.pathname} (${plans.length} plan${plans.length === 1 ? "" : "s"})`);

  console.log("\n── Public endpoint on this machine ──");
  console.log("  HTTPS is terminated by Caddy in Docker Compose (not Apache/nginx).");
  console.log("  DNS: an A record for the hostname must already point at this server.");
  const { domain } = syncPublicEnv(relayerEndpoint);

  const canDocker = dockerReady();
  if (!canDocker) {
    console.log("  ! Docker Compose not available here — install with: sudo bash scripts/vps/prepare.sh");
    console.log("  Then: npm run sponsor:serve");
    rl.close();
  } else if (await askYesNo(`Start HTTPS for ${domain} with Caddy + relayer now?`, true)) {
    rl.close();
    startPublicEndpoint();
  } else {
    rl.close();
    console.log("  Skipped. Later: npm run sponsor:serve");
  }

  console.log("\nNext: `npm run sponsor:onboard -- --dry-run` to preview, then `npm run sponsor:onboard`.");
}

main().catch((e) => {
  console.error("✗", (e as Error).message);
  process.exit(1);
});
