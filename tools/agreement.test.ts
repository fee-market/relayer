/**
 * Offline tests for the sponsor agreement in /subscribe, against a mock JSON-RPC node holding a plan, a token and a
 * FeeMarketAgreements contract:
 *   - off (no address) or nothing published: /subscribe is exactly what it was
 *   - on and published: the batch must be [approve?, accept, subscribe], for the same plan and the current text
 *   - the contract cannot be read: nothing is let through unaccepted
 *   npm run test:agreement
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { concat, decodeFunctionData, encodeAbiParameters, encodeFunctionData, encodeFunctionResult, pad, parseAbi, size, toHex, type Address, type Hex } from "viem";

const AGREEMENTS = "0x00000000000000000000000000000000000a9ee5" as Address;
const ELSEWHERE = "0x00000000000000000000000000000000000b0b0b" as Address;
const USDC = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359" as Address;
const HASH = ("0x" + "2e".repeat(32)) as Hex;
const OLD_HASH = ("0x" + "11".repeat(32)) as Hex;
const SIGNATURE = ("0x" + "ab".repeat(65)) as Hex;

const chain = { version: 1n, hash: HASH, agreementsDown: false, tokenBalance: 0n, allowance: 0n, planSponsor: 1n };
const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)"]);

process.env.CHAIN_ID = "137";
process.env.RELAYER_PRIVATE_KEY ??= "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
process.env.DELEGATION_MANAGER ??= "0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3";
process.env.DELEGATOR_IMPLEMENTATION ??= "0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B";
process.env.FEE_MARKET_REGISTRY ??= "0x57e6742610229c7Ce09df3028471397DaaE6B9f4";
process.env.REDEEMER_RESTRICTION_ENFORCER ??= "0x5C75d7ee6d3d27634bec15e96538e794F9c7053b";
process.env.FEE_MARKET_AGREEMENTS = AGREEMENTS;
process.env.SPONSOR_ID = "1";
process.env.READ_CACHE_MS = "0"; // the mock chain changes between cases

const { feeMarketRegistryAbi } = await import("../src/generated/feeMarketRegistryAbi.js");
const { feeMarketAgreementsAbi } = await import("../src/abi.js");
const REGISTRY = process.env.FEE_MARKET_REGISTRY!.toLowerCase();

const node = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const { id, method, params } = JSON.parse(body) as { id: number; method: string; params: [{ to: string; data: Hex }] };
    const reply = (o: object) => res.setHeader("content-type", "application/json").end(JSON.stringify({ jsonrpc: "2.0", id, ...o }));
    if (method === "eth_chainId") return reply({ result: "0x89" });
    if (method !== "eth_call") return reply({ error: { code: -32601, message: `unmocked ${method}` } });
    const { to, data } = params[0];
    try {
      if (to.toLowerCase() === REGISTRY) {
        const { functionName } = decodeFunctionData({ abi: feeMarketRegistryAbi, data });
        if (functionName === "plans") {
          return reply({ result: encodeFunctionResult({ abi: feeMarketRegistryAbi, functionName: "plans", result: [chain.planSponsor, 0, USDC, 10_000n, 0n, 0n, ("0x" + "00".repeat(32)) as Hex, true] }) });
        }
      } else if (to.toLowerCase() === USDC.toLowerCase()) {
        const { functionName } = decodeFunctionData({ abi: erc20, data });
        return reply({ result: encodeFunctionResult({ abi: erc20, functionName: functionName as "balanceOf", result: functionName === "balanceOf" ? chain.tokenBalance : chain.allowance }) });
      } else if (to.toLowerCase() === AGREEMENTS.toLowerCase()) {
        if (chain.agreementsDown) return reply({ error: { code: -32000, message: "the node is not answering" } });
        const { functionName } = decodeFunctionData({ abi: feeMarketAgreementsAbi, data });
        if (functionName === "current") {
          return reply({ result: encodeFunctionResult({ abi: feeMarketAgreementsAbi, functionName: "current", result: [chain.version, chain.version === 0n ? (("0x" + "00".repeat(32)) as Hex) : chain.hash, "ipfs://agreement"] }) });
        }
      }
    } catch (e) {
      return reply({ error: { code: -32000, message: `mock failed: ${(e as Error).message}` } });
    }
    return reply({ error: { code: -32000, message: "unmocked call" } });
  });
});
await new Promise<void>((r) => node.listen(0, "127.0.0.1", r));
process.env.RPC_URL = `http://127.0.0.1:${(node.address() as AddressInfo).port}`;

const { config, ANY_DELEGATE, ROOT_AUTHORITY } = await import("../src/config.js");
const { relayerAddress } = await import("../src/lib/clients.js");
const { validateSubscribeRequest } = await import("../src/services/subscribeValidator.js");
const { validateBatchLimits } = await import("../src/services/batchValidation.js");
const { AGREEMENT_REQUIRED_REASON, AGREEMENT_STALE_REASON, AGREEMENT_WRONG_PLAN_REASON, AGREEMENT_UNREADABLE_REASON, currentAgreement } = await import("../src/services/agreement.js");

let passed = 0;
let total = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  total++;
  try { await fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); process.exitCode = 1; }
}

const USER = "0x00000000000000000000000000000000000000aa" as Address;
const reason = (r: { ok: boolean; reason?: string }) => r.reason ?? "";
const reset = () => {
  chain.version = 1n; chain.hash = HASH; chain.agreementsDown = false; chain.tokenBalance = 1_000_000n; chain.allowance = 1_000_000n; chain.planSponsor = 1n;
  config.feeMarketAgreements = AGREEMENTS;
  config.policy.allowedTargets = [];
};
type Exec = { target: Address; value: bigint; callData: Hex };
const exec = (target: Address, callData: Hex, value = 0n): Exec => ({ target, value, callData });
const batch = (execs: Exec[]): Hex =>
  encodeAbiParameters([{ type: "tuple[]", components: [{ name: "target", type: "address" }, { name: "value", type: "uint256" }, { name: "callData", type: "bytes" }] }], [execs] as never);
const approve = (amount: bigint) => exec(USDC, encodeFunctionData({ abi: parseAbi(["function approve(address,uint256)"]), functionName: "approve", args: [config.feeMarketRegistry, amount] }));
const subscribe = (planId: bigint, amount: bigint) => exec(config.feeMarketRegistry, encodeFunctionData({ abi: feeMarketRegistryAbi, functionName: "subscribe", args: [planId, amount] }));
const accept = (planId: bigint, hash: Hex = HASH, target: Address = AGREEMENTS, value = 0n) =>
  exec(target, encodeFunctionData({ abi: feeMarketAgreementsAbi, functionName: "accept", args: [planId, hash, SIGNATURE] }), value);
/** A fully pinned, valid delegation by the user for exactly this batch (deadline 5 minutes from now). */
const request = (execs: Exec[]) => {
  const data = batch(execs);
  const before = Math.floor(Date.now() / 1000) + 300;
  return {
    delegations: [{
      delegate: ANY_DELEGATE, delegator: USER, authority: ROOT_AUTHORITY, salt: "1", signature: "0x",
      caveats: [
        { enforcer: config.redeemerRestrictionEnforcer, terms: relayerAddress, args: "0x" },
        { enforcer: config.limitedCallsEnforcer, terms: pad("0x01"), args: "0x" },
        { enforcer: config.exactExecutionBatchEnforcer, terms: data, args: "0x" },
        { enforcer: config.timestampEnforcer, terms: concat([pad(toHex(0), { size: 16 }), pad(toHex(before), { size: 16 })]), args: "0x" },
      ],
    }],
    executionCallData: data,
  } as never;
};
const validate = (execs: Exec[]) => validateSubscribeRequest(request(execs));

