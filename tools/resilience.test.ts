/**
 * Crash safety and RPC resilience, on a real local chain (anvil) behind counting proxies:
 *   - the state file round-trips bigint, survives a corrupt file, and holds in-flight transactions
 *   - a "restart" re-adopts a stuck transaction and still replaces it; mined ones are forgotten
 *   - dashboard counters survive a restart
 *   - a dead provider is skipped (reads and sends), and a send goes to EVERY live provider
 *   - receipt polling load does not grow with the number of waiting requests
 *   npm run test:resilience     (needs foundry's `anvil`; skips with a notice if missing)
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Address } from "viem";

if (spawnSync("anvil", ["--version"]).error) {
  console.log("SKIPPED: anvil is not installed (install foundry to run this suite)");
  process.exit(0);
}

const PORT = 8621;
const anvil = spawn("anvil", ["--port", String(PORT), "--silent"], { stdio: "ignore" });
process.on("exit", () => anvil.kill());
const chainUrl = `http://127.0.0.1:${PORT}`;
const raw = async (method: string, params: unknown[] = []) => {
  const r = await fetch(chainUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  return ((await r.json()) as { result?: unknown }).result;
};
for (let i = 0; i < 50; i++) {
  try { await raw("eth_chainId"); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
}

/** A provider in front of anvil that counts what it is asked. */
function proxy(): Promise<{ url: string; server: Server; calls: Map<string, number>; reset(): void }> {
  const calls = new Map<string, number>();
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      try {
        const j = JSON.parse(body) as { method: string; params?: unknown[] };
        const key = j.method === "eth_getTransactionCount" ? `${j.method}:${String(j.params?.[1])}` : j.method;
        calls.set(key, (calls.get(key) ?? 0) + 1);
        const r = await fetch(chainUrl, { method: "POST", headers: { "content-type": "application/json" }, body });
        res.setHeader("content-type", "application/json").end(await r.text());
      } catch (e) {
        res.statusCode = 502;
        res.end(String(e));
      }
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server, calls, reset: () => calls.clear() })),
  );
}
const a = await proxy();
const b = await proxy();
const DEAD = "http://127.0.0.1:9"; // nothing listens here
const dir = mkdtempSync(join(tmpdir(), "relayer-state-"));

process.env.RPC_URL = DEAD; // the preferred provider is down...
process.env.RPC_URLS = `${a.url},${b.url}`; // ...and two live ones follow
process.env.CHAIN_ID = "31337";
process.env.STATE_DIR = dir;
process.env.RELAYER_PRIVATE_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"; // anvil #1
process.env.DELEGATION_MANAGER ??= "0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3";
process.env.DELEGATOR_IMPLEMENTATION ??= "0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B";
process.env.FEE_MARKET_REGISTRY ??= "0x57e6742610229c7Ce09df3028471397DaaE6B9f4";
process.env.REDEEMER_RESTRICTION_ENFORCER ??= "0x5C75d7ee6d3d27634bec15e96538e794F9c7053b";
process.env.SPONSOR_ID ??= "1";
process.env.STUCK_AFTER_MS = "60000";

const { config } = await import("../src/config.js");
const { StateStore, getStoreSync, encode, decode } = await import("../src/lib/store.js");
const tm = await import("../src/lib/txManager.js");
const { publicClient, providerStatuses } = await import("../src/lib/clients.js");
const stats = await import("../src/services/stats.js");

let passed = 0;
let total = 0;
async function test(name: string, fn: () => Promise<void>) {
  total++;
  try { await fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); process.exitCode = 1; }
}
const to = (n: number) => `0x${(0x2000 + n).toString(16).padStart(40, "0")}` as Address;
const store = getStoreSync(config.stateDir);
const stateFile = join(dir, "state.json");

// ------------------------------------------------------------------------------------------- the state file
await test("the state encoding round-trips bigint (transaction values and gas)", async () => {
  const v = decode<{ a: bigint; nested: { b: bigint[] }; s: string }>(encode({ a: 12345678901234567890n, nested: { b: [0n, 7n] }, s: "x" }));
  assert.equal(v.a, 12345678901234567890n);
  assert.deepEqual(v.nested.b, [0n, 7n]);
  assert.equal(v.s, "x");
});
await test("a corrupt state file is moved aside and the node starts empty instead of refusing to boot", async () => {
  const d = mkdtempSync(join(tmpdir(), "relayer-corrupt-"));
  writeFileSync(join(d, "state.json"), "{ this is not json");
  const s = new StateStore(d);
  assert.deepEqual(s.load(), {});
  assert.ok(readdirSync(d).some((f) => f.startsWith("state.json.corrupt-")), "the bad file is kept for inspection");
});
await test("persistence off (empty STATE_DIR) writes nothing and reads nothing", async () => {
  const s = new StateStore("");
  s.register("x", () => 1);
  s.markDirty();
  s.flushSync();
  assert.equal(s.file, null);
  assert.deepEqual(s.load(), {});
});

