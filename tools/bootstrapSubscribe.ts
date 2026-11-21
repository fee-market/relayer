/**
 * One-time bootstrap: the dummy user (0 native balance) signs a delegation + EIP-7702 authorization
 * for FeeMarketRegistry.subscribe(planId, 0), and the relayer submits it directly (paying gas).
 *
 * This bypasses the /relay HTTP endpoint deliberately: /relay's validator requires an existing
 * subscriptionId to check funds against, but this step is what CREATES that subscriptionId. A real
 * "choose sponsor" dApp flow would need a dedicated bootstrap endpoint for this — out of scope here,
 * this script stands in for it.
 *
 *   npm run e2e:bootstrap
 */
import { readFileSync } from "node:fs";
import {
  type Address,
  type Hex,
  encodeAbiParameters,
  encodeFunctionData,
  createPublicClient,
  http,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { config, BATCH_DEFAULT_MODE, ROOT_AUTHORITY, ANY_DELEGATE } from "../src/config.js";
import { pinnedCaveats } from "./lib/pinned.js";
import { feeMarketRegistryAbi, delegationManagerAbi } from "../src/abi.js";
import { sendTransactionSafe, publicClient as relayerPublicClient } from "../src/lib/clients.js";

const DUMMY_PK = readFileSync(new URL("../.dummy-user.env", import.meta.url), "utf8")
  .split("=")[1]!.trim() as Hex;
const dummy = privateKeyToAccount(DUMMY_PK);

const PLAN_ID = BigInt(process.argv[2] ?? "2"); // default: "Pay As You Go" (PER_TXN)
const DELEGATION_MANAGER = config.delegationManager;
const RELAYER_ADDR = process.env.RELAYER_PRIVATE_KEY
  ? privateKeyToAccount(process.env.RELAYER_PRIVATE_KEY as Hex).address
  : ("0x0000000000000000000000000000000000000000" as Address);

const delegationTypes = {
  Caveat: [{ name: "enforcer", type: "address" }, { name: "terms", type: "bytes" }],
  Delegation: [
    { name: "delegate", type: "address" }, { name: "delegator", type: "address" }, { name: "authority", type: "bytes32" },
    { name: "caveats", type: "Caveat[]" }, { name: "salt", type: "uint256" },
  ],
} as const;

async function main() {
  console.log("dummy user:", dummy.address);

  const publicClient = createPublicClient({ transport: http(config.rpcUrl) });
  const nonce = await publicClient.getTransactionCount({ address: dummy.address });
  console.log("dummy nonce:", nonce, "(0 expected — never sent a tx, since it has 0 native balance)");

  // 2. execution batch: subscribe(planId, 0) — zero-amount escrow, needs no token balance/allowance.
  const subscribeCalldata = encodeFunctionData({
    abi: feeMarketRegistryAbi, functionName: "subscribe", args: [PLAN_ID, 0n],
  });
  const executionCallData = encodeAbiParameters(
    [{ type: "tuple[]", components: [{ name: "target", type: "address" }, { name: "value", type: "uint256" }, { name: "callData", type: "bytes" }] }],
    [[{ target: config.feeMarketRegistry, value: 0n, callData: subscribeCalldata }]] as never,
  );

  // every delegation pins: relayer-only redeemer, single use, the exact batch, a deadline
  const caveats = pinnedCaveats(RELAYER_ADDR as Address, executionCallData);

  const message = {
    delegate: ANY_DELEGATE, delegator: dummy.address, authority: ROOT_AUTHORITY,
    caveats: caveats.map((c) => ({ enforcer: c.enforcer, terms: c.terms })), salt: BigInt(Date.now()) * 1_000_000n + BigInt(Math.floor(Math.random() * 1_000_000)),
  };
  const signature = await dummy.signTypedData({
    domain: { name: "DelegationManager", version: "1", chainId: config.chainId, verifyingContract: DELEGATION_MANAGER },
    types: delegationTypes, primaryType: "Delegation", message,
  });
  const delegation = { ...message, caveats, signature };

  const permissionContext = encodeAbiParameters(
    [{
      type: "tuple[]",
      components: [
        { name: "delegate", type: "address" }, { name: "delegator", type: "address" }, { name: "authority", type: "bytes32" },
        { name: "caveats", type: "tuple[]", components: [{ name: "enforcer", type: "address" }, { name: "terms", type: "bytes" }, { name: "args", type: "bytes" }] },
        { name: "salt", type: "uint256" }, { name: "signature", type: "bytes" },
      ],
    }],
    [[delegation]] as never,
  );


  // 3. sign 7702 authorization (first-time upgrade for this EOA).
  const auth = await dummy.signAuthorization({ chainId: config.chainId, contractAddress: config.delegatorImplementation, nonce });

  // 4. submit directly (relayer pays gas) — mirrors what redeemDelegations does, bypassing /relay's
  //    subscription-funds validator since there's no subscriptionId yet.
  const redeemData = encodeFunctionData({
    abi: delegationManagerAbi,
    functionName: "redeemDelegations",
    args: [[permissionContext], [BATCH_DEFAULT_MODE], [executionCallData]],
  });

  const hash = await sendTransactionSafe({
    to: DELEGATION_MANAGER,
    data: redeemData,
    // Explicit gas: skip viem's automatic estimateGas. Many RPC providers don't correctly simulate
    // an EIP-7702 authorizationList's effect during eth_estimateGas (the account still looks like an
    // empty EOA at simulation time), causing a false revert — even though the REAL broadcast applies
    // the authorization atomically before execution and succeeds. See redeemer.ts's preflight() for
    // the same caveat on the production /relay path.
    gas: 500_000n,
    authorizationList: [{ chainId: config.chainId, address: config.delegatorImplementation, nonce, r: auth.r, s: auth.s, yParity: auth.yParity ?? (auth.v === 27n ? 0 : 1) }],
  });
  console.log("submitted:", hash);
  const receipt = await relayerPublicClient.waitForTransactionReceipt({ hash });
  console.log("status:", receipt.status);
  if (receipt.status !== "success") throw new Error("bootstrap subscribe reverted");

  const nextId = (await publicClient.readContract({
    address: config.feeMarketRegistry, abi: feeMarketRegistryAbi, functionName: "nextSubscriptionId",
  })) as bigint;
  console.log(`\n✓ subscribed. subscriptionId = ${nextId - 1n}`);
}

main().catch((e) => { console.error("✗", e); process.exit(1); });
