/**
 * Offline tests for the abuse and capacity controls (no chain): limiter, per-key locks, idempotent replay, the
 * bounded concurrency gate, and the whole pipeline through real HTTP with a stub handler.
 *   npm run test:abuse
 */
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import express from "express";
import { z } from "zod";

process.env.RPC_URL ??= "http://127.0.0.1:9";
process.env.CHAIN_ID ??= "137";
process.env.STATE_DIR = "";
process.env.RELAYER_PRIVATE_KEY ??= "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
process.env.DELEGATION_MANAGER ??= "0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3";
process.env.DELEGATOR_IMPLEMENTATION ??= "0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B";
process.env.FEE_MARKET_REGISTRY ??= "0x57e6742610229c7Ce09df3028471397DaaE6B9f4";
process.env.REDEEMER_RESTRICTION_ENFORCER ??= "0x5C75d7ee6d3d27634bec15e96538e794F9c7053b";
process.env.SPONSOR_ID ??= "1";
process.env.CLIENT_IP_HEADER = "cf-connecting-ip";
process.env.RATE_LIMIT_DELEGATOR_MAX = "3";
process.env.MAX_CONCURRENT_SPONSORED = "2";
process.env.MAX_QUEUED_SPONSORED = "1";

const { Limiter, KeyedLocks, Idempotency, Gate, fingerprint, locks, idempotency } = await import("../src/services/abuse.js");
const { HttpError } = await import("../src/services/guard.js");
const { cached, _clearCache } = await import("../src/lib/cache.js");
const { clientIp, errorHandler } = await import("../src/middleware.js");
const { sponsoredEndpoint } = await import("../src/services/pipeline.js");

let passed = 0;
let total = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  total++;
  try { await fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); process.exitCode = 1; }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------------------------------------ limiter
await test("limiter: allows up to max per window, then refuses, then resets", () => {
  const l = new Limiter(() => ({ windowMs: 1000, max: 2 }));
  assert.equal(l.allow("a", 0), true);
  assert.equal(l.allow("a", 10), true);
  assert.equal(l.allow("a", 20), false);
  assert.equal(l.allow("b", 20), true, "another key has its own budget");
  assert.equal(l.allow("a", 1001), true, "a new window");
});
await test("limiter: max 0 turns it off", () => {
  const l = new Limiter(() => ({ windowMs: 1000, max: 0 }));
  for (let i = 0; i < 50; i++) assert.equal(l.allow("a", i), true);
});
await test("limiter: memory is bounded (expired windows are swept)", () => {
  const l = new Limiter(() => ({ windowMs: 10, max: 1 }));
  for (let i = 0; i < 10_050; i++) l.allow(`k${i}`, 0);
  l.allow("late", 1_000); // size > 10k and everything expired -> swept
  assert.ok(l.size() < 100, `entries after sweep: ${l.size()}`);
});

// --------------------------------------------------------------------------------------------- real IP
await test("clientIp: uses the configured edge header (first hop), else the socket address", () => {
  assert.equal(clientIp({ headers: { "cf-connecting-ip": "203.0.113.9, 10.0.0.1" }, ip: "10.0.0.1" } as never), "203.0.113.9");
  assert.equal(clientIp({ headers: {}, ip: "10.0.0.1" } as never), "10.0.0.1");
  assert.equal(clientIp({ headers: {} } as never), "unknown");
});

// ------------------------------------------------------------------------------------------------ locks
await test("locks: one holder at a time per key; release lets the next in; keys are independent", () => {
  const k = new KeyedLocks();
  const r1 = k.acquire("sub:1", 0)!;
  assert.ok(r1);
  assert.equal(k.acquire("sub:1", 1), null);
  assert.ok(k.acquire("sub:2", 1), "another subscription is unaffected");
  r1();
  assert.ok(k.acquire("sub:1", 2));
});
await test("locks: a leaked lock is taken over after the stale window instead of wedging the subscription", () => {
  const k = new KeyedLocks(1000);
  k.acquire("s", 0);
  assert.equal(k.acquire("s", 999), null);
  assert.ok(k.acquire("s", 1001));
});
await test("locks: a stale holder releasing late does not free the new holder's lock", () => {
  const k = new KeyedLocks(1000);
  const old = k.acquire("s", 0)!;
  const fresh = k.acquire("s", 1500)!;
  old();
  assert.equal(k.acquire("s", 1501), null, "still held by the new owner");
  fresh();
  assert.ok(k.acquire("s", 1502));
});

