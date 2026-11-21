import { getAddress } from "viem";
import { config } from "../config.js";
import { loadPlanConfig, planConfigExists } from "./planConfig.js";
import { PricingModel, type SponsorRequirements } from "./listing.js";

/**
 * Single source of truth for this sponsor's identity + offers. Shared by the onboarding CLI
 * (register.ts) and the metadata upload/set CLI (metadata.ts) so they never drift apart.
 *
 * Prefers sponsor.plans.json (written by `npm run sponsor:plans:configure`) when present; otherwise
 * falls back to the defaults below. Edit either to match your offer — this is also what gets
 * published as sponsor metadata JSON.
 */
const fromConfigFile = planConfigExists() ? loadPlanConfig() : null;

export const SPONSOR_PROFILE = fromConfigFile?.profile ?? {
  name: process.env.SPONSOR_NAME ?? "My Gas Co",
  region: process.env.SPONSOR_REGION ?? "eu-west",
  relayerEndpoint: process.env.PUBLIC_RELAYER_URL ?? "https://relay.example/relay",
};

export const SPONSOR_PLANS: SponsorRequirements[] = fromConfigFile?.plans ?? [
  {
    name: `${SPONSOR_PROFILE.name} — Bulk`,
    region: SPONSOR_PROFILE.region,
    supportedChains: [config.chainId],
    relayerEndpoint: SPONSOR_PROFILE.relayerEndpoint,
    paymentToken: getAddress("0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359"), // USDC (Polygon)
    model: PricingModel.BULK,
    priceBaseUnits: 10_000_000n, // $10.00
    quota: 1000n,
    periodSeconds: 0n,
    caveats: { restrictToRelayer: true, maxCalls: 1, exactBatch: true },
  },
  {
    name: `${SPONSOR_PROFILE.name} — Pay As You Go`,
    region: SPONSOR_PROFILE.region,
    supportedChains: [config.chainId],
    relayerEndpoint: SPONSOR_PROFILE.relayerEndpoint,
    paymentToken: getAddress("0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359"),
    model: PricingModel.PER_TXN,
    priceBaseUnits: 10_000n, // $0.01
    quota: 0n,
    periodSeconds: 0n,
    caveats: { restrictToRelayer: true, maxCalls: 1 },
  },
];
