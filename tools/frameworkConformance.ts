/**
 * Read-only conformance check for a DelegationManager + DeleGator implementation + enforcer set.
 * Run it against MetaMask's Polygon deployment today and against our own deployment before switching
 * (it doubles as the audit hand-off checklist for the surface this repo depends on). Sends no transactions.
 *
 *   RPC_URL=… DELEGATION_MANAGER=0x… DELEGATOR_IMPLEMENTATION=0x… npm run check:framework
 */
import { type Address } from "viem";
import { config } from "../src/config.js";
import { publicClient } from "../src/lib/clients.js";
import { delegationManagerAbi } from "../src/abi.js";
import { hasSelector } from "../src/sponsor/doctorChecks.js";

const MANAGER_SIGS = [
  "redeemDelegations(bytes[],bytes32[],bytes[])",
  "getDelegationHash((address,address,bytes32,(address,bytes,bytes)[],uint256,bytes))",
];
const ACCOUNT_SIGS = ["executeFromExecutor(bytes32,bytes)", "isValidSignature(bytes32,bytes)", "delegationManager()"];

let failed = false;
const line = (ok: boolean, msg: string) => { if (!ok) failed = true; console.log(`${ok ? "ok  " : "FAIL"} ${msg}`); };

const code = async (a: Address) => publicClient.getCode({ address: a });
const managerCode = await code(config.delegationManager);
const implCode = await code(config.delegatorImplementation);

line(!!managerCode && managerCode !== "0x", `DelegationManager has code (${config.delegationManager})`);
for (const s of MANAGER_SIGS) line(hasSelector(managerCode, s), `manager exposes ${s.split("(")[0]}`);
line(!!implCode && implCode !== "0x", `DeleGator implementation has code (${config.delegatorImplementation})`);
for (const s of ACCOUNT_SIGS) line(hasSelector(implCode, s), `implementation exposes ${s.split("(")[0]}`);

try {
  const trusted = (await publicClient.readContract({ address: config.delegatorImplementation, abi: [{ type: "function", name: "delegationManager", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] }], functionName: "delegationManager" })) as Address;
  line(trusted.toLowerCase() === config.delegationManager.toLowerCase(), `implementation trusts DELEGATION_MANAGER (it trusts ${trusted})`);
} catch { line(false, "could not read delegationManager() on the implementation"); }

try {
  const paused = await publicClient.readContract({ address: config.delegationManager, abi: delegationManagerAbi, functionName: "paused" });
  const owner = await publicClient.readContract({ address: config.delegationManager, abi: delegationManagerAbi, functionName: "owner" });
  line(paused === false, `manager not paused; owner ${owner}`);
} catch { line(false, "could not read paused()/owner() on the manager"); }

for (const [name, a] of [["RedeemerRestriction", config.redeemerRestrictionEnforcer], ["LimitedCalls", config.limitedCallsEnforcer], ["ExactExecutionBatch", config.exactExecutionBatchEnforcer], ["Timestamp", config.timestampEnforcer]] as const) {
  const c = await code(a);
  line(!!c && c !== "0x" && hasSelector(c, "beforeHook(bytes,bytes,bytes32,bytes,bytes32,address,address)"), `${name} enforcer has code and beforeHook`);
}
console.log(failed ? "\nNOT compatible" : "\nCompatible with what this repo relies on");
process.exit(failed ? 1 : 0);
