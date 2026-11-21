/**
 * Offline tests for the profit guard: revenue per request, gas cost in the plan's token, the refuse/allow decision, the
 * unpriced policies, and the oracle round checks. No chain.
 *   npm run test:profit
 */
import assert from "node:assert/strict";

process.env.RPC_URL ??= "http://127.0.0.1:9";
process.env.CHAIN_ID ??= "137";
process.env.STATE_DIR = "";
process.env.RELAYER_PRIVATE_KEY ??= "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
process.env.DELEGATION_MANAGER ??= "0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3";
process.env.DELEGATOR_IMPLEMENTATION ??= "0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B";
process.env.FEE_MARKET_REGISTRY ??= "0x57e6742610229c7Ce09df3028471397DaaE6B9f4";
process.env.REDEEMER_RESTRICTION_ENFORCER ??= "0x5C75d7ee6d3d27634bec15e96538e794F9c7053b";
process.env.SPONSOR_ID ??= "1";

const { revenuePerRequest, gasCostInToken, decide, usableRound } = await import("../src/services/profit.js");
const { PricingModel, config } = await import("../src/config.js");

let passed = 0, total = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  total++;
  try { await fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); process.exitCode = 1; }
}

const USDC = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359" as const;
const WEIRD = "0x000000000000000000000000000000000000dEaD" as const;
const cfg = (over: Partial<typeof config.profit> = {}) => ({ ...config.profit, maxMultiple: 2, unpriced: "allow" as const, ...over });
const plan = (price: bigint, over: Record<string, unknown> = {}) => ({ model: PricingModel.PER_TXN, price, quota: 0n, paymentToken: USDC as `0x${string}`, ...over });
// POL at $0.0932 (8 decimals), USDC has 6 decimals
const env = (over: Partial<{ prices: any; dec: any }> = {}) => ({
  prices: async () => ("prices" in over ? over.prices : { nativeUsd: 9_322_051n, decimals: 8 }),
  tokenDecimals: async () => ("dec" in over ? over.dec : 6),
});
const ONE_CENT_OF_POL = 10n ** 17n; // 0.1 POL = ~$0.0093 = ~9322 USDC base units

console.log("revenue per request");
await test("PER_TXN earns the price; BULK and capped SUBSCRIPTION earn price / quota; an uncapped subscription has no per-request amount", () => {
  assert.equal(revenuePerRequest({ model: PricingModel.PER_TXN, price: 10_000n, quota: 0n }), 10_000n);
  assert.equal(revenuePerRequest({ model: PricingModel.BULK, price: 1_000_000n, quota: 100n }), 10_000n);
  assert.equal(revenuePerRequest({ model: PricingModel.SUBSCRIPTION, price: 1_000_000n, quota: 50n }), 20_000n);
  assert.equal(revenuePerRequest({ model: PricingModel.SUBSCRIPTION, price: 1_000_000n, quota: 0n }), null);
});

console.log("gas cost in the token");
await test("0.1 POL at $0.0932 is about 9322 USDC base units, rounded up", () => {
  assert.equal(gasCostInToken(ONE_CENT_OF_POL, 9_322_051n, 8, 6), 9323n);
  assert.equal(gasCostInToken(0n, 9_322_051n, 8, 6), 0n);
});
await test("it scales with token decimals (an 18-decimal stablecoin)", () => {
  assert.equal(gasCostInToken(10n ** 18n, 100_000_000n, 8, 18), 10n ** 18n); // 1 native at $1 = 1 token
});

