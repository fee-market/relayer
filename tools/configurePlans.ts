/**
 * Interactive builder for sponsor.plans.json (profile + plans).
 *
 *   npm run sponsor:plans:configure
 *
 * Prefer setting PUBLIC_RELAYER_URL first (DNS + proxy / tunnel + ensure-running), then run this.
 * Writes sponsor.plans.json and syncs PUBLIC_DOMAIN / PUBLIC_RELAYER_URL into .env.
 * Profile name/region/optional wallet blurb live in the JSON file — not in .env.
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
// --no-endpoint: the caller (scripts/vps/setup.sh) already brought HTTPS up and keeps the node running.
const NO_ENDPOINT = process.argv.includes("--no-endpoint");
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENV_PATH = join(ROOT, ".env");
const rl = createInterface({ input: process.stdin, output: process.stdout });

const note = (s: string) => console.log(`  · ${s}`);
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

  console.log("── Public node URL ──");
  note("Set this up first: DNS A record → this host, then proxy/tunnel + npm run sponsor:ensure-running.");
  note("PUBLIC_RELAYER_URL in .env is the default below when it looks valid.");
  const envUrl = (process.env.PUBLIC_RELAYER_URL ?? "").replace(/\/$/, "").replace(/\/relay$/i, "");
  const usableEnvUrl = publishedUrlProblem(envUrl) === null ? envUrl : "";
  const saved = existing?.profile.relayerEndpoint?.replace(/\/$/, "").replace(/\/relay$/i, "");
  if (saved && usableEnvUrl && saved !== usableEnvUrl) {
    console.log(`  note: plans file has ${saved}, .env has ${usableEnvUrl}`);
  }
  if (!usableEnvUrl && !saved) {
    console.log("  ! No usable PUBLIC_RELAYER_URL yet. Prefer finishing HTTPS first:");
    note("npm run sponsor:serve   or   sudo bash scripts/vps/setup-proxy.sh apache|nginx");
    note("npm run sponsor:check-endpoint");
  }

  let relayerEndpoint = "";
  while (true) {
    const raw = await ask(
      "Public URL of your node (https://node.example.com)",
      usableEnvUrl || (saved && publishedUrlProblem(saved) === null ? saved : ""),
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
  const { domain } = syncPublicEnv(relayerEndpoint);

  console.log("\n── Sponsor profile (stored in sponsor.plans.json, not .env) ──");
  const name = await ask("Sponsor name", existing?.profile.name ?? "My Gas Co");
  const region = await ask("Region (e.g. eu-west, us-east)", existing?.profile.region ?? "eu-west");
  const description = await ask("Short description for wallets (optional, empty to skip)", existing?.profile.description ?? "");
  const website = await ask("Website https://… (optional)", existing?.profile.website ?? "");
  const supportUrl = await ask("Support URL https://… (optional)", existing?.profile.supportUrl ?? "");

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
    console.log("  Pricing model:");
    note("1) Per transaction — user prepays; you charge the plan price each sponsored send");
    note("2) Bulk bundle — user buys N sends up front (e.g. 1000 for a fixed price)");
    note("3) Subscription — fixed price per period (e.g. 30 days); optional send cap per period");
    const modelChoice = await ask("  Choose 1-3", "1");
    const model: PlanConfigFile["plans"][number]["model"] =
      modelChoice === "2" ? "BULK" : modelChoice === "3" ? "SUBSCRIPTION" : "PER_TXN";

    note("Token users pay with (Polygon USDC by default). Must match what your node accepts.");
    const paymentToken = await askAddress("  Payment token address", USDC_POLYGON);
    let priceUsd: string,
      quota = "0",
      periodDays = "0";
    if (model === "PER_TXN") {
      note("How much USDC (in dollars) to debit from the user's escrow for each sponsored send.");
      priceUsd = await askNumber("  Price per transaction, in USD", "0.01");
    } else if (model === "BULK") {
      note("How many sponsored sends the user gets when they buy this bundle.");
      quota = await askNumber("  Bundle size (number of transactions)", "1000");
      note("One-time price for the whole bundle (debited when they subscribe).");
      priceUsd = await askNumber(`  Price for the whole bundle of ${quota}, in USD`, "10");
    } else {
      note("Length of one billing period before the subscription expires.");
      periodDays = await askNumber("  Period length, in days", "30");
      note("Price charged for each period when the user subscribes / renews.");
      priceUsd = await askNumber(`  Price per ${periodDays}-day period, in USD`, "25");
      note("Hard cap on sponsored sends in that period. 0 = unlimited (still gas-capped by your node).");
      quota = await askNumber("  Max transactions per period (0 = unlimited)", "0");
    }
    const priceBaseUnits = String(Math.round(Number(priceUsd) * 1e6));
    const periodSeconds = String(Number(periodDays) * 86400);

    console.log("  Caveats — on-chain rules every user delegation must carry (protects you):");
    note("Delegations are always locked to YOUR relayer set (cannot be redeemed by another sponsor).");
    note("Pin exact batch: the signed call list cannot be swapped for a different one at redeem time. Keep yes unless you know you need flexible batches.");
    const exactBatch = await askYesNo("  Pin the exact batch (recommended)?", true);
    note("Max redemptions of ONE signed delegation. 1 = single-use (recommended: stops replay). Higher = same signature can be redeemed multiple times.");
    const maxCallsStr = await askNumber("  Max calls per delegation (1 = no replay)", "1");
    note("Spend cap: optional extra limit on how much of a token the user's batch may move in that one redemption (e.g. max 50 USDC transfer). Usually leave off — escrow/plan price already limits what you earn.");
    const addSpendCap = await askYesNo("  Add a per-token spend cap?", false);
    const caveats: PlanConfigFile["plans"][number]["caveats"] = {
      restrictToRelayer: true,
      maxCalls: Number(maxCallsStr),
      ...(exactBatch ? { exactBatch: true } : {}),
    };
    if (addSpendCap) {
      note("Token whose transfers in the batch are capped (often the same as the payment token).");
      const token = await askAddress("    Spend-cap token address", paymentToken);
      note("Max amount of that token the batch may spend/transfer in one redemption.");
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

  const profile: PlanConfigFile["profile"] = {
    name,
    region,
    relayerEndpoint,
    ...(description ? { description } : {}),
    ...(website ? { website } : {}),
    ...(supportUrl ? { supportUrl } : {}),
  };
  const out: PlanConfigFile = { profile, plans };
  writeFileSync(PLAN_CONFIG_PATH, JSON.stringify(out, null, 2) + "\n");
  console.log(`\n✓ wrote ${PLAN_CONFIG_PATH.pathname} (${plans.length} plan${plans.length === 1 ? "" : "s"})`);

  if (NO_ENDPOINT) {
    rl.close();
    return;
  }

  console.log("\n── HTTPS / keep node running (optional if already up) ──");
  if (await askYesNo("Configure or refresh the public endpoint on this machine now?", !usableEnvUrl)) {
    note("1) Caddy via Docker (recommended)");
    note("2) nginx + Certbot");
    note("3) Apache + Certbot");
    note("4) Skip");
    const proxyChoice = (await ask("  HTTPS front-end", usableEnvUrl ? "4" : "1")).toLowerCase();
    if (proxyChoice === "2" || proxyChoice === "nginx") {
      if (existsSync(ENV_PATH)) writeEnvKey("PROXY_KIND", "nginx");
      const runNow = await askYesNo("  Run setup-proxy + start the node service now? (needs sudo)", true);
      rl.close();
      if (runNow) {
        spawnSync("sudo", ["bash", join(ROOT, "scripts/vps/setup-proxy.sh"), "nginx", "--domain", domain], {
          stdio: "inherit",
          cwd: ROOT,
        });
        spawnSync("bash", [join(ROOT, "scripts/ensure-node-running.sh")], { stdio: "inherit", cwd: ROOT });
      } else {
        console.log(`  → sudo bash scripts/vps/setup-proxy.sh nginx --domain ${domain}`);
        console.log("  → npm run sponsor:ensure-running");
      }
    } else if (proxyChoice === "3" || proxyChoice === "apache") {
      if (existsSync(ENV_PATH)) writeEnvKey("PROXY_KIND", "apache");
      const runNow = await askYesNo("  Run setup-proxy + start the node service now? (needs sudo)", true);
      rl.close();
      if (runNow) {
        spawnSync("sudo", ["bash", join(ROOT, "scripts/vps/setup-proxy.sh"), "apache", "--domain", domain], {
          stdio: "inherit",
          cwd: ROOT,
        });
        spawnSync("bash", [join(ROOT, "scripts/ensure-node-running.sh")], { stdio: "inherit", cwd: ROOT });
      } else {
        console.log(`  → sudo bash scripts/vps/setup-proxy.sh apache --domain ${domain}`);
        console.log("  → npm run sponsor:ensure-running");
      }
    } else if (proxyChoice === "4" || proxyChoice === "skip" || proxyChoice === "n") {
      rl.close();
      console.log("  Skipped. Ensure the node is up: npm run sponsor:ensure-running");
    } else {
      if (existsSync(ENV_PATH)) writeEnvKey("PROXY_KIND", "caddy");
      if (!dockerReady()) {
        rl.close();
        console.log("  ! Docker Compose not available — sudo bash scripts/vps/prepare.sh");
        console.log(`  Or: sudo bash scripts/vps/setup-proxy.sh nginx --domain ${domain}`);
      } else if (await askYesNo(`Start HTTPS for ${domain} with Caddy + relayer now?`, true)) {
        rl.close();
        startPublicEndpoint();
      } else {
        rl.close();
        console.log("  Skipped. Later: npm run sponsor:serve");
      }
    }
  } else {
    rl.close();
    console.log("  OK — using existing endpoint. Keep it running for the curator.");
  }

  console.log("\nNext: `npm run sponsor:onboard` (register + publish metadata + keep node running).");
  console.log("Status later: `npm run sponsor:status` or re-run onboard. After VERIFIED: `npm run sponsor:go`.");
}

main().catch((e) => {
  console.error("✗", (e as Error).message);
  process.exit(1);
});