// ------------------------------------------------------------------------------------------------ off
await test("off (no address): [subscribe] and [approve, subscribe] are accepted exactly as before", async () => {
  reset();
  config.feeMarketAgreements = null;
  assert.equal(await currentAgreement(), null);
  let r = await validate([subscribe(1n, 50_000n)]);
  assert.equal(r.ok, true, reason(r));
  chain.allowance = 0n;
  r = await validate([approve(50_000n), subscribe(1n, 50_000n)]);
  assert.equal(r.ok, true, reason(r));
});
await test("off: a batch with any other call is still refused as before, an accept call included", async () => {
  reset();
  config.feeMarketAgreements = null;
  assert.match(reason(await validate([accept(1n), subscribe(1n, 50_000n)])), /first call is not a valid approve\(\)/);
  assert.match(reason(await validate([approve(50_000n), accept(1n), subscribe(1n, 50_000n)])), /batch must be \[subscribe\] or \[approve, subscribe\]/);
});
await test("on, but nothing published (version 0): behaves as off", async () => {
  reset();
  chain.version = 0n;
  assert.equal(await currentAgreement(), null);
  const r = await validate([subscribe(1n, 50_000n)]);
  assert.equal(r.ok, true, reason(r));
  assert.match(reason(await validate([accept(1n), subscribe(1n, 50_000n)])), /first call is not a valid approve\(\)/);
});

