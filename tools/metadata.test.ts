/**
 * Offline tests for the sponsor metadata schema / serialization / content hash (no chain access).
 *   npm run test:metadata
 */
import assert from "node:assert/strict";
import { keccak256, stringToBytes } from "viem";

// config.ts reads required env vars at import time; give it harmless dummies.
process.env.RPC_URL ??= "http://127.0.0.1:9";
process.env.CHAIN_ID ??= "137";
process.env.RELAYER_PRIVATE_KEY ??= "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
process.env.DELEGATION_MANAGER ??= "0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3";
process.env.DELEGATOR_IMPLEMENTATION ??= "0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B";
process.env.FEE_MARKET_REGISTRY ??= "0x57e6742610229c7Ce09df3028471397DaaE6B9f4";
process.env.REDEEMER_RESTRICTION_ENFORCER ??= "0x5C75d7ee6d3d27634bec15e96538e794F9c7053b";
process.env.SPONSOR_ID ??= "1";

const { buildMetadata, metadataHashOf, serializeMetadata, sponsorMetadataSchema } = await import("../src/sponsor/metadata.js");
const { commitmentOfRow, economicsProblems, hashCaveatPolicy, planCommitment } = await import("../src/sponsor/listing.js");
const { computeParity } = await import("./parityFixture.js");
const { readFileSync } = await import("node:fs");

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

const sample = () => JSON.parse(serializeMetadata(buildMetadata()));

const parityFixture = JSON.parse(readFileSync(new URL("../fixtures/metadata-parity.json", import.meta.url), "utf8"));
const parityActual = await computeParity(parityFixture.input);
test("the committed parity fixture still matches what this relayer computes (marketplace clients must match too)", () => {
  assert.deepEqual(parityActual, parityFixture.expected, "fixture is stale: run `npx tsx tools/genParityFixture.ts` and commit it");
});

test("profile fields are optional: metadata without them is unchanged, and with them it validates", () => {
  const base = sample();
  assert.equal("description" in base || "website" in base || "supportUrl" in base, false, "nothing is added unless the env vars are set");
  sponsorMetadataSchema.parse(base);
  sponsorMetadataSchema.parse({ ...base, description: "Fast, cheap gas.", website: "https://sponsor.example", supportUrl: "https://sponsor.example/help" });
});

test("optional profile fields validate when present; bad ones are rejected", () => {
  const m = {
    ...sample(),
    description: "Fast, cheap gas.",
    website: "https://sponsor.example",
    supportUrl: "https://sponsor.example/help",
  };
  sponsorMetadataSchema.parse(m);
  assert.throws(() => sponsorMetadataSchema.parse({ ...m, website: "http://insecure.example" }), /https/);
  assert.throws(() => sponsorMetadataSchema.parse({ ...m, supportUrl: "javascript:alert(1)" }));
  assert.throws(() => sponsorMetadataSchema.parse({ ...m, description: "x".repeat(281) }));
  assert.throws(() => sponsorMetadataSchema.parse({ ...m, description: "" }));
});

test("the payout address is the cold wallet when SPONSOR_PAYOUT_ADDRESS is set", () => {
  const previous = process.env.SPONSOR_PAYOUT_ADDRESS;
  process.env.SPONSOR_PAYOUT_ADDRESS = "0x000000000000000000000000000000000000dEaD";
  try {
    assert.equal(sample().payoutAddress, "0x000000000000000000000000000000000000dEaD");
  } finally {
    if (previous === undefined) delete process.env.SPONSOR_PAYOUT_ADDRESS;
    else process.env.SPONSOR_PAYOUT_ADDRESS = previous;
  }
});
test("the metadata we publish matches the schema", () => {
  sponsorMetadataSchema.parse(sample());
});

test("the published bytes are reproducible (no timestamp): same input, same bytes, same hash", () => {
  const a = serializeMetadata(buildMetadata());
  const b = serializeMetadata(buildMetadata());
  assert.equal(a, b);
  assert.equal(metadataHashOf(a), metadataHashOf(b));
  assert.ok(!/updatedAt/.test(a));
});

