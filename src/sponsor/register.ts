/**
 * Sponsor onboarding CLI. Run AFTER deploying FeeMarketRegistry and funding the relayer key.
 *
 *   npm run sponsor:register     # registers this relayer as a sponsor (status -> PENDING)
 *   npm run sponsor:metadata:publish   # then publish + commit metadata (URI and content hash)
 *   npm run sponsor:list         # lists the plans defined below (requires VERIFIED status)
 *   npm run sponsor:status       # prints this sponsor's on-chain status and metadata commitment
 *
 * Verification (UNVERIFIED/PENDING -> VERIFIED) is done by the marketplace curator after auditing
 * your code/infra AND the committed metadata; you cannot self-verify, and the curator cannot verify a
 * sponsor that has not committed a metadata hash. listPlan reverts until you're VERIFIED. Changing the
 * committed metadata hash, the relayer or the payout address afterwards sends you back to PENDING.
 */
import { encodeFunctionData, getAddress } from "viem";
import { config } from "../config.js";
import { feeMarketRegistryAbi } from "../abi.js";
import { account, publicClient, relayerAddress, sendTransactionSafe } from "../lib/clients.js";
import { generateListing } from "./listing.js";
import { SPONSOR_PLANS as PLANS } from "./plans.js";

// Optional at registration: the metadata embeds the sponsorId, which only exists afterwards, so it is
// normally committed right after with `npm run sponsor:metadata:publish`.
const METADATA_URI = process.env.SPONSOR_METADATA_URI ?? "";
const METADATA_HASH = (process.env.SPONSOR_METADATA_HASH ?? "0x" + "00".repeat(32)) as `0x${string}`;

// Where earnings are paid and who may withdraw / rotate keys. Use a separate cold address in production;
// defaults to the relayer key only for quick tests.
const PAYOUT = process.env.SPONSOR_PAYOUT_ADDRESS ? getAddress(process.env.SPONSOR_PAYOUT_ADDRESS) : account.address;

async function register() {
  console.log(`registering sponsor: payout=${PAYOUT} relayer=${relayerAddress}`);
  const data = encodeFunctionData({
    abi: feeMarketRegistryAbi,
    functionName: "registerSponsor",
    args: [PAYOUT, relayerAddress, METADATA_URI, METADATA_HASH],
  });
  const hash = await sendTransactionSafe({ to: config.feeMarketRegistry, data });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log(`✓ registered (tx ${hash}, status ${receipt.status})`);
  console.log("Next: set SPONSOR_ID, run `npm run sponsor:metadata:publish`, ask the curator to verify you, then `npm run sponsor:list`.");
}

/** Same (model, paymentToken, price, quota, period, caveatsHash) as an already-active plan for this
 * sponsor — used to skip re-listing a plan `listPlans` has already put on-chain. */
function planKey(p: { model: number; paymentToken: string; price: bigint; quota: bigint; period: bigint; caveatsHash: string }): string {
  return [p.model, p.paymentToken.toLowerCase(), p.price, p.quota, p.period, p.caveatsHash.toLowerCase()].join("|");
}

async function existingActivePlanKeys(): Promise<Set<string>> {
  const nextPlanId = (await publicClient.readContract({
    address: config.feeMarketRegistry,
    abi: feeMarketRegistryAbi,
    functionName: "nextPlanId",
  })) as bigint;

  const ids = Array.from({ length: Number(nextPlanId) - 1 }, (_, i) => BigInt(i + 1));
  const plans = await Promise.all(
    ids.map((id) =>
      publicClient.readContract({
        address: config.feeMarketRegistry,
        abi: feeMarketRegistryAbi,
        functionName: "plans",
        args: [id],
      }) as Promise<readonly [bigint, number, string, bigint, bigint, bigint, string, boolean]>,
    ),
  );

  const keys = new Set<string>();
  for (const p of plans) {
    const [sponsorId, model, paymentToken, price, quota, period, caveatsHash, active] = p;
    if (sponsorId === config.sponsorId && active) {
      keys.add(planKey({ model, paymentToken, price, quota, period, caveatsHash }));
    }
  }
  return keys;
}

/** Idempotent: running this again (e.g. after a restart, or re-running the onboarding steps by
 * habit) must not re-list plans that are already active on-chain — `listPlan` has no uniqueness
 * check of its own, so every call used to create a fresh duplicate instead of a no-op. */
async function listPlans() {
  await assertVerified();
  const existing = await existingActivePlanKeys();
  for (const req of PLANS) {
    const gen = generateListing(config.sponsorId, req);
    const { model, paymentToken, price, quota, period, caveatsHash } = gen.listPlanArgs;
    if (existing.has(planKey({ model, paymentToken, price, quota, period, caveatsHash }))) {
      console.log(`· skipped "${req.name}" — an identical plan is already listed and active`);
      continue;
    }
    const data = encodeFunctionData({
      abi: feeMarketRegistryAbi,
      functionName: "listPlan",
      args: [config.sponsorId, model, paymentToken, price, quota, period, caveatsHash],
    });
    const hash = await sendTransactionSafe({ to: config.feeMarketRegistry, data });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    console.log(`✓ listed "${req.name}" (tx ${hash}, status ${receipt.status})`);
  }
}

async function status() {
  const base = { address: config.feeMarketRegistry, abi: feeMarketRegistryAbi, args: [config.sponsorId] } as const;
  const [s, committed, verified] = await Promise.all([
    publicClient.readContract({ ...base, functionName: "sponsors" }),
    publicClient.readContract({ ...base, functionName: "metadataHash" }),
    publicClient.readContract({ ...base, functionName: "verifiedMetadataHash" }),
  ]);
  const labels = ["UNVERIFIED", "PENDING", "VERIFIED", "REVOKED"];
  console.log({
    payout: s[0],
    relayer: s[1],
    metadataURI: s[2],
    status: labels[s[3]] ?? s[3],
    active: s[4],
    metadataHash: committed,
    verifiedMetadataHash: verified,
  });
}

async function assertVerified() {
  const s = (await publicClient.readContract({
    address: config.feeMarketRegistry,
    abi: feeMarketRegistryAbi,
    functionName: "sponsors",
    args: [config.sponsorId],
  })) as readonly [string, string, string, number, boolean];
  if (s[3] !== 2) throw new Error(`sponsor not VERIFIED (status ${s[3]}); listPlan will revert`);
}

const cmd = process.argv[2] ?? "register";
const run = { register, list: listPlans, status }[cmd];
if (!run) {
  console.error(`unknown command "${cmd}". use: register | list | status`);
  process.exit(1);
}
run().catch((e) => {
  console.error("✗", (e as Error).message);
  process.exit(1);
});