console.log("decision");
await test("off (multiple 0) or no plan: never checks", async () => {
  assert.deepEqual(await decide(plan(1n), 10n ** 18n, env(), cfg({ maxMultiple: 0 })), { ok: true, checked: false });
  assert.deepEqual(await decide(undefined, 10n ** 18n, env(), cfg()), { ok: true, checked: false });
});
await test("gas within the multiple of the price is allowed", async () => {
  // costs ~9323; price 10_000, multiple 2 -> limit 20_000
  assert.deepEqual(await decide(plan(10_000n), ONE_CENT_OF_POL, env(), cfg()), { ok: true, checked: true });
});
await test("gas above the multiple of the price is refused, with a user-readable reason", async () => {
  const d = await decide(plan(4_000n), ONE_CENT_OF_POL, env(), cfg()); // limit 8_000 < 9323
  assert.equal(d.ok, false);
  if (!d.ok) { assert.match(d.reason, /network fees are too high/); assert.equal(d.costToken, 9323n); assert.equal(d.revenue, 4_000n); }
});
await test("exactly at the limit is allowed; one unit over is refused", async () => {
  assert.equal((await decide(plan(4_662n), ONE_CENT_OF_POL, env(), cfg({ maxMultiple: 2 }))).ok, true); // limit 9324 >= 9323
  assert.equal((await decide(plan(4_661n), ONE_CENT_OF_POL, env(), cfg({ maxMultiple: 2 }))).ok, false); // limit 9322 < 9323
});
await test("a fractional multiple works (1.5x)", async () => {
  assert.equal((await decide(plan(6_300n), ONE_CENT_OF_POL, env(), cfg({ maxMultiple: 1.5 }))).ok, true); // limit 9450 >= 9323
  assert.equal((await decide(plan(6_000n), ONE_CENT_OF_POL, env(), cfg({ maxMultiple: 1.5 }))).ok, false); // limit 9000 < 9323
});
await test("the cost grows with the gas price: the same plan is fine at low fees and refused in a spike", async () => {
  assert.equal((await decide(plan(10_000n), 10n ** 16n, env(), cfg())).ok, true);
  assert.equal((await decide(plan(10_000n), 10n ** 18n, env(), cfg())).ok, false);
});

console.log("unpriced");
await test("allow (default): no oracle price, an unknown token or no per-request price lets the request through unchecked", async () => {
  assert.deepEqual(await decide(plan(1n), 10n ** 18n, env({ prices: null }), cfg()), { ok: true, checked: false, reason: "no fresh native price" });
  assert.equal((await decide(plan(1n, { paymentToken: WEIRD }), 10n ** 18n, env(), cfg())).ok, true);
  assert.equal((await decide(plan(1n, { model: PricingModel.SUBSCRIPTION }), 10n ** 18n, env(), cfg())).ok, true);
});
await test("refuse (strict): the same cases are refused", async () => {
  const strict = cfg({ unpriced: "refuse" });
  assert.equal((await decide(plan(1n), 1n, env({ prices: null }), strict)).ok, false);
  assert.equal((await decide(plan(1n, { paymentToken: WEIRD }), 1n, env(), strict)).ok, false);
  assert.equal((await decide(plan(1n), 1n, env({ dec: null }), strict)).ok, false);
});
await test("a failing oracle read is treated as unpriced, not as a crash", async () => {
  const e = { prices: async () => { throw new Error("rpc down"); }, tokenDecimals: async () => 6 };
  assert.equal((await decide(plan(1n), 10n ** 18n, e, cfg())).ok, true);
  assert.equal((await decide(plan(1n), 10n ** 18n, e, cfg({ unpriced: "refuse" }))).ok, false);
});

console.log("oracle round");
const now = 1_800_000_000;
await test("a fresh, positive, complete round is usable", () => {
  assert.equal(usableRound({ answer: 9n, updatedAt: BigInt(now - 60), roundId: 5n, answeredInRound: 5n }, now, 7200), true);
});
await test("a stale, zero, negative or incomplete round is not", () => {
  assert.equal(usableRound({ answer: 9n, updatedAt: BigInt(now - 9000), roundId: 5n, answeredInRound: 5n }, now, 7200), false);
  assert.equal(usableRound({ answer: 0n, updatedAt: BigInt(now), roundId: 5n, answeredInRound: 5n }, now, 7200), false);
  assert.equal(usableRound({ answer: -1n, updatedAt: BigInt(now), roundId: 5n, answeredInRound: 5n }, now, 7200), false);
  assert.equal(usableRound({ answer: 9n, updatedAt: BigInt(now), roundId: 6n, answeredInRound: 5n }, now, 7200), false);
});

console.log(`\n${passed}/${total} passed`);
if (passed !== total) process.exit(1);
