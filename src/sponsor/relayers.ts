/**
 * The sponsor's relayer set: up to 8 keys that may redeem delegations locked to the sponsor (SponsorRelayerEnforcer).
 * Several nodes can serve one sponsor, and a key can be replaced with no gap. Changes are made by the PAYOUT address.
 *
 *   npm run sponsor:relayers                                  # count, primary, and whether THIS node's key is in the set
 *   npm run sponsor:relayers -- check 0xKey                   # is this address a relayer of the sponsor?
 *   SPONSOR_ADMIN_PRIVATE_KEY=0x… npm run sponsor:relayers -- add 0xNewKey
 *   SPONSOR_ADMIN_PRIVATE_KEY=0x… npm run sponsor:relayers -- remove 0xOldKey
 *   … add that same command with  --safe-batch relayers.json  when the payout wallet is a Safe.
 *
 * The new key must accept first: on the new node, `SPONSOR_ID=… npm run sponsor:accept -- relayer` (the registry refuses a key that
 * did not agree, so nobody can be enrolled without asking). `add` checks this before it sends anything.
 *
 * Zero-downtime rotation: accept, then add the new key, start a second node with it (same SPONSOR_ID), check `/health` on both, then
 * remove the old key. Delegations locked to the sponsor keep working throughout. Delegations locked to ONE key (the older
 * RedeemerRestrictionEnforcer) stop working when that key is removed: they live at most MAX_DELEGATION_TTL_SECONDS.
 * The primary relayer (the one named in the metadata) cannot be removed; change it with `sponsor:rotate -- relayer`.
 */
import { writeFileSync } from "node:fs";
import { encodeFunctionData, getAddress, isAddress } from "viem";
import { config } from "../config.js";
import { feeMarketRegistryAbi } from "../abi.js";
import { publicClient, relayerAddress } from "../lib/clients.js";
import { payoutOf, sendAsPayout } from "./payoutSigner.js";
import { batch, consentProblem, relayerTx } from "./safeBatch.js";

const read = (functionName: string, args: unknown[]) => publicClient.readContract({ address: config.feeMarketRegistry, abi: feeMarketRegistryAbi, functionName, args } as never);

/** Pre-checks that save a reverted transaction. Pure: exported for tests. */
export function relayerChangeProblem(
  what: "add" | "remove",
  target: string,
  state: { count: number; isMember: boolean; primary: string; consent?: number; sponsorId?: bigint; registry?: string },
): string | null {
  if (!isAddress(target)) return `${target} is not an address`;
  if (what === "add") {
    if (state.isMember) return "that address is already a relayer of this sponsor";
    if (state.count >= 8) return "the relayer set is full (8 keys): remove one first";
    if (state.consent !== undefined) return consentProblem("relayer", state.consent, getAddress(target), state.sponsorId ?? 0n, state.registry ?? "<registry>");
    return null;
  }
  if (getAddress(target) === getAddress(state.primary)) return "the primary relayer cannot be removed: change it with `sponsor:rotate -- relayer <address>`";
  if (!state.isMember) return "that address is not a relayer of this sponsor";
  return null;
}

async function main() {
  const args = process.argv.slice(2);
  const sb = args.indexOf("--safe-batch");
  const out = sb >= 0 ? args[sb + 1] : undefined;
  const rest = sb < 0 ? args : args.filter((_, i) => i !== sb && i !== sb + 1);
  const [cmd, target] = rest;
  const id = config.sponsorId;

  const sponsor = (await read("sponsors", [id])) as readonly [string, string, string, number, boolean];
  const primary = sponsor[1];
  const count = Number(await read("relayerCount", [id]));

  if (!cmd) {
    const me = (await read("isRelayer", [id, relayerAddress])) as boolean;
    console.log(`sponsor #${id}: ${count} relayer key(s). Primary ${primary}.`);
    console.log(`this node's key ${relayerAddress} is ${me ? "IN" : "NOT in"} the relayer set${me ? "" : ": delegations locked to the sponsor will not work through this node"}.`);
    console.log(`payout address ${sponsor[0]}`);
    return;
  }
  if (cmd === "check") {
    if (!target || !isAddress(target)) throw new Error("usage: sponsor:relayers -- check <address>");
    return void console.log(`${getAddress(target)} ${(await read("isRelayer", [id, target])) ? "IS" : "is NOT"} a relayer of sponsor #${id}`);
  }
  if (cmd !== "add" && cmd !== "remove") throw new Error("usage: sponsor:relayers [-- check|add|remove <address>] [--safe-batch <file>]");
  if (!target) throw new Error(`usage: sponsor:relayers -- ${cmd} <address>`);
  const isMember = isAddress(target) ? ((await read("isRelayer", [id, target])) as boolean) : false;
  const consent = cmd === "add" && isAddress(target) ? Number(await read("roleConsent", [id, target])) : undefined;
  const problem = relayerChangeProblem(cmd, target, { count, isMember, primary, consent, sponsorId: id, registry: config.feeMarketRegistry });
  if (problem) throw new Error(problem);

  if (out) {
    writeFileSync(out, JSON.stringify(batch(config.chainId, `fee.market: ${cmd} relayer`, `${cmd === "add" ? "Add" : "Remove"} relayer ${getAddress(target)} for sponsor ${id}; payout address ${await payoutOf(id)}`, [relayerTx(config.feeMarketRegistry, id, cmd, getAddress(target))]), null, 2));
    return void console.log(`✓ wrote ${out}. Import it in the payout Safe (Transaction Builder) and have the owners sign.`);
  }
  const data = encodeFunctionData({ abi: feeMarketRegistryAbi, functionName: cmd === "add" ? "addRelayer" : "removeRelayer", args: [id, getAddress(target)] });
  const hash = await sendAsPayout(id, data);
  console.log(`✓ ${cmd === "add" ? "added" : "removed"} ${getAddress(target)} (tx ${hash}). The set now has ${cmd === "add" ? count + 1 : count - 1} key(s).`);
}

if (process.argv[1] && /relayers\.[tj]s$/.test(process.argv[1])) {
  main().catch((e) => {
    console.error("✗", (e as Error).message);
    process.exit(1);
  });
}
