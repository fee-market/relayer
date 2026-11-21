import { cached } from "../lib/cache.js";
import { type Address, toFunctionSelector } from "viem";
import { config, PricingModel } from "../config.js";
import { feeMarketRegistryAbi } from "../abi.js";
import { publicClient } from "../lib/clients.js";

export interface Subscription {
  planId: bigint;
  user: Address;
  balance: bigint;
  txnsRemaining: bigint;
  expiry: bigint;
}

export interface Plan {
  sponsorId: bigint;
  model: PricingModel;
  paymentToken: Address;
  price: bigint;
  quota: bigint;
  period: bigint;
  caveatsHash: `0x${string}`;
  active: boolean;
}

export async function getEarnings(token: Address): Promise<bigint> {
  return (await publicClient.readContract({
    address: config.feeMarketRegistry,
    abi: feeMarketRegistryAbi,
    functionName: "earnings",
    args: [config.sponsorId, token],
  })) as bigint;
}

export async function getSponsorStatus(): Promise<{ status: number; active: boolean; payout: Address; metadataURI: string }> {
  const s = (await publicClient.readContract({
    address: config.feeMarketRegistry,
    abi: feeMarketRegistryAbi,
    functionName: "sponsors",
    args: [config.sponsorId],
  })) as readonly [Address, Address, string, number, boolean];
  return { payout: s[0], metadataURI: s[2], status: s[3], active: s[4] };
}

export async function getSubscription(id: bigint): Promise<Subscription> {
  const r = (await publicClient.readContract({
    address: config.feeMarketRegistry,
    abi: feeMarketRegistryAbi,
    functionName: "subscriptions",
    args: [id],
  })) as readonly [bigint, Address, bigint, bigint, bigint];
  return { planId: r[0], user: r[1], balance: r[2], txnsRemaining: r[3], expiry: r[4] };
}

/** Plans change rarely (only `active` flips), and every request for a plan reads it: share one read for READ_CACHE_MS.
 * Subscriptions are deliberately NOT cached: their balance changes with every charge. */
export function getPlan(id: bigint): Promise<Plan> {
  return cached(`plan:${config.feeMarketRegistry}:${id}`, config.policy.readCacheMs, () => readPlan(id));
}

async function readPlan(id: bigint): Promise<Plan> {
  const r = (await publicClient.readContract({
    address: config.feeMarketRegistry,
    abi: feeMarketRegistryAbi,
    functionName: "plans",
    args: [id],
  })) as readonly [bigint, number, Address, bigint, bigint, bigint, `0x${string}`, boolean];
  return {
    sponsorId: r[0],
    model: r[1] as PricingModel,
    paymentToken: r[2],
    price: r[3],
    quota: r[4],
    period: r[5],
    caveatsHash: r[6],
    active: r[7],
  };
}

/** True once the subscription was closed (refund claimed, or left with nothing to refund). Registries deployed before
 * the end-state existed have no such getter: for them the call reverts and the escrow check below is what stops it. */
export async function isSubscriptionEnded(id: bigint): Promise<boolean> {
  try {
    return (await publicClient.readContract({ address: config.feeMarketRegistry, abi: feeMarketRegistryAbi, functionName: "subscriptionEnded", args: [id] })) as boolean;
  } catch {
    return false;
  }
}

/**
 * Is `account` currently in this sponsor's relayer set? null when the registry predates relayer sets. Read through the
 * short-lived cache: it is checked on every request that relies on the sponsor-level lock.
 */
export function isSponsorRelayer(account: Address): Promise<boolean | null> {
  return cached(`isRelayer:${account.toLowerCase()}`, config.policy.readCacheMs, async () => {
    try {
      return (await publicClient.readContract({ address: config.feeMarketRegistry, abi: feeMarketRegistryAbi, functionName: "isRelayer", args: [config.sponsorId, account] })) as boolean;
    } catch {
      return null;
    }
  });
}

