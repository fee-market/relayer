/**
 * Sponsor metadata CLI.
 *
 *   npm run sponsor:metadata:upload   # build + validate + upload metadata.json, print URL and hash (no tx)
 *   npm run sponsor:metadata:set -- <uri> <hash>   # commit an already-uploaded URI + content hash on-chain
 *   npm run sponsor:metadata:publish  # upload AND commit on-chain in one step (the common case)
 *   (internal) publishMetadata.ts hash # print the content hash only; used by sponsor:onboard
 *
 * Edit src/sponsor/plans.ts (SPONSOR_PROFILE, SPONSOR_PLANS) to change what gets published.
 *
 * Committing a different hash for a VERIFIED sponsor sends it back to PENDING until the curator
 * re-verifies (same hash at a new URI does not). See docs/audit/AUDIT-REPORT.md (M-05).
 */
import type { Hex } from "viem";
import { commitmentOfRow } from "./listing.js";
import { buildMetadata, metadataHashOf, serializeMetadata, setMetadata, uploadMetadata, validateMetadata } from "./metadata.js";
import { publishedUrlProblem } from "./flow.js";

/** The metadata this node would publish, refused when its relay URL is a placeholder or one the wallet cannot use. */
function buildChecked() {
  const metadata = buildMetadata();
  for (const url of new Set<string>([metadata.relayerEndpoint, ...metadata.plans.map((p) => String(p.relayerEndpoint))])) {
    const problem = publishedUrlProblem(url);
    if (problem) {
      throw new Error(
        `${problem}. Set your real address with \`npm run sponsor:plans:configure\` (or PUBLIC_RELAYER_URL in .env when there is no sponsor.plans.json).`,
      );
    }
  }
  return metadata;
}

async function prepare() {
  const metadata = await validateMetadata(buildChecked());
  const body = serializeMetadata(metadata);
  const hash = metadataHashOf(body);
  console.log(body);
  console.log(`\n✓ schema valid and consistent with the registry; content hash ${hash}`);
  return { body, hash };
}

async function upload() {
  const { body, hash } = await prepare();
  const url = await uploadMetadata(body);
  console.log(`✓ uploaded: ${url}`);
  console.log(`Next: npm run sponsor:metadata:set -- ${url} ${hash}`);
}

async function set() {
  const uri = process.argv[3];
  const hash = process.argv[4];
  if (!uri || !hash || !/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error('usage: sponsor:metadata:set -- "<uri>" <0x…32-byte hash>');
  const { hash: expected } = await prepare();
  if (expected.toLowerCase() !== hash.toLowerCase()) {
    throw new Error("the hash does not match the metadata this node would publish; commit that metadata, or the plan set on-chain will not match the bytes");
  }
  const tx = await setMetadata(uri, hash as Hex, caveatHashes());
  console.log(`✓ metadata committed on-chain (tx ${tx})`);
}

/** One commitment per plan (token, model, price, quota, period and caveat policy), in plan order: what `listPlan` checks later. */
function caveatHashes() {
  return buildMetadata().plans.map((p) => commitmentOfRow(p));
}

async function publish() {
  const { body, hash } = await prepare();
  const url = await uploadMetadata(body);
  console.log(`✓ uploaded: ${url}`);
  const tx = await setMetadata(url, hash, caveatHashes());
  console.log(`✓ metadata committed on-chain (tx ${tx}). If you were VERIFIED you are now PENDING: ask the curator to re-verify.`);
}

/** Print only `HASH 0x…` of the metadata that would be published (no upload, no tx); used by sponsor:onboard. */
async function hashOnly() {
  const metadata = await validateMetadata(buildChecked());
  console.log(`HASH ${metadataHashOf(serializeMetadata(metadata))}`);
}

const cmd = process.argv[2];
const run = { upload, set, publish, hash: hashOnly }[cmd ?? ""];
if (!run) {
  console.error(`unknown command "${cmd}". use: upload | set | publish | hash`);
  process.exit(1);
}
run().catch((e) => {
  console.error("✗", (e as Error).message);
  process.exit(1);
});
