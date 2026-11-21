/**
 * Sponsor metadata: build the JSON, validate it against the schema, upload it, and commit its location
 * AND content hash on-chain via FeeMarketRegistry.updateMetadata.
 *
 * Integrity model: the contract stores `metadataHash = keccak256(exact bytes uploaded)`. The curator
 * verifies that exact content and the contract pins the hash, so changing the file later (or re-uploading
 * different bytes) demotes the sponsor to PENDING until it is re-verified. Clients (wallet, web) re-hash
 * what they fetch and refuse content that does not match the on-chain hash. The contract cannot parse
 * JSON, so the schema below is enforced here before publishing and consistency with on-chain data
 * (relayer, payout, registry, caveat hashes) is checked too.
 *
 * Storage: IPFS by default (via thirdweb storage) — content-addressed and publicly fetchable by anyone
 * with no credentials, so the marketplace's own web app never needs to hold a sponsor's storage keys to
 * read their metadata (see README's "A known centralization gap, and the honest fix", #50). Configure:
 *     THIRDWEB_SECRET_KEY=...    (recommended for a server: full-trust, no domain restriction)
 *   or THIRDWEB_CLIENT_ID=...    (a public id is enough; same one the web Sponsor panel uses)
 *   Get either free at https://thirdweb.com/dashboard — this is "your app's" key, not a per-upload secret;
 *   it just authenticates the upload request, nothing about the content is private.
 *
 * Fil One (S3-compatible object storage) is still available as an alternate, opt-in backend
 * (METADATA_STORAGE=filone) for sponsors who already have their own bucket — the web app no longer has a
 * Fil-One-specific fetch path, so self-hosted Fil One buckets MUST be public-read to be reachable by clients.
 */
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createThirdwebClient } from "thirdweb";
import { upload } from "thirdweb/storage";
import { type Hex, encodeAbiParameters, encodeFunctionData, getAddress, keccak256, stringToBytes } from "viem";
import { z } from "zod";
import { config } from "../config.js";
import { feeMarketRegistryAbi } from "../abi.js";
import { account, publicClient, relayerAddress, sendTransactionSafe } from "../lib/clients.js";
import { economicsProblems, generateListing, hashCaveatPolicy } from "./listing.js";
import { SPONSOR_PLANS, SPONSOR_PROFILE } from "./plans.js";

function storageConfig() {
  const bucket = process.env.FIL_BUCKET;
  if (!bucket) {
    throw new Error(
      "FIL_BUCKET is not set. Create a bucket in your Fil One account and set FIL_BUCKET in .env.",
    );
  }
  const region = process.env.FIL_REGION ?? "eu-west-1";
  const endpoint = process.env.FIL_ENDPOINT ?? `https://${region}.s3.filonecontent.com`;
  const accessKeyId = process.env.STORAGE_ACCESS_KEY_ID;
  const secretAccessKey = process.env.STORAGE_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) {
    throw new Error("STORAGE_ACCESS_KEY_ID / STORAGE_SECRET_ACCESS_KEY are not set in .env.");
  }
  return { bucket, region, endpoint, accessKeyId, secretAccessKey };
}

/** Aggregates sponsor identity + all listed plans into one publishable metadata object. */
export function buildMetadata() {
  return {
    sponsorId: config.sponsorId.toString(),
    name: SPONSOR_PROFILE.name,
    region: SPONSOR_PROFILE.region,
    relayerEndpoint: SPONSOR_PROFILE.relayerEndpoint,
    // Only included when set, so a sponsor that sets none publishes exactly the bytes it always did.
    ...(process.env.SPONSOR_DESCRIPTION ? { description: process.env.SPONSOR_DESCRIPTION } : {}),
    ...(process.env.SPONSOR_WEBSITE ? { website: process.env.SPONSOR_WEBSITE } : {}),
    ...(process.env.SPONSOR_SUPPORT_URL ? { supportUrl: process.env.SPONSOR_SUPPORT_URL } : {}),
    relayer: relayerAddress,
    // The cold wallet from SPONSOR_PAYOUT_ADDRESS. Falling back to the relayer is only the same-key test setup;
    // a distinct payout is what registration stored, and validateMetadata rejects a mismatch.
    payoutAddress: process.env.SPONSOR_PAYOUT_ADDRESS ? getAddress(process.env.SPONSOR_PAYOUT_ADDRESS) : account.address,
    chainId: config.chainId,
    feeMarketRegistry: config.feeMarketRegistry,
    plans: SPONSOR_PLANS.map((p) => generateListing(config.sponsorId, p).metadata),
    // No timestamp on purpose: the content hash is committed on-chain, so the bytes must be reproducible.
  };
}

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "must be an address");
const hex32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "must be a 32-byte hex value");
const httpsUrl = z.string().url().refine((u) => u.startsWith("https://"), "must be an https:// URL");

