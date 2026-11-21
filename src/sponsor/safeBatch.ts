import { encodeFunctionData, getAddress, type Address, type Hex } from "viem";
import { feeMarketRegistryAbi } from "../abi.js";

/**
 * A payout wallet that is a Safe cannot sign with a key in an environment variable: its owners approve a transaction
 * in the Safe app. These helpers build the transaction as a Safe "Transaction Builder" batch (JSON the app imports under
 * Apps -> Transaction Builder -> upload), so the owners see exactly what they approve and the node never touches the payout key.
 */
export interface SafeTx {
  to: Address;
  value: "0";
  data: Hex;
}

export interface SafeBatch {
  version: "1.0";
  chainId: string;
  createdAt: number;
  meta: { name: string; description: string; txBuilderVersion: string };
  transactions: SafeTx[];
}

export function batch(chainId: number, name: string, description: string, transactions: SafeTx[]): SafeBatch {
  return { version: "1.0", chainId: String(chainId), createdAt: Date.now(), meta: { name, description, txBuilderVersion: "1.17.0" }, transactions };
}

export function withdrawTxs(registry: Address, sponsorId: bigint, tokens: Address[]): SafeTx[] {
  return tokens.map((token) => ({
    to: getAddress(registry),
    value: "0" as const,
    data: encodeFunctionData({ abi: feeMarketRegistryAbi, functionName: "withdraw", args: [sponsorId, getAddress(token)] }),
  }));
}

export function endpointTx(registry: Address, sponsorId: bigint, url: string): SafeTx {
  return { to: getAddress(registry), value: "0", data: encodeFunctionData({ abi: feeMarketRegistryAbi, functionName: "setEndpoint", args: [sponsorId, url] }) };
}

export function relayerTx(registry: Address, sponsorId: bigint, what: "add" | "remove", relayer: Address): SafeTx {
  return { to: getAddress(registry), value: "0", data: encodeFunctionData({ abi: feeMarketRegistryAbi, functionName: what === "add" ? "addRelayer" : "removeRelayer", args: [sponsorId, getAddress(relayer)] }) };
}

export function rotateTx(registry: Address, sponsorId: bigint, what: "relayer" | "payout", next: Address): SafeTx {
  return {
    to: getAddress(registry),
    value: "0",
    data: encodeFunctionData({ abi: feeMarketRegistryAbi, functionName: what === "relayer" ? "setRelayer" : "setPayoutAddress", args: [sponsorId, getAddress(next)] }),
  };
}

/** Bits of `roleConsent(sponsorId, address)`: what an address can agree to be given on a sponsor. */
export const ROLE_RELAYER = 1;
export const ROLE_PAYOUT = 2;
export type Role = "relayer" | "payout";

/** `acceptRole(sponsorId, roles)`: signed by the address that will TAKE the role, before the payout key can use it. */
export function acceptRoleTx(registry: Address, sponsorId: bigint, roles: number): SafeTx {
  return { to: getAddress(registry), value: "0", data: encodeFunctionData({ abi: feeMarketRegistryAbi, functionName: "acceptRole", args: [sponsorId, roles] }) };
}

/**
 * The registry only lets the payout key add a relayer, rotate to one, or move the payout address to an address that has
 * accepted that role (`acceptRole`). Say so, and say how, before sending a transaction that would revert. Pure.
 */
export function consentProblem(role: Role, consent: number, who: string, sponsorId: bigint, registry: string): string | null {
  const bit = role === "relayer" ? ROLE_RELAYER : ROLE_PAYOUT;
  if ((consent & bit) !== 0) return null;
  const how = role === "relayer"
    ? `on the new node run \`SPONSOR_ID=${sponsorId} npm run sponsor:accept -- relayer\` (it signs with that node's own key)`
    : `the new payout wallet runs \`SPONSOR_NEW_PAYOUT_PRIVATE_KEY=0x… npm run sponsor:accept -- payout\`, or \`npm run sponsor:accept -- payout --safe-batch accept.json\` when it is a Safe`;
  return `${who} has not accepted the ${role} role for sponsor #${sponsorId} yet. It must agree first: ${how}; or open /sponsor/accept?sponsor=${sponsorId} in the sponsor panel with that address connected; or \`cast send ${registry} "acceptRole(uint256,uint8)" ${sponsorId} ${bit} --private-key <that key>\`. An agreement lasts 30 days, so one that has lapsed counts as none: accept again. Then run this again.`;
}

/**
 * Is there a sponsor with this number? The registry issues 1, 2, 3 and so on, and `sponsors(n)` of a number it has not issued is all
 * zeros. `acceptRole` refuses such a number (a key must not be able to agree to "whoever registers next"), so say so before sending.
 * `sponsor` is the `sponsors(n)` tuple. Pure.
 */
export function sponsorProblem(sponsorId: bigint, sponsor: readonly unknown[] | undefined): string | null {
  const payout = String(sponsor?.[0] ?? "");
  if (sponsorId === 0n || !payout || /^0x0*$/i.test(payout)) {
    return `sponsor #${sponsorId} does not exist on this registry. Check SPONSOR_ID: the registry refuses an acceptance for a sponsor that has not registered`;
  }
  return null;
}

/** Whose sponsor an acceptance is for, in one line, so the signer sees what they are agreeing to. `sponsor` is the `sponsors(n)` tuple. Pure. */
export function describeSponsor(sponsorId: bigint, sponsor: readonly unknown[]): string {
  const status = ["unverified", "pending", "verified", "revoked"][Number(sponsor[3])] ?? `status ${String(sponsor[3])}`;
  return `sponsor #${sponsorId} (${status}): payout ${String(sponsor[0])}, relayer ${String(sponsor[1])}, metadata ${String(sponsor[2]) || "(none)"}`;
}

/** What kind of account an address is, from its code: an EIP-7702 delegated account is NOT a multisig. */
export function classifyAccount(code: Hex | undefined): "eoa" | "delegated-eoa" | "contract" {
  if (!code || code === "0x") return "eoa";
  return /^0xef0100[0-9a-f]{40}$/i.test(code) ? "delegated-eoa" : "contract";
}
