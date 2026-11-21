/**
 * Offline tests for the relayer hardening (no real chain): batch limits and allowlist, first-use authorization
 * checks, payment pre-checks, and preflight's gas cap / state-override simulation against a mock JSON-RPC node.
 *   npm run test:hardening
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { encodeAbiParameters, getAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

// --- a tiny JSON-RPC node: only what preflight touches ---------------------------------------------------------
type Rpc = { method: string; params: unknown[] };
const seen: Rpc[] = [];
let estimate: (p: unknown[]) => { result?: string; error?: { code: number; message: string } } = () => ({ result: "0x30d40" }); // 200,000
const node = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const { id, method, params } = JSON.parse(body) as { id: number; method: string; params: unknown[] };
    seen.push({ method, params });
    const reply = (o: object) => res.setHeader("content-type", "application/json").end(JSON.stringify({ jsonrpc: "2.0", id, ...o }));
    if (method === "eth_chainId") return reply({ result: "0x89" });
    if (method === "eth_gasPrice") return reply({ result: "0x" + (100_000_000_000n).toString(16) }); // 100 gwei
    if (method === "eth_estimateGas") return reply(estimate(params));
    if (method === "eth_getTransactionCount") return reply({ result: "0x0" });
    if (method === "eth_maxPriorityFeePerGas") return reply({ result: "0x" + (30_000_000_000n).toString(16) });
    if (method === "eth_getBlockByNumber") {
      return reply({
        result: {
          number: "0x1", hash: "0x" + "11".repeat(32), parentHash: "0x" + "00".repeat(32), timestamp: "0x65000000", gasLimit: "0x1c9c380", gasUsed: "0x0",
          baseFeePerGas: "0x" + (70_000_000_000n).toString(16), miner: "0x" + "00".repeat(20), nonce: "0x0000000000000000", difficulty: "0x0", totalDifficulty: "0x0",
          sha3Uncles: "0x" + "00".repeat(32), logsBloom: "0x" + "00".repeat(256), transactionsRoot: "0x" + "00".repeat(32), stateRoot: "0x" + "00".repeat(32),
          receiptsRoot: "0x" + "00".repeat(32), extraData: "0x", size: "0x1", uncles: [], transactions: [],
        },
      });
    }
    return reply({ error: { code: -32601, message: `unmocked ${method}` } });
  });
});
await new Promise<void>((r) => node.listen(0, "127.0.0.1", r));
const rpcUrl = `http://127.0.0.1:${(node.address() as AddressInfo).port}`;

const ALLOWED = "0x2222222222222222222222222222222222222222";
process.env.RPC_URL = rpcUrl;
process.env.CHAIN_ID = "137";
process.env.RELAYER_PRIVATE_KEY ??= "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
process.env.DELEGATION_MANAGER ??= "0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3";
process.env.DELEGATOR_IMPLEMENTATION ??= "0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B";
process.env.FEE_MARKET_REGISTRY ??= "0x57e6742610229c7Ce09df3028471397DaaE6B9f4";
process.env.REDEEMER_RESTRICTION_ENFORCER ??= "0x5C75d7ee6d3d27634bec15e96538e794F9c7053b";
process.env.SPONSOR_ID ??= "1";
process.env.MAX_BATCH_CALLS = "4";
process.env.MAX_BATCH_CALLDATA_BYTES = "1024";
process.env.ALLOWED_TARGETS = ALLOWED;
process.env.MAX_GAS_UNITS = "600000";
process.env.MAX_GAS_WEI = "100000000000000000"; // 0.1; 100 gwei -> any estimate above 1,000,000 gas is over this

const { config } = await import("../src/config.js");
const { validateBatchLimits } = await import("../src/services/batchValidation.js");
const { validateAuthorization, delegationTargetOf } = await import("../src/services/authorization.js");
const { checkUserCanPay } = await import("../src/services/payment.js");
const { preflight } = await import("../src/services/redeemer.js");

let passed = 0;
let total = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  total++;
  try { await fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); process.exitCode = 1; }
}

type E = { target: Address; value: bigint; callData: Hex };
const enc = (execs: E[]): Hex =>
  encodeAbiParameters(
    [{ type: "tuple[]", components: [{ name: "target", type: "address" }, { name: "value", type: "uint256" }, { name: "callData", type: "bytes" }] }],
    [execs] as never,
  );
const call = (target: Address, callData: Hex = "0x12345678"): E => ({ target, value: 0n, callData });
const registry = config.feeMarketRegistry;

// ---------------------------------------------------------------------------------------------- batch limits
await test("a batch within limits and targets is accepted (registry is always allowed)", () => {
  assert.equal(validateBatchLimits(enc([call(ALLOWED), call(registry)])).ok, true);
});
await test("too many calls is rejected", () => {
  const r = validateBatchLimits(enc([call(ALLOWED), call(ALLOWED), call(ALLOWED), call(ALLOWED), call(registry)]));
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /5 calls, the limit is 4/);
});
await test("oversized calldata is rejected", () => {
  const big = ("0x" + "ab".repeat(2000)) as Hex;
  const r = validateBatchLimits(enc([call(ALLOWED, big), call(registry)]));
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /larger than 1024 bytes/);
});
await test("a target outside ALLOWED_TARGETS is rejected, naming it", () => {
  const other = "0x3333333333333333333333333333333333333333" as Address;
  const r = validateBatchLimits(enc([call(other), call(registry)]));
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /0x3333.*not allowed/i);
});
await test("malformed batch data is rejected", () => {
  assert.equal(validateBatchLimits("0xdeadbeef").ok, false);
});

// ------------------------------------------------------------------------------------------- authorization
const user = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const stranger = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a");
const IMPL = config.delegatorImplementation;
const reqFor = async (opts: { signer?: typeof user; chainId?: number; impl?: Address; nonce?: number; delegator?: Address } = {}) => {
  const signer = opts.signer ?? user;
  const a = await signer.signAuthorization({ chainId: opts.chainId ?? 137, contractAddress: opts.impl ?? IMPL, nonce: opts.nonce ?? 0 });
  return {
    delegations: [{ delegate: relayerAddr(), delegator: opts.delegator ?? user.address, authority: "0x" + "ff".repeat(32), caveats: [], salt: "1", signature: "0x" }],
    executionCallData: "0x" as Hex,
    authorization: { chainId: opts.chainId ?? 137, address: opts.impl ?? IMPL, nonce: opts.nonce ?? 0, r: a.r, s: a.s, yParity: a.yParity ?? 0 },
  };
};
const relayerAddr = (): Address => privateKeyToAccount(process.env.RELAYER_PRIVATE_KEY as Hex).address;
const plain = { getCode: async () => "0x" as Hex, getNonce: async () => 0 };
const reason = (r: { ok: boolean }) => (r as { reason?: string }).reason ?? "";

await test("no authorization attached is fine (the account is already delegated)", async () => {
  const r = await reqFor();
  assert.equal((await validateAuthorization({ ...r, authorization: undefined } as never, plain)).ok, true);
});
await test("a correct first-use authorization is accepted", async () => {
  assert.equal((await validateAuthorization((await reqFor()) as never, plain)).ok, true);
});
await test("an authorization for the wrong chain is rejected", async () => {
  assert.match(reason(await validateAuthorization((await reqFor({ chainId: 1 })) as never, plain)), /chain 1/);
});
await test("an authorization pointing at some other contract is rejected", async () => {
  const other = "0x1111111111111111111111111111111111111111" as Address;
  assert.match(reason(await validateAuthorization((await reqFor({ impl: other })) as never, plain)), /delegator implementation/);
});
await test("an authorization signed by someone other than the delegator is rejected", async () => {
  assert.match(reason(await validateAuthorization((await reqFor({ signer: stranger })) as never, plain)), /not signed by the delegator/);
});
await test("a stale or wrong authorization nonce is rejected", async () => {
  assert.match(reason(await validateAuthorization((await reqFor({ nonce: 3 })) as never, plain)), /nonce 3 .* current nonce 0/);
});
await test("an account that already has contract code cannot be upgraded", async () => {
  const deps = { getCode: async () => "0x6080604052" as Hex, getNonce: async () => 0 };
  assert.match(reason(await validateAuthorization((await reqFor()) as never, deps)), /contract code/);
});
await test("an account already delegated (to us) with a matching nonce passes", async () => {
  const deps = { getCode: async () => (`0xef0100${IMPL.slice(2).toLowerCase()}`) as Hex, getNonce: async () => 0 };
  assert.equal((await validateAuthorization((await reqFor()) as never, deps)).ok, true);
});
await test("delegationTargetOf reads designators and nothing else", () => {
  assert.equal(delegationTargetOf(`0xef0100${IMPL.slice(2).toLowerCase()}` as Hex)?.toLowerCase(), IMPL.toLowerCase());
  assert.equal(delegationTargetOf("0x"), null);
  assert.equal(delegationTargetOf("0x6080"), null);
});

// ------------------------------------------------------------------------------------------------- payment
const token = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359" as Address;
const pay = (balance: bigint, allowance: bigint) => ({ balanceOf: async () => balance, allowance: async () => allowance });
await test("a user who can pay passes", async () => {
  assert.equal((await checkUserCanPay({ user: user.address, token, amount: 10n, batchApproves: false }, pay(10n, 10n))).ok, true);
});
await test("insufficient token balance is rejected", async () => {
  assert.match(reason(await checkUserCanPay({ user: user.address, token, amount: 10n, batchApproves: false }, pay(9n, 99n))), /balance 9 is below/);
});
await test("missing allowance is rejected unless the batch approves first", async () => {
  assert.match(reason(await checkUserCanPay({ user: user.address, token, amount: 10n, batchApproves: false }, pay(99n, 0n))), /not approved/);
  assert.equal((await checkUserCanPay({ user: user.address, token, amount: 10n, batchApproves: true }, pay(99n, 0n))).ok, true);
});

// ------------------------------------------------------------------------------------------------ preflight
const delegation = (delegator: Address) => ({ delegate: relayerAddr(), delegator, authority: "0x" + "ff".repeat(32), caveats: [], salt: "1", signature: "0x" });
const plainReq = { delegations: [delegation(user.address)], executionCallData: "0x" as Hex };
const firstUseReq = async () => ({ ...(await reqFor()), delegations: [delegation(user.address)] });
const lastEstimate = () => seen.filter((s) => s.method === "eth_estimateGas").at(-1)!;

await test("preflight: gas limit is the estimate plus 25% headroom", async () => {
  estimate = () => ({ result: "0x30d40" }); // 200,000
  const r = await preflight(plainReq as never);
  assert.equal(r.ok, true);
  assert.equal(r.gas, 250_000n);
  assert.equal(r.simulated, true);
});
await test("preflight: an estimate above MAX_GAS_UNITS is refused (a heavy batch cannot slip through)", async () => {
  estimate = () => ({ result: "0x" + (700_000).toString(16) });
  const r = await preflight(plainReq as never);
  assert.equal(r.ok, false);
  assert.match(r.reason!, /exceeds this sponsor's limit of 600000/);
});
await test("preflight: the limit never exceeds MAX_GAS_UNITS even with headroom", async () => {
  estimate = () => ({ result: "0x" + (550_000).toString(16) }); // +25% would be 687,500
  const r = await preflight(plainReq as never);
  assert.equal(r.ok, true);
  assert.equal(r.gas, 600_000n);
});
await test("preflight: a revert is reported, not swallowed", async () => {
  estimate = () => ({ error: { code: 3, message: "execution reverted: InsufficientBalance" } });
  const r = await preflight(plainReq as never);
  assert.equal(r.ok, false);
  assert.match(r.reason!, /simulation reverted/);
});
await test("preflight: first use simulates the upgrade by overriding the account's code, and adds the authorization gas", async () => {
  estimate = () => ({ result: "0x30d40" }); // 200,000 + 25,000 authorization
  const r = await preflight((await firstUseReq()) as never);
  assert.equal(r.ok, true);
  assert.equal(r.simulated, true);
  assert.equal(r.gas, 281_250n); // 225,000 * 1.25
  const override = lastEstimate().params[2] as Record<string, { code: string }>;
  const entry = Object.entries(override).find(([a]) => getAddress(a) === user.address);
  assert.ok(entry, "the delegator is in the state override");
  assert.equal(entry![1].code.toLowerCase(), `0xef0100${IMPL.slice(2).toLowerCase()}`);
});
await test("preflight: a plain (already delegated) request sends no state override", async () => {
  estimate = () => ({ result: "0x30d40" });
  await preflight(plainReq as never);
  assert.equal(lastEstimate().params.length <= 2, true);
});
await test("preflight: first use on an RPC that rejects overrides falls back to a capped limit instead of refusing", async () => {
  estimate = (p) => (p.length > 2 ? { error: { code: -32602, message: "invalid argument 2: stateOverride is not supported" } } : { result: "0x30d40" });
  const r = await preflight((await firstUseReq()) as never);
  assert.equal(r.ok, true);
  assert.equal(r.simulated, false);
  assert.ok(r.gas! <= 600_000n);
});
await test("preflight: first use that REVERTS under the override is refused", async () => {
  estimate = (p) => (p.length > 2 ? { error: { code: 3, message: "execution reverted: ERC20: transfer amount exceeds balance" } } : { result: "0x30d40" });
  const r = await preflight((await firstUseReq()) as never);
  assert.equal(r.ok, false);
  assert.match(r.reason!, /simulation reverted/);
});
await test("preflight: a cost above MAX_GAS_WEI is refused", async () => {
  // at 100 gwei, 0.1 token = 1,000,000 gas: MAX_GAS_UNITS (600k) trips first, so exercise the wei cap with a unit cap raised
  (config.policy as { maxGasUnits: bigint }).maxGasUnits = 5_000_000n;
  try {
    estimate = () => ({ result: "0x" + (1_200_000).toString(16) });
    const r = await preflight(plainReq as never);
    assert.equal(r.ok, false);
    assert.match(r.reason!, /gas cost .* exceeds cap/);
  } finally {
    (config.policy as { maxGasUnits: bigint }).maxGasUnits = 600_000n;
  }
});

node.close();
console.log(`\n${passed}/${total} passed`);
if (passed !== total) process.exitCode = 1;
