/**
 * Offline tests for the relayer's chargeUsage batch check (no chain access).
 *   npm run test:charge
 *
 * Every sponsored /relay batch must end with registry.chargeUsage(subId, 1), run by the user's account.
 */
import assert from "node:assert/strict";
import { encodeAbiParameters, encodeFunctionData, type Hex } from "viem";

process.env.RPC_URL ??= "http://127.0.0.1:9";
process.env.CHAIN_ID ??= "137";
process.env.RELAYER_PRIVATE_KEY ??= "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
process.env.DELEGATION_MANAGER ??= "0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3";
process.env.DELEGATOR_IMPLEMENTATION ??= "0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B";
process.env.FEE_MARKET_REGISTRY ??= "0x57e6742610229c7Ce09df3028471397DaaE6B9f4";
process.env.REDEEMER_RESTRICTION_ENFORCER ??= "0x5C75d7ee6d3d27634bec15e96538e794F9c7053b";
process.env.SPONSOR_ID ??= "1";

const { config } = await import("../src/config.js");
const { feeMarketRegistryAbi } = await import("../src/generated/feeMarketRegistryAbi.js");
const { validateChargeCall } = await import("../src/services/batchValidation.js");

type E = { target: `0x${string}`; value: bigint; callData: Hex };
const enc = (execs: E[]): Hex =>
  encodeAbiParameters(
    [{ type: "tuple[]", components: [{ name: "target", type: "address" }, { name: "value", type: "uint256" }, { name: "callData", type: "bytes" }] }],
    [execs] as never,
  );
const charge = (subId: bigint, n: bigint, value = 0n, target = config.feeMarketRegistry): E => ({
  target, value, callData: encodeFunctionData({ abi: feeMarketRegistryAbi, functionName: "chargeUsage", args: [subId, n] }),
});
const action: E = { target: "0x" + "22".repeat(20) as `0x${string}`, value: 0n, callData: "0xdeadbeef" };

let passed = 0;
let total = 0;
function test(name: string, fn: () => void) {
  total++;
  try { fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); process.exitCode = 1; }
}
const rejects = (execs: E[], re: RegExp, subId = 7n) => {
  const r = validateChargeCall(enc(execs), subId);
  assert.equal(r.ok, false, "expected a rejection");
  assert.match((r as { reason: string }).reason, re);
};

test("action followed by chargeUsage(subId, 1) is accepted", () => assert.deepEqual(validateChargeCall(enc([action, charge(7n, 1n)]), 7n), { ok: true }));
test("a batch without a charge call is rejected", () => rejects([action, action], /last call must be chargeUsage/));
test("a lone charge call (no action) is rejected", () => rejects([charge(7n, 1n)], /action and a final chargeUsage/));
test("charge must be last and appear once", () => {
  rejects([charge(7n, 1n), action], /exactly once, last/);
  rejects([charge(7n, 1n), action, charge(7n, 1n)], /exactly once, last/);
});
test("wrong subscription id is rejected", () => rejects([action, charge(8n, 1n)], /does not match/));
test("n must be exactly 1", () => { rejects([action, charge(7n, 2n)], /exactly one op/); rejects([action, charge(7n, 0n)], /exactly one op/); });
test("charge must not send value", () => rejects([action, charge(7n, 1n, 1n)], /must not send value/));
test("charge on another contract is rejected", () => rejects([action, charge(7n, 1n, 0n, action.target)], /last call must be chargeUsage/));
test("truncated charge calldata is rejected", () => {
  const c = charge(7n, 1n); rejects([action, { ...c, callData: c.callData.slice(0, -2) as Hex }], /argument length/);
});
test("garbage executionCallData is rejected", () => assert.equal(validateChargeCall("0x1234", 7n).ok, false));

console.log(`\n${passed}/${total} passed`);
if (passed !== total) process.exitCode = 1;
