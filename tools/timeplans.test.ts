/**
 * Offline tests for what the node does for TIME plans (no chain): the daily send budget per subscription, the list of
 * time-plan subscriptions it has served, and the settle pass that collects what they have accrued.
 *   npm run test:timeplans
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import type { Address, Hex } from "viem";

const stateDir = mkdtempSync(join(tmpdir(), "timeplans-state-"));
process.env.RPC_URL ??= "http://127.0.0.1:9";
process.env.CHAIN_ID ??= "137";
process.env.STATE_DIR = stateDir;
process.env.RELAYER_PRIVATE_KEY ??= "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
process.env.DELEGATION_MANAGER ??= "0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3";
process.env.DELEGATOR_IMPLEMENTATION ??= "0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B";
process.env.FEE_MARKET_REGISTRY ??= "0x57e6742610229c7Ce09df3028471397DaaE6B9f4";
process.env.REDEEMER_RESTRICTION_ENFORCER ??= "0x5C75d7ee6d3d27634bec15e96538e794F9c7053b";
process.env.SPONSOR_ID = "1";
process.env.TIME_PLAN_DAILY_SENDS = "3";
process.env.SETTLE_INTERVAL_MS = "86400000";

const { config, PricingModel } = await import("../src/config.js");
const { StateStore, getStoreSync } = await import("../src/lib/store.js");
const {
  SendBudget, KnownSubscriptions, SETTLE_CHUNK, runSettle, pendingEarnings, waitText, isTimePlan,
  sendBudgetCheck, countSend, noteSubscription, answerIfOverBudget, knownTimePlanSubs, sendBudget,
} = await import("../src/services/timePlans.js");
type SettleDeps = import("../src/services/timePlans.js").SettleDeps;
type Snapshot = import("../src/services/timePlans.js").SubscriptionSnapshot;

let passed = 0;
let total = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  total++;
  try { await fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); process.exitCode = 1; }
}

const HOUR = 3_600_000, DAY = 24 * HOUR;
const TIME = { model: PricingModel.SUBSCRIPTION }, PER_TXN = { model: PricingModel.PER_TXN }, BULK = { model: PricingModel.BULK };
const USDC = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359" as Address, DAI = "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063" as Address;

// ------------------------------------------------------------------------------------------------ settings
await test("settings: 200 sends a day and a daily settle unless set otherwise; 0 turns either off", () => {
  assert.equal(config.policy.timePlanDailySends, 3, "read from TIME_PLAN_DAILY_SENDS");
  assert.equal(config.policy.settleIntervalMs, 86_400_000, "read from SETTLE_INTERVAL_MS");
  const src = readFileSync(new URL("../src/config.ts", import.meta.url), "utf8");
  assert.match(src, /env\("TIME_PLAN_DAILY_SENDS", "200"\)/);
  assert.match(src, /env\("SETTLE_INTERVAL_MS", "86400000"\)/);
});

// -------------------------------------------------------------------------------------------- daily budget
await test("budget: a subscription gets its sends, then is refused with the limit and when it frees up", () => {
  const b = new SendBudget(() => 3);
  const t0 = 1_800_000_000_000;
  for (let i = 0; i < 3; i++) {
    assert.deepEqual(b.check("7", t0 + i * 1000), { ok: true });
    b.count("7", t0 + i * 1000);
  }
  const no = b.check("7", t0 + 10_000);
  assert.equal(no.ok, false);
  if (no.ok) return;
  assert.equal(no.reason, "daily limit of 3 sends for this time plan reached; next send in 24h 0m");
  assert.equal(no.retryAfterSec, (DAY - 10_000) / 1000, "Retry-After is when the oldest send leaves the window");
  assert.deepEqual(b.check("8", t0 + 10_000), { ok: true }, "another subscription has its own budget");
});
await test("budget: the window rolls (it is not a calendar day): room comes back as each send turns 24 hours old", () => {
  const b = new SendBudget(() => 2);
  b.count("7", 0);
  b.count("7", 10 * HOUR);
  const at20h = b.check("7", 20 * HOUR + 48 * 60_000);
  assert.equal(at20h.ok, false);
  if (!at20h.ok) assert.equal(at20h.reason, "daily limit of 2 sends for this time plan reached; next send in 3h 12m");
  assert.deepEqual(b.check("7", DAY), { ok: true }, "the first send is 24 hours old");
  b.count("7", DAY);
  assert.equal(b.check("7", DAY + 1).ok, false, "and the second one still counts");
  assert.deepEqual(b.check("7", 34 * HOUR), { ok: true });
});
await test("budget: checking counts nothing, so a refused or failed request does not use the budget", () => {
  const b = new SendBudget(() => 1);
  for (let i = 0; i < 50; i++) assert.deepEqual(b.check("7", i), { ok: true });
  assert.equal(b.used("7", 50), 0);
});
await test("budget: 0 turns it off", () => {
  const b = new SendBudget(() => 0);
  for (let i = 0; i < 500; i++) { b.count("7", i); assert.deepEqual(b.check("7", i), { ok: true }); }
  assert.equal(b.size(), 0, "and nothing is stored");
});
await test("budget: memory is bounded, per subscription and across subscriptions", () => {
  const b = new SendBudget(() => 5, DAY, 100);
  for (let i = 0; i < 1000; i++) b.count("busy", i);
  assert.equal(b.snapshot().busy.length, 5, "only the sends that can matter are kept");
  for (let i = 0; i < 500; i++) b.count(`s${i}`, 2000 + i);
  assert.ok(b.size() <= 100, `subscriptions held: ${b.size()}`);
  assert.equal(b.used("s499", 3000), 1, "the most recent ones are the ones kept");
});
await test("budget: what was counted survives a restart; sends older than a day are not restored", () => {
  const before = new SendBudget(() => 2);
  before.count("7", 0); before.count("7", 1000); before.count("9", 500);
  const after = new SendBudget(() => 2);
  after.restore(JSON.parse(JSON.stringify(before.snapshot())), HOUR);
  assert.equal(after.check("7", HOUR).ok, false, "still used up after the restart");
  assert.deepEqual(after.check("9", HOUR), { ok: true });
  const late = new SendBudget(() => 2);
  late.restore(before.snapshot(), 2 * DAY);
  assert.equal(late.size(), 0);
  late.restore("garbage"); late.restore({ a: "x", b: [1, "2", null] }, 0);
  assert.deepEqual(late.snapshot(), { b: [1] }, "a damaged section is read as far as it makes sense");
});
await test("budget: the wait reads as hours and minutes", () => {
  assert.equal(waitText(3 * HOUR + 12 * 60_000), "3h 12m");
  assert.equal(waitText(12 * 60_000), "12m");
  assert.equal(waitText(61_000), "2m");
  assert.equal(waitText(20_000), "under a minute");
});

// ------------------------------------------------------------------------- the node's own budget and list
await test("only time plans are budgeted: per-transaction and bulk plans are charged per send already", () => {
  assert.ok(isTimePlan(TIME)); assert.ok(!isTimePlan(PER_TXN)); assert.ok(!isTimePlan(BULK)); assert.ok(!isTimePlan(undefined));
  for (let i = 0; i < 20; i++) { countSend("100", PER_TXN); countSend("101", BULK); }
  assert.deepEqual(sendBudgetCheck("100", PER_TXN), { ok: true });
  assert.deepEqual(sendBudgetCheck("101", BULK), { ok: true });
  assert.equal(sendBudget.used("100"), 0, "nothing is even counted for them");
});
await test("a time plan with a quota is budgeted the same as an unlimited one", () => {
  for (const [id, plan] of [["200", { model: PricingModel.SUBSCRIPTION, quota: 0n }], ["201", { model: PricingModel.SUBSCRIPTION, quota: 1000n }]] as const) {
    for (let i = 0; i < 3; i++) { assert.deepEqual(sendBudgetCheck(id, plan), { ok: true }); countSend(id, plan); }
    assert.equal(sendBudgetCheck(id, plan).ok, false);
  }
});
await test("over budget is answered 429 with Retry-After and the reason, before anything is spent", async () => {
  const app = express();
  let reached = 0;
  app.post("/relay/:id", (req, res) => {
    const plan = req.query.plan === "time" ? TIME : PER_TXN;
    const refused = answerIfOverBudget(res, String(req.params.id), plan);
    if (refused) return;
    reached++;
    countSend(String(req.params.id), plan); // the transaction was broadcast
    res.json({ ok: true });
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    for (let i = 0; i < 3; i++) assert.equal((await fetch(`${url}/relay/300?plan=time`, { method: "POST" })).status, 200);
    const res = await fetch(`${url}/relay/300?plan=time`, { method: "POST" });
    assert.equal(res.status, 429);
    const retry = Number(res.headers.get("retry-after"));
    assert.ok(retry > 86_000 && retry <= 86_400, `Retry-After ${retry}`);
    const body = (await res.json()) as { ok: boolean; error: string };
    assert.equal(body.ok, false);
    assert.ok(body.error.startsWith("daily limit of 3 sends for this time plan reached"), body.error);
    assert.equal(reached, 3, "the fourth request never reached the part that spends gas");
    for (let i = 0; i < 6; i++) assert.equal((await fetch(`${url}/relay/301?plan=pertxn`, { method: "POST" })).status, 200, "a per-transaction plan is not limited");
  } finally {
    server.close();
  }
});
await test("known subscriptions: only time plans are remembered, each once, and the list is bounded", () => {
  const start = knownTimePlanSubs.size();
  noteSubscription("400", TIME); noteSubscription(400n, TIME); noteSubscription("401", PER_TXN); noteSubscription("402", BULK); noteSubscription(undefined, TIME);
  assert.equal(knownTimePlanSubs.size(), start + 1);
  assert.ok(knownTimePlanSubs.list().includes(400n));
  const k = new KnownSubscriptions(3);
  for (const id of [1n, 2n, 3n, 4n]) k.add(id);
  assert.deepEqual(k.list(), [2n, 3n, 4n], "the oldest is dropped when it is full");
  assert.equal(k.add(4n), false);
  const r = new KnownSubscriptions();
  r.restore(["5", "6", 7, "x", "-1", null]); r.restore("garbage");
  assert.deepEqual(r.list(), [5n, 6n], "a damaged section is read as far as it makes sense");
});
await test("the budget and the list are written to the node's state file and read back after a restart", () => {
  const store = getStoreSync(config.stateDir);
  store.markDirty();
  store.flushSync();
  const reopened = new StateStore(stateDir).section<{ sends: Record<string, number[]>; known: string[]; lastSettleAt: number }>("timePlans")!;
  assert.equal(reopened.sends["300"].length, 3, "the three sends counted over HTTP above");
  assert.ok(reopened.known.includes("400"));
  const after = new SendBudget(() => 3);
  after.restore(reopened.sends);
  assert.equal(after.check("300").ok, false, "a restart does not hand the day's budget back");
  const known = new KnownSubscriptions();
  known.restore(reopened.known);
  assert.ok(known.list().includes(400n));
});

// --------------------------------------------------------------------------------------------------- settle
const row = (p: Partial<Snapshot> = {}): Snapshot => ({ sponsorId: 1n, paymentToken: USDC, model: PricingModel.SUBSCRIPTION, ended: false, pendingEarned: 0n, ...p });
function world(rows: Record<string, Snapshot | Error>, o: { halted?: boolean; balance?: bigint; failChunk?: number } = {}) {
  const calls: bigint[][] = [];
  const reads: bigint[] = [];
  const deps: SettleDeps = {
    halted: async () => o.halted ?? false,
    relayerBalance: async () => o.balance ?? 10n ** 18n,
    details: async (id) => {
      reads.push(id);
      const r = rows[id.toString()];
      if (!r || r instanceof Error) throw r ?? new Error("unknown subscription");
      return r;
    },
    settleMany: async (ids) => {
      calls.push(ids);
      if (o.failChunk === calls.length) throw new Error("settleMany reverted");
      return `0x${calls.length.toString(16).padStart(64, "0")}` as Hex;
    },
  };
  return { deps, calls, reads };
}
const knownOf = (...ids: bigint[]) => { const k = new KnownSubscriptions(); for (const id of ids) k.add(id); return k; };
const OPTS = { sponsorId: 1n, minBalanceWei: 3n * 10n ** 17n };

await test("settle: what has accrued is collected in one call, and only for subscriptions with something pending", async () => {
  const w = world({ "1": row({ pendingEarned: 2_330_000n }), "2": row(), "3": row({ pendingEarned: 1_000_000n }) });
  const known = knownOf(1n, 2n, 3n);
  const r = await runSettle(w.deps, known, OPTS);
  assert.deepEqual(w.calls, [[1n, 3n]]);
  assert.deepEqual(r.settled, [1n, 3n]);
  assert.equal(r.amounts[USDC.toLowerCase()], 3_330_000n);
  assert.equal(r.skipped, undefined);
  assert.deepEqual(known.list(), [1n, 2n, 3n], "a subscription with nothing pending yet stays on the list");
});
await test("settle: nothing is sent when nothing is known, nothing is pending, the registry is halted, or the relayer is low", async () => {
  const none = world({});
  assert.match((await runSettle(none.deps, knownOf(), OPTS)).skipped!, /no time-plan subscription/);
  const idle = world({ "1": row(), "2": row() });
  assert.equal((await runSettle(idle.deps, knownOf(1n, 2n), OPTS)).skipped, "nothing is pending");
  const halted = world({ "1": row({ pendingEarned: 5n }) }, { halted: true });
  const h = await runSettle(halted.deps, knownOf(1n), OPTS);
  assert.equal(h.skipped, "the registry is halted"); assert.equal(h.transient, true);
  assert.deepEqual(halted.reads, [], "it does not even read the subscriptions");
  const low = world({ "1": row({ pendingEarned: 5n }) }, { balance: 10n ** 17n });
  const l = await runSettle(low.deps, knownOf(1n), OPTS);
  assert.match(l.skipped!, /below the minimum/); assert.equal(l.transient, true);
  for (const w of [none, idle, halted, low]) assert.deepEqual(w.calls, []);
  const off = world({ "1": row({ pendingEarned: 5n }) }, { balance: 0n });
  assert.deepEqual((await runSettle(off.deps, knownOf(1n), { sponsorId: 1n, minBalanceWei: 0n })).settled, [1n], "MIN_RELAYER_BALANCE off: no balance check");
});
await test("settle: a closed subscription with nothing left is dropped; one that closed with money pending is collected first", async () => {
  const w = world({ "1": row({ ended: true }), "2": row({ ended: true, pendingEarned: 7n }), "3": row({ sponsorId: 9n, pendingEarned: 7n }), "4": row({ model: PricingModel.PER_TXN }) });
  const known = knownOf(1n, 2n, 3n, 4n);
  const r = await runSettle(w.deps, known, OPTS);
  assert.deepEqual(r.dropped, [1n, 3n, 4n], "closed and empty, another sponsor's, and not a time plan");
  assert.deepEqual(w.calls, [[2n]]);
  assert.deepEqual(known.list(), [2n]);
});
await test("settle: at most 50 subscriptions per transaction", async () => {
  const rows: Record<string, Snapshot> = {};
  const ids: bigint[] = [];
  for (let i = 1n; i <= 120n; i++) { rows[i.toString()] = row({ pendingEarned: 1n }); ids.push(i); }
  const w = world(rows);
  const r = await runSettle(w.deps, knownOf(...ids), OPTS);
  assert.equal(SETTLE_CHUNK, 50);
  assert.deepEqual(w.calls.map((c) => c.length), [50, 50, 20]);
  assert.equal(r.txs.length, 3); assert.equal(r.settled.length, 120); assert.equal(r.amounts[USDC.toLowerCase()], 120n);
});
await test("settle: one failed transaction does not stop the others, and nothing throws", async () => {
  const rows: Record<string, Snapshot> = {};
  const ids: bigint[] = [];
  for (let i = 1n; i <= 120n; i++) { rows[i.toString()] = row({ pendingEarned: 1n }); ids.push(i); }
  const w = world(rows, { failChunk: 2 });
  const known = knownOf(...ids);
  const r = await runSettle(w.deps, known, OPTS);
  assert.equal(r.failed, 1); assert.equal(r.settled.length, 70); assert.equal(r.txs.length, 2);
  assert.equal(known.size(), 120, "the failed ones stay on the list for the next run");
});
await test("settle: a subscription that cannot be read now is kept for the next run", async () => {
  const w = world({ "1": new Error("rpc timeout"), "2": row({ pendingEarned: 9n }) });
  const known = knownOf(1n, 2n);
  const r = await runSettle(w.deps, known, OPTS);
  assert.deepEqual(r.settled, [2n]); assert.deepEqual(r.dropped, []); assert.deepEqual(known.list(), [1n, 2n]);
  const broken: SettleDeps = { ...w.deps, halted: async () => { throw new Error("rpc down"); } };
  const b = await runSettle(broken, known, OPTS);
  assert.match(b.skipped!, /could not be read/); assert.equal(b.transient, true);
});
await test("dashboard: earned but not settled is summed per payment token, and an unreadable subscription counts as nothing", async () => {
  const w = world({ "1": row({ pendingEarned: 2_000_000n }), "2": row({ pendingEarned: 330_000n }), "3": row({ paymentToken: DAI, pendingEarned: 10n ** 18n }), "4": new Error("rpc") });
  const known = knownOf(1n, 2n, 3n, 4n);
  assert.equal(await pendingEarnings(w.deps.details, known, USDC), 2_330_000n);
  assert.equal(await pendingEarnings(w.deps.details, known, DAI), 10n ** 18n);
  assert.equal(await pendingEarnings(w.deps.details, knownOf(), USDC), 0n);
  const page = readFileSync(new URL("../src/public/dashboard.html", import.meta.url), "utf8");
  assert.match(page, /Earned, not settled yet/);
  assert.match(page, /pendingTimePlanEarnings/);
});

console.log(`\n${passed}/${total} passed`);
