import { type Address, parseAbi } from "viem";
import { config } from "../config.js";
import { publicClient } from "../lib/clients.js";

const erc20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
]);

export interface PaymentDeps {
  balanceOf(token: Address, user: Address): Promise<bigint>;
  allowance(token: Address, user: Address, spender: Address): Promise<bigint>;
}

const chainDeps: PaymentDeps = {
  balanceOf: (token, user) => publicClient.readContract({ address: token, abi: erc20, functionName: "balanceOf", args: [user] }),
  allowance: (token, user, spender) => publicClient.readContract({ address: token, abi: erc20, functionName: "allowance", args: [user, spender] }),
};

/**
 * subscribe / topUp pull `amount` from the user inside the sponsored transaction. If the user cannot pay, the
 * transaction reverts and the sponsor has paid gas for nothing (and for a first-use account the node cannot always
 * simulate that), so check it up front: enough balance, and enough allowance unless the batch approves first.
 */
export async function checkUserCanPay(
  p: { user: Address; token: Address; amount: bigint; batchApproves: boolean },
  deps: PaymentDeps = chainDeps,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const [balance, allowance] = await Promise.all([
    deps.balanceOf(p.token, p.user),
    p.batchApproves ? Promise.resolve(p.amount) : deps.allowance(p.token, p.user, config.feeMarketRegistry),
  ]);
  if (balance < p.amount) return { ok: false, reason: `user's token balance ${balance} is below the amount ${p.amount}` };
  if (allowance < p.amount) return { ok: false, reason: "user has not approved the registry for this amount" };
  return { ok: true };
}
