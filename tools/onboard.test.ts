/**
 * Offline tests for the decision logic behind `sponsor:onboard` and `sponsor:go` (no chain, no processes).
 *   npm run test:onboard
 */
import assert from "node:assert/strict";
import { ZERO_HASH, chooseMode, healthBaseUrl, metadataStorageReady, planGo, planOnboard, type GoState, type OnboardState } from "../src/sponsor/flow.js";

let passed = 0;
let total = 0;
function test(name: string, fn: () => void) {
  total++;
  try { fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); process.exitCode = 1; }
}
const H1 = "0x" + "11".repeat(32);
const H2 = "0x" + "22".repeat(32);
const fresh: OnboardState = {
  registryOk: true, balanceWei: 10n ** 18n, chainSponsorId: 0n, envSponsorId: 1n, status: null,
  onchainHash: ZERO_HASH, freshHash: null, storageConfigured: true,
};
const kinds = (p: { steps: { kind: string }[] }) => p.steps.map((s) => s.kind);

test("a brand-new sponsor registers, writes the id and publishes metadata", () => {
  const p = planOnboard(fresh);
  assert.deepEqual(p.blockers, []);
  assert.deepEqual(kinds(p), ["register", "write-env", "publish-metadata"]);
});
test("an existing registration is reused: no register, only fix .env and publish", () => {
  const p = planOnboard({ ...fresh, chainSponsorId: 7n, envSponsorId: 1n, status: 1, freshHash: H1 });
  assert.deepEqual(kinds(p), ["write-env", "publish-metadata"]);
});
test("fully set up and in sync: nothing to do, waits for the curator", () => {
  const p = planOnboard({ ...fresh, chainSponsorId: 7n, envSponsorId: 7n, status: 1, onchainHash: H1, freshHash: H1 });
  assert.deepEqual(p.steps, []);
  assert.match(p.next, /curator/);
  assert.match(p.next, /background|Keep the node running/i);
});
test("verified and in sync points at sponsor:go", () => {
  const p = planOnboard({ ...fresh, chainSponsorId: 7n, envSponsorId: 7n, status: 2, onchainHash: H1, freshHash: H1 });
  assert.deepEqual(p.steps, []);
  assert.match(p.next, /sponsor:go/);
});
test("changed metadata is republished", () => {
  const p = planOnboard({ ...fresh, chainSponsorId: 7n, envSponsorId: 7n, status: 2, onchainHash: H1, freshHash: H2 });
  assert.deepEqual(kinds(p), ["publish-metadata"]);
});
test("hash comparison is case-insensitive", () => {
  const p = planOnboard({ ...fresh, chainSponsorId: 7n, envSponsorId: 7n, status: 2, onchainHash: H1.toUpperCase().replace("0X", "0x"), freshHash: H1 });
  assert.deepEqual(p.steps, []);
});
test("IPFS is ready with a thirdweb key; Fil One needs its own bucket credentials", () => {
  assert.equal(metadataStorageReady({}), false);
  assert.equal(metadataStorageReady({ thirdwebSecret: "sk" }), true);
  assert.equal(metadataStorageReady({ thirdwebClientId: "cid" }), true);
  assert.equal(metadataStorageReady({ metadataStorage: "filone", filBucket: "b", accessKey: "a" }), false);
  assert.equal(metadataStorageReady({ metadataStorage: "filone", filBucket: "b", accessKey: "a", secretKey: "s" }), true);
  assert.equal(metadataStorageReady({ metadataStorage: "s3" }), false);
});
test("blockers: old registry, no gas, no storage, revoked", () => {
  assert.equal(planOnboard({ ...fresh, registryOk: false }).blockers.length, 1);
  assert.match(planOnboard({ ...fresh, balanceWei: 0n }).blockers.join(), /no gas/);
  assert.match(planOnboard({ ...fresh, storageConfigured: false }).blockers.join(), /storage/i);
  assert.match(planOnboard({ ...fresh, chainSponsorId: 7n, status: 3, freshHash: H1 }).blockers.join(), /REVOKED/);
});
test("no gas is not a blocker when nothing needs a transaction", () => {
  const p = planOnboard({ ...fresh, balanceWei: 0n, chainSponsorId: 7n, envSponsorId: 7n, status: 1, onchainHash: H1, freshHash: H1 });
  assert.deepEqual(p.blockers, []);
});

const go: GoState = { status: 2, hasDocker: true, hasCompose: true, hasDomain: true, publicUrl: "https://r.example/relay", noStart: false };
test("go: verified sponsor lists plans, starts and waits (docker when everything is there)", () => {
  const p = planGo(go);
  assert.equal(p.mode, "docker");
  assert.deepEqual(p.blockers, []);
  assert.deepEqual(kinds(p), ["list-plans", "start", "wait-health"]);
});
test("go: falls back to running the node directly without docker or a domain", () => {
  assert.equal(chooseMode({ hasDocker: false, hasCompose: true, hasDomain: true }), "node");
  assert.equal(chooseMode({ hasDocker: true, hasCompose: true, hasDomain: false }), "node");
  assert.equal(chooseMode({ mode: "docker", hasDocker: false, hasCompose: false, hasDomain: false }), "docker");
});
test("go: blocked unless VERIFIED", () => {
  for (const status of [null, 0, 1, 3]) assert.match(planGo({ ...go, status }).blockers.join(), /VERIFIED/);
});
test("go: explicit docker mode reports missing prerequisites", () => {
  const b = planGo({ ...go, mode: "docker", hasDocker: false, hasCompose: false, hasDomain: false }).blockers.join();
  assert.match(b, /Docker installed/);
  assert.match(b, /docker-compose\.yml/);
  assert.match(b, /PUBLIC_DOMAIN/);
});
test("go: --no-start only lists plans and skips docker checks", () => {
  const p = planGo({ ...go, noStart: true, mode: "docker", hasDocker: false });
  assert.deepEqual(p.blockers, []);
  assert.deepEqual(kinds(p), ["list-plans"]);
});
test("health base url strips /relay and trailing slashes", () => {
  assert.equal(healthBaseUrl("https://r.example/relay"), "https://r.example");
  assert.equal(healthBaseUrl("https://r.example/relay/"), "https://r.example");
  assert.equal(healthBaseUrl("https://r.example/"), "https://r.example");
});

console.log(`\n${passed}/${total} passed`);
if (passed !== total) process.exitCode = 1;
