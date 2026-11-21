import { toFunctionSelector } from "viem";
import { config } from "../config.js";
import { checkUserCanPay } from "./payment.js";
import { isSubscriptionEnded, getPlan, getSubscription, type Plan, type Subscription } from "./registry.js";
import { decodeBatch, decodeUint256PairCall, validateApproveCall, validateDelegationShape } from "./batchValidation.js";
import type { ExecutionRequest } from "../types.js";

const TOPUP_SELECTOR = toFunctionSelector("topUp(uint256,uint256)"); // 0xde643a71

/**
 * /topup adds escrow to an EXISTING subscription. Unlike /subscribe there's a subscriptionId, so we
 * can (and do) look up which sponsor/plan it belongs to directly — the request doesn't get to name
 * an arbitrary plan. The batch must be exactly [topUp] or [approve, topUp], target THIS sponsor's
 * FeeMarketRegistry, and be for a subscription whose plan belongs to this sponsor and is active.
 * `amount` must be > 0 — a zero top-up is either a no-op or (for models with no per-amount effect)
 * pointless gas spent by the sponsor for nothing.
 */
export interface TopUpValidationResult {
  ok: boolean;
  reason?: string;
  subscriptionId?: bigint;
  amount?: bigint;
  plan?: Plan;
  sub?: Subscription;
}

export async function validateTopUpRequest(req: ExecutionRequest): Promise<TopUpValidationResult> {
  const shape = validateDelegationShape(req.delegations, req.executionCallData as `0x${string}`, req.mode);
  if (!shape.ok) return shape;

  let executions;
  try {
    executions = decodeBatch(req.executionCallData as `0x${string}`);
  } catch (e) {
    return { ok: false, reason: `could not decode execution batch: ${(e as Error).message}` };
  }
  if (executions.length < 1 || executions.length > 2) {
    return { ok: false, reason: "batch must be [topUp] or [approve, topUp]" };
  }

  let subscriptionId: bigint, amount: bigint;
  try {
    [subscriptionId, amount] = decodeUint256PairCall(
      executions[executions.length - 1],
      config.feeMarketRegistry,
      TOPUP_SELECTOR,
      "topUp(uint256,uint256)",
    );
  } catch (e) {
    return { ok: false, reason: `last call is not a valid topUp(): ${(e as Error).message}` };
  }
  if (amount <= 0n) {
    return { ok: false, reason: "amount must be greater than 0" };
  }

  const sub = await getSubscription(subscriptionId);
  if (sub.user === "0x0000000000000000000000000000000000000000") {
    return { ok: false, reason: "unknown subscription" };
  }
  const plan = await getPlan(sub.planId);
  if (plan.sponsorId !== config.sponsorId) {
    return { ok: false, reason: "subscription's plan does not belong to this sponsor" };
  }
  if (!plan.active) {
    return { ok: false, reason: "plan is not active" };
  }

  // The registry only lets the subscriber top up (`topUp` reverts NotSubscriber for anyone else), and the call runs
  // as the delegator. A mismatch would revert on the sponsor's gas, so refuse it here.
  const delegator = req.delegations[req.delegations.length - 1].delegator;
  if (delegator.toLowerCase() !== sub.user.toLowerCase()) {
    return { ok: false, reason: "delegator is not the subscription's owner", subscriptionId };
  }
  if (await isSubscriptionEnded(subscriptionId)) {
    return { ok: false, reason: "subscription has ended", subscriptionId };
  }

  if (executions.length === 2) {
    try {
      validateApproveCall(executions[0], plan);
    } catch (e) {
      return { ok: false, reason: `first call is not a valid approve(): ${(e as Error).message}` };
    }
  }

  const pay = await checkUserCanPay({ user: sub.user, token: plan.paymentToken, amount, batchApproves: executions.length === 2 });
  if (!pay.ok) return { ...pay, subscriptionId };

  return { ok: true, subscriptionId, amount, plan, sub };
}
