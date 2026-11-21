/**
 * Regenerates fixtures/metadata-parity.json from this relayer implementation (source of truth for hashing).
 *   npx tsx tools/genParityFixture.ts
 * Marketplace clients that publish/verify metadata must reproduce every `expected` value exactly.
 */
import { writeFileSync } from "node:fs";

process.env.RPC_URL ??= "http://127.0.0.1:9";
process.env.CHAIN_ID ??= "137";
process.env.RELAYER_PRIVATE_KEY ??= "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
process.env.DELEGATION_MANAGER ??= "0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3";
process.env.DELEGATOR_IMPLEMENTATION ??= "0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B";
process.env.FEE_MARKET_REGISTRY ??= "0x57e6742610229c7Ce09df3028471397DaaE6B9f4";
process.env.REDEEMER_RESTRICTION_ENFORCER ??= "0x5C75d7ee6d3d27634bec15e96538e794F9c7053b";

const { fixtureInput, computeParity } = await import("./parityFixture.js");
const out = { input: fixtureInput, expected: await computeParity(fixtureInput) };
writeFileSync(new URL("../fixtures/metadata-parity.json", import.meta.url), JSON.stringify(out, null, 2) + "\n");
console.log("wrote fixtures/metadata-parity.json");
