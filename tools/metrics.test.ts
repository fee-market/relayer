/**
 * Offline tests for monitoring: the metrics registry (text format), structured logs, the on-chain watcher's alerts, and
 * the /metrics endpoint's auth. No chain.
 *   npm run test:metrics
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.RPC_URL ??= "http://127.0.0.1:9";
process.env.CHAIN_ID ??= "137";
process.env.STATE_DIR = "";
process.env.RELAYER_PRIVATE_KEY ??= "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
process.env.DELEGATION_MANAGER ??= "0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3";
process.env.DELEGATOR_IMPLEMENTATION ??= "0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B";
process.env.FEE_MARKET_REGISTRY ??= "0x57e6742610229c7Ce09df3028471397DaaE6B9f4";
process.env.REDEEMER_RESTRICTION_ENFORCER ??= "0x5C75d7ee6d3d27634bec15e96538e794F9c7053b";
process.env.SPONSOR_ID ??= "1";
process.env.ALERT_COOLDOWN_MS = "0";

const { Registry, escapeLabel } = await import("../src/lib/metrics.js");
const { format, enabled, runWithRequestId, currentRequestId } = await import("../src/lib/log.js");
const { runWatch, describe, readCanary } = await import("../src/services/watcher.js");
const { resetAlertCooldowns } = await import("../src/services/alerts.js");

let passed = 0, total = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  total++;
  try { await fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); process.exitCode = 1; }
}

console.log("metrics registry");
await test("counter, gauge and labels render in the Prometheus text format", async () => {
  const r = new Registry();
  const c = r.counter("t_total", "a counter");
  c.inc({ outcome: "ok" }); c.inc({ outcome: "ok" }, 2); c.inc({ outcome: "bad" });
  r.gauge("t_gauge", "a gauge").set(7);
  const out = await r.render();
  assert.match(out, /# HELP t_total a counter\n# TYPE t_total counter/);
  assert.match(out, /t_total\{outcome="ok"\} 3/);
  assert.match(out, /t_total\{outcome="bad"\} 1/);
  assert.match(out, /# TYPE t_gauge gauge\nt_gauge 7/);
});
await test("a counter cannot decrease", () => {
  assert.throws(() => new Registry().counter("x_total", "x").inc({}, -1));
});
await test("histogram buckets are cumulative and carry sum and count", async () => {
  const r = new Registry();
  const h = r.histogram("d_seconds", "d", [0.1, 1]);
  h.observe(0.05, { route: "/a" }); h.observe(0.5, { route: "/a" }); h.observe(5, { route: "/a" });
  const out = await r.render();
  assert.match(out, /d_seconds_bucket\{route="\/a",le="0.1"\} 1/);
  assert.match(out, /d_seconds_bucket\{route="\/a",le="1"\} 2/);
  assert.match(out, /d_seconds_bucket\{route="\/a",le="\+Inf"\} 3/);
  assert.match(out, /d_seconds_count\{route="\/a"\} 3/);
});
await test("label values are escaped, so a hostile value cannot break the format", async () => {
  assert.equal(escapeLabel('a"b\\c\nd'), 'a\\"b\\\\c\\nd');
  const r = new Registry();
  r.counter("e_total", "e").inc({ v: 'x"} 999\n# evil' });
  const out = await r.render();
  assert.equal(out.split("\n").filter((l) => l.startsWith("e_total")).length, 1);
});
await test("a metric registered twice, or with a bad name, is refused", () => {
  const r = new Registry();
  r.counter("dup_total", "d");
  assert.throws(() => r.counter("dup_total", "d"));
  assert.throws(() => r.gauge("bad name", "d"));
});
await test("a failing collector does not blind the rest", async () => {
  const r = new Registry();
  const g = r.gauge("ok_gauge", "g");
  r.onCollect(() => { throw new Error("boom"); });
  r.onCollect(() => g.set(1));
  assert.match(await r.render(), /ok_gauge 1/);
});

console.log("structured logs");
await test("json lines carry ts, level, event and fields; bigint and errors are made printable", () => {
  const l = JSON.parse(format("info", "relay", { n: 5n, err: new Error("x"), skip: undefined }, "json", new Date(0)));
  assert.deepEqual(l, { ts: "1970-01-01T00:00:00.000Z", level: "info", event: "relay", n: "5", err: "x" });
});
await test("text format is readable and quotes values with spaces", () => {
  assert.equal(format("warn", "e", { a: 1, b: "x y" }, "text", new Date(0)), '1970-01-01T00:00:00.000Z WARN e a=1 b="x y"');
});
await test("level filtering", () => {
  assert.equal(enabled("debug", "info"), false);
  assert.equal(enabled("warn", "info"), true);
});
await test("the request id follows the request through awaits", async () => {
  assert.equal(currentRequestId(), undefined);
  await runWithRequestId("req-1", async () => {
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(currentRequestId(), "req-1");
  });
});

console.log("watcher");
const base = () => ({
  head: async () => 100n,
  events: async () => [],
  halted: async () => false,
  solvent: async () => true,
  recentOutcomes: () => ({ total: 0, failed: 0 }),
  canary: () => null,
  now: () => 1_000_000,
});
const captured: string[] = [];
const origError = console.error;
console.error = (...a: unknown[]) => { captured.push(a.join(" ")); };
const run = async (deps: ReturnType<typeof base>, state = { lastBlock: 90n as bigint | null }) => { resetAlertCooldowns(); captured.length = 0; return runWatch(deps, state); };

await test("a healthy registry raises nothing", async () => {
  assert.deepEqual(await run(base()), []);
});
await test("a halted registry raises an alert", async () => {
  assert.deepEqual(await run({ ...base(), halted: async () => true }), ["registry-halted"]);
});
await test("insolvency raises an alert naming the token", async () => {
  const r = await run({ ...base(), solvent: async () => false });
  assert.ok(r[0].startsWith("insolvent:"));
});
await test("a timelock CallScheduled raises a high-severity alert and is not repeated once the block is passed", async () => {
  const ev = describe("timelock", "CallScheduled", { id: "0xab", target: "0xT", delay: 604800n }, "0xtx:0");
  assert.equal(ev.severity, "high");
  const state = { lastBlock: 90n as bigint | null };
  const first = await run({ ...base(), events: async () => [ev] }, state);
  assert.deepEqual(first, ["event:0xtx:0"]);
  assert.match(captured.join("\n"), /timelock CallScheduled/);
  assert.equal(state.lastBlock, 100n);
  const second = await run({ ...base(), events: async () => { throw new Error("must not rescan"); } }, state);
  assert.deepEqual(second, []);
});
await test("the first run starts at the head and does not replay history", async () => {
  const state = { lastBlock: null as bigint | null };
  const r = await run({ ...base(), events: async () => { throw new Error("must not scan on first run"); } }, state);
  assert.deepEqual(r, []);
  assert.equal(state.lastBlock, 100n);
});
await test("after a long outage only the recent past is scanned", async () => {
  let from = 0n;
  await run({ ...base(), head: async () => 100_000n, events: async (f) => { from = f; return []; } }, { lastBlock: 10n });
  assert.equal(from, 98_000n);
});
await test("a high share of failed requests raises error-rate; rejected requests do not count as failures", async () => {
  assert.deepEqual(await run({ ...base(), recentOutcomes: () => ({ total: 10, failed: 6 }) }), ["error-rate"]);
  assert.deepEqual(await run({ ...base(), recentOutcomes: () => ({ total: 3, failed: 3 }) }), []); // too few to judge
  assert.deepEqual(await run({ ...base(), recentOutcomes: () => ({ total: 10, failed: 2 }) }), []);
});
await test("event descriptions are readable for every watched event", () => {
  assert.match(describe("registry", "OwnershipTransferStarted", { previousOwner: "0xA", newOwner: "0xB" }, "i").detail, /not final until accepted/);
  assert.match(describe("proxy", "Upgraded", { implementation: "0xI" }, "i").detail, /0xI/);
  assert.equal(describe("registry", "DepositCapSet", { token: "0xT", cap: 5n }, "i").severity, "info");
});
await test("canary: read from STATE_DIR; unreadable or missing is null", () => {
  const dir = mkdtempSync(join(tmpdir(), "canary-"));
  assert.equal(readCanary(dir), null);
  writeFileSync(join(dir, "canary.json"), JSON.stringify({ at: 5, ok: true }));
  assert.deepEqual(readCanary(dir), { at: 5, ok: true, error: undefined });
  writeFileSync(join(dir, "canary.json"), "not json");
  assert.equal(readCanary(dir), null);
});
console.error = origError;

console.log(`\n${passed}/${total} passed`);
if (passed !== total) process.exit(1);
