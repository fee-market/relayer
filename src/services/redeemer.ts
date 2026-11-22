import {
  decodeErrorResult,
  decodeEventLog,
  encodeAbiParameters,
  encodeFunctionData,
  formatEther,
  type Hex,
  type Log,
  type SignAuthorizationReturnType,
} from "viem";
import { config, BATCH_DEFAULT_MODE } from "../config.js";
import { delegationManagerAbi, delegationStructAbi, feeMarketRegistryAbi } from "../abi.js";
import type { ExecutionRequest } from "../types.js";
import { cached } from "../lib/cache.js";
import { account, publicClient, relayerAddress } from "../lib/clients.js";
import { sendAndConfirm } from "../lib/txManager.js";

/** Builds a `permissionContexts` entry: an abi-encoded Delegation[] (leaf->root). */
function encodePermissionContext(delegations: ExecutionRequest["delegations"]): Hex {
  const tuples = delegations.map((d) => ({
    delegate: d.delegate as Hex,
    delegator: d.delegator as Hex,
    authority: d.authority as Hex,
    caveats: d.caveats.map((c) => ({ enforcer: c.enforcer as Hex, terms: c.terms as Hex, args: (c.args ?? "0x") as Hex })),
    salt: BigInt(d.salt),
    signature: d.signature as Hex,
  }));
  return encodeAbiParameters([delegationStructAbi], [tuples as never]);
}

function encodeRedeemCalldata(req: ExecutionRequest): Hex {
  const permissionContext = encodePermissionContext(req.delegations);
  const mode = (req.mode ?? BATCH_DEFAULT_MODE) as Hex;
  return encodeFunctionData({
    abi: delegationManagerAbi,
    functionName: "redeemDelegations",
    args: [[permissionContext], [mode], [req.executionCallData as Hex]],
  });
}

function buildAuthorizationList(req: ExecutionRequest): SignAuthorizationReturnType[] | undefined {
  if (!req.authorization) return undefined;
  return [
    {
      chainId: req.authorization.chainId,
      address: req.authorization.address as Hex,
      nonce: req.authorization.nonce,
      r: req.authorization.r as Hex,
      s: req.authorization.s as Hex,
      yParity: req.authorization.yParity,
    },
  ];
}

export interface PreflightResult {
  ok: boolean;
  reason?: string;
  gasCostWei?: bigint;
  /** The gas limit to broadcast with (estimate + headroom, never above MAX_GAS_UNITS). */
  gas?: bigint;
  /** False when the redemption could not be simulated (first-use on an RPC that rejects state overrides). */
  simulated?: boolean;
  /** Refused because the estimate is above the gas-unit ceiling (a setting the operator may need to raise). */
  overUnitCap?: boolean;
}

/** A ceiling that would have let `gas` through with the usual 25% headroom, rounded up to the next 100k. */
export function suggestedGasCap(gas: bigint): bigint {
  const step = 100_000n;
  const need = gas + gas / 4n;
  return ((need + step - 1n) / step) * step;
}

/** Intrinsic cost of applying one EIP-7702 authorization, which eth_estimateGas on a plain call does not include. */
const AUTHORIZATION_GAS = 25_000n;

/**
 * Used only when a first-use redemption cannot be simulated at all (the RPC rejected the state override). The
 * authorization, signer, nonce and the user's balance/allowance were already checked, which covers the ways the
 * upgrade or the payment can fail; the gas limit stays capped by MAX_GAS_UNITS either way.
 */
const FIRST_USE_GAS_FALLBACK = 500_000n;

/** Walks viem's nested error chain for the raw revert data the contract returned. */
function revertData(err: unknown): Hex | null {
  for (let e = err as { data?: unknown; cause?: unknown } | undefined, i = 0; e && i < 8; e = e.cause as typeof e, i++) {
    if (typeof e.data === "string" && /^0x[0-9a-fA-F]{8,}$/.test(e.data)) return e.data as Hex;
    const nested = (e.data as { data?: unknown } | undefined)?.data;
    if (typeof nested === "string" && /^0x[0-9a-fA-F]{8,}$/.test(nested)) return nested as Hex;
  }
  return null;
}

/**
 * A revert's real reason. The RPC's message alone is "Execution reverted for an unknown reason" for every custom error, which
 * hides whether the user lacks funds, the plan is paused or a caveat refused. Decoded against the registry and the delegation
 * manager; an error neither knows is reported as its 4-byte selector so it can still be looked up.
 */
export function describeRevert(err: unknown): string {
  const data = revertData(err);
  const first = ((err as Error).message ?? "").split("\n")[0];
  if (!data) return first;
  for (const abi of [feeMarketRegistryAbi, delegationManagerAbi]) {
    try {
      const d = decodeErrorResult({ abi: abi as never, data });
      const args = d.args && d.args.length ? `(${d.args.map((a) => String(a)).join(", ")})` : "";
      return `${d.errorName}${args}`;
    } catch { /* not in this ABI */ }
  }
  return `${first} [error ${data.slice(0, 10)}]`;
}

