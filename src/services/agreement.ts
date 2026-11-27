import { type Address, decodeFunctionData, size, slice, toFunctionSelector } from "viem";
import { config } from "../config.js";
import { feeMarketAgreementsAbi } from "../abi.js";
import { cached } from "../lib/cache.js";
import { publicClient } from "../lib/clients.js";
import type { Execution } from "./batchValidation.js";

/**
 * The sponsor agreement, on-chain.
 *
 * A subscriber accepts the agreement by having their own account call `FeeMarketAgreements.accept(planId, hash, signature)`
 * in the same batch as `FeeMarketRegistry.subscribe`, so the acceptance and the subscription are mined together or not at
 * all. The contract checks the signature and the hash itself; the registry does not know about it (it has no room to).
 * What makes the acceptance a condition of subscribing is this node: with FEE_MARKET_AGREEMENTS set and a version
 * published there, /subscribe only sponsors a batch that carries the acceptance, for the same plan and the current text.
 *
 * Off (the address is not set) or nothing published yet (version 0): /subscribe behaves exactly as before.
 */

export const ACCEPT_SELECTOR = toFunctionSelector("accept(uint256,bytes32,bytes)");

/** What the node answers. The wallet matches on the first one. */
export const AGREEMENT_REQUIRED_REASON = "this sponsor requires the sponsor agreement to be accepted in the same transaction as subscribe";
export const AGREEMENT_STALE_REASON = "the sponsor agreement in this request is not the current version";
export const AGREEMENT_WRONG_PLAN_REASON = "the agreement was accepted for a different plan than the one being subscribed to";
export const AGREEMENT_UNREADABLE_REASON = "could not read the sponsor agreement contract just now, so this subscription was not sent: try again in a moment";

export interface CurrentAgreement {
  address: Address;
  version: bigint;
  hash: `0x${string}`;
}

/**
 * The agreement a new subscriber must accept: null when the feature is off or nothing is published. Throws when the
 * contract cannot be read, so the caller refuses rather than letting a subscription through unaccepted. Shared for
 * READ_CACHE_MS: it changes only when the curator publishes a new version.
 */
export function currentAgreement(): Promise<CurrentAgreement | null> {
  const address = config.feeMarketAgreements;
  if (!address) return Promise.resolve(null);
  return cached(`agreement:${address.toLowerCase()}`, config.policy.readCacheMs, async () => {
    const [version, hash] = (await publicClient.readContract({ address, abi: feeMarketAgreementsAbi, functionName: "current" })) as readonly [bigint, `0x${string}`, string];
    return version === 0n ? null : { address, version, hash };
  });
}

/** Is this call addressed to the agreements contract's `accept`? (Nothing is decoded yet.) */
export function isAcceptCall(exec: Execution): boolean {
  const address = config.feeMarketAgreements;
  return !!address && exec.target.toLowerCase() === address.toLowerCase() && size(exec.callData) >= 4 && slice(exec.callData, 0, 4).toLowerCase() === ACCEPT_SELECTOR.toLowerCase();
}

/**
 * Checks the acceptance call that precedes subscribe: the right contract and function, no value, the plan that is being
 * subscribed to, and the text that is current. The signature is not checked here: the contract does that, and a bad one
 * makes the whole batch revert in the node's simulation before any gas is spent.
 */
export function validateAcceptCall(exec: Execution, planId: bigint, agreement: CurrentAgreement): { ok: true } | { ok: false; reason: string } {
  if (!isAcceptCall(exec)) return { ok: false, reason: AGREEMENT_REQUIRED_REASON };
  if (exec.value !== 0n) return { ok: false, reason: "the agreement acceptance call must not send value" };
  let args: readonly [bigint, `0x${string}`, `0x${string}`];
  try {
    args = decodeFunctionData({ abi: feeMarketAgreementsAbi, data: exec.callData }).args as never;
  } catch {
    return { ok: false, reason: "the agreement acceptance call could not be decoded" };
  }
  const [acceptedPlan, hash, signature] = args;
  if (size(signature) > 512) return { ok: false, reason: "the agreement acceptance carries an oversized signature" };
  if (acceptedPlan !== planId) return { ok: false, reason: AGREEMENT_WRONG_PLAN_REASON };
  if (hash.toLowerCase() !== agreement.hash.toLowerCase()) return { ok: false, reason: AGREEMENT_STALE_REASON };
  return { ok: true };
}