// ------------------------------------------------------------------------------------- failover and broadcast
await test("a dead preferred provider is skipped: reads still work", async () => {
  const n = await publicClient.getBlockNumber();
  assert.ok(n >= 0n);
});
await test("provider status reports the dead one down, the live ones up, and never leaks a URL path", async () => {
  const st = await providerStatuses(Date.now() + 60_000);
  assert.equal(st.length, 3);
  assert.equal(st[0].up, false);
  assert.equal(st[1].up && st[2].up, true);
  assert.ok(st.every((p) => !p.host.includes("/")), "host only");
});
await test("a transaction is sent to EVERY live provider, and confirms despite the dead one", async () => {
  tm._reset();
  a.reset(); b.reset();
  const { receipt } = await tm.sendAndConfirm({ to: to(1), value: 1n });
  assert.equal(receipt.status, "success");
  assert.equal(a.calls.get("eth_sendRawTransaction"), 1, "provider A received the raw transaction");
  assert.equal(b.calls.get("eth_sendRawTransaction"), 1, "provider B received the raw transaction");
});

// ------------------------------------------------------------------------------------------ polling load
await test("20 requests waiting for a receipt cost a handful of polls, not 20 per second", async () => {
  tm._reset();
  await raw("evm_setAutomine", [false]);
  a.reset(); b.reset();
  const waits = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => tm.sendAndConfirm({ to: to(100 + i), value: 1n }, 3200)));
  assert.ok(waits.every((w) => w.status === "rejected"), "none mined, all timed out");
  const receipts = (a.calls.get("eth_getTransactionReceipt") ?? 0) + (b.calls.get("eth_getTransactionReceipt") ?? 0);
  const countPolls = (a.calls.get("eth_getTransactionCount:latest") ?? 0) + (b.calls.get("eth_getTransactionCount:latest") ?? 0);
  assert.ok(receipts <= 4, `receipt lookups while nothing is mined: ${receipts}`);
  assert.ok(countPolls <= 8, `nonce polls over ~3 s for 20 waiters: ${countPolls}`);
  await raw("evm_setAutomine", [true]);
  await raw("evm_mine");
  await tm.tick();
  await tm.tick();
});

// ------------------------------------------------------------------------------------------ crash recovery
await test("a restart re-adopts an unconfirmed transaction, still replaces it when stuck, and the replacement confirms", async () => {
  tm._reset();
  await raw("evm_setAutomine", [false]);
  const first = await tm.send({ to: to(200), value: 1n });
  store.flushSync();
  const onDisk = decode<{ sections: { inflight: { nonce: number; hashes: string[]; params: { value: bigint } }[] } }>(readFileSync(stateFile, "utf8"));
  assert.equal(onDisk.sections.inflight.length, 1);
  assert.equal(onDisk.sections.inflight[0].hashes[0], first);
  assert.equal(onDisk.sections.inflight[0].params.value, 1n, "bigint params survive the file");

  // --- "restart": the process forgets everything, then boots and adopts from the file
  const nonce = tm._state().inflight[0].nonce;
  tm._reset();
  store.reload();
  assert.equal(tm._state().inflight.length, 0, "a fresh process knows nothing");
  assert.equal(await tm.adoptPersisted(), 1);
  assert.equal(tm._state().inflight[0].nonce, nonce);

  await tm.tick(Date.now() + 120_000); // stuck -> replaced, same nonce
  const f = tm._state().inflight[0];
  assert.equal(f.nonce, nonce);
  assert.equal(f.hashes.length, 2);
  await raw("evm_setAutomine", [true]);
  await raw("evm_mine");
  const receipt = await publicClient.getTransactionReceipt({ hash: f.hashes[1] });
  assert.equal(receipt.status, "success");
  await tm.tick();
  assert.equal(tm._state().inflight.length, 0, "mined: forgotten");
});
await test("a restart does not adopt what was already mined while the node was down", async () => {
  tm._reset();
  await raw("evm_setAutomine", [false]);
  await tm.send({ to: to(201), value: 1n });
  store.flushSync();
  tm._reset();
  await raw("evm_setAutomine", [true]);
  await raw("evm_mine"); // mined during the "downtime"
  store.reload();
  assert.equal(await tm.adoptPersisted(), 0);
  assert.equal(tm._state().inflight.length, 0);
});

// ---------------------------------------------------------------------------------------- dashboard stats
await test("dashboard counters and logs survive a restart", async () => {
  stats.record({ outcome: "success", subscriptionId: "5", delegator: "0xabc", redeemTx: "0x1", gasUsedWei: "1000" });
  stats.record({ outcome: "rejected", reason: "nope" });
  store.flushSync();
  const doc = decode<{ sections: { stats: { counters: { total: number; success: number; totalGasUsedWei: bigint }; logs: { outcome: string }[] } } }>(readFileSync(stateFile, "utf8"));
  assert.equal(doc.sections.stats.counters.total, 2);
  assert.equal(doc.sections.stats.counters.success, 1);
  assert.equal(doc.sections.stats.counters.totalGasUsedWei, 1000n, "the gas total is a real bigint after reload");
  assert.equal(doc.sections.stats.logs[0].outcome, "rejected", "newest first");
  assert.ok(existsSync(stateFile));
});

a.server.close();
b.server.close();
anvil.kill();
console.log(`\n${passed}/${total} passed`);
if (passed !== total) process.exitCode = 1;
setTimeout(() => process.exit(process.exitCode ?? 0), 200);
