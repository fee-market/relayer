/**
 * End-to-end local test: acts as the USER's wallet against a running sponsor node + forked anvil.
 *
 *   1. reads the addresses deployed by contracts/script/LocalSetup.s.sol
 *   2. builds + signs an ERC-7710 delegation (ANY_DELEGATE, locked to the sponsor relayer)
 *   3. signs the EIP-7702 authorization (upgrades the user EOA to the DeleGator)
 *   4. POSTs to the sponsor node's /relay (the node pays gas and redeems; the batch's last call is the user's own chargeUsage)
 *   5. asserts the spend happened and the subscription was debited
 *
 *   npm run e2e
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  type Address,
  type Hex,
  createPublicClient,
  encodeAbiParameters,
  encodeFunctionData,
  http,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { chargeExecution, pinnedCaveats } from "./lib/pinned.js";

const RELAYER_URL = process.env.RELAYER_URL ?? "http://localhost:8787";
const RPC_URL = process.env.RPC_URL ?? "http://localhost:8545";
const CHAIN_ID = Number(process.env.CHAIN_ID ?? "137");

const DELEGATION_MANAGER = (process.env.DELEGATION_MANAGER ?? "0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3") as Address;
const DELEGATOR_IMPL = (process.env.DELEGATOR_IMPLEMENTATION ?? "0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B") as Address;
const ANY_DELEGATE = "0x0000000000000000000000000000000000000a11" as Address;
const ROOT_AUTHORITY = `0x${"ff".repeat(32)}` as Hex;
const BATCH_MODE = `0x01${"00".repeat(31)}` as Hex;
const RELAYER_ADDR = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Address;
const RECIPIENT = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as Address;

const USER_KEY = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a" as Hex; // anvil #2
const user = privateKeyToAccount(USER_KEY);

const here = dirname(fileURLToPath(import.meta.url));
const dep = JSON.parse(readFileSync(join(here, "../../contracts/deployments/local.json"), "utf8"));

const publicClient = createPublicClient({ transport: http(RPC_URL) });

const erc20Abi = [
  { type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;
const registryAbi = [
  { type: "function", name: "subscriptions", stateMutability: "view", inputs: [{ name: "", type: "uint256" }], outputs: [
    { name: "planId", type: "uint256" }, { name: "user", type: "address" }, { name: "balance", type: "uint256" },
    { name: "txnsRemaining", type: "uint256" }, { name: "expiry", type: "uint256" }] },
] as const;

const delegationTypes = {
  Caveat: [{ name: "enforcer", type: "address" }, { name: "terms", type: "bytes" }],
  Delegation: [
    { name: "delegate", type: "address" }, { name: "delegator", type: "address" }, { name: "authority", type: "bytes32" },
    { name: "caveats", type: "Caveat[]" }, { name: "salt", type: "uint256" },
  ],
} as const;

async function main() {
  console.log("user:", user.address);
  console.log("registry:", dep.registry, "token:", dep.token);

  const recipientBefore = (await publicClient.readContract({ address: dep.token, abi: erc20Abi, functionName: "balanceOf", args: [RECIPIENT] })) as bigint;
  const subBefore = (await publicClient.readContract({ address: dep.registry, abi: registryAbi, functionName: "subscriptions", args: [BigInt(dep.subscriptionId)] })) as readonly [bigint, Address, bigint, bigint, bigint];

  // 3. execution batch: transfer 1000 token units from the user's (DeleGator) account
  const transfer = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [RECIPIENT, 1000n] });
  const executionCallData = encodeAbiParameters(
    [{ type: "tuple[]", components: [{ name: "target", type: "address" }, { name: "value", type: "uint256" }, { name: "callData", type: "bytes" }] }],
    [[{ target: dep.token, value: 0n, callData: transfer }, chargeExecution(dep.registry as Address, BigInt(dep.subscriptionId))]] as never,
  );

  // every delegation pins: relayer-only redeemer, single use, the exact batch, a deadline
  const caveats = pinnedCaveats(RELAYER_ADDR as Address, executionCallData, dep.enforcer as Address);

  // 2. sign delegation
  const message = {
    delegate: ANY_DELEGATE, delegator: user.address, authority: ROOT_AUTHORITY,
    caveats: caveats.map((c) => ({ enforcer: c.enforcer, terms: c.terms })), salt: BigInt(Date.now()) * 1_000_000n + BigInt(Math.floor(Math.random() * 1_000_000)),
  };
  const signature = await user.signTypedData({
    domain: { name: "DelegationManager", version: "1", chainId: CHAIN_ID, verifyingContract: DELEGATION_MANAGER },
    types: delegationTypes, primaryType: "Delegation", message,
  });
  const delegation = { ...message, salt: message.salt.toString(), caveats, signature };


  // 4. sign 7702 authorization (first-time EOA upgrade)
  const nonce = await publicClient.getTransactionCount({ address: user.address });
  const auth = await user.signAuthorization({ chainId: CHAIN_ID, contractAddress: DELEGATOR_IMPL, nonce });

  // 5. relay
  const res = await fetch(`${RELAYER_URL}/relay`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      subscriptionId: String(dep.subscriptionId), delegations: [delegation], mode: BATCH_MODE, executionCallData,
      authorization: { chainId: CHAIN_ID, address: DELEGATOR_IMPL, nonce, r: auth.r, s: auth.s, yParity: auth.yParity ?? (auth.v === 27n ? 0 : 1) },
    }),
  });
  const body = await res.json();
  console.log("relay response:", body);
  if (!body.ok) throw new Error("relay failed");

  // 6. assert effects
  const recipientAfter = (await publicClient.readContract({ address: dep.token, abi: erc20Abi, functionName: "balanceOf", args: [RECIPIENT] })) as bigint;
  const subAfter = (await publicClient.readContract({ address: dep.registry, abi: registryAbi, functionName: "subscriptions", args: [BigInt(dep.subscriptionId)] })) as readonly [bigint, Address, bigint, bigint, bigint];

  console.log(`recipient balance: ${recipientBefore} -> ${recipientAfter} (+${recipientAfter - recipientBefore})`);
  console.log(`sub escrow:        ${subBefore[2]} -> ${subAfter[2]} (-${subBefore[2] - subAfter[2]})`);

  if (recipientAfter - recipientBefore !== 1000n) throw new Error("spend did not execute");
  if (subBefore[2] - subAfter[2] !== 10000n) throw new Error("chargeUsage did not debit");
  console.log("\nE2E PASSED ✅  (sponsored transfer executed + subscription charged by the user's own call)");
}

main().catch((e) => { console.error("E2E FAILED ❌", e); process.exit(1); });