// ------------------------------------------------------------------------------------------------ on
await test("on and published: [accept, subscribe] is accepted, and so is [approve, accept, subscribe]", async () => {
  reset();
  assert.deepEqual(await currentAgreement(), { address: AGREEMENTS, version: 1n, hash: HASH });
  assert.equal(config.feeMarketAgreements, AGREEMENTS);
  let r = await validate([accept(1n), subscribe(1n, 50_000n)]);
  assert.equal(r.ok, true, reason(r));
  assert.equal(r.planId, 1n);
  chain.allowance = 0n; // the approve in the batch is what makes the payment possible, as before
  r = await validate([approve(50_000n), accept(1n), subscribe(1n, 50_000n)]);
  assert.equal(r.ok, true, reason(r));
});
await test("on: a subscription without the acceptance is refused, with the text the wallet matches on", async () => {
  reset();
  assert.equal(AGREEMENT_REQUIRED_REASON, "this sponsor requires the sponsor agreement to be accepted in the same transaction as subscribe");
  assert.equal(reason(await validate([subscribe(1n, 50_000n)])), AGREEMENT_REQUIRED_REASON);
  assert.equal(reason(await validate([approve(50_000n), subscribe(1n, 50_000n)])), AGREEMENT_REQUIRED_REASON, "what an older wallet sends");
});
await test("on: the acceptance must come directly before subscribe (an approve belongs first)", async () => {
  reset();
  assert.equal(reason(await validate([accept(1n), approve(50_000n), subscribe(1n, 50_000n)])), AGREEMENT_REQUIRED_REASON);
});
await test("on: an acceptance of an older text is refused", async () => {
  reset();
  assert.equal(AGREEMENT_STALE_REASON, "the sponsor agreement in this request is not the current version");
  assert.equal(reason(await validate([accept(1n, OLD_HASH), subscribe(1n, 50_000n)])), AGREEMENT_STALE_REASON);
  // ...and the same request passes again once that text is the published one
  chain.hash = OLD_HASH;
  const r = await validate([accept(1n, OLD_HASH), subscribe(1n, 50_000n)]);
  assert.equal(r.ok, true, reason(r));
});
await test("on: an acceptance for another plan than the one subscribed to is refused", async () => {
  reset();
  assert.equal(AGREEMENT_WRONG_PLAN_REASON, "the agreement was accepted for a different plan than the one being subscribed to");
  assert.equal(reason(await validate([accept(2n), subscribe(1n, 50_000n)])), AGREEMENT_WRONG_PLAN_REASON);
});
await test("on: accept on some other contract, or sending value with it, does not count", async () => {
  reset();
  assert.equal(reason(await validate([accept(1n, HASH, ELSEWHERE), subscribe(1n, 50_000n)])), AGREEMENT_REQUIRED_REASON);
  assert.match(reason(await validate([accept(1n, HASH, AGREEMENTS, 1n), subscribe(1n, 50_000n)])), /must not send value/);
  const truncated = exec(AGREEMENTS, (accept(1n).callData.slice(0, 10) + "00") as Hex);
  assert.match(reason(await validate([truncated, subscribe(1n, 50_000n)])), /could not be decoded/);
});
await test("on: nothing else rides along (four calls, or a first call that is not an approve)", async () => {
  reset();
  assert.match(reason(await validate([approve(1n), approve(50_000n), accept(1n), subscribe(1n, 50_000n)])), /batch must be \[accept, subscribe\] or \[approve, accept, subscribe\]/);
  assert.match(reason(await validate([accept(1n), accept(1n), subscribe(1n, 50_000n)])), /first call is not a valid approve\(\)/);
});
await test("on: the other subscribe checks still apply (another sponsor's plan, a user who cannot pay)", async () => {
  reset();
  chain.planSponsor = 2n;
  assert.match(reason(await validate([accept(1n), subscribe(1n, 50_000n)])), /does not belong to this sponsor/);
  chain.planSponsor = 1n;
  chain.tokenBalance = 0n;
  assert.match(reason(await validate([accept(1n), subscribe(1n, 50_000n)])), /balance 0 is below/);
});
await test("the agreements contract cannot be read: the subscription is refused, not let through unaccepted", async () => {
  reset();
  chain.agreementsDown = true;
  assert.equal(reason(await validate([accept(1n), subscribe(1n, 50_000n)])), AGREEMENT_UNREADABLE_REASON);
  assert.equal(reason(await validate([subscribe(1n, 50_000n)])), AGREEMENT_UNREADABLE_REASON);
  assert.match(AGREEMENT_UNREADABLE_REASON, /try again/);
});

// ------------------------------------------------------------------------------------------------ limits
await test("the three-call batch is well inside the node's batch limits, with or without a target allowlist", () => {
  reset();
  const data = batch([approve(50_000n), accept(1n), subscribe(1n, 50_000n)]);
  assert.ok(size(data) < config.policy.maxBatchCalldataBytes / 4, `the batch is ${size(data)} bytes`);
  assert.ok(3 <= config.policy.maxBatchCalls);
  assert.deepEqual(validateBatchLimits(data), { ok: true });
  // A sponsor that only allows named targets does not have to name the agreements contract: it is allowed like the registry.
  config.policy.allowedTargets = [USDC.toLowerCase()];
  assert.deepEqual(validateBatchLimits(data), { ok: true });
  const stranger = validateBatchLimits(batch([approve(50_000n), accept(1n, HASH, ELSEWHERE), subscribe(1n, 50_000n)]));
  assert.equal(stranger.ok, false);
  // ...and only while the node is set up with it.
  config.feeMarketAgreements = null;
  assert.equal(validateBatchLimits(data).ok, false);
});

node.close();
console.log(`\n${passed}/${total} passed`);
if (passed !== total) process.exitCode = 1;
