import { getAddress } from "viem";
import { ANY_DELEGATE, ROOT_AUTHORITY } from "../config.js";
import { relayerAddress } from "../lib/clients.js";
import { checkSubscriptionFunds, type Plan, type Subscription } from "./registry.js";
import { validateChargeCall, validatePinnedDelegation } from "./batchValidation.js";
import type { RelayRequest } from "../types.js";

/**
 * Validates that an incoming delegation is one this sponsor is willing and able to redeem.
 * Defence-in-depth ON TOP of the on-chain caveat enforcers: enforcers keep the *user* safe; this
 * validator keeps the *sponsor* from wasting gas on delegations it can't be paid for.
 *
 * Two layers:
 *   1. Static (cheap, no RPC): shape, delegate, authority, required caveats, calldata present.
 *   2. On-chain (one RPC round-trip): the subscription exists, belongs to this sponsor's plan, and
 *      can fund exactly one more sponsored op (escrow / quota / expiry).
 */
export interface ValidationResult {
  ok: boolean;
  reason?: string;
  plan?: Plan;
  sub?: Subscription;
}

export function validateStatic(req: RelayRequest): ValidationResult {
  const leaf = req.delegations[0];

  // 1. The leaf delegate must allow this relayer to redeem (ANY_DELEGATE or our address).
  const delegate = getAddress(leaf.delegate);
  if (delegate !== getAddress(ANY_DELEGATE) && delegate !== getAddress(relayerAddress)) {
    return { ok: false, reason: "delegation not redeemable by this relayer" };
  }

  // 2. Root delegation must terminate in ROOT_AUTHORITY.
  const root = req.delegations[req.delegations.length - 1];
  if (root.authority.toLowerCase() !== ROOT_AUTHORITY.toLowerCase()) {
    return { ok: false, reason: "chain does not terminate at ROOT_AUTHORITY" };
  }

  // 3. executionCallData present.
  if (!req.executionCallData || req.executionCallData === "0x") {
    return { ok: false, reason: "empty executionCallData" };
  }

  // 4. The delegation must pin the exact batch, a single use, the redeemer and a deadline: without it the
  //    redeemer (this relayer) could substitute any batch, and a leaked relayer key could drain users.
  const pinned = validatePinnedDelegation(req.delegations, req.executionCallData as `0x${string}`, req.mode);
  if (!pinned.ok) return pinned;

  return { ok: true };
}

export async function validateRelayRequest(req: RelayRequest): Promise<ValidationResult> {
  const staticResult = validateStatic(req);
  if (!staticResult.ok) return staticResult;

  const charge = validateChargeCall(req.executionCallData as `0x${string}`, BigInt(req.subscriptionId));
  if (!charge.ok) return charge;

  const funds = await checkSubscriptionFunds(BigInt(req.subscriptionId));
  if (!funds.ok) return { ok: false, reason: funds.reason };

  // chargeUsage is executed by the delegator, so the registry only accepts it from the subscriber.
  const delegator = req.delegations[req.delegations.length - 1].delegator;
  if (getAddress(funds.sub.user) !== getAddress(delegator)) {
    return { ok: false, reason: "delegator is not the subscriber" };
  }

  return { ok: true, plan: funds.plan, sub: funds.sub };
}

