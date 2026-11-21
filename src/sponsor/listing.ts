import { type Address, type Hex, encodeAbiParameters, keccak256, toHex } from "viem";

/**
 * Sponsor-side listing model. A sponsor describes their offer in plain terms; this module turns it
 * into (a) the on-chain Plan params for FeeMarketRegistry.listPlan and (b) the caveat policy that the
 * relayer will require on every user delegation. This is the "sponsor code generation" entry point:
 * a sponsor writes a SponsorRequirements object and gets verifiable, on-chain-ready output.
 */

export enum PricingModel {
  PER_TXN = 0,
  BULK = 1,
  SUBSCRIPTION = 2,
}

export interface CaveatPolicy {
  /** Restrict redemption to this sponsor's relayer (RedeemerRestrictionEnforcer). */
  restrictToRelayer: boolean;
  /** Max number of redemptions per delegation (LimitedCallsEnforcer). */
  maxCalls?: number;
  /** Pin the exact batch (ExactExecutionBatchEnforcer). */
  exactBatch?: boolean;
  /** Allowed target contracts (AllowedTargetsEnforcer). */
  allowedTargets?: Address[];
  /** Allowed 4-byte selectors (AllowedMethodsEnforcer). */
  allowedSelectors?: Hex[];
  /** Per-token spend cap, e.g. { token, maxAmount }. */
  spendCaps?: { token: Address; maxAmount: bigint }[];
}

export interface SponsorRequirements {
  name: string;
  region: string;
  supportedChains: number[];
  relayerEndpoint: string; // where users POST delegations
  paymentToken: Address; // e.g. USDC
  model: PricingModel;
  /** Human price config, normalized to token base units (e.g. 6 decimals for USDC). */
  priceBaseUnits: bigint; // PER_TXN: per txn. BULK: total. SUBSCRIPTION: per period.
  quota: bigint; // BULK: #txns. SUBSCRIPTION: max txns (0 = unlimited).
  periodSeconds: bigint; // SUBSCRIPTION only.
  caveats: CaveatPolicy;
}

export interface GeneratedListing {
  metadata: Record<string, unknown> & { economics: PlanEconomics; caveatsHash: Hex };
  metadataString: string;
  /** Args for FeeMarketRegistry.listPlan(...) */
  listPlanArgs: {
    sponsorId: bigint;
    model: number;
    paymentToken: Address;
    price: bigint;
    quota: bigint;
    period: bigint;
    caveatsHash: Hex;
  };
}

/** Deterministic hash of the caveat policy — stored on-chain so users can verify what they agreed to. */
export function hashCaveatPolicy(policy: CaveatPolicy): Hex {
  const encoded = encodeAbiParameters(
    [{ type: "string" }],
    [JSON.stringify(policy, (_k, v) => (typeof v === "bigint" ? v.toString() : v))],
  );
  return keccak256(encoded);
}

/** A plan's money terms as published in the metadata, so the curator reviews them with the rest (audit CT-04). Strings, as JSON has no bigint. */
export interface PlanEconomics {
  paymentToken: string;
  model: number;
  price: string;
  quota: string;
  period: string;
}

/**
 * What the registry's `planCommitment` returns, and what `listPlan` checks against the list published with the metadata:
 * keccak256(abi.encode(token, model, price, quota, period, caveatsHash)). The list the sponsor commits is one of these per plan.
 */
export function planCommitment(e: PlanEconomics, caveatsHash: Hex): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "uint8" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "bytes32" }],
      [e.paymentToken.toLowerCase() as Address, e.model, BigInt(e.price), BigInt(e.quota), BigInt(e.period), caveatsHash],
    ),
  );
}

/** The commitment of one plan row of a metadata document. */
export const commitmentOfRow = (row: { economics: PlanEconomics; caveatsHash: string }): Hex => planCommitment(row.economics, row.caveatsHash as Hex);

/** What the registry would refuse about a plan's terms (so a mistake shows here, not as a reverted listPlan). Empty = fine. */
export function economicsProblems(e: PlanEconomics): string[] {
  const out: string[] = [];
  const price = BigInt(e.price);
  if (e.model !== 0 && e.model !== 1 && e.model !== 2) out.push("model must be 0 (per transaction), 1 (bulk) or 2 (subscription)");
  if (price > (1n << 128n) - 1n) out.push("price is above the registry's ceiling of 2^128 - 1");
  if (e.model === 1 && BigInt(e.quota) === 0n) out.push("a bulk plan needs a quota above 0");
  if (e.model === 2 && BigInt(e.period) < 3600n) out.push("a subscription period must be at least one hour");
  return out;
}

export function generateListing(sponsorId: bigint, req: SponsorRequirements): GeneratedListing {
  const caveatsHash = hashCaveatPolicy(req.caveats);

  const metadata = {
    name: req.name,
    region: req.region,
    supportedChains: req.supportedChains,
    relayerEndpoint: req.relayerEndpoint,
    pricing: describePricing(req),
    economics: {
      paymentToken: req.paymentToken,
      model: req.model,
      price: req.priceBaseUnits.toString(),
      quota: req.quota.toString(),
      period: req.periodSeconds.toString(),
    } satisfies PlanEconomics,
    caveats: req.caveats,
    caveatsHash,
  };

  return {
    metadata,
    metadataString: JSON.stringify(metadata, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2),
    listPlanArgs: {
      sponsorId,
      model: req.model,
      paymentToken: req.paymentToken,
      price: req.priceBaseUnits,
      quota: req.quota,
      period: req.periodSeconds,
      caveatsHash,
    },
  };
}

function describePricing(req: SponsorRequirements): string {
  const human = Number(req.priceBaseUnits) / 1e6; // assume 6-decimal stablecoin for display
  switch (req.model) {
    case PricingModel.PER_TXN:
      return `$${human} per transaction`;
    case PricingModel.BULK:
      return `${req.quota} transactions for $${human}`;
    case PricingModel.SUBSCRIPTION:
      return `$${human} per ${Number(req.periodSeconds) / 86400} days${
        req.quota === 0n ? " (unlimited)" : ` (up to ${req.quota} txns)`
      }`;
  }
}

export { toHex };
