import { existsSync, readFileSync } from "node:fs";
import { getAddress, isAddress, type Address, type Hex } from "viem";
import { PricingModel, type CaveatPolicy, type SponsorRequirements } from "./listing.js";

/**
 * File-based alternative to hand-editing plans.ts: `npm run sponsor:plans:configure` writes this,
 * and plans.ts (the single source register.ts/metadata.ts both import) loads it when present.
 * JSON has no bigint, so price/quota/period/spendCap amounts are decimal strings here.
 */
export interface PlanConfigFile {
  /** Display identity + public node URL. Lives here (not in .env) so `plans:configure` is the single editor. */
  profile: {
    name: string;
    region: string;
    relayerEndpoint: string;
    description?: string;
    website?: string;
    supportUrl?: string;
  };
  plans: {
    name: string;
    region?: string;
    supportedChains: number[];
    paymentToken: string;
    model: "PER_TXN" | "BULK" | "SUBSCRIPTION";
    priceBaseUnits: string;
    quota: string;
    periodSeconds: string;
    caveats: {
      restrictToRelayer: boolean;
      maxCalls?: number;
      exactBatch?: boolean;
      allowedTargets?: string[];
      allowedSelectors?: string[];
      spendCaps?: { token: string; maxAmount: string }[];
    };
  }[];
}

const MODEL: Record<PlanConfigFile["plans"][number]["model"], PricingModel> = {
  PER_TXN: PricingModel.PER_TXN,
  BULK: PricingModel.BULK,
  SUBSCRIPTION: PricingModel.SUBSCRIPTION,
};

export const PLAN_CONFIG_PATH = new URL("../../sponsor.plans.json", import.meta.url);

export function planConfigExists(): boolean {
  return existsSync(PLAN_CONFIG_PATH);
}

/** Throws with a plain-language message on malformed input — this is user-edited/CLI-generated JSON. */
export function loadPlanConfig(path: URL = PLAN_CONFIG_PATH): { profile: PlanConfigFile["profile"]; plans: SponsorRequirements[] } {
  const raw: PlanConfigFile = JSON.parse(readFileSync(path, "utf8"));
  if (!raw.profile?.name || !raw.profile?.relayerEndpoint) throw new Error("sponsor.plans.json: profile.name and profile.relayerEndpoint are required");
  if (!Array.isArray(raw.plans) || raw.plans.length === 0) throw new Error("sponsor.plans.json: plans must be a non-empty array");

  const address = (a: string, where: string): Address => {
    if (!isAddress(a)) throw new Error(`sponsor.plans.json: ${where} is not a valid address: ${a}`);
    return getAddress(a);
  };

  const plans: SponsorRequirements[] = raw.plans.map((p, i) => {
    // `in`, not truthiness: PER_TXN is 0 in the enum, and a truthiness test refused every per-transaction plan.
    if (!(p.model in MODEL)) throw new Error(`sponsor.plans.json: plans[${i}].model must be one of PER_TXN, BULK, SUBSCRIPTION`);
    const caveats: CaveatPolicy = {
      restrictToRelayer: p.caveats.restrictToRelayer,
      ...(p.caveats.maxCalls !== undefined ? { maxCalls: p.caveats.maxCalls } : {}),
      ...(p.caveats.exactBatch !== undefined ? { exactBatch: p.caveats.exactBatch } : {}),
      ...(p.caveats.allowedTargets ? { allowedTargets: p.caveats.allowedTargets.map((t, j) => address(t, `plans[${i}].caveats.allowedTargets[${j}]`)) } : {}),
      ...(p.caveats.allowedSelectors ? { allowedSelectors: p.caveats.allowedSelectors as Hex[] } : {}),
      ...(p.caveats.spendCaps
        ? { spendCaps: p.caveats.spendCaps.map((c, j) => ({ token: address(c.token, `plans[${i}].caveats.spendCaps[${j}].token`), maxAmount: BigInt(c.maxAmount) })) }
        : {}),
    };
    return {
      name: p.name,
      region: p.region ?? raw.profile.region,
      supportedChains: p.supportedChains,
      relayerEndpoint: raw.profile.relayerEndpoint,
      paymentToken: address(p.paymentToken, `plans[${i}].paymentToken`),
      model: MODEL[p.model],
      priceBaseUnits: BigInt(p.priceBaseUnits),
      quota: BigInt(p.quota),
      periodSeconds: BigInt(p.periodSeconds),
      caveats,
    };
  });

  return { profile: raw.profile, plans };
}
