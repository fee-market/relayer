import { type Hex, keccak256, stringToHex } from "viem";
import { config } from "../config.js";
import { HttpError } from "./guard.js";

/**
 * Per-user and per-request controls that sit in front of the (expensive, gas-spending) sponsored path:
 *
 *  - Limiter:      a fixed-window budget per key (per IP, per delegator). Memory-bounded: expired windows are swept.
 *  - KeyedLocks:   one request at a time per subscription (or per user, for /subscribe). Two parallel requests for the
 *                  same subscription are how a user makes the sponsor pay gas for a charge that then reverts.
 *  - Idempotency:  a signed delegation is remembered. A wallet that gave up waiting and retries gets the ORIGINAL answer
 *                  back (same transaction hash) instead of a second, doomed redemption; one still being processed
 *                  answers 409.
 *  - Gate:         bounded concurrency plus a bounded queue. Beyond that the node says 503 + Retry-After, instead of
 *                  growing an unbounded backlog of requests that each hold a connection and RPC calls.
 */

// ------------------------------------------------------------------------------------------------ limiter
export interface LimiterOptions {
  windowMs: number;
  max: number;
}

export class Limiter {
  private hits = new Map<string, { count: number; resetAt: number }>();
  constructor(private readonly opts: () => LimiterOptions) {}

  /** True if `key` has used up its budget in the current window. Does not count anything. */
  isBlocked(key: string, now = Date.now()): boolean {
    const { max } = this.opts();
    if (max <= 0) return false; // off
    const e = this.hits.get(key);
    return !!e && now <= e.resetAt && e.count >= max;
  }

  /** Count one use of `key`'s budget without checking it (used to count failures, such as a wrong token). */
  hit(key: string, now = Date.now()): void {
    const { windowMs, max } = this.opts();
    if (max <= 0) return;
    if (this.hits.size > 10_000) this.sweep(now);
    const e = this.hits.get(key);
    if (!e || now > e.resetAt) this.hits.set(key, { count: 1, resetAt: now + windowMs });
    else e.count++;
  }

  /** Seconds until `key`'s window ends (for Retry-After). */
  retryAfterSec(key: string, now = Date.now()): number {
    const e = this.hits.get(key);
    return e ? Math.max(1, Math.ceil((e.resetAt - now) / 1000)) : 1;
  }

  /** True if `key` may proceed (and counts it). */
  allow(key: string, now = Date.now()): boolean {
    const { windowMs, max } = this.opts();
    if (max <= 0) return true; // off
    if (this.hits.size > 10_000) this.sweep(now);
    const e = this.hits.get(key);
    if (!e || now > e.resetAt) {
      this.hits.set(key, { count: 1, resetAt: now + windowMs });
      return true;
    }
    if (e.count >= max) return false;
    e.count++;
    return true;
  }

  private sweep(now: number): void {
    for (const [k, e] of this.hits) if (now > e.resetAt) this.hits.delete(k);
  }

  /** Test hook. */
  size(): number {
    return this.hits.size;
  }
}

export const ipLimiter = new Limiter(() => ({ windowMs: config.policy.rateLimitWindowMs, max: config.policy.rateLimitMax }));
/** Failed dashboard or metrics logins per IP: after 10 wrong tokens in 15 minutes the IP is locked out for the rest of the window. */
export const authFailureLimiter = new Limiter(() => ({ windowMs: 15 * 60_000, max: 10 }));
/** Everything under /admin, per IP: the dashboard polls, so this is far more generous than the sponsored endpoints. */
export const adminLimiter = new Limiter(() => ({ windowMs: 60_000, max: 120 }));
export const delegatorLimiter = new Limiter(() => ({ windowMs: config.policy.rateLimitWindowMs, max: config.policy.rateLimitDelegatorMax }));

// ---------------------------------------------------------------------------------------------- key locks
export class KeyedLocks {
  private held = new Map<string, number>();
  constructor(private readonly staleMs = 120_000) {}

