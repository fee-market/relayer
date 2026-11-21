/**
 * Drives the REAL POST /topup endpoint as a 0-native-balance user.
 *
 *   npm run e2e:topup -- <dummyKeyFile> <subscriptionId> <amount> [paymentTokenForApprove]
 */
import { readFileSync } from "node:fs";
import { type Address, type Hex, createPublicClient, encodeAbiParameters, encodeFunctionData, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { config, ANY_DELEGATE, ROOT_AUTHORITY } from "../src/config.js";
import { pinnedCaveats } from "./lib/pinned.js";

const keyFile = process.argv[2] ?? ".dummy-user-2.env";
const SUBSCRIPTION_ID = BigInt(process.argv[3] ?? "1");
const AMOUNT = BigInt(process.argv[4] ?? "5000000");
const PAYMENT_TOKEN = process.argv[5] as `0x${string}` | undefined;

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
  { type: "function", name: "topUp", stateMutability: "nonpayable", inputs: [{ name: "_subscriptionId", type: "uint256" }, { name: "_amount", type: "uint256" }], outputs: [] },
] as const;
const erc20Abi = [
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
] as const;

async function main() {
  console.log("dummy user:", dummy.address, "-> POST /topup (subscriptionId", SUBSCRIPTION_ID.toString(), "amount", AMOUNT.toString(), ")");

  const publicClient = createPublicClient({ transport: http(config.rpcUrl) });
  console.log("dummy native balance:", await publicClient.getBalance({ address: dummy.address }));

  const topUpCalldata = encodeFunctionData({ abi: feeMarketRegistryAbi, functionName: "topUp", args: [SUBSCRIPTION_ID, AMOUNT] });
  const executions = PAYMENT_TOKEN
    ? [
        { target: PAYMENT_TOKEN, value: 0n, callData: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [config.feeMarketRegistry, AMOUNT] }) },
        { target: config.feeMarketRegistry, value: 0n, callData: topUpCalldata },
      ]
    : [{ target: config.feeMarketRegistry, value: 0n, callData: topUpCalldata }];
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

  const res = await fetch(`${RELAYER_URL}/topup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ delegations: [delegation], executionCallData }),
  });
  const body = await res.json();
  console.log("topup response:", body);
  if (!body.ok) throw new Error("topup failed");
}

main().catch((e) => { console.error("✗", e.message ?? e); process.exit(1); });
