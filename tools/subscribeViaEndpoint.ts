/**
 * Drives the REAL POST /subscribe endpoint as a 0-native-balance user — no bootstrap script, no
 * direct redeemDelegations call. This is what a production wallet/dApp would do.
 *
 *   npm run e2e:subscribe -- <dummyKeyFile> <planId> <amount>
 */
import { readFileSync } from "node:fs";
import { type Address, type Hex, createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { config, ANY_DELEGATE, ROOT_AUTHORITY } from "../src/config.js";
import { pinnedCaveats } from "./lib/pinned.js";
import { encodeAbiParameters, encodeFunctionData } from "viem";

const keyFile = process.argv[2] ?? ".dummy-user-2.env";
const PLAN_ID = BigInt(process.argv[3] ?? "1");
const AMOUNT = BigInt(process.argv[4] ?? "10000000"); // default: full Bulk price (10 USDC-equivalent)

const DUMMY_PK = readFileSync(new URL(`../${keyFile}`, import.meta.url), "utf8")
  .split("=")[1]!.trim() as Hex;
const dummy = privateKeyToAccount(DUMMY_PK);

const RELAYER_URL = process.env.RELAYER_URL ?? "http://localhost:8787";
const RELAYER_ADDR = privateKeyToAccount(process.env.RELAYER_PRIVATE_KEY as Hex).address;

const delegationTypes = {
  Caveat: [{ name: "enforcer", type: "address" }, { name: "terms", type: "bytes" }],
  Delegation: [
    { name: "delegate", type: "address" }, { name: "delegator", type: "address" }, { name: "authority", type: "bytes32" },
    { name: "caveats", type: "Caveat[]" }, { name: "salt", type: "uint256" },
  ],
} as const;

const feeMarketRegistryAbi = [
  { type: "function", name: "subscribe", stateMutability: "nonpayable", inputs: [{ name: "_planId", type: "uint256" }, { name: "_amount", type: "uint256" }], outputs: [{ type: "uint256" }] },
] as const;
const erc20Abi = [
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
] as const;
const PAYMENT_TOKEN = process.argv[5] as `0x${string}` | undefined; // pass to include an approve() call first

async function main() {
  console.log("dummy user:", dummy.address, "-> POST /subscribe (planId", PLAN_ID.toString(), "amount", AMOUNT.toString(), ")");

  const publicClient = createPublicClient({ transport: http(config.rpcUrl) });
  const nonce = await publicClient.getTransactionCount({ address: dummy.address });
  console.log("dummy native balance:", await publicClient.getBalance({ address: dummy.address }));

  const subscribeCalldata = encodeFunctionData({ abi: feeMarketRegistryAbi, functionName: "subscribe", args: [PLAN_ID, AMOUNT] });
  const executions = PAYMENT_TOKEN
    ? [
        { target: PAYMENT_TOKEN, value: 0n, callData: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [config.feeMarketRegistry, AMOUNT] }) },
        { target: config.feeMarketRegistry, value: 0n, callData: subscribeCalldata },
      ]
    : [{ target: config.feeMarketRegistry, value: 0n, callData: subscribeCalldata }];
  const executionCallData = encodeAbiParameters(
    [{ type: "tuple[]", components: [{ name: "target", type: "address" }, { name: "value", type: "uint256" }, { name: "callData", type: "bytes" }] }],
    [executions] as never,
  );

  // every delegation pins: relayer-only redeemer, single use, the exact batch, a deadline
  const caveats = pinnedCaveats(RELAYER_ADDR as Address, executionCallData);
  const message = {
    delegate: ANY_DELEGATE, delegator: dummy.address, authority: ROOT_AUTHORITY,
    caveats: caveats.map((c) => ({ enforcer: c.enforcer, terms: c.terms })), salt: BigInt(Date.now()) * 1_000_000n + BigInt(Math.floor(Math.random() * 1_000_000)),
  };
  const signature = await dummy.signTypedData({
    domain: { name: "DelegationManager", version: "1", chainId: config.chainId, verifyingContract: config.delegationManager },
    types: delegationTypes, primaryType: "Delegation", message,
  });
  const delegation = { ...message, caveats, signature, salt: message.salt.toString() };

  let authorization: object | undefined;
  const code = await publicClient.getCode({ address: dummy.address });
  if (!code || code === "0x") {
    const auth = await dummy.signAuthorization({ chainId: config.chainId, contractAddress: config.delegatorImplementation, nonce });
    authorization = { chainId: config.chainId, address: config.delegatorImplementation, nonce, r: auth.r, s: auth.s, yParity: auth.yParity ?? (auth.v === 27n ? 0 : 1) };
    console.log("(signed 7702 authorization — first use for this EOA)");
  } else {
    console.log("(EOA already upgraded, skipping authorization)");
  }

  const res = await fetch(`${RELAYER_URL}/subscribe`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ delegations: [delegation], executionCallData, ...(authorization ? { authorization } : {}) }),
  });
  const body = await res.json();
  console.log("subscribe response:", body);
  if (!body.ok) throw new Error("subscribe failed");
}

main().catch((e) => { console.error("✗", e.message ?? e); process.exit(1); });
