/**
 * Key rotation for a registered sponsor. Only the sponsor's PAYOUT (cold) address may rotate keys, so a
 * leaked relayer key cannot hand the sponsor to an attacker. Sign with the payout key:
 *
 *   SPONSOR_ADMIN_PRIVATE_KEY=0x… npm run sponsor:rotate -- relayer 0xNewRelayer
 *   SPONSOR_ADMIN_PRIVATE_KEY=0x… npm run sponsor:rotate -- payout  0xNewPayout
 *
 * The new address must have accepted the role first (`npm run sponsor:accept`, run by the new key or wallet): the registry
 * refuses a relayer or payout address that did not agree. This command checks that before it sends anything.
 *
 * With a Safe as the payout wallet, add `--safe-batch <file.json>` instead of a key: the file is a Transaction Builder batch
 * for the owners to approve (see sponsor:withdraw).
 *
 * A VERIFIED sponsor is demoted to PENDING (the curator verified the old relayer / payout address and the
 * metadata names them), so after rotating: update RELAYER_PRIVATE_KEY, re-run `npm run
 * sponsor:metadata:publish`, and ask the curator to re-verify. User funds stay refundable meanwhile.
 */
import { writeFileSync } from "node:fs";
import { createWalletClient, getAddress, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { config } from "../config.js";
import { feeMarketRegistryAbi } from "../abi.js";
import { chain, publicClient } from "../lib/clients.js";
import { batch, classifyAccount, consentProblem, rotateTx } from "./safeBatch.js";

/** Stops with instructions when `next` has not accepted the role the registry needs it to have accepted. */
async function requireConsent(what: "relayer" | "payout", next: `0x${string}`) {
  const c = Number(await publicClient.readContract({ address: config.feeMarketRegistry, abi: feeMarketRegistryAbi, functionName: "roleConsent", args: [config.sponsorId, next] }));
  const problem = consentProblem(what, c, next, config.sponsorId, config.feeMarketRegistry);
  if (problem) throw new Error(problem);
}

async function main() {
  const argv = process.argv.slice(2);
  const sb = argv.indexOf("--safe-batch");
  const [what, target] = argv.filter((_, i) => i !== sb && i !== sb + 1 || sb < 0);
  if (sb >= 0) {
    const out = argv[sb + 1];
    if ((what !== "relayer" && what !== "payout") || !target || !out) throw new Error("usage: sponsor:rotate -- <relayer|payout> <new address> --safe-batch <file.json>");
    const next = getAddress(target);
    await requireConsent(what, next);
    if (what === "payout") {
      const kind = classifyAccount(await publicClient.getCode({ address: next }));
      if (kind !== "contract") console.warn(`! ${next} is ${kind === "eoa" ? "a plain key (EOA)" : "an EIP-7702 delegated key, which still has a single key and is not a multisig"}: the payout wallet should be a Safe.`);
    }
    writeFileSync(out, JSON.stringify(batch(config.chainId, `fee.market: set ${what}`, `Set the ${what} of sponsor ${config.sponsorId} to ${next}`, [rotateTx(config.feeMarketRegistry, config.sponsorId, what, next)]), null, 2));
    return void console.log(`✓ wrote ${out}. Import it in the payout Safe (Transaction Builder) and have the owners sign.`);
  }
  const key = process.env.SPONSOR_ADMIN_PRIVATE_KEY;
  if (!key) throw new Error("SPONSOR_ADMIN_PRIVATE_KEY (the sponsor's payout key) is required");
  if ((what !== "relayer" && what !== "payout") || !target) {
    throw new Error("usage: sponsor:rotate -- <relayer|payout> <new address>");
  }
  const next = getAddress(target);
  await requireConsent(what, next);
  const admin = privateKeyToAccount(key as `0x${string}`);
  const wallet = createWalletClient({ account: admin, chain, transport: http(config.rpcUrl) });

  const hash = await wallet.writeContract({
    address: config.feeMarketRegistry,
    abi: feeMarketRegistryAbi,
    functionName: what === "relayer" ? "setRelayer" : "setPayoutAddress",
    args: [config.sponsorId, next],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`rotation reverted (tx ${hash})`);
  console.log(`✓ ${what} set to ${next} (tx ${hash}). Sponsor is now PENDING if it was VERIFIED: re-publish metadata and ask the curator to re-verify.`);
}

main().catch((e) => {
  console.error("✗", (e as Error).message);
  process.exit(1);
});