/** The registry's own words for why `chargeUsage` would revert, keyed by error selector (what `canSponsor` returns). */
const CAN_SPONSOR_REASONS: Record<string, string> = Object.fromEntries(
  ([
    ["NotSubscriber()", "delegator is not the subscriber"],
    ["SubscriptionAlreadyEnded()", "subscription has ended"],
    ["InvalidAmount()", "invalid amount"],
    ["RegistryHalted()", "the registry is halted by its curator"],
    ["NotVerified()", "this sponsor is not verified"],
    ["SponsorPaused()", "this sponsor is paused"],
    ["QuotaExceeded()", "subscription quota exhausted"],
    ["SubscriptionExpired()", "subscription expired"],
    ["InsufficientBalance()", "insufficient escrow for one txn"],
  ] as const).map(([sig, text]) => [toFunctionSelector(sig), text]),
);

/**
 * Asks the registry whether `chargeUsage(subscriptionId, 1)` would succeed for `user` right now: ONE eth_call that mirrors
 * every precondition of the real call, so this node cannot drift from the contract. Returns null when the registry has no
 * `canSponsor` (a registry deployed before it existed): the caller then falls back to its own checks.
 */
export async function canSponsor(subscriptionId: bigint, user: Address): Promise<{ ok: true } | { ok: false; reason: string } | null> {
  try {
    const [ok, reason] = (await publicClient.readContract({
      address: config.feeMarketRegistry,
      abi: feeMarketRegistryAbi,
      functionName: "canSponsor",
      args: [subscriptionId, user, 1n],
    })) as readonly [boolean, `0x${string}`];
    if (ok) return { ok: true };
    return { ok: false, reason: CAN_SPONSOR_REASONS[reason.toLowerCase()] ?? `the registry would refuse this charge (${reason})` };
  } catch {
    return null;
  }
}

/**
 * Confirm a subscription can fund exactly one more sponsored op under this sponsor's plan.
 * Returns the resolved plan/subscription so the caller can avoid re-reading.
 */
export async function checkSubscriptionFunds(
  subscriptionId: bigint,
): Promise<{ ok: true; plan: Plan; sub: Subscription } | { ok: false; reason: string }> {
  const sub = await getSubscription(subscriptionId);
  if (sub.user === "0x0000000000000000000000000000000000000000") {
    return { ok: false, reason: "unknown subscription" };
  }
  const plan = await getPlan(sub.planId);

  if (!plan.active) return { ok: false, reason: "plan inactive" };
  if (plan.sponsorId !== config.sponsorId) {
    return { ok: false, reason: "subscription belongs to a different sponsor" };
  }
  // The registry's own answer is authoritative where it has one (halt, pause, verification, quota, expiry, escrow, all in
  // one call). The checks below are the fallback for a registry without `canSponsor`.
  const verdict = await canSponsor(subscriptionId, sub.user);
  if (verdict) return verdict.ok ? { ok: true, plan, sub } : verdict;
  // Every model charges out of the escrow, so nothing can be paid for once it is empty (an ended subscription
  // always is). Reject here rather than letting the sponsor pay gas for a charge that reverts.
  if (sub.balance === 0n) return { ok: false, reason: "subscription has no escrow left" };
  if (await isSubscriptionEnded(subscriptionId)) return { ok: false, reason: "subscription has ended" };

  switch (plan.model) {
    case PricingModel.PER_TXN:
      if (sub.balance < plan.price) return { ok: false, reason: "insufficient escrow for one txn" };
      break;
    case PricingModel.BULK:
      if (sub.txnsRemaining < 1n) return { ok: false, reason: "bulk quota exhausted" };
      break;
    case PricingModel.SUBSCRIPTION:
      if (sub.expiry !== 0n && BigInt(Math.floor(Date.now() / 1000)) > sub.expiry) {
        return { ok: false, reason: "subscription expired" };
      }
      if (plan.quota !== 0n && sub.txnsRemaining < 1n) {
        return { ok: false, reason: "subscription quota exhausted" };
      }
      break;
  }
  return { ok: true, plan, sub };
}
