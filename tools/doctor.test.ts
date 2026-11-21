/**
 * Offline tests for `sponsor:doctor` checks and `sponsor:init` env templating (no chain access).
 *   npm run test:doctor
 */
import assert from "node:assert/strict";
import { toFunctionSelector } from "viem";
import { addressFromSlot, checkBalance, checkManagerState, checkRegistryBuild, checkSponsor, hasSelector, isPublicRpc, lintPolicy, type PolicyInput } from "../src/sponsor/doctorChecks.js";
import { setEnv } from "../src/sponsor/envFile.js";
import { registryBuildCode } from "../src/sponsor/registryCode.js";

let passed = 0;
let total = 0;
function test(name: string, fn: () => void) {
  total++;
  try { fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); process.exitCode = 1; }
}
const sel = (s: string) => toFunctionSelector(s).slice(2);
const CURRENT = ["chargeUsage(uint256,uint256)", "verifySponsor(uint256,bytes32,bytes32)"];
const codeWith = (...sigs: string[]) => "0x6080" + sigs.map((s) => "63" + sel(s)).join("") + "00";
const levels = (f: { level: string }[]) => f.map((x) => x.level);
const good: PolicyInput = {
  dashboardToken: "x".repeat(32), corsOrigins: ["https://wallet.example"], maxGasWei: 1n, publicRelayerUrl: "https://relay.example",
  requireRedeemerRestriction: true, simulateBeforeSend: true, trustProxy: 1, maxDelegationTtlSeconds: 3600,
};

test("manager pause state", () => {
  assert.deepEqual(levels(checkManagerState(false, "0xabc")), ["ok"]);
  assert.deepEqual(levels(checkManagerState(true, "0xabc")), ["fail"]);
  assert.deepEqual(levels(checkManagerState(undefined, undefined)), ["warn"]);
});

test("selector detection", () => {
  assert.equal(hasSelector(codeWith("chargeUsage(uint256,uint256)"), "chargeUsage(uint256,uint256)"), true);
  assert.equal(hasSelector(codeWith("withdraw(uint256,address)"), "chargeUsage(uint256,uint256)"), false);
  assert.equal(hasSelector("0x", "chargeUsage(uint256,uint256)"), false);
  assert.equal(hasSelector(undefined, "chargeUsage(uint256,uint256)"), false);
});
test("selector detection copes with selectors that start with a zero byte", () => {
  // refundRequestedAt(uint256) = 0x00923e46: the compiler pushes it as PUSH3 (0x62) 923e46, not PUSH4
  assert.equal(toFunctionSelector("refundRequestedAt(uint256)"), "0x00923e46");
  assert.equal(hasSelector("0x608062923e4614", "refundRequestedAt(uint256)"), true);
  assert.equal(hasSelector("0x6080630000000014", "refundRequestedAt(uint256)"), false);
  assert.equal(hasSelector("0x", "refundRequestedAt(uint256)"), false);
});
test("the implementation behind a proxy is read from the EIP-1967 storage word", () => {
  const word = "0x000000000000000000000000" + "5fbdb2315678afecb367f032d93f642f64180aa3";
  assert.equal(addressFromSlot(word), "0x5fbdb2315678afecb367f032d93f642f64180aa3");
  assert.equal(addressFromSlot("0x" + "0".repeat(64)), undefined, "empty slot: not a proxy, look at the code itself");
  assert.equal(addressFromSlot("0x12"), undefined);
  assert.equal(addressFromSlot(undefined), undefined);
});
// The lookups are async, so they run first and the assertions below stay synchronous (the harness does not await tests).
const PROXY = "0x00000000000000000000000000000000000000aa" as const;
const IMPL = "0x5fbdb2315678afecb367f032d93f642f64180aa3" as const;
const fakeClient = (slot: string, codes: Record<string, string>) =>
  ({
    getStorageAt: async () => slot,
    getCode: async ({ address }: { address: string }) => codes[address.toLowerCase()],
  }) as never;
