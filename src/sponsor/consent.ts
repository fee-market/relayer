/**
 * A key or wallet agrees to be given a role on a sponsor. The registry lets the sponsor's payout key add a relayer key, rotate
 * to one, or move the payout address ONLY to an address that has accepted that role for that sponsor: nobody can be enrolled
 * without asking, and a mistyped payout address can never take a sponsor over. This is the first step of those commands.
 *
 *   npm run sponsor:accept -- relayer                         # THIS node's own key accepts the relayer-key role on SPONSOR_ID
 *   SPONSOR_NEW_PAYOUT_PRIVATE_KEY=0x… npm run sponsor:accept -- payout
 *                                                             # the NEW payout key accepts the payout role
 *   npm run sponsor:accept -- payout --safe-batch accept.json # the NEW payout wallet is a Safe: a batch for ITS owners
 *   npm run sponsor:accept -- check 0xAddress                 # what has this address accepted on SPONSOR_ID?
 *   npm run sponsor:accept -- withdraw relayer|payout         # take an acceptance back (accept with no role)
 *
 * The acceptance is used up when the payout key uses it. It costs one small transaction and gives the sponsor nothing by itself.
 */
import { writeFileSync } from "node:fs";
import { createWalletClient, encodeFunctionData, getAddress, http, isAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { config } from "../config.js";
import { feeMarketRegistryAbi } from "../abi.js";
import { chain, publicClient, relayerAddress, sendTransactionSafe } from "../lib/clients.js";
import { ROLE_PAYOUT, ROLE_RELAYER, acceptRoleTx, batch, describeSponsor, sponsorProblem, type Role } from "./safeBatch.js";

const bitOf = (r: string) => (r === "relayer" ? ROLE_RELAYER : r === "payout" ? ROLE_PAYOUT : null);
const words = (c: number) => (c === 3 ? "both the relayer key and the payout wallet roles" : c === 1 ? "the relayer key role" : c === 2 ? "the payout wallet role" : "no role");

async function main() {
  const args = process.argv.slice(2);
  const sb = args.indexOf("--safe-batch");
  const out = sb >= 0 ? args[sb + 1] : undefined;
  const rest = sb < 0 ? args : args.filter((_, i) => i !== sb && i !== sb + 1);
  const id = config.sponsorId;
  const read = (who: string) => publicClient.readContract({ address: config.feeMarketRegistry, abi: feeMarketRegistryAbi, functionName: "roleConsent", args: [id, getAddress(who)] }) as Promise<number>;

  // The registry refuses an acceptance for a sponsor that does not exist, and an acceptance is a promise to be added by THIS
  // sponsor (an enrolled key cannot remove itself), so show whose it is before anything is signed or written.
  const sponsor = (await publicClient.readContract({ address: config.feeMarketRegistry, abi: feeMarketRegistryAbi, functionName: "sponsors", args: [id] })) as readonly unknown[];
  const missing = sponsorProblem(id, sponsor);
  if (missing) throw new Error(missing);
  console.log(describeSponsor(id, sponsor));

  if (rest[0] === "check") {
    if (!rest[1] || !isAddress(rest[1])) throw new Error("usage: sponsor:accept -- check <address>");
    return void console.log(`${getAddress(rest[1])} has accepted ${words(Number(await read(rest[1])))} on sponsor #${id}`);
  }
  const withdrawing = rest[0] === "withdraw";
  const role = (withdrawing ? rest[1] : rest[0]) as Role;
  if (!bitOf(role)) throw new Error("usage: sponsor:accept -- <relayer|payout> [--safe-batch <file>]   |   check <address>   |   withdraw <relayer|payout>");

  // what the address keeps after this call: accepting adds the role, withdrawing removes it
  const signerOf = async (): Promise<`0x${string}`> => {
    if (role === "relayer") return relayerAddress;
    const k = process.env.SPONSOR_NEW_PAYOUT_PRIVATE_KEY;
    if (!k) throw new Error("SPONSOR_NEW_PAYOUT_PRIVATE_KEY (the NEW payout wallet's key) is required, or use --safe-batch <file> when it is a Safe");
    return privateKeyToAccount(k as `0x${string}`).address;
  };
  if (out) {
    if (withdrawing) throw new Error("--safe-batch is for accepting; to withdraw from a Safe, import a batch with acceptRole(sponsorId, 0)");
    writeFileSync(out, JSON.stringify(batch(config.chainId, `fee.market: accept the ${role} role`, `The wallet that executes this accepts the ${role} role on sponsor ${id}. Execute it from the NEW ${role === "payout" ? "payout wallet (this Safe)" : "relayer key"}.`, [acceptRoleTx(config.feeMarketRegistry, id, bitOf(role)!)]), null, 2));
    return void console.log(`✓ wrote ${out}. Import it in the Safe that will take the role (Transaction Builder), have its owners sign, then run the sponsor's payout command.`);
  }
  const who = await signerOf();
  const before = Number(await read(who));
  const after = withdrawing ? before & ~bitOf(role)! : before | bitOf(role)!;
  const data = encodeFunctionData({ abi: feeMarketRegistryAbi, functionName: "acceptRole", args: [id, after] });
  let hash: `0x${string}`;
  if (role === "relayer") hash = await sendTransactionSafe({ to: config.feeMarketRegistry, data });
  else hash = await createWalletClient({ account: privateKeyToAccount(process.env.SPONSOR_NEW_PAYOUT_PRIVATE_KEY as `0x${string}`), chain, transport: http(config.rpcUrl) }).sendTransaction({ to: config.feeMarketRegistry, data });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`the transaction reverted (tx ${hash})`);
  console.log(`✓ ${who} now has accepted ${words(after)} on sponsor #${id} (tx ${hash}).${withdrawing ? "" : " The sponsor's payout key can now use it, for the next 30 days (then run this again)."}`);
}

main().catch((e) => {
  console.error("✗", (e as Error).message);
  process.exit(1);
});