/** The published metadata schema. Anything not matching is rejected before it can be committed. */
export const sponsorMetadataSchema = z
  .object({
    sponsorId: z.string().regex(/^[1-9][0-9]*$/),
    name: z.string().min(1).max(100),
    region: z.string().min(1).max(50),
    relayerEndpoint: httpsUrl,
    // Optional profile fields shown in the wallet's "Your sponsor" page. Absent by default so existing metadata (and its
    // pinned hash) is byte-for-byte unchanged; when present they are reviewed by the curator with everything else.
    description: z.string().min(1).max(280).optional(),
    website: httpsUrl.optional(),
    supportUrl: httpsUrl.optional(),
    relayer: address,
    payoutAddress: address,
    chainId: z.number().int().positive(),
    feeMarketRegistry: address,
    plans: z
      .array(
        z
          .object({
            name: z.string().min(1).max(100),
            region: z.string().optional(),
            supportedChains: z.array(z.number().int().positive()).min(1),
            relayerEndpoint: httpsUrl,
            pricing: z.string().min(1),
            economics: z
              .object({
                paymentToken: address,
                model: z.number().int().min(0).max(2),
                price: z.string().regex(/^[0-9]+$/),
                quota: z.string().regex(/^[0-9]+$/),
                period: z.string().regex(/^[0-9]+$/),
              })
              .strict(),
            caveats: z.record(z.string(), z.unknown()),
            caveatsHash: hex32,
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

export type SponsorMetadata = z.infer<typeof sponsorMetadataSchema>;

const bigintReplacer = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);

/** The one canonical serialization: these exact bytes are what gets hashed, uploaded and later re-hashed. */
export function serializeMetadata(json: unknown): string {
  return JSON.stringify(json, bigintReplacer, 2);
}

export function metadataHashOf(body: string): Hex {
  return keccak256(stringToBytes(body));
}

/** Throws unless `json` matches the schema and agrees with the registry and with itself. */
export async function validateMetadata(json: unknown): Promise<SponsorMetadata> {
  const parsed = sponsorMetadataSchema.parse(JSON.parse(serializeMetadata(json)));

  if (parsed.chainId !== config.chainId) throw new Error(`metadata.chainId ${parsed.chainId} != configured chain ${config.chainId}`);
  if (getAddress(parsed.feeMarketRegistry) !== config.feeMarketRegistry) {
    throw new Error("metadata.feeMarketRegistry does not match FEE_MARKET_REGISTRY");
  }
  const onChain = (await publicClient.readContract({
    address: config.feeMarketRegistry,
    abi: feeMarketRegistryAbi,
    functionName: "sponsors",
    args: [config.sponsorId],
  })) as readonly [string, string, string, number, boolean];
  if (getAddress(parsed.payoutAddress) !== getAddress(onChain[0])) throw new Error("metadata.payoutAddress != on-chain payout address");
  if (getAddress(parsed.relayer) !== getAddress(onChain[1])) throw new Error("metadata.relayer != on-chain relayer");

  // each plan's caveat policy must hash to the value committed with listPlan (users verify this too)
  for (const plan of parsed.plans) {
    const recomputed = hashCaveatPolicy(plan.caveats as never);
    if (recomputed.toLowerCase() !== plan.caveatsHash.toLowerCase()) {
      throw new Error(`plan "${plan.name}": caveatsHash does not match keccak256 of its caveat policy`);
    }
    const bad = economicsProblems(plan.economics);
    if (bad.length) throw new Error(`plan "${plan.name}": ${bad.join("; ")}`);
  }
  return parsed;
}

/** Uploads the already-serialized metadata (exact bytes) to IPFS via thirdweb storage and returns its ipfs:// URI. */
export async function uploadMetadataToIPFS(body: string): Promise<string> {
  const secretKey = process.env.THIRDWEB_SECRET_KEY;
  const clientId = process.env.THIRDWEB_CLIENT_ID;
  if (!secretKey && !clientId) {
    throw new Error(
      "THIRDWEB_SECRET_KEY (or THIRDWEB_CLIENT_ID) is not set. Get either free at https://thirdweb.com/dashboard, " +
        "or set METADATA_STORAGE=filone to use a Fil One bucket instead.",
    );
  }
  const client = createThirdwebClient(secretKey ? { secretKey } : { clientId: clientId as string });
  const uri = await upload({
    client,
    files: [new File([body], "metadata.json", { type: "application/json" })],
    uploadWithoutDirectory: true,
  });
  if (!uri) throw new Error("IPFS upload returned no URI");
  return uri;
}

/** Uploads the already-serialized metadata (exact bytes) to Fil One (S3-compatible) and returns its URL. */
export async function uploadMetadataToFilOne(body: string): Promise<string> {
  const { bucket, region, endpoint, accessKeyId, secretAccessKey } = storageConfig();
  const client = new S3Client({
    region,
    endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
  });

  const key = `sponsor-${config.sponsorId}/metadata.json`;

  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: "application/json",
      ACL: "public-read",
    }),
  );

  return `${endpoint}/${bucket}/${key}`;
}

/** Uploads via the configured backend — IPFS by default (METADATA_STORAGE=ipfs), Fil One if opted into. */
export async function uploadMetadata(body: string): Promise<string> {
  const provider = process.env.METADATA_STORAGE ?? "ipfs";
  if (provider === "filone") return uploadMetadataToFilOne(body);
  if (provider !== "ipfs") throw new Error(`METADATA_STORAGE must be "ipfs" or "filone", got "${provider}"`);
  return uploadMetadataToIPFS(body);
}

/** keccak256(abi.encode(bytes32[])) — the registry's caveatsRoot. Order is the metadata plan order. */
export function caveatsRoot(hashes: readonly Hex[]): Hex {
  return keccak256(encodeAbiParameters([{ type: "bytes32[]" }], [hashes]));
}

/** Calls FeeMarketRegistry.updateMetadata — signer must be the relayer or payout. */
export async function setMetadata(uri: string, hash: Hex, caveatsHashes: readonly Hex[]): Promise<`0x${string}`> {
  const data = encodeFunctionData({
    abi: feeMarketRegistryAbi,
    functionName: "updateMetadata",
    args: [config.sponsorId, uri, hash, caveatsHashes],
  });
  const tx = await sendTransactionSafe({ to: config.feeMarketRegistry, data });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: tx });
  if (receipt.status !== "success") throw new Error(`updateMetadata reverted (tx ${tx})`);
  return tx;
}
