import { type Address, decodeAbiParameters, getAddress, size, slice, toFunctionSelector } from "viem";
import { config, ANY_DELEGATE, BATCH_DEFAULT_MODE, ROOT_AUTHORITY } from "../config.js";
import { relayerAddress } from "../lib/clients.js";
import type { Plan } from "./registry.js";
import type { Delegation } from "../types.js";

export const CHARGE_USAGE_SELECTOR = toFunctionSelector("chargeUsage(uint256,uint256)");
export const APPROVE_SELECTOR = toFunctionSelector("approve(address,uint256)"); // 0x095ea7b3

export interface Execution {
  target: Address;
  value: bigint;
  callData: `0x${string}`;
}

/** Static checks shared by every endpoint that redeems a delegation: delegate/authority shape, plus the
 * caveats that pin what the redeemer may do (see `validatePinnedDelegation`). */
export function validateDelegationShape(
  delegations: Delegation[],
  executionCallData: `0x${string}`,
  mode?: string,
): { ok: true } | { ok: false; reason: string } {
  const leaf = delegations[0];
  const delegate = getAddress(leaf.delegate);
  if (delegate !== getAddress(ANY_DELEGATE) && delegate !== getAddress(relayerAddress)) {
    return { ok: false, reason: "delegation not redeemable by this relayer" };
  }
  const root = delegations[delegations.length - 1];
  if (root.authority.toLowerCase() !== ROOT_AUTHORITY.toLowerCase()) {
    return { ok: false, reason: "chain does not terminate at ROOT_AUTHORITY" };
  }
  return validatePinnedDelegation(delegations, executionCallData, mode);
}

/** True when the delegation locks the redeemer to the sponsor's relayer set (rather than to one key). */
export function usesSponsorLevelLock(delegations: Delegation[]): boolean {
  const e = config.sponsorRelayerEnforcer.toLowerCase();
  return delegations[delegations.length - 1]?.caveats.some((c) => c.enforcer.toLowerCase() === e) ?? false;
}

/**
 * The user's delegation must bind the redeemer to exactly what the user signed. The `executionCallData`
 * is supplied by whoever redeems, so unless the delegation pins it on-chain, the redeemer could swap in
 * any batch from the user's account. Required, in the leaf delegation, each exactly once:
 *   - RedeemerRestrictionEnforcer: terms = this relayer's address, OR (exactly one of the two)
 *     SponsorRelayerEnforcer:      terms = abi.encodePacked(this registry, this sponsorId): any key in the sponsor's relayer
 *                                  set may redeem, so a key rotation or a standby node does not invalidate signed delegations
 *   - LimitedCallsEnforcer:        terms = 1 (no replay)
 *   - ExactExecutionBatchEnforcer: terms = the batch itself (abi.encode(Execution[]), identical to
 *                                  executionCallData)
 *   - TimestampEnforcer:           terms = (after, before) uint128 pair; `before` must be in the future
 *                                  and no further than MAX_DELEGATION_TTL_SECONDS away
 * Any other enforcer is rejected (unknown enforcer code runs during redemption on the sponsor's gas).
 * The batch enforcers only support the default single-batch mode, so no other mode is accepted.
 */