// ------------------------------------------------------------------------------------------ idempotency
const req = (over: Partial<{ delegator: string; salt: string; signature: string; data: string }> = {}) => ({
  delegations: [{ delegator: over.delegator ?? "0xAbC0000000000000000000000000000000000001", salt: over.salt ?? "1", signature: over.signature ?? "0xaa" }],
  executionCallData: over.data ?? "0x1234",
});
await test("fingerprint: stable, case-insensitive on the address, and different for any other change", () => {
  const f = fingerprint(req());
  assert.equal(fingerprint(req()), f);
  assert.equal(fingerprint(req({ delegator: "0xabc0000000000000000000000000000000000001" })), f);
  for (const o of [{ salt: "2" }, { signature: "0xbb" }, { data: "0x5678" }, { delegator: "0xabc0000000000000000000000000000000000002" }]) {
    assert.notEqual(fingerprint(req(o)), f, JSON.stringify(o));
  }
});
await test("idempotency: new -> inflight -> done replays the original answer; abort lets a retry run", () => {
  const i = new Idempotency(() => 1000);
  assert.deepEqual(i.begin("x", 0), { state: "new" });
  assert.deepEqual(i.begin("x", 1), { state: "inflight" });
  i.finish("x", { status: 200, body: { ok: true, redeemTx: "0x1" } }, 2);
  assert.deepEqual(i.begin("x", 3), { state: "done", response: { status: 200, body: { ok: true, redeemTx: "0x1" } } });
  assert.deepEqual(i.begin("y", 0), { state: "new" });
  i.abort("y");
  assert.deepEqual(i.begin("y", 1), { state: "new" }, "an aborted attempt can be retried");
});
await test("idempotency: an answer is forgotten after the TTL", () => {
  const i = new Idempotency(() => 1000);
  i.begin("x", 0);
  i.finish("x", { status: 200, body: {} }, 0);
  assert.equal(i.begin("x", 1001).state, "new");
});
await test("idempotency: it cannot grow without bound", () => {
  const i = new Idempotency(() => 1_000_000);
  for (let n = 0; n < 6000; n++) i.begin(`k${n}`, n);
  assert.ok(i.size() <= 5000, `size ${i.size()}`);
});

// -------------------------------------------------------------------------------------------------- gate
await test("gate: runs at most N at once, queues up to M, then refuses with 503 + Retry-After", async () => {
  const g = new Gate(() => ({ concurrent: 2, queued: 1 }));
  let running = 0, peak = 0;
  const job = async () => { running++; peak = Math.max(peak, running); await sleep(60); running--; return "ok"; };
  const results = await Promise.allSettled([g.run(job), g.run(job), g.run(job), g.run(job)]);
  const ok = results.filter((r) => r.status === "fulfilled").length;
  const refused = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
  assert.equal(ok, 3, "2 running + 1 queued");
  assert.equal(refused.length, 1);
  assert.ok(refused[0].reason instanceof HttpError);
  assert.equal(refused[0].reason.status, 503);
  assert.equal(refused[0].reason.retryAfter, 5);
  assert.ok(peak <= 2, `never more than 2 at once (peak ${peak})`);
});
await test("gate: a failing job frees its slot", async () => {
  const g = new Gate(() => ({ concurrent: 1, queued: 0 }));
  await assert.rejects(g.run(async () => { throw new Error("boom"); }));
  assert.equal(await g.run(async () => "next"), "next");
  assert.equal(g.active(), 0);
});

// ------------------------------------------------------------------------------------------------- cache
await test("cache: concurrent callers share ONE underlying call (single-flight)", async () => {
  _clearCache();
  let calls = 0;
  const fn = async () => { calls++; await sleep(40); return calls; };
  const out = await Promise.all(Array.from({ length: 25 }, () => cached("k1", 1000, fn)));
  assert.equal(calls, 1);
  assert.ok(out.every((v) => v === 1));
});
await test("cache: a value is reused within the TTL and re-read after it", async () => {
  _clearCache();
  let calls = 0;
  const fn = async () => ++calls;
  assert.equal(await cached("k2", 1000, fn, 0), 1);
  assert.equal(await cached("k2", 1000, fn, 500), 1, "within the TTL");
  assert.equal(await cached("k2", 1000, fn, Date.now() + 5000), 2, "after the TTL");
});
await test("cache: errors are never cached, and ttl 0 means no caching at all", async () => {
  _clearCache();
  let n = 0;
  const flaky = async () => { if (++n === 1) throw new Error("rpc down"); return "ok"; };
  await assert.rejects(cached("k3", 1000, flaky));
  assert.equal(await cached("k3", 1000, flaky), "ok", "the failure was not remembered");
  let m = 0;
  await cached("k4", 0, async () => ++m);
  await cached("k4", 0, async () => ++m);
  assert.equal(m, 2);
});

// ------------------------------------------------------------------------------- the pipeline over HTTP
const schema = z.object({
  delegations: z.array(z.object({ delegator: z.string(), salt: z.string(), signature: z.string() })).min(1),
  executionCallData: z.string(),
  subscriptionId: z.string().default("1"),
});
let handlerCalls = 0;
let nextOutcome: "ok" | "reject" | "pending" | "slow" = "ok";
const app = express();
app.use(express.json());
app.post("/x", sponsoredEndpoint(
  schema,
  (d) => `sub:${d.subscriptionId}`,
  async (_d, _delegator, res) => {
    handlerCalls++;
    if (nextOutcome === "slow") await sleep(150);
    if (nextOutcome === "reject") return void res.status(422).json({ ok: false, error: "nope" });
    if (nextOutcome === "pending") return void res.status(504).json({ ok: false, pending: true, redeemTx: "0xpend" });
    res.json({ ok: true, redeemTx: `0xhash${handlerCalls}` });
  },
  async () => {}, // no chain here: skip the balance/RPC pre-check
));
app.use(errorHandler);
const server = app.listen(0);
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const body = (o: Partial<{ delegator: string; salt: string; sub: string }> = {}) => JSON.stringify({
  delegations: [{ delegator: o.delegator ?? "0xaaaa000000000000000000000000000000000001", salt: o.salt ?? "1", signature: "0xsig" }],
  executionCallData: "0xdata",
  subscriptionId: o.sub ?? "1",
});
const post = (b: string) => fetch(`${base}/x`, { method: "POST", headers: { "content-type": "application/json" }, body: b });
const reset = () => { handlerCalls = 0; nextOutcome = "ok"; };

