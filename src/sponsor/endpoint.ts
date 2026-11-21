/**
 * Publishes this sponsor's relay URL on chain (`setEndpoint`), so wallets can find the node without the curator-pinned
 * metadata: moving a domain or a tunnel then needs no new review. Only the PAYOUT address can set it.
 *
 *   SPONSOR_ADMIN_PRIVATE_KEY=0x… npm run sponsor:endpoint                 # publishes PUBLIC_RELAYER_URL
 *   SPONSOR_ADMIN_PRIVATE_KEY=0x… npm run sponsor:endpoint -- https://relay.example.com
 *   npm run sponsor:endpoint -- --safe-batch endpoint.json                 # payout wallet is a Safe: a batch to import
 *   npm run sponsor:endpoint -- --clear                                    # remove it (wallets fall back to the metadata)
 */
import { writeFileSync } from "node:fs";
import { config } from "../config.js";
import { feeMarketRegistryAbi } from "../abi.js";
import { publicClient } from "../lib/clients.js";
import { encodeFunctionData } from "viem";
import { endpointProblem } from "./flow.js";
import { payoutOf, sendAsPayout } from "./payoutSigner.js";
import { batch, endpointTx } from "./safeBatch.js";

async function main() {
  const args = process.argv.slice(2);
  const sb = args.indexOf("--safe-batch");
  const out = sb >= 0 ? args[sb + 1] : undefined;
  if (sb >= 0 && !out) throw new Error("usage: sponsor:endpoint -- [url|--clear] [--safe-batch <file.json>]");
  const clear = args.includes("--clear");
  const url = clear ? "" : (args.find((a, i) => (sb < 0 || (i !== sb && i !== sb + 1)) && !a.startsWith("--")) ?? config.publicRelayerUrl);
  if (!clear) {
    const problem = endpointProblem(url);
    if (problem) throw new Error(problem);
  }

  const current = (await publicClient.readContract({ address: config.feeMarketRegistry, abi: feeMarketRegistryAbi, functionName: "sponsorEndpoint", args: [config.sponsorId] }).catch(() => null)) as string | null;
  if (current === null) throw new Error("this registry has no setEndpoint (an older build)");
  if (current === url) return void console.log(`the endpoint on chain already is ${url || "(empty)"}`);

  if (out) {
    writeFileSync(out, JSON.stringify(batch(config.chainId, "fee.market: set relay endpoint", `Set the relay endpoint of sponsor ${config.sponsorId} to ${url || "(empty)"}; payout address ${await payoutOf(config.sponsorId)}`, [endpointTx(config.feeMarketRegistry, config.sponsorId, url)]), null, 2));
    return void console.log(`✓ wrote ${out}. Import it in the payout Safe (Transaction Builder) and have the owners sign.`);
  }
  const data = encodeFunctionData({ abi: feeMarketRegistryAbi, functionName: "setEndpoint", args: [config.sponsorId, url] });
  const hash = await sendAsPayout(config.sponsorId, data);
  console.log(`✓ endpoint set to ${url || "(empty)"} (tx ${hash})`);
}

main().catch((e) => {
  console.error("✗", (e as Error).message);
  process.exit(1);
});