  /** Returns a release function, or null when `key` is already being processed. A lock older than `staleMs` is
   * treated as leaked (a bug must never wedge a subscription forever) and taken over. */
  acquire(key: string, now = Date.now()): (() => void) | null {
    const since = this.held.get(key);
    if (since !== undefined && now - since < this.staleMs) return null;
    this.held.set(key, now);
    return () => {
      if (this.held.get(key) === now) this.held.delete(key);
    };
  }

  size(): number {
    return this.held.size;
  }
}
export const locks = new KeyedLocks();

// ------------------------------------------------------------------------------------------- idempotency
export interface StoredResponse {
  status: number;
  body: unknown;
}
type Entry = { state: "inflight"; at: number } | { state: "done"; at: number; response: StoredResponse };

export class Idempotency {
  private entries = new Map<string, Entry>();
  private readonly max = 5000;
  constructor(private readonly ttlMs: () => number) {}

  /** 'new' = proceed (and it is now marked in flight); otherwise the earlier outcome. */
  begin(fp: string, now = Date.now()): { state: "new" } | { state: "inflight" } | { state: "done"; response: StoredResponse } {
    const e = this.entries.get(fp);
    if (e && now - e.at < this.ttlMs()) {
      return e.state === "done" ? { state: "done", response: e.response } : { state: "inflight" };
    }
    if (this.entries.size >= this.max) this.sweep(now);
    this.entries.set(fp, { state: "inflight", at: now });
    return { state: "new" };
  }

  /** Remember a successful (or pending) outcome so a retry replays it. */
  finish(fp: string, response: StoredResponse, now = Date.now()): void {
    this.entries.set(fp, { state: "done", at: now, response });
  }

  /** The attempt did not produce an outcome worth replaying (rejected, failed): let a retry run for real. */
  abort(fp: string): void {
    const e = this.entries.get(fp);
    if (e?.state === "inflight") this.entries.delete(fp);
  }

  private sweep(now: number): void {
    for (const [k, e] of this.entries) if (now - e.at >= this.ttlMs()) this.entries.delete(k);
    // still full of live entries: drop the oldest quarter rather than grow without bound
    if (this.entries.size >= this.max) {
      const oldest = [...this.entries.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, Math.ceil(this.max / 4));
      for (const [k] of oldest) this.entries.delete(k);
    }
  }

  size(): number {
    return this.entries.size;
  }
}
export const idempotency = new Idempotency(() => config.policy.idempotencyTtlMs);

/** What identifies "the same request": who signed it, with which salt and signature, for which batch. */
export function fingerprint(req: { delegations: { delegator: string; salt: string; signature: string }[]; executionCallData: string }): Hex {
  const leaf = req.delegations[req.delegations.length - 1];
  return keccak256(stringToHex(JSON.stringify([leaf.delegator.toLowerCase(), leaf.salt, leaf.signature, req.executionCallData])));
}

// ----------------------------------------------------------------------------------------------- gate
export class Gate {
  private running = 0;
  private queue: (() => void)[] = [];
  constructor(private readonly limits: () => { concurrent: number; queued: number }) {}

  /** Runs `fn` when a slot is free; waits in a bounded queue; throws 503 (with Retry-After) when the queue is full. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    const { concurrent, queued } = this.limits();
    if (concurrent > 0 && this.running >= concurrent) {
      if (this.queue.length >= queued) throw new HttpError(503, "this sponsor is busy, try again in a moment", 5);
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.running++;
    try {
      return await fn();
    } finally {
      this.running--;
      this.queue.shift()?.();
    }
  }

  active(): number {
    return this.running + this.queue.length;
  }
  stats() {
    return { running: this.running, queued: this.queue.length };
  }
}
export const gate = new Gate(() => ({ concurrent: config.policy.maxConcurrentSponsored, queued: config.policy.maxQueuedSponsored }));
