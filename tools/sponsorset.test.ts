/**
 * Offline tests for the sponsor relayer set and the on-chain endpoint: the onboarding step, the doctor's endpoint check
 * and the pre-checks that save a reverted transaction. No chain.
 *   npm run test:sponsorset
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

const { planOnboard, endpointNeedsPublishing, endpointProblem } = await import("../src/sponsor/flow.js");
const { checkEndpoint, checkSponsor } = await import("../src/sponsor/doctorChecks.js");
const { relayerChangeProblem } = await import("../src/sponsor/relayers.js");

let passed = 0, total = 0;
function test(name: string, fn: () => void) {
  total++;
  try { fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); process.exitCode = 1; }
}

const HASH = "0x" + "ab".repeat(32);
const state = (over: Record<string, unknown> = {}) => ({
  registryOk: true, balanceWei: 10n ** 18n, chainSponsorId: 1n, envSponsorId: 1n, status: 2, onchainHash: HASH, freshHash: HASH, storageConfigured: true, ...over,
}) as never;
const URL = "https://relay.realsponsor.io";
const A = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const B = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";

console.log("endpoint step");
test("a registered sponsor whose on-chain endpoint differs gets a publish-endpoint step", () => {
  const p = planOnboard(state({ onchainEndpoint: "", publicUrl: URL, payoutIsRelayerKey: true }));
  assert.deepEqual(p.steps, [{ kind: "publish-endpoint", viaPayout: false }]);
});
test("when the payout key is not this node's key the step is viaPayout and needs no gas from the relayer", () => {
  const p = planOnboard(state({ onchainEndpoint: "", publicUrl: URL, payoutIsRelayerKey: false, balanceWei: 0n }));
  assert.deepEqual(p.steps, [{ kind: "publish-endpoint", viaPayout: true }]);
  assert.deepEqual(p.blockers, []);
});
test("the same URL (trailing slash and case aside), no URL, a placeholder or an older registry: no step", () => {
  assert.deepEqual(planOnboard(state({ onchainEndpoint: URL + "/", publicUrl: URL })).steps, []);
  assert.deepEqual(planOnboard(state({ onchainEndpoint: "", publicUrl: "" })).steps, []);
  assert.deepEqual(planOnboard(state({ onchainEndpoint: "", publicUrl: "https://relay.example/relay" })).steps, []);
  assert.deepEqual(planOnboard(state({ onchainEndpoint: null, publicUrl: URL })).steps, []);
  assert.deepEqual(planOnboard(state()).steps, [], "callers that do not know about endpoints are unchanged");
});
test("what can be published: https only, at most 256 bytes", () => {
  assert.equal(endpointProblem(URL), null);
  assert.match(endpointProblem("http://relay.realsponsor.io")!, /https/);
  assert.match(endpointProblem("https://x.io/" + "a".repeat(300))!, /256/);
  assert.equal(endpointNeedsPublishing(undefined, URL), false);
});

console.log("doctor");
test("doctor compares the on-chain URL with PUBLIC_RELAYER_URL", () => {
  assert.equal(checkEndpoint(URL, URL)[0].level, "ok");
  assert.equal(checkEndpoint("", URL)[0].level, "warn");
  assert.match(checkEndpoint("https://old.io", URL)[0].msg, /differs/);
  assert.deepEqual(checkEndpoint(null, URL), []);
  assert.equal(checkEndpoint(URL, "")[0].level, "warn");
});
test("a standby relayer key is recognised as belonging to the sponsor", () => {
  const f = checkSponsor({ registered: true, relayerMatches: true, standby: true, status: 2, metadataCommitted: true });
  assert.ok(f.some((x) => x.level === "ok" && /standby relayer/.test(x.msg)));
  assert.ok(!checkSponsor({ registered: true, relayerMatches: false, status: 2, metadataCommitted: true }).every((x) => x.level !== "fail"));
});

console.log("relayer set pre-checks");
test("add: not an address, already a member, full set", () => {
  assert.match(relayerChangeProblem("add", "nope", { count: 1, isMember: false, primary: A })!, /not an address/);
  assert.match(relayerChangeProblem("add", B, { count: 2, isMember: true, primary: A })!, /already/);
  assert.match(relayerChangeProblem("add", B, { count: 8, isMember: false, primary: A })!, /full/);
  assert.equal(relayerChangeProblem("add", B, { count: 7, isMember: false, primary: A }), null);
});
test("add: the key must have accepted the relayer role first", () => {
  const withConsent = (consent: number) => relayerChangeProblem("add", B, { count: 1, isMember: false, primary: A, consent, sponsorId: 7n, registry: "0xReg" });
  assert.match(withConsent(0)!, /has not accepted the relayer role for sponsor #7/);
  assert.match(withConsent(0)!, /sponsor:accept -- relayer/);
  assert.match(withConsent(2)!, /not accepted the relayer role/); // accepted the payout role only
  assert.equal(withConsent(1), null);
  assert.equal(withConsent(3), null);
  assert.equal(relayerChangeProblem("add", B, { count: 1, isMember: false, primary: A }), null); // consent unknown: the contract decides
  assert.equal(relayerChangeProblem("remove", B, { count: 2, isMember: true, primary: A, consent: 0 }), null); // removal needs no consent
});
test("remove: the primary cannot go, a non-member cannot go", () => {
  assert.match(relayerChangeProblem("remove", A.toLowerCase(), { count: 2, isMember: true, primary: A })!, /primary/);
  assert.match(relayerChangeProblem("remove", B, { count: 2, isMember: false, primary: A })!, /not a relayer/);
  assert.equal(relayerChangeProblem("remove", B, { count: 2, isMember: true, primary: A }), null);
});

console.log(`\n${passed}/${total} passed`);
if (passed !== total) process.exit(1);