export function validatePinnedDelegation(
  delegations: Delegation[],
  executionCallData: `0x${string}`,
  mode?: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): { ok: true } | { ok: false; reason: string } {
  if (delegations.length !== 1) {
    return { ok: false, reason: "exactly one delegation is supported (no re-delegation chains)" };
  }
  const limits = validateBatchLimits(executionCallData);
  if (!limits.ok) return limits;
  if (mode !== undefined && mode.toLowerCase() !== BATCH_DEFAULT_MODE.toLowerCase()) {
    return { ok: false, reason: "execution mode must be the default single batch" };
  }
  const leaf = delegations[0];

  const known = {
    redeemer: config.redeemerRestrictionEnforcer.toLowerCase(),
    sponsor: config.sponsorRelayerEnforcer.toLowerCase(),
    limited: config.limitedCallsEnforcer.toLowerCase(),
    exact: config.exactExecutionBatchEnforcer.toLowerCase(),
    timestamp: config.timestampEnforcer.toLowerCase(),
  };
  const found = new Map<string, `0x${string}`>();
  for (const c of leaf.caveats) {
    const key = c.enforcer.toLowerCase();
    if (!Object.values(known).includes(key)) return { ok: false, reason: `unknown caveat enforcer ${c.enforcer}` };
    if (found.has(key)) return { ok: false, reason: `duplicate caveat ${c.enforcer}` };
    found.set(key, c.terms as `0x${string}`);
  }

  if (config.policy.requireRedeemerRestriction) {
    const single = found.get(known.redeemer);
    const sponsorLevel = found.get(known.sponsor);
    if (single && sponsorLevel) return { ok: false, reason: "use either RedeemerRestrictionEnforcer or SponsorRelayerEnforcer, not both" };
    if (!single && !sponsorLevel) return { ok: false, reason: "missing RedeemerRestrictionEnforcer caveat (or SponsorRelayerEnforcer)" };
    if (single && (size(single) !== 20 || getAddress(single) !== getAddress(relayerAddress))) {
      return { ok: false, reason: "RedeemerRestrictionEnforcer is not locked to this relayer" };
    }
    if (sponsorLevel) {
      if (size(sponsorLevel) !== 52) return { ok: false, reason: "invalid SponsorRelayerEnforcer terms" };
      if (getAddress(slice(sponsorLevel, 0, 20)) !== getAddress(config.feeMarketRegistry)) {
        return { ok: false, reason: "SponsorRelayerEnforcer is locked to a different registry" };
      }
      if (BigInt(slice(sponsorLevel, 20, 52)) !== config.sponsorId) {
        return { ok: false, reason: "SponsorRelayerEnforcer is locked to a different sponsor" };
      }
    }
  }

  const limited = found.get(known.limited);
  if (!limited) return { ok: false, reason: "missing LimitedCallsEnforcer caveat" };
  if (size(limited) !== 32 || BigInt(limited) !== 1n) return { ok: false, reason: "call limit must be exactly 1" };

  const exact = found.get(known.exact);
  if (!exact) return { ok: false, reason: "missing ExactExecutionBatchEnforcer caveat (the batch must be pinned)" };
  if (exact.toLowerCase() !== executionCallData.toLowerCase()) {
    return { ok: false, reason: "pinned batch does not match executionCallData" };
  }

  const ts = found.get(known.timestamp);
  if (!ts) return { ok: false, reason: "missing TimestampEnforcer caveat (a deadline is required)" };
  if (size(ts) !== 32) return { ok: false, reason: "invalid TimestampEnforcer terms" };
  const after = BigInt(slice(ts, 0, 16));
  const before = BigInt(slice(ts, 16, 32));
  const now = BigInt(nowSeconds);
  if (before === 0n) return { ok: false, reason: "delegation has no deadline" };
  if (before <= now + 30n) return { ok: false, reason: "delegation deadline is too close or already passed" };
  if (before > now + BigInt(config.policy.maxDelegationTtlSeconds)) {
    return { ok: false, reason: `delegation deadline is more than ${config.policy.maxDelegationTtlSeconds}s away` };
  }
  if (after !== 0n && after >= before) return { ok: false, reason: "delegation start is not before its deadline" };
  return { ok: true };
}

/**
 * A sponsored batch is paid for as ONE operation however much it does, and the sponsor pays its gas. So bound it:
 * at most MAX_BATCH_CALLS calls and MAX_BATCH_CALLDATA_BYTES of data, and (optionally) only ALLOWED_TARGETS as call
 * targets. The FeeMarketRegistry is always allowed because the final charge call is addressed to it, and so is
 * FeeMarketAgreements when the node is set up with it (the acceptance call that goes with subscribe).
 */
export function validateBatchLimits(executionCallData: `0x${string}`): { ok: true } | { ok: false; reason: string } {
  let executions: Execution[];
  try {
    executions = decodeBatch(executionCallData);
  } catch {
    return { ok: false, reason: "malformed executionCallData" };
  }
  const p = config.policy;
  if (executions.length > p.maxBatchCalls) return { ok: false, reason: `batch has ${executions.length} calls, the limit is ${p.maxBatchCalls}` };
  if (size(executionCallData) > p.maxBatchCalldataBytes) return { ok: false, reason: `batch is larger than ${p.maxBatchCalldataBytes} bytes` };
  if (p.allowedTargets.length > 0) {
    const registry = config.feeMarketRegistry.toLowerCase();
    // The agreements contract only records the caller's own acceptance; a subscribe batch has to be able to call it.
    const agreements = config.feeMarketAgreements?.toLowerCase();
    const bad = executions.find((e) => {
      const t = e.target.toLowerCase();
      return t !== registry && t !== agreements && !p.allowedTargets.includes(t);
    });
    if (bad) return { ok: false, reason: `call target ${bad.target} is not allowed by this sponsor` };
  }
  return { ok: true };
}

