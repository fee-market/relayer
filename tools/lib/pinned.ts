import { concat, encodeFunctionData, pad, toHex, type Address, type Hex } from "viem";
import { feeMarketRegistryAbi } from "../../src/generated/feeMarketRegistryAbi.js";
import { config } from "../../src/config.js";

/** The four caveats every fee-market delegation carries (mirrors wallet/src/lib/delegation.ts):
 * only `relayer` may redeem, once, exactly `executionCallData`, before `now + ttl`. */
export function pinnedCaveats(
  relayer: Address,
  executionCallData: Hex,
  redeemerEnforcer: Address = config.redeemerRestrictionEnforcer,
  ttlSeconds = 600,
) {
  const before = BigInt(Math.floor(Date.now() / 1000) + ttlSeconds);
  // SPONSOR_LOCK=1 locks the delegation to the sponsor's relayer SET (what the wallet signs on the new registry) instead of one key.
  const redeemer = process.env.SPONSOR_LOCK === "1"
    ? { enforcer: config.sponsorRelayerEnforcer, terms: concat([config.feeMarketRegistry as Hex, pad(toHex(config.sponsorId), { size: 32 })]), args: "0x" as Hex }
    : { enforcer: redeemerEnforcer, terms: relayer as Hex, args: "0x" as Hex };
  return [
    redeemer,
    { enforcer: config.limitedCallsEnforcer, terms: pad("0x01"), args: "0x" as Hex },
    { enforcer: config.exactExecutionBatchEnforcer, terms: executionCallData, args: "0x" as Hex },
    { enforcer: config.timestampEnforcer, terms: concat([pad(toHex(0n), { size: 16 }), pad(toHex(before), { size: 16 })]), args: "0x" as Hex },
  ];
}

/** The last call of every sponsored batch: the user's own account pays the sponsor via registry.chargeUsage. */
export function chargeExecution(registry: Address, subscriptionId: bigint) {
  return {
    target: registry,
    value: 0n,
    callData: encodeFunctionData({ abi: feeMarketRegistryAbi, functionName: "chargeUsage", args: [subscriptionId, 1n] }),
  };
}