const viaProxy = await registryBuildCode(fakeClient("0x" + "0".repeat(24) + IMPL.slice(2), { [PROXY]: "0x6080", [IMPL]: "0x6080aabb" }), PROXY);
const plainRegistry = await registryBuildCode(fakeClient("0x" + "0".repeat(64), { [PROXY]: "0x6080cc" }), PROXY);

test("the build to inspect is the implementation behind a proxy, or the code itself when there is no proxy", () => {
  assert.equal(viaProxy.implementation, IMPL);
  assert.equal(viaProxy.code, "0x6080aabb", "the implementation's code, not the proxy's");
  assert.equal(plainRegistry.implementation, undefined);
  assert.equal(plainRegistry.code, "0x6080cc");
});

test("current registry build passes; old build and empty address fail", () => {
  assert.deepEqual(levels(checkRegistryBuild(codeWith(...CURRENT))), ["ok", "ok"]);
  assert.ok(levels(checkRegistryBuild(codeWith("chargeUsage(uint256,uint256)"))).includes("fail"), "chargeUsage without verifySponsor is the pre-fix build");
  assert.ok(levels(checkRegistryBuild(codeWith("reportUsage(uint256,uint256)"))).includes("fail"));
  assert.ok(levels(checkRegistryBuild(codeWith(...CURRENT, "reportUsage(uint256,uint256)"))).includes("fail"));
  assert.deepEqual(levels(checkRegistryBuild("0x")), ["fail"]);
});
test("production-grade policy has no warnings or failures", () => {
  assert.deepEqual(lintPolicy(good).filter((f) => f.level !== "ok"), []);
});
test("risky policy is flagged", () => {
  const bad = lintPolicy({ ...good, requireRedeemerRestriction: false, dashboardToken: "1", corsOrigins: ["*"], maxGasWei: 0n, simulateBeforeSend: false, trustProxy: 0, publicRelayerUrl: "http://r.example", maxDelegationTtlSeconds: 86400 });
  assert.equal(bad.filter((f) => f.level === "fail").length, 2, "redeemer restriction off + weak dashboard token");
  assert.equal(bad.filter((f) => f.level === "warn").length, 6);
});
test("a wildcard CORS origin is a warning for a test node and a FAILURE once the node is published", () => {
  const wild = { ...good, corsOrigins: ["*"] };
  assert.ok(lintPolicy({ ...wild, publicRelayerUrl: "https://relay.example" }).some((f) => f.level === "warn" && /CORS_ORIGINS/.test(f.msg)), "an example URL is still a test node");
  assert.ok(lintPolicy({ ...wild, publicRelayerUrl: "https://relay.realsponsor.io" }).some((f) => f.level === "fail" && /CORS_ORIGINS/.test(f.msg)));
  assert.ok(!lintPolicy({ ...good, corsOrigins: ["https://app.realsponsor.io"], publicRelayerUrl: "https://relay.realsponsor.io" }).some((f) => /CORS_ORIGINS/.test(f.msg)), "a list of origins is fine");
});
test("empty dashboard token means disabled, not weak", () => {
  assert.equal(lintPolicy({ ...good, dashboardToken: "" }).some((f) => f.level === "fail"), false);
});
test("sponsor states", () => {
  assert.deepEqual(levels(checkSponsor({ registered: false, relayerMatches: false, status: 0, metadataCommitted: false })), ["fail"]);
  assert.deepEqual(levels(checkSponsor({ registered: true, relayerMatches: true, status: 2, metadataCommitted: true })), ["ok", "ok", "ok"]);
  assert.ok(levels(checkSponsor({ registered: true, relayerMatches: true, status: 1, metadataCommitted: true })).includes("warn"));
  assert.ok(levels(checkSponsor({ registered: true, relayerMatches: true, status: 3, metadataCommitted: true })).includes("fail"));
  assert.ok(levels(checkSponsor({ registered: true, relayerMatches: false, status: 2, metadataCommitted: true })).includes("fail"));
});
test("balance thresholds", () => {
  assert.equal(checkBalance(0n).level, "fail");
  assert.equal(checkBalance(1n).level, "warn");
  assert.equal(checkBalance(10n ** 18n).level, "ok");
});
test("setEnv replaces an existing key and appends a missing one", () => {
  assert.equal(setEnv("A=1\nB=2\n", "A", "9"), "A=9\nB=2\n");
  assert.equal(setEnv("A=1\n", "C", "3"), "A=1\nC=3\n");
});

