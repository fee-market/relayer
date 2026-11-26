/**
 * Collects what this sponsor's TIME-plan subscribers have accrued. A time plan earns by the clock, but the registry only
 * moves the money into the sponsor's withdrawable earnings when someone settles (`settleMany`). The node does this by
 * itself every SETTLE_INTERVAL_MS; this command does the same thing once, now, and prints what it did.
 *
 *   npm run sponsor:settle                 # the time-plan subscriptions this node has served (from its state file)
 *   npm run sponsor:settle -- 12 15 31     # also these subscription ids (for ones the node never served)
 *   npm run sponsor:settle -- --dry-run    # only show what is pending; send nothing
 *
 * Anyone may settle, so no special key is needed. The transaction is signed with SPONSOR_ADMIN_PRIVATE_KEY when it is
 * set on the command line, otherwise with the relayer key. Signing with the relayer key while the node is running uses
 * one of the node's transaction numbers behind its back: the node notices on its next send and carries on, but that one
 * request can fail. It reads the node's state file and never writes it.
 */
import { createWalletClient, formatUnits, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { config } from "../config.js";
import { feeMarketRegistryAbi } from "../abi.js";
import { account, chain, publicClient, walletClient } from "../lib/clients.js";
import { KnownSubscriptions, chainSettleDeps, knownTimePlanSubs, runSettle } from "../services/timePlans.js";

async function tokenLabel(token: string): Promise<{ symbol: string; decimals: number }> {
  const abi = parseAbi(["function symbol() view returns (string)", "function decimals() view returns (uint8)"]);
  try {
    const [symbol, decimals] = await Promise.all([
      publicClient.readContract({ address: token as `0x${string}`, abi, functionName: "symbol" }),
      publicClient.readContract({ address: token as `0x${string}`, abi, functionName: "decimals" }),
    ]);
    return { symbol, decimals };
  } catch {
    return { symbol: token, decimals: 0 };
  }
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const extra = args.filter((a) => !a.startsWith("--"));
  const bad = extra.find((a) => !/^\d+$/.test(a));
  if (bad) throw new Error(`"${bad}" is not a subscription id. usage: sponsor:settle -- [id ...] [--dry-run]`);

  // A copy: this command reads the node's list and leaves the node's own state alone.
  const known = new KnownSubscriptions();
  for (const id of knownTimePlanSubs.list()) known.add(id);
  for (const id of extra) known.add(id);

  const key = process.env.SPONSOR_ADMIN_PRIVATE_KEY;
  const signer = key ? createWalletClient({ account: privateKeyToAccount(key as `0x${string}`), chain, transport: http(config.rpcUrl) }) : walletClient;
  const from = key ? signer.account!.address : account.address;
  const chainDeps = await chainSettleDeps();
  const sent: string[] = [];

  const result = await runSettle(
    {
      halted: chainDeps.halted,
      // The node's minimum is for sponsoring; a settle from the payout key has nothing to do with the relayer's balance.
      relayerBalance: () => (key ? Promise.resolve(config.policy.minRelayerBalanceWei) : publicClient.getBalance({ address: account.address })),
      details: chainDeps.details,
      settleMany: async (ids) => {
        if (dryRun) return "0x" as `0x${string}`;
        const hash = await signer.writeContract({ account: signer.account!, chain, address: config.feeMarketRegistry, abi: feeMarketRegistryAbi, functionName: "settleMany", args: [ids] });
        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        if (receipt.status !== "success") throw new Error(`settleMany reverted (tx ${hash})`);
        sent.push(hash);
        return hash;
      },
    },
    known,
    { sponsorId: config.sponsorId, minBalanceWei: config.policy.minRelayerBalanceWei },
  );

  if (result.dropped.length) console.log(`· left out ${result.dropped.join(", ")}: closed with nothing to collect, or not one of sponsor ${config.sponsorId}'s time plans`);
  if (result.skipped) return void console.log(`nothing settled: ${result.skipped}`);
  const sums: string[] = [];
  for (const [token, amount] of Object.entries(result.amounts)) {
    const t = await tokenLabel(token);
    sums.push(`${formatUnits(amount, t.decimals)} ${t.symbol}`);
  }
  if (dryRun) return void console.log(`pending on ${result.settled.length} subscription(s) (${result.settled.join(", ")}): ${sums.join(", ")}. Nothing was sent (--dry-run).`);
  if (result.settled.length) console.log(`✓ settled ${result.settled.length} subscription(s) (${result.settled.join(", ")}): ${sums.join(", ")} moved to sponsor ${config.sponsorId}'s earnings, signed by ${from} (tx ${sent.join(", ")}). Withdraw with \`npm run sponsor:withdraw\`.`);
  if (result.failed) {
    console.error(`✗ ${result.failed} transaction(s) failed; those subscriptions are still pending. Run it again.`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error("✗", (e as Error).message);
  process.exit(1);
});
