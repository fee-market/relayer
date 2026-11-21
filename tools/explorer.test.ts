/**
 * Offline tests for the explorer proxy: which requests are forwarded, what is refused, that the key is added upstream only,
 * and the short cache.
 *   npm run test:explorer
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
process.env.ETHERSCAN_API_KEY = "test-key";

const { buildExplorerQuery, explorerFetch, clearExplorerCache } = await import("../src/services/explorerProxy.js");
const { config } = await import("../src/config.js");

const USER = "0x1111111111111111111111111111111111111111";
const WORD = "0x" + "ab".repeat(32);
let passed = 0, total = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  total++;
  try { await fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); process.exitCode = 1; }
}
const q = (o: Record<string, string>) => buildExplorerQuery(o);

await test("a native history request is forwarded with fixed range and order", () => {
  const r = q({ chainid: "137", module: "account", action: "txlist", address: USER });
  assert.ok(r instanceof URLSearchParams);
  assert.equal(r.get("sort"), "desc"); assert.equal(r.get("startblock"), "0"); assert.equal(r.get("page"), "1");
  assert.equal(r.get("apikey"), null);
});
await test("a token history request keeps the contract address", () => {
  const r = q({ module: "account", action: "tokentx", address: USER, contractaddress: USER });
  assert.ok(r instanceof URLSearchParams); assert.equal(r.get("contractaddress"), USER);
});
await test("a usage log request is forwarded for the registry only", () => {
  assert.ok(q({ module: "logs", action: "getLogs", address: config.feeMarketRegistry, topic0: WORD, topic1: WORD }) instanceof URLSearchParams);
  assert.equal(typeof q({ module: "logs", action: "getLogs", address: USER, topic0: WORD, topic1: WORD }), "string");
});
await test("other modules and actions are refused", () => {
  for (const o of [{ module: "proxy", action: "eth_getBalance", address: USER }, { module: "account", action: "balance", address: USER },
    { module: "contract", action: "getabi", address: USER }, { module: "account", action: "txlistinternal", address: USER }, {}])
    assert.equal(typeof q(o), "string");
});
await test("bad addresses, chains, pages and sizes are refused", () => {
  const base = { module: "account", action: "txlist", address: USER };
  assert.equal(typeof q({ ...base, address: "0x12" }), "string");
  assert.equal(typeof q({ ...base, chainid: "5" }), "string");
  assert.equal(typeof q({ ...base, page: "0" }), "string");
  assert.equal(typeof q({ ...base, page: "21" }), "string");
  assert.equal(typeof q({ ...base, offset: "1001" }), "string");
  assert.equal(typeof q({ ...base, offset: "1e3" }), "string");
  assert.equal(typeof q({ ...base, contractaddress: "nope" }), "string");
});
await test("repeated parameters (arrays) are not accepted as values", () => {
  assert.equal(typeof buildExplorerQuery({ module: "account", action: "txlist", address: [USER, USER] }), "string");
});
await test("the key is added upstream, the answer is passed through, and a repeat is served from the cache", async () => {
  clearExplorerCache();
  let calls = 0, seen = "";
  const fake = (async (url: string) => { calls++; seen = url; return new Response('{"status":"1","result":[]}', { status: 200 }); }) as unknown as typeof fetch;
  const query = q({ module: "account", action: "txlist", address: USER }) as URLSearchParams;
  const a = await explorerFetch(query, fake), b = await explorerFetch(query, fake);
  assert.equal(a.status, 200); assert.equal(a.body, '{"status":"1","result":[]}');
  assert.ok(seen.includes("apikey=test-key")); assert.equal(calls, 1); assert.equal(b.body, a.body);
});
await test("an upstream failure is a 502 and is not cached", async () => {
  clearExplorerCache();
  let calls = 0;
  const bad = (async () => { calls++; return new Response("x", { status: 500 }); }) as unknown as typeof fetch;
  const query = q({ module: "account", action: "txlist", address: USER }) as URLSearchParams;
  assert.equal((await explorerFetch(query, bad)).status, 502);
  assert.equal((await explorerFetch(query, bad)).status, 502); assert.equal(calls, 2);
});

console.log(`\n${passed}/${total} passed`);
