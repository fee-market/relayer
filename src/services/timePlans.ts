import type { Response } from "express";
import { encodeFunctionData, type Address, type Hex } from "viem";
import { config, PricingModel } from "../config.js";
import { getStoreSync } from "../lib/store.js";
import { logger } from "../lib/log.js";
import type { Plan } from "./registry.js";

/**
 * What a sponsor needs for TIME plans (the SUBSCRIPTION pricing model), which charge by the clock instead of by the send:
 *
 *  - a daily send budget per subscription, because sends cost the sponsor gas and earn it nothing extra;
 *  - a list of the time-plan subscriptions this node has served, so it can collect what they have accrued
 *    (`settleMany`) on a timer. The registry only moves accrued money to the sponsor's earnings when someone settles.
 *
 * Both are kept in the node's state file and are per node process: two nodes for the same sponsor each count their own
 * sends and each know only the subscriptions they served. The chain reads and the transaction are injected so the logic
 * is tested without a chain.
 */

export const isTimePlan = (plan: Pick<Plan, "model"> | undefined): boolean => plan?.model === PricingModel.SUBSCRIPTION;

const DAY_MS = 24 * 60 * 60 * 1000;

/** "3h 12m", "12m", or "under a minute". */
export function waitText(ms: number): string {
  const minutes = Math.ceil(ms / 60_000);
  if (minutes <= 1) return "under a minute";
  const h = Math.floor(minutes / 60), m = minutes % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

// ------------------------------------------------------------------------------------------- daily budget
export type BudgetVerdict = { ok: true } | { ok: false; reason: string; retryAfterSec: number };

/**
 * Sends per key over a rolling window. Holds at most `max` timestamps per key (older ones cannot matter) and at most
 * `maxKeys` keys (keys whose sends have all left the window are dropped first, then the least recently used).
 */
export class SendBudget {
  private sends = new Map<string, number[]>();
  constructor(private readonly max: () => number, private readonly windowMs = DAY_MS, private readonly maxKeys = 5000) {}

  private live(key: string, now: number): number[] {
    const kept = (this.sends.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (kept.length) this.sends.set(key, kept);
    else this.sends.delete(key);
    return kept;
  }

  /** May `key` have one more send now? Counts nothing. */
  check(key: string, now = Date.now()): BudgetVerdict {
    const max = this.max();
    if (max <= 0) return { ok: true }; // off
    const kept = this.live(key, now);
    if (kept.length < max) return { ok: true };
    // The send that has to leave the window before there is room again.
    const freesIn = kept[kept.length - max] + this.windowMs - now;
    return { ok: false, reason: `daily limit of ${max} sends for this time plan reached; next send in ${waitText(freesIn)}`, retryAfterSec: Math.max(1, Math.ceil(freesIn / 1000)) };
  }

  /** One send was broadcast for `key`. */
  count(key: string, now = Date.now()): void {
    const max = this.max();
    if (max <= 0) return;
    const kept = this.live(key, now);
    kept.push(now);
    this.sends.delete(key); // re-inserted last: the map's order is least recently used first
    this.sends.set(key, kept.slice(-max));
    if (this.sends.size > this.maxKeys) this.sweep(now);
  }

  used(key: string, now = Date.now()): number {
    return this.live(key, now).length;
  }

  private sweep(now: number): void {
    for (const key of [...this.sends.keys()]) this.live(key, now);
    for (const key of this.sends.keys()) {
      if (this.sends.size <= this.maxKeys) break;
      this.sends.delete(key);
    }
  }

  size(): number {
    return this.sends.size;
  }
  snapshot(): Record<string, number[]> {
    return Object.fromEntries(this.sends);
  }
  restore(saved: unknown, now = Date.now()): void {
    if (!saved || typeof saved !== "object") return;
    for (const [key, list] of Object.entries(saved as Record<string, unknown>)) {
      if (!Array.isArray(list)) continue;
      const kept = list.filter((t): t is number => typeof t === "number" && now - t < this.windowMs).sort((a, b) => a - b);
      if (kept.length) this.sends.set(key, kept);
    }
  }
}

// --------------------------------------------------------------------------------------- known subscriptions
/** Insertion-ordered, bounded set of subscription ids (as decimal strings). The oldest is dropped when full. */
export class KnownSubscriptions {
  private ids = new Set<string>();
  constructor(private readonly max = 5000) {}

  /** Returns true when the id was not known before. */
  add(id: string | bigint): boolean {
    const key = id.toString();
    if (this.ids.has(key)) return false;
    this.ids.add(key);
    if (this.ids.size > this.max) this.ids.delete(this.ids.values().next().value as string);
    return true;
  }
  delete(id: string | bigint): void {
    this.ids.delete(id.toString());
  }
  list(): bigint[] {
    return [...this.ids].map((s) => BigInt(s));
  }
  size(): number {
    return this.ids.size;
  }
  restore(saved: unknown): void {
    if (!Array.isArray(saved)) return;
    for (const s of saved) if (typeof s === "string" && /^\d{1,78}$/.test(s)) this.add(s);
  }
}

// --------------------------------------------------------------------------------------------------- settle
export interface SubscriptionSnapshot {
  sponsorId: bigint;
  paymentToken: Address;
  model: number;
  ended: boolean;
  pendingEarned: bigint;
}

export interface SettleDeps {
  halted(): Promise<boolean>;
  relayerBalance(): Promise<bigint>;
  details(id: bigint): Promise<SubscriptionSnapshot>;
  /** Sends registry.settleMany(ids) and waits for it; returns the transaction hash. */
  settleMany(ids: bigint[]): Promise<Hex>;
}

export interface SettleResult {
  /** Why nothing was sent, when nothing was. */
  skipped?: string;
  /** The skip is about right now (halted, low balance, chain unreadable): worth trying again before a whole interval has passed. */
  transient?: boolean;
  /** Subscriptions whose accrued earnings were moved, and the sum per payment token. */
  settled: bigint[];
  amounts: Record<string, bigint>;
  txs: Hex[];
  /** Subscriptions dropped from the list: closed with nothing left to collect, or not this sponsor's time plan. */
  dropped: bigint[];
  /** Chunks whose transaction failed; they are tried again on the next run. */
  failed: number;
}

export const SETTLE_CHUNK = 50;

/**
 * One settle pass over the known time-plan subscriptions. Never throws: a subscription that cannot be read is left for
 * the next run, and a chunk whose transaction fails is counted and left for the next run.
 */
export async function runSettle(deps: SettleDeps, known: KnownSubscriptions, opts: { sponsorId: bigint; minBalanceWei: bigint; chunk?: number }): Promise<SettleResult> {
  const out: SettleResult = { settled: [], amounts: {}, txs: [], dropped: [], failed: 0 };
  const ids = known.list();
  if (ids.length === 0) return { ...out, skipped: "no time-plan subscription has been served by this node yet" };
  try {
    if (await deps.halted()) return { ...out, transient: true, skipped: "the registry is halted" };
    const balance = await deps.relayerBalance();
    if (opts.minBalanceWei > 0n && balance < opts.minBalanceWei) return { ...out, transient: true, skipped: `the relayer balance ${balance} is below the minimum ${opts.minBalanceWei}` };
  } catch (e) {
    return { ...out, transient: true, skipped: `the chain could not be read (${(e as Error).message.split("\n")[0]})` };
  }

  const pending: { id: bigint; amount: bigint; token: string }[] = [];
  for (const id of ids) {
    let d: SubscriptionSnapshot;
    try {
      d = await deps.details(id);
    } catch {
      continue; // unreadable now: keep it for the next run
    }
    if (d.sponsorId !== opts.sponsorId || d.model !== PricingModel.SUBSCRIPTION || (d.ended && d.pendingEarned === 0n)) {
      known.delete(id);
      out.dropped.push(id);
      continue;
    }
    if (d.pendingEarned > 0n) pending.push({ id, amount: d.pendingEarned, token: d.paymentToken.toLowerCase() });
  }
  if (pending.length === 0) return { ...out, skipped: "nothing is pending" };

  const size = opts.chunk ?? SETTLE_CHUNK;
  for (let i = 0; i < pending.length; i += size) {
    const chunk = pending.slice(i, i + size);
    try {
      out.txs.push(await deps.settleMany(chunk.map((p) => p.id)));
      for (const p of chunk) {
        out.settled.push(p.id);
        out.amounts[p.token] = (out.amounts[p.token] ?? 0n) + p.amount;
      }
    } catch (e) {
      out.failed++;
      logger.warn("settle_chunk_failed", { subscriptions: chunk.length, error: (e as Error).message.split("\n")[0] });
    }
  }
  return out;
}

/** Earned but not yet settled, summed over the known subscriptions paid in `token`. Unreadable ones count as nothing. */
export async function pendingEarnings(details: SettleDeps["details"], known: KnownSubscriptions, token: Address): Promise<bigint> {
  let sum = 0n;
  const ids = known.list();
  for (let i = 0; i < ids.length; i += 20) {
    const rows = await Promise.all(ids.slice(i, i + 20).map((id) => details(id).catch(() => null)));
    for (const d of rows) if (d && d.paymentToken.toLowerCase() === token.toLowerCase()) sum += d.pendingEarned;
  }
  return sum;
}

// ------------------------------------------------------------------------------------- the node's own state
const store = getStoreSync(config.stateDir);
const saved = store.section<{ sends?: unknown; known?: unknown; lastSettleAt?: number }>("timePlans");

export const sendBudget = new SendBudget(() => config.policy.timePlanDailySends);
export const knownTimePlanSubs = new KnownSubscriptions();
sendBudget.restore(saved?.sends);
knownTimePlanSubs.restore(saved?.known);
let lastSettleAt = typeof saved?.lastSettleAt === "number" ? saved.lastSettleAt : 0;
store.register("timePlans", () => ({ sends: sendBudget.snapshot(), known: knownTimePlanSubs.list().map((id) => id.toString()), lastSettleAt }));

/** A subscription this node handled: remembered for settling when it is on a time plan. */
export function noteSubscription(subscriptionId: string | bigint | undefined, plan: Pick<Plan, "model"> | undefined): void {
  if (subscriptionId === undefined || !isTimePlan(plan)) return;
  if (knownTimePlanSubs.add(subscriptionId)) store.markDirty();
}

/** May this subscription have one more sponsored send today? Always yes for a plan that is not a time plan. */
export function sendBudgetCheck(subscriptionId: string | bigint, plan: Pick<Plan, "model"> | undefined, now = Date.now()): BudgetVerdict {
  return isTimePlan(plan) ? sendBudget.check(subscriptionId.toString(), now) : { ok: true };
}

/**
 * Refuses the request when the subscription's daily budget is used up: 429, a Retry-After header and the reason.
 * Returns the reason it answered with, or null when the send may go on (nothing was written to `res`).
 */
export function answerIfOverBudget(res: Response, subscriptionId: string | bigint, plan: Pick<Plan, "model"> | undefined, now = Date.now()): string | null {
  const budget = sendBudgetCheck(subscriptionId, plan, now);
  if (budget.ok) return null;
  res.setHeader("Retry-After", String(budget.retryAfterSec));
  res.status(429).json({ ok: false, error: budget.reason });
  return budget.reason;
}

/** A send for this subscription was broadcast (whatever became of it: the gas is spent either way). */
export function countSend(subscriptionId: string | bigint, plan: Pick<Plan, "model"> | undefined, now = Date.now()): void {
  if (!isTimePlan(plan)) return;
  sendBudget.count(subscriptionId.toString(), now);
  store.markDirty();
}

/** The real chain and the real transaction manager, loaded on first use (a test of the logic never needs them). */
export async function chainSettleDeps(): Promise<SettleDeps> {
  const { publicClient } = await import("../lib/clients.js");
  const { feeMarketRegistryAbi } = await import("../abi.js");
  const { relayerBalance } = await import("./guard.js");
  const { sendAndConfirm } = await import("../lib/txManager.js");
  const read = { address: config.feeMarketRegistry, abi: feeMarketRegistryAbi } as const;
  return {
    halted: () => publicClient.readContract({ ...read, functionName: "halted" }) as Promise<boolean>,
    relayerBalance: () => relayerBalance(),
    details: async (id) => {
      const d = (await publicClient.readContract({ ...read, functionName: "subscriptionDetails", args: [id] })) as SubscriptionSnapshot;
      return { sponsorId: d.sponsorId, paymentToken: d.paymentToken, model: Number(d.model), ended: d.ended, pendingEarned: d.pendingEarned };
    },
    settleMany: async (ids) => {
      const { hash, receipt } = await sendAndConfirm({ to: config.feeMarketRegistry, data: encodeFunctionData({ abi: feeMarketRegistryAbi, functionName: "settleMany", args: [ids] }) }, 120_000);
      if (receipt.status !== "success") throw new Error(`settleMany reverted (tx ${hash})`);
      return hash;
    },
  };
}

/** One pass with the node's own state, logged. Used by the timer; never throws. */
export async function settleNow(deps?: SettleDeps): Promise<SettleResult> {
  try {
    const result = await runSettle(deps ?? (await chainSettleDeps()), knownTimePlanSubs, { sponsorId: config.sponsorId, minBalanceWei: config.policy.minRelayerBalanceWei });
    // A skip that is about right now is tried again within the hour; everything else waits for the next interval.
    const every = config.policy.settleIntervalMs;
    lastSettleAt = result.transient ? Date.now() - every + Math.min(every, 60 * 60_000) : Date.now();
    store.markDirty();
    if (result.skipped) logger.info("settle_skipped", { reason: result.skipped, known: knownTimePlanSubs.size() });
    else logger.info("settle_done", { subscriptions: result.settled.length, txs: result.txs, failed: result.failed, amounts: Object.fromEntries(Object.entries(result.amounts).map(([t, a]) => [t, a.toString()])) });
    return result;
  } catch (e) {
    logger.error("settle_failed", { error: (e as Error).message });
    return { skipped: `failed: ${(e as Error).message}`, settled: [], amounts: {}, txs: [], dropped: [], failed: 0 };
  }
}

let timer: NodeJS.Timeout | null = null;
let running = false;

/**
 * Settles every SETTLE_INTERVAL_MS, counted from the last run (kept in the state file), so a restart neither skips a
 * day nor settles again at once. No-op when the interval is 0.
 */
export function startSettler(): void {
  const every = config.policy.settleIntervalMs;
  if (every <= 0 || timer) return;
  const due = async () => {
    if (running || Date.now() - lastSettleAt < every) return;
    running = true;
    try {
      await settleNow();
    } finally {
      running = false;
    }
  };
  timer = setInterval(() => void due(), Math.min(every, 10 * 60_000));
  timer.unref?.();
  const first = setTimeout(() => void due(), 30_000); // after startup has settled down
  first.unref?.();
  logger.info("settler_started", { intervalMs: every, known: knownTimePlanSubs.size() });
}

export function stopSettler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
