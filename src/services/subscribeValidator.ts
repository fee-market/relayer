import { toFunctionSelector } from "viem";
import { config, PricingModel } from "../config.js";
import { getPlan, type Plan } from "./registry.js";
import { checkUserCanPay } from "./payment.js";
import { decodeBatch, decodeUint256PairCall, validateApproveCall, validateDelegationShape } from "./batchValidation.js";
import type { SubscribeRequest } from "../types.js";

const SUBSCRIBE_SELECTOR = toFunctionSelector("subscribe(uint256,uint256)"); // 0x84370813

/**
 * /subscribe has no pre-existing subscriptionId to check funds against — that's exactly what this
 * call creates. So instead of a funds check, it validates the batch ITSELF against a strict shape:
 *
 *   [ (optional) paymentToken.approve(registry, amount), registry.subscribe(planId, amount) ]
 *
 * The subscribe() call must be present, be the LAST call, target THIS sponsor's FeeMarketRegistry,
 * and be for a plan that belongs to this sponsor. Any preceding call must be an approve() on the
 * plan's own paymentToken with the registry as spender — the only reason a call would precede
 * subscribe() at all. Without this, /subscribe would be an unbounded "sponsor pays for literally
 * anything" endpoint gated only by caveats. `amount` must also cover the plan's price for
 * Bulk/Subscription models — defense in depth regardless of what the contract itself enforces.
 */
export interface SubscribeValidationResult {
  ok: boolean;
  reason?: string;
  planId?: bigint;
  amount?: bigint;
  plan?: Plan;
}

export async function validateSubscribeRequest(req: SubscribeRequest): Promise<SubscribeValidationResult> {
  const shape = validateDelegationShape(req.delegations, req.executionCallData as `0x${string}`, req.mode);
  if (!shape.ok) return shape;

  let executions;
  try {
    executions = decodeBatch(req.executionCallData as `0x${string}`);
  } catch (e) {
    return { ok: false, reason: `could not decode execution batch: ${(e as Error).message}` };
  }
  if (executions.length < 1 || executions.length > 2) {
    return { ok: false, reason: "batch must be [subscribe] or [approve, subscribe]" };
  }

  let planId: bigint, amount: bigint;
  try {
    [planId, amount] = decodeUint256PairCall(
      executions[executions.length - 1],
      config.feeMarketRegistry,
      SUBSCRIBE_SELECTOR,
      "subscribe(uint256,uint256)",
    );
  } catch (e) {
    return { ok: false, reason: `last call is not a valid subscribe(): ${(e as Error).message}` };
  }

  const plan = await getPlan(planId);
  if (plan.sponsorId !== config.sponsorId) {
    return { ok: false, reason: "plan does not belong to this sponsor" };
  }
  if (!plan.active) {
    return { ok: false, reason: "plan is not active" };
  }
  if ((plan.model === PricingModel.BULK || plan.model === PricingModel.SUBSCRIPTION) && amount < plan.price) {
    return { ok: false, reason: `amount ${amount} is below plan price ${plan.price}` };
  }

  if (executions.length === 2) {
    try {
      validateApproveCall(executions[0], plan);
    } catch (e) {
      return { ok: false, reason: `first call is not a valid approve(): ${(e as Error).message}` };
    }
  }

  const user = req.delegations[req.delegations.length - 1].delegator as `0x${string}`;
  const pay = await checkUserCanPay({ user, token: plan.paymentToken, amount, batchApproves: executions.length === 2 });
  if (!pay.ok) return pay;

  return { ok: true, planId, amount, plan };
}
