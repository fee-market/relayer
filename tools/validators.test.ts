/**
 * Offline tests for the endpoint validators' on-chain checks, against a mock JSON-RPC node holding a tiny registry:
 *   - /topup: only the subscription's owner, never an ended one, and the user must be able to pay
 *   - /subscribe: the user must hold (and have approved) the amount
 *   - /relay funds: empty or ended subscriptions are refused (and an older registry without the ended getter still works)
 *   npm run test:validators
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { concat, decodeFunctionData, encodeAbiParameters, encodeFunctionData, encodeFunctionResult, pad, parseAbi, toHex, type Address, type Hex } from "viem";

type Sub = { planId: bigint; user: Address; balance: bigint; txns: bigint; expiry: bigint };
type PlanRow = { sponsorId: bigint; model: number; token: Address; price: bigint; quota: bigint; period: bigint; active: boolean };
const chain = {
  subs: new Map<bigint, Sub>(),
  plans: new Map<bigint, PlanRow>(),
  ended: new Set<bigint>(),
  endedSupported: true,
  canSponsor: null as null | { ok: boolean; reason: Hex },
  tokenBalance: 0n,
  allowance: 0n,
};
const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)"]);

process.env.CHAIN_ID = "137";
process.env.RELAYER_PRIVATE_KEY ??= "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
process.env.DELEGATION_MANAGER ??= "0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3";
process.env.DELEGATOR_IMPLEMENTATION ??= "0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B";
process.env.FEE_MARKET_REGISTRY ??= "0x57e6742610229c7Ce09df3028471397DaaE6B9f4";
process.env.REDEEMER_RESTRICTION_ENFORCER ??= "0x5C75d7ee6d3d27634bec15e96538e794F9c7053b";
process.env.SPONSOR_ID = "1";
process.env.READ_CACHE_MS = "0"; // these tests change the mock chain between cases; the cache has its own tests (test:abuse)

const { feeMarketRegistryAbi } = await import("../src/generated/feeMarketRegistryAbi.js");
const USDC = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359" as Address;
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
        const { functionName, args } = decodeFunctionData({ abi: feeMarketRegistryAbi, data });
        if (functionName === "subscriptions") {
          const s = chain.subs.get(args![0] as bigint) ?? { planId: 0n, user: "0x0000000000000000000000000000000000000000" as Address, balance: 0n, txns: 0n, expiry: 0n };
          return reply({ result: encodeFunctionResult({ abi: feeMarketRegistryAbi, functionName: "subscriptions", result: [s.planId, s.user, s.balance, s.txns, s.expiry] }) });
        }
        if (functionName === "plans") {
          const p = chain.plans.get(args![0] as bigint)!;
          return reply({ result: encodeFunctionResult({ abi: feeMarketRegistryAbi, functionName: "plans", result: [p.sponsorId, p.model, p.token, p.price, p.quota, p.period, ("0x" + "00".repeat(32)) as Hex, p.active] }) });
        }
        if (functionName === "canSponsor") {
          if (!chain.canSponsor) return reply({ error: { code: 3, message: "execution reverted", data: "0x" } });
          return reply({ result: encodeFunctionResult({ abi: feeMarketRegistryAbi, functionName: "canSponsor", result: [chain.canSponsor.ok, chain.canSponsor.reason] }) });
        }
        if (functionName === "subscriptionEnded") {
          if (!chain.endedSupported) return reply({ error: { code: 3, message: "execution reverted", data: "0x" } });
          return reply({ result: encodeFunctionResult({ abi: feeMarketRegistryAbi, functionName: "subscriptionEnded", result: chain.ended.has(args![0] as bigint) }) });
        }
      } else if (to.toLowerCase() === USDC.toLowerCase()) {
        const { functionName } = decodeFunctionData({ abi: erc20, data });
        const v = functionName === "balanceOf" ? chain.tokenBalance : chain.allowance;
        return reply({ result: encodeFunctionResult({ abi: erc20, functionName: functionName as "balanceOf", result: v }) });
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
const { validateTopUpRequest } = await import("../src/services/topUpValidator.js");
const { validateSubscribeRequest } = await import("../src/services/subscribeValidator.js");
const { checkSubscriptionFunds } = await import("../src/services/registry.js");

let passed = 0;
let total = 0;
async function test(name: string, fn: () => Promise<void>) {
  total++;
  try { await fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); process.exitCode = 1; }
}

const OWNER = "0x00000000000000000000000000000000000000aa" as Address;
const OTHER = "0x00000000000000000000000000000000000000bb" as Address;
const reason = (r: { ok: boolean; reason?: string }) => r.reason ?? "";
const reset = () => {
  chain.subs.clear(); chain.plans.clear(); chain.ended.clear();
  chain.endedSupported = true; chain.canSponsor = null; chain.tokenBalance = 1_000_000n; chain.allowance = 1_000_000n;
  chain.plans.set(1n, { sponsorId: 1n, model: 0, token: USDC, price: 10_000n, quota: 0n, period: 0n, active: true });
  chain.subs.set(7n, { planId: 1n, user: OWNER, balance: 500_000n, txns: 0n, expiry: 0n });
};
const exec = (target: Address, callData: Hex) => ({ target, value: 0n, callData });
const batch = (execs: ReturnType<typeof exec>[]): Hex =>
  encodeAbiParameters([{ type: "tuple[]", components: [{ name: "target", type: "address" }, { name: "value", type: "uint256" }, { name: "callData", type: "bytes" }] }], [execs] as never);
const approve = (amount: bigint) => exec(USDC, encodeFunctionData({ abi: parseAbi(["function approve(address,uint256)"]), functionName: "approve", args: [config.feeMarketRegistry, amount] }));
const topUp = (subId: bigint, amount: bigint) => exec(config.feeMarketRegistry, encodeFunctionData({ abi: feeMarketRegistryAbi, functionName: "topUp", args: [subId, amount] }));
const subscribe = (planId: bigint, amount: bigint) => exec(config.feeMarketRegistry, encodeFunctionData({ abi: feeMarketRegistryAbi, functionName: "subscribe", args: [planId, amount] }));
/** A fully pinned, valid delegation by `delegator` for exactly this batch (deadline 5 minutes from now). */
const request = (delegator: Address, execs: ReturnType<typeof exec>[]) => {
  const data = batch(execs);
  const before = Math.floor(Date.now() / 1000) + 300;
  return {
    delegations: [{
      delegate: ANY_DELEGATE, delegator, authority: ROOT_AUTHORITY, salt: "1", signature: "0x",
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

// ----------------------------------------------------------------------------------------------- /topup
await test("topup: the owner topping up a live subscription they can pay for is accepted", async () => {
  reset();
  const r = await validateTopUpRequest(request(OWNER, [topUp(7n, 100_000n)]));
  assert.equal(r.ok, true, reason(r));
});
await test("topup: someone else's delegator is refused (the registry only lets the owner top up)", async () => {
  reset();
  assert.match(reason(await validateTopUpRequest(request(OTHER, [topUp(7n, 100_000n)]))), /not the subscription's owner/);
});
await test("topup: an ended subscription is refused", async () => {
  reset();
  chain.ended.add(7n);
  assert.match(reason(await validateTopUpRequest(request(OWNER, [topUp(7n, 100_000n)]))), /ended/);
});
await test("topup: an owner without enough tokens is refused before any gas is spent", async () => {
  reset();
  chain.tokenBalance = 10n;
  assert.match(reason(await validateTopUpRequest(request(OWNER, [topUp(7n, 100_000n)]))), /balance 10 is below/);
});
await test("topup: no allowance and no approve in the batch is refused; with the approve it passes", async () => {
  reset();
  chain.allowance = 0n;
  assert.match(reason(await validateTopUpRequest(request(OWNER, [topUp(7n, 100_000n)]))), /not approved/);
  const r = await validateTopUpRequest(request(OWNER, [approve(100_000n), topUp(7n, 100_000n)]));
  assert.equal(r.ok, true, reason(r));
});
await test("topup: a subscription on another sponsor's plan is refused", async () => {
  reset();
  chain.plans.set(1n, { ...chain.plans.get(1n)!, sponsorId: 2n });
  assert.match(reason(await validateTopUpRequest(request(OWNER, [topUp(7n, 100_000n)]))), /does not belong to this sponsor/);
});

// -------------------------------------------------------------------------------------------- /subscribe
await test("subscribe: a user who holds and has approved the amount is accepted", async () => {
  reset();
  const r = await validateSubscribeRequest(request(OWNER, [subscribe(1n, 50_000n)]));
  assert.equal(r.ok, true, reason(r));
});
await test("subscribe: a user without the tokens is refused (the first-use revert that used to burn sponsor gas)", async () => {
  reset();
  chain.tokenBalance = 0n;
  assert.match(reason(await validateSubscribeRequest(request(OWNER, [subscribe(1n, 50_000n)]))), /balance 0 is below/);
});
await test("subscribe: missing allowance is refused unless the batch approves first", async () => {
  reset();
  chain.allowance = 0n;
  assert.match(reason(await validateSubscribeRequest(request(OWNER, [subscribe(1n, 50_000n)]))), /not approved/);
  const r = await validateSubscribeRequest(request(OWNER, [approve(50_000n), subscribe(1n, 50_000n)]));
  assert.equal(r.ok, true, reason(r));
});

// ------------------------------------------------------------------------------------------ /relay funds
await test("relay: a subscription with escrow is accepted", async () => {
  reset();
  assert.equal((await checkSubscriptionFunds(7n)).ok, true);
});
await test("relay: an empty subscription is refused for every pricing model", async () => {
  for (const model of [0, 1, 2]) {
    reset();
    chain.plans.set(1n, { ...chain.plans.get(1n)!, model, quota: 100n, period: 86_400n });
    chain.subs.set(7n, { ...chain.subs.get(7n)!, balance: 0n, txns: 100n, expiry: BigInt(Math.floor(Date.now() / 1000) + 9999) });
    const r = await checkSubscriptionFunds(7n);
    assert.equal(r.ok, false, `model ${model}`);
    assert.match((r as { reason: string }).reason, /no escrow left/, `model ${model}`);
  }
});
await test("relay: an ended subscription is refused", async () => {
  reset();
  chain.ended.add(7n);
  const r = await checkSubscriptionFunds(7n);
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /has ended/);
});
await test("relay: a registry deployed before the ended getter existed still works (escrow check is the guard)", async () => {
  reset();
  chain.endedSupported = false;
  assert.equal((await checkSubscriptionFunds(7n)).ok, true);
  chain.subs.set(7n, { ...chain.subs.get(7n)!, balance: 0n });
  assert.equal((await checkSubscriptionFunds(7n)).ok, false);
});

await test("relay: canSponsor is authoritative where the registry has it, with the registry's own reason", async () => {
  const { toFunctionSelector } = await import("viem");
  const cases: [string, RegExp][] = [
    ["RegistryHalted()", /halted/], ["SponsorPaused()", /paused/], ["NotVerified()", /not verified/], ["QuotaExceeded()", /quota/],
    ["SubscriptionExpired()", /expired/], ["InsufficientBalance()", /insufficient escrow/], ["SubscriptionAlreadyEnded()", /ended/],
  ];
  for (const [sig, re] of cases) {
    reset();
    chain.canSponsor = { ok: false, reason: toFunctionSelector(sig) };
    const r = await checkSubscriptionFunds(7n);
    assert.equal(r.ok, false, sig);
    assert.match((r as { reason: string }).reason, re, sig);
  }
  reset();
  chain.canSponsor = { ok: false, reason: "0xdeadbeef" };
  assert.match((await checkSubscriptionFunds(7n) as { reason: string }).reason, /would refuse this charge/);
  reset();
  chain.canSponsor = { ok: true, reason: "0x00000000" };
  const ok = await checkSubscriptionFunds(7n);
  assert.equal(ok.ok, true);
  assert.equal((ok as { plan: { sponsorId: bigint } }).plan.sponsorId, 1n, "still returns the plan for the profit guard");
});
await test("relay: canSponsor says yes while local checks would say no -> the registry wins (it is the contract's truth)", async () => {
  reset();
  chain.ended.add(7n);
  chain.canSponsor = { ok: true, reason: "0x00000000" };
  assert.equal((await checkSubscriptionFunds(7n)).ok, true);
});
await test("relay: a registry without canSponsor falls back to the local checks", async () => {
  reset();
  chain.canSponsor = null;
  chain.ended.add(7n);
  assert.match((await checkSubscriptionFunds(7n) as { reason: string }).reason, /has ended/);
});

node.close();
console.log(`\n${passed}/${total} passed`);
if (passed !== total) process.exitCode = 1;
