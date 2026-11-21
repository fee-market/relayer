import { createWalletClient, getAddress, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { config } from "../config.js";
import { feeMarketRegistryAbi } from "../abi.js";
import { account, chain, publicClient, sendTransactionSafe } from "../lib/clients.js";

/** The sponsor's payout address as the registry has it. */
export async function payoutOf(sponsorId: bigint): Promise<Address> {
  const s = (await publicClient.readContract({ address: config.feeMarketRegistry, abi: feeMarketRegistryAbi, functionName: "sponsors", args: [sponsorId] })) as readonly [Address, ...unknown[]];
  return getAddress(s[0]);
}

/**
 * Sends a registry call that only the PAYOUT address may make (setEndpoint, addRelayer, removeRelayer, setRelayer ...).
 * The key is SPONSOR_ADMIN_PRIVATE_KEY, or the node's own key when the payout address IS the relayer key (a test setup).
 * A Safe payout wallet has no key: those commands offer `--safe-batch` instead and never reach this function.
 */
export async function sendAsPayout(sponsorId: bigint, data: Hex): Promise<Hex> {
  const payout = await payoutOf(sponsorId);
  const adminKey = process.env.SPONSOR_ADMIN_PRIVATE_KEY;
  let hash: Hex;
  if (adminKey) {
    const admin = privateKeyToAccount(adminKey as Hex);
    if (admin.address !== payout) throw new Error(`SPONSOR_ADMIN_PRIVATE_KEY is ${admin.address}, but the payout address is ${payout}`);
    hash = await createWalletClient({ account: admin, chain, transport: http(config.rpcUrl) }).sendTransaction({ to: config.feeMarketRegistry, data });
  } else if (account.address === payout) {
    hash = await sendTransactionSafe({ to: config.feeMarketRegistry, data });
  } else {
    throw new Error(`only the payout address ${payout} may do this: set SPONSOR_ADMIN_PRIVATE_KEY, or use --safe-batch <file> if the payout wallet is a Safe`);
  }
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`the transaction reverted (tx ${hash})`);
  return hash;
}
