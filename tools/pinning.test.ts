/**
 * Offline tests for the relayer's delegation-pinning checks (no chain access).
 *   npm run test:pinning
 *
 * A delegation is only safe to redeem if it pins the batch (ExactExecutionBatch), a single use
 * (LimitedCalls=1), the redeemer, and a deadline; the redeemer supplies the batch, so anything less lets
 * a compromised relayer substitute or replay it.
 */
import assert from "node:assert/strict";
import { concat, encodeAbiParameters, pad, toHex, type Hex } from "viem";

process.env.RPC_URL ??= "http://127.0.0.1:9";
process.env.CHAIN_ID ??= "137";
process.env.RELAYER_PRIVATE_KEY ??= "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
process.env.DELEGATION_MANAGER ??= "0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3";
process.env.DELEGATOR_IMPLEMENTATION ??= "0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B";
process.env.FEE_MARKET_REGISTRY ??= "0x57e6742610229c7Ce09df3028471397DaaE6B9f4";
process.env.REDEEMER_RESTRICTION_ENFORCER ??= "0x5C75d7ee6d3d27634bec15e96538e794F9c7053b";
process.env.SPONSOR_ID ??= "1";

const { config, BATCH_DEFAULT_MODE, ANY_DELEGATE, ROOT_AUTHORITY } = await import("../src/config.js");
const { relayerAddress } = await import("../src/lib/clients.js");
const { validatePinnedDelegation, usesSponsorLevelLock } = await import("../src/services/batchValidation.js");

const NOW = 1_800_000_000;
const registry = config.feeMarketRegistry;
const executionCallData: Hex = encodeAbiParameters(
  [{ type: "tuple[]", components: [{ name: "target", type: "address" }, { name: "value", type: "uint256" }, { name: "callData", type: "bytes" }] }],
  [[{ target: registry, value: 0n, callData: "0xdeadbeef" }]] as never,
);
const tsTerms = (before: number, after = 0): Hex => concat([pad(toHex(after), { size: 16 }), pad(toHex(before), { size: 16 })]);

type Caveat = { enforcer: string; terms: string; args: string };
const good = (): Caveat[] => [
  { enforcer: config.redeemerRestrictionEnforcer, terms: relayerAddress, args: "0x" },
  { enforcer: config.limitedCallsEnforcer, terms: pad("0x01"), args: "0x" },
  { enforcer: config.exactExecutionBatchEnforcer, terms: executionCallData, args: "0x" },
  { enforcer: config.timestampEnforcer, terms: tsTerms(NOW + 600), args: "0x" },
];
const del = (caveats: Caveat[]) => [
  { delegate: ANY_DELEGATE, delegator: "0x" + "11".repeat(20), authority: ROOT_AUTHORITY, caveats, salt: "1", signature: "0x" },
] as never;

const sponsorLock = (registryAddr: string = config.feeMarketRegistry, sponsorId: bigint = config.sponsorId): Caveat => ({
  enforcer: config.sponsorRelayerEnforcer, terms: concat([registryAddr as Hex, pad(toHex(sponsorId), { size: 32 })]), args: "0x",
});
const withSponsorLock = (lock: Caveat): Caveat[] => [lock, ...without(config.redeemerRestrictionEnforcer)];