test("rpc: public endpoints are recognised, paid ones are not", () => {
  for (const u of ["https://polygon-bor-rpc.publicnode.com", "https://polygon.drpc.org", "https://polygon-rpc.com", "https://polygon.llamarpc.com"]) assert.equal(isPublicRpc(u), true, u);
  for (const u of ["https://polygon-mainnet.g.alchemy.com/v2/KEY", "https://example.quiknode.pro/KEY/", "http://127.0.0.1:8545"]) assert.equal(isPublicRpc(u), false, u);
});
test("rpc: a single provider warns; several ok; all-public is a warning for a test node and a FAILURE once published", () => {
  const paid = ["https://polygon-mainnet.g.alchemy.com/v2/KEY"];
  assert.ok(lintPolicy({ ...good, rpcUrls: paid }).some((f) => f.level === "warn" && /only one RPC provider/.test(f.msg)));
  assert.ok(lintPolicy({ ...good, rpcUrls: [...paid, "https://polygon.drpc.org"] }).some((f) => f.level === "ok" && /2 RPC providers/.test(f.msg)));
  const pub = ["https://polygon.drpc.org", "https://polygon-bor-rpc.publicnode.com"];
  assert.ok(lintPolicy({ ...good, rpcUrls: pub, publicRelayerUrl: "https://relay.example" }).some((f) => f.level === "warn" && /free public/.test(f.msg)), "an example URL is still a test node");
  assert.ok(lintPolicy({ ...good, rpcUrls: pub, publicRelayerUrl: "https://relay.realsponsor.io" }).some((f) => f.level === "fail" && /free public/.test(f.msg)));
  assert.equal(lintPolicy({ ...good, rpcUrls: [] }).some((f) => f.level === "fail" && /no RPC URL/.test(f.msg)), true);
});
test("state dir, per-account budget and concurrency limits are linted", () => {
  assert.ok(lintPolicy({ ...good, stateDir: "" }).some((f) => f.level === "warn" && /STATE_DIR is empty/.test(f.msg)));
  assert.ok(lintPolicy({ ...good, stateDir: "./data" }).some((f) => f.level === "ok" && /state is kept/.test(f.msg)));
  assert.ok(lintPolicy({ ...good, rateLimitDelegatorMax: 0 }).some((f) => f.level === "warn" && /per-account/.test(f.msg)));
  assert.ok(lintPolicy({ ...good, maxConcurrentSponsored: 0 }).some((f) => f.level === "warn" && /unbounded concurrency/.test(f.msg)));
});
test("real-IP header: without TRUST_PROXY it satisfies the shared-bucket warning; without either it warns", () => {
  const published = { ...good, trustProxy: 0, publicRelayerUrl: "https://relay.realsponsor.io" };
  assert.ok(lintPolicy(published).some((f) => f.level === "warn" && /shares? one rate-limit bucket|share one rate-limit bucket/.test(f.msg)));
  const withHeader = lintPolicy({ ...published, clientIpHeader: "cf-connecting-ip" });
  assert.equal(withHeader.some((f) => f.level === "warn" && /rate-limit bucket/.test(f.msg)), false);
  assert.ok(withHeader.some((f) => f.level === "ok" && /cf-connecting-ip/.test(f.msg)));
});

console.log(`\n${passed}/${total} passed`);
if (passed !== total) process.exitCode = 1;
