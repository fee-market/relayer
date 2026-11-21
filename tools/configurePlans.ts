/**
 * Interactive builder for relayer/sponsor.plans.json — define your profile and plans without
 * touching plans.ts. Run before `sponsor:onboard`/`sponsor:go`; those (via plans.ts) pick this file
 * up automatically once it exists.
 *
 *   npm run sponsor:plans:configure
 *
 * Re-running edits the existing file's profile and lets you keep, drop, or add plans.
 */
import "dotenv/config"; // only for PUBLIC_RELAYER_URL, the default for the profile's URL
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { isAddress } from "viem";
import { PLAN_CONFIG_PATH, type PlanConfigFile } from "../src/sponsor/planConfig.js";
import { publishedUrlProblem } from "../src/sponsor/flow.js";

const USDC_POLYGON = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359";
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

async function main() {
  const existing: PlanConfigFile | null = existsSync(PLAN_CONFIG_PATH) ? JSON.parse(readFileSync(PLAN_CONFIG_PATH, "utf8")) : null;
  if (existing) console.log(`Found an existing ${PLAN_CONFIG_PATH.pathname} — editing it.\n`);

  console.log("── Sponsor profile ──");
  const name = await ask("Sponsor name", existing?.profile.name ?? "My Gas Co");
  const region = await ask("Region (e.g. eu-west, us-east)", existing?.profile.region ?? "eu-west");
  // The node's own address from .env is the right answer nearly always; a placeholder there is not offered.
  const envUrl = (process.env.PUBLIC_RELAYER_URL ?? "").replace(/\/$/, "");
  const usableEnvUrl = publishedUrlProblem(envUrl) === null ? envUrl : "";
  const saved = existing?.profile.relayerEndpoint;
  if (saved && usableEnvUrl && saved.replace(/\/$/, "") !== usableEnvUrl) {
    console.log(`  note: the saved URL is ${saved}, but PUBLIC_RELAYER_URL in .env is ${usableEnvUrl}`);
  }
  let relayerEndpoint = "";
  while (true) {
    relayerEndpoint = (await ask("Public URL of your node, without a path (https://...)", saved && publishedUrlProblem(saved) === null ? saved : usableEnvUrl)).replace(/\/$/, "");
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
    const model: PlanConfigFile["plans"][number]["model"] = modelChoice === "2" ? "BULK" : modelChoice === "3" ? "SUBSCRIPTION" : "PER_TXN";

    const paymentToken = await askAddress("  Payment token address", USDC_POLYGON);
    let priceUsd: string, quota = "0", periodDays = "0";
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
    const priceBaseUnits = String(Math.round(Number(priceUsd) * 1e6)); // assumes a 6-decimal token (USDC)
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

  rl.close();
  if (plans.length === 0) {
    console.log("\nNo plans defined — nothing written.");
    return;
  }

  const out: PlanConfigFile = { profile: { name, region, relayerEndpoint }, plans };
  writeFileSync(PLAN_CONFIG_PATH, JSON.stringify(out, null, 2) + "\n");
  console.log(`\n✓ wrote ${PLAN_CONFIG_PATH.pathname} (${plans.length} plan${plans.length === 1 ? "" : "s"})`);
  console.log("Next: `npm run sponsor:onboard -- --dry-run` to preview, then `npm run sponsor:onboard`.");
}

main().catch((e) => {
  console.error("✗", (e as Error).message);
  process.exit(1);
});