let passed = 0;
let total = 0;
function test(name: string, fn: () => void) {
  total++;
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}\n    ${(e as Error).message}`);
    process.exitCode = 1;
  }
}
const check = (caveats: Caveat[], opts: { data?: Hex; mode?: string; now?: number } = {}) =>
  validatePinnedDelegation(del(caveats), opts.data ?? executionCallData, opts.mode, opts.now ?? NOW);
const rejects = (r: { ok: boolean; reason?: string }, re: RegExp) => {
  assert.equal(r.ok, false, "expected a rejection");
  assert.match((r as { reason: string }).reason, re);
};
const without = (enforcer: string) => good().filter((c) => c.enforcer !== enforcer);

test("a fully pinned delegation is accepted", () => assert.deepEqual(check(good()), { ok: true }));
test("the default batch mode is accepted explicitly", () => assert.deepEqual(check(good(), { mode: BATCH_DEFAULT_MODE }), { ok: true }));

test("missing any one required caveat is rejected", () => {
  rejects(check(without(config.redeemerRestrictionEnforcer)), /RedeemerRestriction/);
  rejects(check(without(config.limitedCallsEnforcer)), /LimitedCalls/);
  rejects(check(without(config.exactExecutionBatchEnforcer)), /ExactExecutionBatch/);
  rejects(check(without(config.timestampEnforcer)), /TimestampEnforcer/);
});

test("the pinned batch must equal executionCallData (a swapped batch is rejected)", () => {
  const other: Hex = encodeAbiParameters(
    [{ type: "tuple[]", components: [{ name: "target", type: "address" }, { name: "value", type: "uint256" }, { name: "callData", type: "bytes" }] }],
    [[{ target: registry, value: 0n, callData: "0xcafebabe" }]] as never,
  );
  rejects(check(good(), { data: other }), /does not match executionCallData/);
});

test("a call limit other than 1 is rejected (no replay)", () => {
  const c = good();
  c[1].terms = pad("0x02");
  rejects(check(c), /exactly 1/);
  c[1].terms = "0x01";
  rejects(check(c), /exactly 1/);
});

test("the redeemer restriction must be locked to THIS relayer", () => {
  const c = good();
  c[0].terms = "0x" + "22".repeat(20);
  rejects(check(c), /not locked to this relayer/);
});

test("deadline: missing, passed, too close, too far, or inverted are rejected", () => {
  const set = (terms: Hex) => {
    const c = good();
    c[3].terms = terms;
    return c;
  };
  rejects(check(set(tsTerms(0))), /no deadline/);
  rejects(check(set(tsTerms(NOW - 10))), /too close or already passed/);
  rejects(check(set(tsTerms(NOW + 10))), /too close or already passed/);
  rejects(check(set(tsTerms(NOW + config.policy.maxDelegationTtlSeconds + 5))), /away/);
  rejects(check(set(tsTerms(NOW + 600, NOW + 700))), /start is not before/);
  rejects(check(set("0x1234")), /invalid TimestampEnforcer terms/);
  assert.deepEqual(check(set(tsTerms(NOW + 600, NOW - 5))), { ok: true }); // valid window that already opened
});

test("an unknown enforcer is rejected (arbitrary enforcer code would run on the sponsor's gas)", () => {
  rejects(check([...good(), { enforcer: "0x" + "ab".repeat(20), terms: "0x", args: "0x" }]), /unknown caveat enforcer/);
});

test("duplicate caveats are rejected", () => {
  rejects(check([...good(), good()[1]]), /duplicate caveat/);
});

test("only the default single-batch mode and a single delegation are accepted", () => {
  rejects(check(good(), { mode: "0x0001" + "00".repeat(30) }), /default single batch/);
  const two = [...(del(good()) as never[]), ...(del(good()) as never[])] as never;
  rejects(validatePinnedDelegation(two, executionCallData, undefined, NOW), /exactly one delegation/);
});

test("sponsor-level lock (registry + sponsor id) is accepted in place of the single-key lock", () => {
  assert.deepEqual(check(withSponsorLock(sponsorLock())), { ok: true });
});
test("sponsor-level lock: wrong registry, wrong sponsor, wrong length are rejected", () => {
  rejects(check(withSponsorLock(sponsorLock("0x" + "22".repeat(20)))), /different registry/);
  rejects(check(withSponsorLock(sponsorLock(config.feeMarketRegistry, config.sponsorId + 1n))), /different sponsor/);
  rejects(check(withSponsorLock({ enforcer: config.sponsorRelayerEnforcer, terms: relayerAddress, args: "0x" })), /invalid SponsorRelayerEnforcer terms/);
});
test("both locks together, or neither, are rejected", () => {
  rejects(check([sponsorLock(), ...good()]), /not both/);
  rejects(check(without(config.redeemerRestrictionEnforcer)), /RedeemerRestriction/);
});
test("sponsor-level lock still needs the other three caveats, each once", () => {
  rejects(check(withSponsorLock(sponsorLock()).filter((c) => c.enforcer !== config.limitedCallsEnforcer)), /LimitedCalls/);
  rejects(check([...withSponsorLock(sponsorLock()), sponsorLock()]), /duplicate caveat/);
});
test("usesSponsorLevelLock tells the two apart", () => {
  assert.equal(usesSponsorLevelLock(del(withSponsorLock(sponsorLock()))), true);
  assert.equal(usesSponsorLevelLock(del(good())), false);
});

console.log(`\n${passed}/${total} passed`);
if (passed !== total) process.exitCode = 1;