await test("pipeline: a malformed body is a 400 and never reaches the handler", async () => {
  reset();
  assert.equal((await post("{}")).status, 400);
  assert.equal(handlerCalls, 0);
});
await test("pipeline: a retry of an answered request replays the ORIGINAL answer without running it again", async () => {
  reset();
  const b = body({ delegator: "0xbbbb000000000000000000000000000000000001", salt: "r1" });
  const first = await post(b);
  const again = await post(b);
  assert.equal(first.status, 200);
  assert.equal(again.status, 200);
  assert.deepEqual(await again.json(), await first.json());
  assert.equal(again.headers.get("x-idempotent-replay"), "true");
  assert.equal(first.headers.get("x-idempotent-replay"), null);
  assert.equal(handlerCalls, 1, "the second request did not spend gas");
});
await test("pipeline: a 'sent, not confirmed yet' answer is replayed too (the retry gets the hash, no second send)", async () => {
  reset();
  nextOutcome = "pending";
  const b = body({ delegator: "0xcccc000000000000000000000000000000000001", salt: "p1" });
  const first = await post(b);
  const again = await post(b);
  assert.equal(first.status, 504);
  assert.equal(again.status, 504);
  assert.equal(((await again.json()) as { redeemTx: string }).redeemTx, "0xpend");
  assert.equal(handlerCalls, 1);
});
await test("pipeline: a rejection is NOT remembered, so the user can fix things and try again", async () => {
  reset();
  nextOutcome = "reject";
  const b = body({ delegator: "0xdddd000000000000000000000000000000000001", salt: "x1" });
  assert.equal((await post(b)).status, 422);
  nextOutcome = "ok";
  assert.equal((await post(b)).status, 200);
  assert.equal(handlerCalls, 2);
});
await test("pipeline: the same request arriving while the first is still running gets 409, not a second send", async () => {
  reset();
  nextOutcome = "slow";
  const b = body({ delegator: "0xeeee000000000000000000000000000000000001", salt: "s1", sub: "77" });
  const [first, second] = await Promise.all([post(b), (async () => { await sleep(30); return post(b); })()]);
  assert.equal(first.status, 200);
  assert.equal(second.status, 409);
  assert.equal(handlerCalls, 1);
});
await test("pipeline: two DIFFERENT requests for the same subscription cannot run in parallel (409), but can one after the other", async () => {
  reset();
  nextOutcome = "slow";
  const mk = (salt: string) => body({ delegator: "0xffff000000000000000000000000000000000001", salt, sub: "88" });
  const [a, b] = await Promise.all([post(mk("a")), (async () => { await sleep(30); return post(mk("b")); })()]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 409);
  assert.equal(locks.size(), 0, "the lock was released");
  nextOutcome = "ok";
  assert.equal((await post(mk("c"))).status, 200);
});
await test("pipeline: a user who keeps sending different requests hits the per-delegator budget (429 + Retry-After)", async () => {
  reset();
  const delegator = "0x1111000000000000000000000000000000000001";
  const statuses: number[] = [];
  let retryAfter: string | null = null;
  for (let i = 0; i < 5; i++) {
    const r = await post(body({ delegator, salt: `d${i}`, sub: `d${i}` }));
    statuses.push(r.status);
    if (r.status === 429) retryAfter = r.headers.get("retry-after");
  }
  assert.deepEqual(statuses, [200, 200, 200, 429, 429], "3 allowed per window, the rest refused");
  assert.equal(retryAfter, "60");
  assert.equal(handlerCalls, 3, "refused requests never reached the handler");
});
await test("pipeline: beyond the concurrency limit and queue the node answers 503 with Retry-After", async () => {
  reset();
  nextOutcome = "slow";
  const rs = await Promise.all(Array.from({ length: 5 }, (_, i) => post(body({ delegator: `0x22220000000000000000000000000000000000${10 + i}`, salt: `g${i}`, sub: `g${i}` }))));
  const statuses = rs.map((r) => r.status).sort();
  assert.deepEqual(statuses, [200, 200, 200, 503, 503], "2 running + 1 queued, 2 refused");
  const refused = rs.find((r) => r.status === 503)!;
  assert.equal(refused.headers.get("retry-after"), "5");
});

server.close();
console.log(`\n${passed}/${total} passed`);
if (passed !== total) process.exitCode = 1;
void idempotency;
