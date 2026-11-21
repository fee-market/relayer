/**
 * CLI: generate a ready-to-publish sponsor listing from a requirements file.
 *
 *   npm run listing:gen
 *
 * Edit the `requirements` below (or load from JSON) to match your offer. The output prints:
 *   - the marketplace metadata JSON to pin to IPFS / serve from your endpoint
 *   - the exact arguments to call FeeMarketRegistry.listPlan(...)
 *
 * This is the "sponsor onboarding" code-gen: it encodes the two example offers the product spec calls
 * out — "1000 txns for $10" and "$0.01 per txn" — plus a subscription example.
 */
import { config } from "../config.js";
import { PricingModel, commitmentOfRow, generateListing, type SponsorRequirements } from "./listing.js";

const USDC_POLYGON = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359" as const;

const examples: Record<string, SponsorRequirements> = {
  bulk_1000_for_10: {
    name: "Acme Gas — Bulk",
    region: "eu-west",
    supportedChains: [137],
    relayerEndpoint: "https://relay.acme.example/relay",
    paymentToken: USDC_POLYGON,
    model: PricingModel.BULK,
    priceBaseUnits: 10_000_000n, // $10.00 (6 decimals)
    quota: 1000n,
    periodSeconds: 0n,
    caveats: {
      restrictToRelayer: true,
      maxCalls: 1,
      exactBatch: true,
      spendCaps: [{ token: USDC_POLYGON, maxAmount: 100_000_000n }],
    },
  },
  per_txn_one_cent: {
    name: "Acme Gas — Pay As You Go",
    region: "eu-west",
    supportedChains: [137],
    relayerEndpoint: "https://relay.acme.example/relay",
    paymentToken: USDC_POLYGON,
    model: PricingModel.PER_TXN,
    priceBaseUnits: 10_000n, // $0.01
    quota: 0n,
    periodSeconds: 0n,
    caveats: { restrictToRelayer: true, maxCalls: 1 },
  },
  monthly_unlimited: {
    name: "Acme Gas — Pro Monthly",
    region: "eu-west",
    supportedChains: [137],
    relayerEndpoint: "https://relay.acme.example/relay",
    paymentToken: USDC_POLYGON,
    model: PricingModel.SUBSCRIPTION,
    priceBaseUnits: 25_000_000n, // $25 / month
    quota: 0n, // unlimited
    periodSeconds: 30n * 86_400n,
    caveats: { restrictToRelayer: true, allowedTargets: [USDC_POLYGON] },
  },
};

for (const [key, req] of Object.entries(examples)) {
  const out = generateListing(config.sponsorId, req);
  console.log(`\n=============== ${key} ===============`);
  console.log("metadata.json:\n" + out.metadataString);
  console.log("\nlistPlan args:");
  console.log(
    JSON.stringify(out.listPlanArgs, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2),
  );
  console.log(`\ncommitment to publish with the metadata (listPlan checks it): ${commitmentOfRow(out.metadata)}`);
}
