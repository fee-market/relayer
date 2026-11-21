/**
 * Read-only readiness check for a sponsor node. Sends no transactions.
 *
 *   npm run sponsor:doctor
 *
 * Exits 1 if anything blocks you from serving users, 0 otherwise (warnings are advice).
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Address } from "viem";
import { config } from "../config.js";
import { delegationManagerAbi, feeMarketRegistryAbi } from "../abi.js";
import { publicClient, relayerAddress } from "../lib/clients.js";
import { registryBuildCode } from "./registryCode.js";
import { classifyAccount } from "./safeBatch.js";
import {
  checkBalance,
  checkEndpoint,
  checkPayoutWallet,
  checkManagerState,
  checkRegistryBuild,
  checkSponsor,
  lintPolicy,
  type Finding,
} from "./doctorChecks.js";
import { healthBaseUrl } from "./flow.js";

const findings: Finding[] = [];
const icon = { ok: "✓", warn: "!", fail: "✗" } as const;
function add(...f: Finding[]) {
  for (const x of f) {
    findings.push(x);
    console.log(` ${icon[x.level]} ${x.msg}`);
  }
}
function section(title: string) {
  console.log(`\n${title}`);
}

async function main() {
  console.log(`sponsor:doctor  relayer ${relayerAddress}  registry ${config.feeMarketRegistry}`);

  section("Chain");
  let chainOk = false;
  try {
    const id = await publicClient.getChainId();
    chainOk = id === config.chainId;
    add(chainOk ? { level: "ok", msg: `RPC reachable, chain id ${id}` } : { level: "fail", msg: `RPC is chain ${id} but CHAIN_ID=${config.chainId}` });
  } catch (e) {
    add({ level: "fail", msg: `RPC unreachable: ${(e as Error).message.split("\n")[0]}` });
  }
  if (!chainOk) return;

  section("Contracts");
  const named: [string, Address][] = [
    ["DelegationManager", config.delegationManager],
    ["delegator implementation", config.delegatorImplementation],
    ["RedeemerRestrictionEnforcer", config.redeemerRestrictionEnforcer],
    ["LimitedCallsEnforcer", config.limitedCallsEnforcer],
    ["ExactExecutionBatchEnforcer", config.exactExecutionBatchEnforcer],
    ["TimestampEnforcer", config.timestampEnforcer],
  ];
  const [registryBuild, ...codes] = await Promise.all([
    registryBuildCode(publicClient, config.feeMarketRegistry),
    ...named.map(([, a]) => publicClient.getCode({ address: a })),
  ]);
  // The registry is a proxy: the functions live in the implementation it points at, so look there.
  if (registryBuild.implementation) add({ level: "ok", msg: `registry is a proxy; implementation ${registryBuild.implementation}` });
  const registryImplCode = registryBuild.code;
  add(...checkRegistryBuild(registryImplCode));
  named.forEach(([name, addr], i) => {
    const c = codes[i];
    add(c && c !== "0x" ? { level: "ok", msg: `${name} has code` } : { level: "fail", msg: `${name} has no code at ${addr}` });
  });

  const mgr = { address: config.delegationManager, abi: delegationManagerAbi } as const;
  const [paused, owner] = await Promise.all([
    publicClient.readContract({ ...mgr, functionName: "paused" }).catch(() => undefined),
    publicClient.readContract({ ...mgr, functionName: "owner" }).catch(() => undefined),
  ]);
  add(...checkManagerState(paused as boolean | undefined, owner as string | undefined));

  section("Relayer key");
  add(checkBalance(await publicClient.getBalance({ address: relayerAddress })));

  section("Sponsor registration");
  const base = { address: config.feeMarketRegistry, abi: feeMarketRegistryAbi } as const;
  try {
    const [s, committed, isMember, endpoint] = await Promise.all([
      publicClient.readContract({ ...base, functionName: "sponsors", args: [config.sponsorId] }),
      publicClient.readContract({ ...base, functionName: "metadataHash", args: [config.sponsorId] }),
      // null when the registry has no relayer set / endpoint (older build)
      publicClient.readContract({ ...base, functionName: "isRelayer", args: [config.sponsorId, relayerAddress] }).then((v) => v as boolean, () => null),
      publicClient.readContract({ ...base, functionName: "sponsorEndpoint", args: [config.sponsorId] }).then((v) => v as string, () => null),
    ]);
    const [payout, relayer, , status] = s as readonly [Address, Address, string, number, boolean];
    const registered = relayer !== "0x0000000000000000000000000000000000000000";
    add(
      ...checkSponsor({
        registered,
        relayerMatches: relayer.toLowerCase() === relayerAddress.toLowerCase() || isMember === true,
        standby: relayer.toLowerCase() !== relayerAddress.toLowerCase() && isMember === true,
        status,
        metadataCommitted: (committed as string) !== "0x" + "00".repeat(32),
      }),
    );
    add(...checkEndpoint(endpoint, config.publicRelayerUrl));
    if (registered) {
      const published = !!config.publicRelayerUrl && !config.publicRelayerUrl.includes("example");
      add(checkPayoutWallet(classifyAccount(await publicClient.getCode({ address: payout })), published));
    }
  } catch (e) {
    add({ level: "fail", msg: `could not read the registry: ${(e as Error).message.split("\n")[0]}` });
  }

  section("Policy");
  add(
    ...lintPolicy({
      dashboardToken: config.dashboardToken,
      corsOrigins: config.corsOrigins,
      maxGasWei: config.policy.maxGasWei,
      publicRelayerUrl: config.publicRelayerUrl,
      requireRedeemerRestriction: config.policy.requireRedeemerRestriction,
      simulateBeforeSend: config.policy.simulateBeforeSend,
      trustProxy: config.trustProxy,
      maxDelegationTtlSeconds: config.policy.maxDelegationTtlSeconds,
      maxGasUnits: config.policy.maxGasUnits,
      minRelayerBalanceWei: config.policy.minRelayerBalanceWei,
      alertWebhookUrl: config.policy.alertWebhookUrl,
      maxFeePerGasGwei: config.policy.maxFeePerGasGwei,
      rpcUrls: config.rpcUrls,
      stateDir: config.stateDir,
      clientIpHeader: config.clientIpHeader,
      rateLimitDelegatorMax: config.policy.rateLimitDelegatorMax,
      maxConcurrentSponsored: config.policy.maxConcurrentSponsored,
      signerSource: config.signer.source,
      metricsToken: config.metricsToken,
      watchIntervalMs: config.watch.intervalMs,
      host: config.host,
    }),
  );

  if (config.stateDir) {
    try {
      mkdirSync(config.stateDir, { recursive: true });
      const probe = join(config.stateDir, ".doctor-write-test");
      writeFileSync(probe, "ok");
      rmSync(probe);
      add({ level: "ok", msg: `state directory ${config.stateDir} is writable` });
    } catch (e) {
      add({ level: "fail", msg: `cannot write to STATE_DIR ${config.stateDir} (${(e as Error).message}): in-flight transactions would not survive a restart` });
    }
  }

  section("Public endpoint");
  if (!config.publicRelayerUrl || config.publicRelayerUrl.includes("example")) {
    add({ level: "warn", msg: "PUBLIC_RELAYER_URL is not set to your real URL yet" });
  } else {
    const base = healthBaseUrl(config.publicRelayerUrl);
    try {
      const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(8000) });
      const body = (await res.json()) as { relayer?: string; sponsorId?: string };
      if (body.relayer?.toLowerCase() === relayerAddress.toLowerCase()) {
        add({ level: "ok", msg: `${base}/health answers and reports this relayer` });
      } else {
        add({ level: "fail", msg: `${base}/health answers but reports relayer ${body.relayer}, not ${relayerAddress}` });
      }
    } catch (e) {
      add({ level: "warn", msg: `${base}/health is not reachable yet (${(e as Error).message}); fine before you deploy` });
    }
  }
}

main()
  .catch((e) => add({ level: "fail", msg: `doctor crashed: ${(e as Error).message}` }))
  .finally(() => {
    const fails = findings.filter((f) => f.level === "fail").length;
    const warns = findings.filter((f) => f.level === "warn").length;
    console.log(`\n${fails} blocking, ${warns} advice`);
    process.exit(fails > 0 ? 1 : 0);
  });
