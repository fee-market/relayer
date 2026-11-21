/**
 * Transaction manager against a real local chain (anvil): serialized nonces under concurrency, a bounded receipt
 * wait, replacement of a stuck transaction with a higher fee, and the fee ceiling.
 *   npm run test:txmanager        (needs foundry's `anvil` on PATH; skips with a notice if it is missing)
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createPublicClient, http, type Address } from "viem";

if (spawnSync("anvil", ["--version"]).error) {
  console.log("SKIPPED: anvil is not installed (install foundry to run this suite)");
  process.exit(0);
}

const PORT = 8611;
const anvil = spawn("anvil", ["--port", String(PORT), "--silent"], { stdio: "ignore" });
process.on("exit", () => anvil.kill());
const rpc = `http://127.0.0.1:${PORT}`;
const raw = async (method: string, params: unknown[] = []) => {
  const r = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  return ((await r.json()) as { result?: unknown }).result;
};
for (let i = 0; i < 50; i++) {
  try { await raw("eth_chainId"); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
}

process.env.RPC_URL = rpc;
process.env.CHAIN_ID = "31337";
process.env.RELAYER_PRIVATE_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"; // anvil account #1
process.env.DELEGATION_MANAGER ??= "0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3";
process.env.DELEGATOR_IMPLEMENTATION ??= "0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B";
process.env.FEE_MARKET_REGISTRY ??= "0x57e6742610229c7Ce09df3028471397DaaE6B9f4";
process.env.REDEEMER_RESTRICTION_ENFORCER ??= "0x5C75d7ee6d3d27634bec15e96538e794F9c7053b";
process.env.SPONSOR_ID ??= "1";
// A long threshold so the manager's own 1 s loop never replaces anything behind the test's back; the tests move the
// clock explicitly through tick(now).
process.env.STUCK_AFTER_MS = "60000";
process.env.STATE_DIR = "";
process.env.MAX_REPLACEMENTS = "3";

const { config } = await import("../src/config.js");
const tm = await import("../src/lib/txManager.js");
const pub = createPublicClient({ transport: http(rpc) });

let passed = 0;
let total = 0;
async function test(name: string, fn: () => Promise<void>) {
  total++;
  try { await fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); process.exitCode = 1; }
}
// Plain addresses: 0x…01–0x…09 are EVM precompiles, where a bare 21,000-gas transfer reverts.
const to = (n: number) => `0x${(0x1000 + n).toString(16).padStart(40, "0")}` as Address;

await test("concurrent sends get distinct, consecutive nonces and all confirm", async () => {
  tm._reset();
  const results = await Promise.all([1, 2, 3, 4, 5, 6].map((i) => tm.sendAndConfirm({ to: to(i), value: 1n })));
  const nonces = await Promise.all(results.map((r) => pub.getTransaction({ hash: r.hash }).then((t) => t.nonce)));
  const sorted = [...nonces].sort((a, b) => a - b);
  assert.equal(new Set(nonces).size, 6, "no nonce reused");
  assert.deepEqual(sorted, [sorted[0], sorted[0] + 1, sorted[0] + 2, sorted[0] + 3, sorted[0] + 4, sorted[0] + 5], "no gaps");
  assert.ok(results.every((r) => r.receipt.status === "success"));
});

await test("waiting for a receipt is bounded: a transaction that never mines yields ReceiptTimeoutError with its hash", async () => {
  tm._reset();
  await raw("evm_setAutomine", [false]);
  await assert.rejects(tm.sendAndConfirm({ to: to(10), value: 1n }, 1500), (e: Error) => {
    assert.ok(e instanceof tm.ReceiptTimeoutError, `expected ReceiptTimeoutError, got ${e.name}: ${e.message}`);
    assert.match((e as InstanceType<typeof tm.ReceiptTimeoutError>).hash, /^0x[0-9a-f]{64}$/);
    return true;
  });
  assert.equal(tm._state().inflight.length, 1, "it stays managed after the response gave up");
});

await test("a stuck transaction is replaced with a higher fee at the SAME nonce, and the replacement confirms", async () => {
  const tracked = tm._state().inflight[0];
  assert.ok(tracked, "the unmined transaction from the previous step is still tracked");
  // _state() hands out the live record, which the manager mutates: snapshot what we compare against.
  const before = { nonce: tracked.nonce, maxFeePerGas: tracked.maxFeePerGas, maxPriorityFeePerGas: tracked.maxPriorityFeePerGas };
  await tm.tick(Date.now() + 120_000);
  const after = tm._state().inflight[0];
  assert.equal(after.nonce, before.nonce, "same nonce");
  assert.equal(after.hashes.length, 2, "original + replacement");
  assert.equal(after.replacements, 1);
  assert.ok(after.maxFeePerGas >= (before.maxFeePerGas * 125n) / 100n, `fee bumped by at least 25% (${before.maxFeePerGas} -> ${after.maxFeePerGas})`);
  assert.ok(after.maxPriorityFeePerGas >= (before.maxPriorityFeePerGas * 125n) / 100n, "tip bumped by at least 25%");
  await raw("evm_mine");
  const receipt = await pub.getTransactionReceipt({ hash: after.hashes[1] });
  assert.equal(receipt.status, "success");
  await tm.tick();
  assert.equal(tm._state().inflight.length, 0, "a mined nonce is forgotten");
});

await test("after a stuck period the next send still uses the right nonce (no gap, no collision)", async () => {
  await raw("evm_setAutomine", [true]);
  const { hash } = await tm.sendAndConfirm({ to: to(11), value: 1n });
  const t = await pub.getTransaction({ hash });
  const count = await pub.getTransactionCount({ address: t.from, blockTag: "latest" });
  assert.equal(count, t.nonce + 1);
});

await test("a network fee above MAX_FEE_PER_GAS_GWEI refuses to broadcast instead of overpaying", async () => {
  const policy = config.policy as { maxFeePerGasGwei: number };
  const saved = policy.maxFeePerGasGwei;
  policy.maxFeePerGasGwei = 1; // anvil's base fee + tip is above 1 gwei
  try {
    await assert.rejects(tm.send({ to: to(12), value: 1n }), (e: Error) => e instanceof tm.FeeTooHighError);
  } finally {
    policy.maxFeePerGasGwei = saved;
  }
});

await test("a transaction stuck past MAX_REPLACEMENTS stops being replaced (and the operator is alerted)", async () => {
  tm._reset();
  await raw("evm_setAutomine", [false]);
  await tm.send({ to: to(13), value: 1n });
  for (let i = 0; i < 5; i++) await tm.tick(Date.now() + 120_000 * (i + 1));
  const f = tm._state().inflight[0];
  assert.equal(f.replacements, 3, "capped at MAX_REPLACEMENTS");
  await raw("evm_setAutomine", [true]);
  await raw("evm_mine");
});

anvil.kill();
console.log(`\n${passed}/${total} passed`);
if (passed !== total) process.exitCode = 1;
setTimeout(() => process.exit(process.exitCode ?? 0), 200);