/** A revert is an answer; anything else from the RPC (unsupported override, rate limit) is not. */
function isRevert(err: unknown): boolean {
  return /revert|execution reverted|VM Exception/i.test((err as Error).message ?? "");
}

/**
 * Dry-run the redemption WITHOUT spending gas, and fix the gas the transaction may use.
 *
 *  - estimateGas reverts exactly when the real tx would (bad signature, disabled delegation, caveat failure, empty
 *    escrow...), so success means the redemption should land.
 *  - First use: the account is still a plain EOA on-chain, so the upgrade is simulated by overriding its code with
 *    the delegation designator (`0xef0100 ++ implementation`), which is what the authorization installs. Public
 *    Polygon RPCs execute that, so first-use sends get the same revert protection as any other.
 *  - The estimate (plus 25% headroom) becomes the transaction's own gas limit and is refused above MAX_GAS_UNITS, so
 *    a heavy user batch can neither slip past nor run away. MAX_GAS_POL caps the estimated cost in the native token.
 */
export async function preflight(
  req: ExecutionRequest,
  limit: { cap: bigint; name: string } = { cap: config.policy.maxGasUnits, name: "MAX_GAS_UNITS" },
): Promise<PreflightResult> {
  const cap = limit.cap;
  const data = encodeRedeemCalldata(req);
  const delegator = req.delegations[req.delegations.length - 1].delegator as Hex;
  const override = req.authorization
    ? [{ address: delegator, code: `0xef0100${config.delegatorImplementation.slice(2)}` as Hex }]
    : undefined;

  let gas: bigint;
  let simulated = true;
  if (!config.policy.simulateBeforeSend) {
    gas = cap;
    simulated = false;
  } else {
    try {
      // The address, not the account object: for a local account viem prepares the call with eth_fillTransaction, which has
      // no state-override slot, so the first-use code override would be dropped and the call would revert as a plain EOA.
      gas = await publicClient.estimateGas({ account: account.address, to: config.delegationManager, data, ...(override ? { stateOverride: override } : {}) });
      if (req.authorization) gas += AUTHORIZATION_GAS;
    } catch (err) {
      if (override && !isRevert(err)) {
        console.warn(`[preflight] first-use simulation unavailable (${(err as Error).message.split("\n")[0]}); using the capped fallback`);
        gas = FIRST_USE_GAS_FALLBACK;
        simulated = false;
      } else {
        const why = describeRevert(err);
        console.warn(`[preflight] simulation reverted for ${delegator}: ${why}`);
        return { ok: false, reason: `simulation reverted: ${why}` };
      }
    }
  }

  if (gas > cap) return { ok: false, reason: `gas estimate ${gas} exceeds this sponsor's limit of ${cap} (${limit.name})`, gas, overUnitCap: true };
  const gasLimit = gas + gas / 4n > cap ? cap : gas + gas / 4n;

  // Shared for a couple of seconds: a burst of requests prices off one read.
  const gasPrice = await cached("gasPrice", 2000, () => publicClient.getGasPrice());
  const gasCostWei = gas * gasPrice;
  if (config.policy.maxGasWei > 0n && gasCostWei > config.policy.maxGasWei) {
    return {
      ok: false,
      reason: `gas cost ${gasCostWei} exceeds cap ${config.policy.maxGasWei} (${formatEther(gasCostWei)} POL > MAX_GAS_POL ${formatEther(config.policy.maxGasWei)})`,
      gasCostWei,
      gas,
    };
  }
  return { ok: true, gasCostWei, gas: gasLimit, simulated };
}

/** Submit the type-4 (EIP-7702) redemption and wait for it. The sponsor pays gas. `gas` is the limit from preflight. */
export async function redeemAndConfirm(req: ExecutionRequest, gas: bigint) {
  const data = encodeRedeemCalldata(req);
  const authorizationList = buildAuthorizationList(req);
  return sendAndConfirm({
    to: config.delegationManager,
    data,
    gas,
    ...(authorizationList ? { authorizationList } : {}),
  });
}

/** Extracts the new subscriptionId from a receipt's Subscribed event, if present. */
export function findSubscriptionId(logs: Log[]): bigint | undefined {
  for (const log of logs) {
    if (log.address.toLowerCase() !== config.feeMarketRegistry.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({ abi: feeMarketRegistryAbi, data: log.data, topics: log.topics });
      if (decoded.eventName === "Subscribed") {
        return (decoded.args as { subscriptionId: bigint }).subscriptionId;
      }
    } catch {
      continue; // not a Subscribed log (or a different event on the same contract) — skip
    }
  }
  return undefined;
}

export { relayerAddress };
