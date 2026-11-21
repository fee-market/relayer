/**
 * The dummy user (0 native balance, already 7702-upgraded + subscribed via bootstrapSubscribe.ts)
 * signs a delegation for a plain test-USDT transfer and posts it to the REAL /relay HTTP endpoint —
 * this is the actual "choose sponsor, interact via sponsor node rpc" step.
 *
 *   npm run e2e:mainnet-transfer -- <subscriptionId> <toAddress> <amount>
 */
import { readFileSync } from "node:fs";
import { type Address, type Hex, encodeAbiParameters, encodeFunctionData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { config, BATCH_DEFAULT_MODE, ROOT_AUTHORITY, ANY_DELEGATE } from "../src/config.js";
import { chargeExecution, pinnedCaveats } from "./lib/pinned.js";

const DUMMY_PK = readFileSync(new URL("../.dummy-user.env", import.meta.url), "utf8")
  .split("=")[1]!.trim() as Hex;
const dummy = privateKeyToAccount(DUMMY_PK);

const RELAYER_URL = process.env.RELAYER_URL ?? "http://localhost:8787";
const RELAYER_ADDR = privateKeyToAccount(process.env.RELAYER_PRIVATE_KEY as Hex).address;

const MOCK_USDT = process.argv[5] as Address; // pass explicitly to avoid guessing
const subscriptionId = process.argv[2] ?? "1";
const to = process.argv[3] as Address;
const amount = BigInt(process.argv[4] ?? "1000000"); // default 1 test-USDT (6 decimals)

const erc20Abi = [
  { type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
] as const;

const delegationTypes = {
  Caveat: [{ name: "enforcer", type: "address" }, { name: "terms", type: "bytes" }],
  Delegation: [
    { name: "delegate", type: "address" }, { name: "delegator", type: "address" }, { name: "authority", type: "bytes32" },
    { name: "caveats", type: "Caveat[]" }, { name: "salt", type: "uint256" },
  ],
} as const;

async function main() {
  console.log("dummy user:", dummy.address, "-> transferring", amount.toString(), "test-USDT to", to);

  const transferCalldata = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, amount] });
  const executionCallData = encodeAbiParameters(
    [{ type: "tuple[]", components: [{ name: "target", type: "address" }, { name: "value", type: "uint256" }, { name: "callData", type: "bytes" }] }],
    [[{ target: MOCK_USDT, value: 0n, callData: transferCalldata }, chargeExecution(config.feeMarketRegistry, BigInt(subscriptionId))]] as never,
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


  const res = await fetch(`${RELAYER_URL}/relay`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ subscriptionId, delegations: [delegation], mode: BATCH_DEFAULT_MODE, executionCallData }),
  });
  const body = await res.json();
  console.log("relay response:", body);
  if (!body.ok) throw new Error("relay failed");
}

main().catch((e) => { console.error("✗", e.message ?? e); process.exit(1); });
