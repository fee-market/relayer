import { type Address, type Hex, getAddress } from "viem";
import { recoverAuthorizationAddress } from "viem/utils";
import { config } from "../config.js";
import { publicClient } from "../lib/clients.js";
import type { ExecutionRequest } from "../types.js";

/** Returns the contract an account delegates to, or null for a plain account / ordinary contract. */
export function delegationTargetOf(code: Hex | undefined): Address | null {
  if (!code) return null;
  const c = code.toLowerCase();
  return c.length === 48 && c.startsWith("0xef0100") ? (`0x${c.slice(8)}` as Address) : null;
}

export interface AuthDeps {
  getCode(address: Address): Promise<Hex | undefined>;
  getNonce(address: Address): Promise<number>;
}

const chainDeps: AuthDeps = {
  getCode: (address) => publicClient.getCode({ address }),
  getNonce: (address) => publicClient.getTransactionCount({ address, blockTag: "latest" }),
};

/**
 * The EIP-7702 authorization a wallet attaches the first time its account is used. The sponsor pays for the
 * transaction that applies it, and an authorization that is skipped on-chain (wrong nonce, wrong chain, signed by a
 * different account) makes the redemption revert on the sponsor's gas. Nodes cannot always simulate the upgrade, so
 * every way it can be skipped is checked here, before any gas is spent:
 *
 *  - it names this chain and OUR delegator implementation (never an arbitrary contract),
 *  - it was signed by the delegation's own delegator (recovered from the signature),
 *  - its nonce is the account's current nonce (otherwise it is silently ignored),
 *  - the account has no other code (an upgrade only applies to a plain account or an existing delegation).
 */
export async function validateAuthorization(
  req: ExecutionRequest,
  deps: AuthDeps = chainDeps,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const a = req.authorization;
  if (!a) return { ok: true };
  if (a.chainId !== config.chainId) return { ok: false, reason: `authorization is for chain ${a.chainId}, this node serves ${config.chainId}` };
  if (getAddress(a.address) !== getAddress(config.delegatorImplementation)) {
    return { ok: false, reason: "authorization does not point at this marketplace's delegator implementation" };
  }
  const delegator = getAddress(req.delegations[req.delegations.length - 1].delegator);

  let signer: Address;
  try {
    signer = await recoverAuthorizationAddress({
      authorization: { address: getAddress(a.address), chainId: a.chainId, nonce: a.nonce, r: a.r as Hex, s: a.s as Hex, yParity: a.yParity },
    });
  } catch {
    return { ok: false, reason: "authorization signature is invalid" };
  }
  if (getAddress(signer) !== delegator) return { ok: false, reason: "authorization was not signed by the delegator" };

  const [code, nonce] = await Promise.all([deps.getCode(delegator), deps.getNonce(delegator)]);
  const hasCode = !!code && code !== "0x";
  if (hasCode && !delegationTargetOf(code)) return { ok: false, reason: "delegator account has contract code and cannot be upgraded" };
  if (nonce !== a.nonce) return { ok: false, reason: `authorization nonce ${a.nonce} is not the account's current nonce ${nonce}` };
  return { ok: true };
}
