/**
 * Withdraw earned fees to the payout address. Only the payout (cold) key can do this.
 *
 *   SPONSOR_ADMIN_PRIVATE_KEY=0x… npm run sponsor:withdraw            # USDC (DASHBOARD_EARNINGS_TOKEN)
 *   SPONSOR_ADMIN_PRIVATE_KEY=0x… npm run sponsor:withdraw -- 0xToken # another payment token
 *
 * Payout wallet is a Safe (recommended)? No key needed: this writes a Transaction Builder batch for the owners to approve.
 *   npm run sponsor:withdraw -- --safe-batch withdraw.json            # USDC
 *   npm run sponsor:withdraw -- 0xToken --safe-batch withdraw.json
 * Import the file in the Safe app (Apps -> Transaction Builder), review, and collect the owners' signatures.
 */
import { writeFileSync } from "node:fs";
import { createWalletClient, getAddress, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { config } from "../config.js";
import { feeMarketRegistryAbi } from "../abi.js";
import { chain, publicClient } from "../lib/clients.js";
import { batch, withdrawTxs } from "./safeBatch.js";

async function main() {
  const args = process.argv.slice(2);
  const sb = args.indexOf("--safe-batch");
  if (sb >= 0) {
    const out = args[sb + 1];
    if (!out) throw new Error("usage: sponsor:withdraw -- [0xToken] --safe-batch <file.json>");
    const token = getAddress(args.find((a, i) => i !== sb && i !== sb + 1 && /^0x/i.test(a)) ?? config.dashboardEarningsToken);
    const read = { address: config.feeMarketRegistry, abi: feeMarketRegistryAbi } as const;
    const sponsor = (await publicClient.readContract({ ...read, functionName: "sponsors", args: [config.sponsorId] })) as readonly [string, ...unknown[]];
    const earned = (await publicClient.readContract({ ...read, functionName: "earnings", args: [config.sponsorId, token] })) as bigint;
    if (earned === 0n) return void console.log(`nothing to withdraw for ${token}`);
    const file = batch(config.chainId, "fee.market: withdraw earnings", `Withdraw ${earned} base units of ${token} for sponsor ${config.sponsorId} to ${getAddress(sponsor[0])}`, withdrawTxs(config.feeMarketRegistry, config.sponsorId, [token]));
    writeFileSync(out, JSON.stringify(file, null, 2));
    console.log(`✓ wrote ${out}: withdraw ${earned} base units of ${token} to the payout address ${getAddress(sponsor[0])}. Import it in the payout Safe (Transaction Builder) and have the owners sign.`);
    return;
  }
  const key = process.env.SPONSOR_ADMIN_PRIVATE_KEY;
  if (!key) throw new Error("SPONSOR_ADMIN_PRIVATE_KEY (the sponsor's payout key) is required");
  const token = getAddress(args[0] ?? config.dashboardEarningsToken);
  const admin = privateKeyToAccount(key as `0x${string}`);
  const base = { address: config.feeMarketRegistry, abi: feeMarketRegistryAbi } as const;

  const sponsor = (await publicClient.readContract({ ...base, functionName: "sponsors", args: [config.sponsorId] })) as readonly [string, string, string, number, boolean];
  if (getAddress(sponsor[0]) !== admin.address) throw new Error(`this key is ${admin.address}, but the payout address is ${getAddress(sponsor[0])}`);
  const earned = (await publicClient.readContract({ ...base, functionName: "earnings", args: [config.sponsorId, token] })) as bigint;
  if (earned === 0n) return void console.log(`nothing to withdraw for ${token}`);

  const wallet = createWalletClient({ account: admin, chain, transport: http(config.rpcUrl) });
  const hash = await wallet.writeContract({ ...base, functionName: "withdraw", args: [config.sponsorId, token] });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`withdraw reverted (tx ${hash})`);
  console.log(`✓ withdrew ${earned} base units of ${token} to ${admin.address} (tx ${hash})`);
}

main().catch((e) => {
  console.error("✗", (e as Error).message);
  process.exit(1);
});