test("the hash is keccak256 of the exact UTF-8 bytes (what the web proxy and wallet recompute)", () => {
  const body = serializeMetadata(buildMetadata());
  assert.equal(metadataHashOf(body), keccak256(stringToBytes(body)));
  // any single-character change moves the hash
  assert.notEqual(metadataHashOf(body), metadataHashOf(body + " "));
  assert.notEqual(metadataHashOf(body), metadataHashOf(body.replace("My Gas Co", "My Gas Cp")));
});

test("bigint values in caveats serialize (they used to break JSON.stringify)", () => {
  const body = serializeMetadata({ n: 1n, nested: { m: 2n } });
  assert.equal(JSON.parse(body).n, "1");
});

test("each plan's caveatsHash equals keccak256 of its (round-tripped) caveat policy", () => {
  const m = sample();
  for (const plan of m.plans) assert.equal(hashCaveatPolicy(plan.caveats), plan.caveatsHash);
});

test("schema rejects a non-https relayer endpoint", () => {
  const m = sample();
  m.relayerEndpoint = "http://relay.example/relay";
  assert.throws(() => sponsorMetadataSchema.parse(m));
});

test("schema rejects unknown top-level and plan fields (strict)", () => {
  const m = sample();
  assert.throws(() => sponsorMetadataSchema.parse({ ...m, extra: 1 }));
  const p = sample();
  p.plans[0].extra = true;
  assert.throws(() => sponsorMetadataSchema.parse(p));
});

test("schema rejects bad addresses, a bad caveatsHash, and an empty plan list", () => {
  let m = sample();
  m.relayer = "0x1234";
  assert.throws(() => sponsorMetadataSchema.parse(m));
  m = sample();
  m.plans[0].caveatsHash = "0x1234";
  assert.throws(() => sponsorMetadataSchema.parse(m));
  m = sample();
  m.plans = [];
  assert.throws(() => sponsorMetadataSchema.parse(m));
});

test("schema rejects an empty name and a non-numeric sponsorId", () => {
  let m = sample();
  m.name = "";
  assert.throws(() => sponsorMetadataSchema.parse(m));
  m = sample();
  m.sponsorId = "abc";
  assert.throws(() => sponsorMetadataSchema.parse(m));
});

test("the plan commitments published with the metadata are the ones the registry checks (CT-04)", () => {
  const fx = JSON.parse(readFileSync(new URL("../fixtures/metadata-parity.json", import.meta.url), "utf8"));
  const rows = buildMetadata().plans;
  assert.ok(rows.length > 0);
  for (const row of rows) {
    assert.equal(commitmentOfRow(row), planCommitment(row.economics, row.caveatsHash as `0x${string}`));
    // every term is part of it
    const c = commitmentOfRow(row);
    for (const changed of [{ price: (BigInt(row.economics.price) + 1n).toString() }, { quota: (BigInt(row.economics.quota) + 1n).toString() }, { period: (BigInt(row.economics.period) + 1n).toString() }, { model: (row.economics.model + 1) % 3 }, { paymentToken: "0x" + "11".repeat(20) }]) {
      assert.notEqual(planCommitment({ ...row.economics, ...changed }, row.caveatsHash as `0x${string}`), c, JSON.stringify(changed));
    }
  }
  assert.equal(fx.expected.commitments.length, fx.input.plans.length);
});

test("plan terms the registry would refuse are reported before anything is sent", () => {
  const ok = { paymentToken: "0x" + "11".repeat(20), model: 1, price: "100", quota: "10", period: "0" };
  assert.deepEqual(economicsProblems(ok), []);
  assert.match(economicsProblems({ ...ok, price: (2n ** 128n).toString() }).join(), /ceiling/);
  assert.match(economicsProblems({ ...ok, quota: "0" }).join(), /quota/);
  assert.match(economicsProblems({ ...ok, model: 2, period: "60" }).join(), /one hour/);
  assert.match(economicsProblems({ ...ok, model: 3 }).join(), /model/);
});

console.log(`\n${passed}/${total} passed`);
if (passed !== total) process.exitCode = 1;
