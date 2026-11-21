// Shared by genParityFixture.ts and metadata.test.ts: the input set and how the RELAYER computes the outputs.
import type { Address } from "viem";

const USDC = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359";
export const fixtureInput = {
  profile: {
    sponsorId: "7",
    name: "Parity Gas Co",
    region: "eu-west",
    relayerEndpoint: "https://relay.parity.example/relay",
    relayer: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    payoutAddress: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
    chainId: 137,
    feeMarketRegistry: "0x57e6742610229c7Ce09df3028471397DaaE6B9f4",
  },
  plans: [
    { name: "Bulk", region: "eu-west", supportedChains: [137], relayerEndpoint: "https://relay.parity.example/relay", paymentToken: USDC, model: 1, priceBaseUnits: "10000000", quota: "1000", periodSeconds: "0", caveats: { restrictToRelayer: true, maxCalls: 1, exactBatch: true } },
    { name: "Pay as you go", region: "eu-west", supportedChains: [137], relayerEndpoint: "https://relay.parity.example/relay", paymentToken: USDC, model: 0, priceBaseUnits: "10000", quota: "0", periodSeconds: "0", caveats: { restrictToRelayer: true, maxCalls: 1 } },
    { name: "Monthly unlimited", region: "eu-west", supportedChains: [137], relayerEndpoint: "https://relay.parity.example/relay", paymentToken: USDC, model: 2, priceBaseUnits: "25000000", quota: "0", periodSeconds: "2592000", caveats: { restrictToRelayer: true, maxCalls: 1, exactBatch: true, allowedTargets: [USDC] } },
    { name: "Capped subscription", region: "us-east", supportedChains: [137, 1], relayerEndpoint: "https://relay.parity.example/relay", paymentToken: USDC, model: 2, priceBaseUnits: "1500000", quota: "50", periodSeconds: "86400", caveats: { restrictToRelayer: true, allowedSelectors: ["0xa9059cbb"], spendCaps: [{ token: USDC, maxAmount: "5000000" }] } },
  ],
} as const;

export type FixtureInput = typeof fixtureInput;

export async function computeParity(input: FixtureInput) {
  const { commitmentOfRow, generateListing, hashCaveatPolicy } = await import("../src/sponsor/listing.js");
  const { metadataHashOf, serializeMetadata } = await import("../src/sponsor/metadata.js");
  const reqs = input.plans.map((p) => ({
    ...p,
    paymentToken: p.paymentToken as Address,
    priceBaseUnits: BigInt(p.priceBaseUnits),
    quota: BigInt(p.quota),
    periodSeconds: BigInt(p.periodSeconds),
    caveats: {
      ...p.caveats,
      ...("spendCaps" in p.caveats ? { spendCaps: (p.caveats as { spendCaps: { token: string; maxAmount: string }[] }).spendCaps.map((c) => ({ token: c.token as Address, maxAmount: BigInt(c.maxAmount) })) } : {}),
    },
  }));
  const listings = reqs.map((r) => generateListing(BigInt(input.profile.sponsorId), r as never));
  const metadata = {
    ...input.profile,
    plans: listings.map((l) => l.metadata),
  };
  const body = serializeMetadata(metadata);
  return {
    caveatsHashes: reqs.map((r) => hashCaveatPolicy(r.caveats as never)),
    // what the registry's `planCommitment` returns for each plan: the list that is actually committed on chain
    commitments: listings.map((l) => commitmentOfRow(l.metadata)),
    pricing: listings.map((l) => l.metadata.pricing),
    serialized: body,
    hash: metadataHashOf(body),
  };
}