export function decodeBatch(executionCallData: `0x${string}`): Execution[] {
  const [executions] = decodeAbiParameters(
    [
      {
        type: "tuple[]",
        components: [
          { name: "target", type: "address" },
          { name: "value", type: "uint256" },
          { name: "callData", type: "bytes" },
        ],
      },
    ],
    executionCallData,
  ) as unknown as [Execution[]];
  return executions;
}

/** Decodes a call as `fn(uint256,uint256)` after checking target/selector/value. Used for
 * subscribe(planId,amount), topUp(subscriptionId,amount), etc. */
export function decodeUint256PairCall(
  exec: Execution,
  expectedTarget: Address,
  expectedSelector: `0x${string}`,
  label: string,
): [bigint, bigint] {
  if (getAddress(exec.target) !== getAddress(expectedTarget)) {
    throw new Error(`call target is not this sponsor's FeeMarketRegistry`);
  }
  if (exec.value !== 0n) throw new Error(`${label} call must not send value`);
  if (slice(exec.callData, 0, 4).toLowerCase() !== expectedSelector.toLowerCase()) {
    throw new Error(`call is not ${label}`);
  }
  const args = slice(exec.callData, 4);
  if (size(args) !== 64) throw new Error("unexpected argument length");
  return decodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], args) as [bigint, bigint];
}

/** Validates a preceding approve() call targets the plan's own payment token, spender = registry. */
export function validateApproveCall(exec: Execution, plan: Plan): void {
  if (getAddress(exec.target) !== getAddress(plan.paymentToken)) {
    throw new Error("approve target is not the plan's payment token");
  }
  if (exec.value !== 0n) throw new Error("approve call must not send value");
  if (slice(exec.callData, 0, 4).toLowerCase() !== APPROVE_SELECTOR.toLowerCase()) {
    throw new Error("call is not approve(address,uint256)");
  }
  const args = slice(exec.callData, 4);
  if (size(args) !== 64) throw new Error("unexpected argument length");
  const [spender] = decodeAbiParameters([{ type: "address" }, { type: "uint256" }], args) as [Address, bigint];
  if (getAddress(spender) !== getAddress(config.feeMarketRegistry)) {
    throw new Error("approve spender is not this sponsor's FeeMarketRegistry");
  }
}

/**
 * A sponsored /relay batch must end with `registry.chargeUsage(subscriptionId, 1)` (value 0), executed by the
 * user's own account. That call is how the sponsor gets paid: the registry only lets the subscriber charge,
 * so the relayer never reports usage itself. Exactly one such call is allowed, and it must be the last.
 */
export function validateChargeCall(
  executionCallData: `0x${string}`,
  subscriptionId: bigint,
): { ok: true } | { ok: false; reason: string } {
  let executions: Execution[];
  try {
    executions = decodeBatch(executionCallData);
  } catch {
    return { ok: false, reason: "malformed executionCallData" };
  }
  if (executions.length < 2) return { ok: false, reason: "batch must contain the action and a final chargeUsage call" };
  const isCharge = (e: Execution) =>
    getAddress(e.target) === getAddress(config.feeMarketRegistry) &&
    size(e.callData) >= 4 &&
    slice(e.callData, 0, 4).toLowerCase() === CHARGE_USAGE_SELECTOR.toLowerCase();
  if (executions.slice(0, -1).some(isCharge)) return { ok: false, reason: "chargeUsage must appear exactly once, last" };
  const last = executions[executions.length - 1];
  if (!isCharge(last)) return { ok: false, reason: "last call must be chargeUsage on this sponsor's registry" };
  if (last.value !== 0n) return { ok: false, reason: "chargeUsage call must not send value" };
  const args = slice(last.callData, 4);
  if (size(args) !== 64) return { ok: false, reason: "unexpected chargeUsage argument length" };
  const [subId, n] = decodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], args) as [bigint, bigint];
  if (subId !== subscriptionId) return { ok: false, reason: "chargeUsage subscription does not match the request" };
  if (n !== 1n) return { ok: false, reason: "chargeUsage must charge exactly one op" };
  return { ok: true };
}
