import type { Address, Hex, PublicClient } from "viem";
import { addressFromSlot, IMPLEMENTATION_SLOT } from "./doctorChecks.js";

/**
 * The code to inspect when asking "is this the right registry build?". The registry is a proxy: the address everyone uses holds a
 * tiny forwarding contract, and the functions live in the implementation behind it. So read the implementation address from the
 * EIP-1967 slot and return its code; for a registry that is not a proxy, return the code at the address itself.
 */
export async function registryBuildCode(
  client: Pick<PublicClient, "getCode" | "getStorageAt">,
  registry: Address,
): Promise<{ code: Hex | undefined; implementation?: Address }> {
  const implementation = addressFromSlot(await client.getStorageAt({ address: registry, slot: IMPLEMENTATION_SLOT }));
  if (!implementation) return { code: await client.getCode({ address: registry }) };
  return { code: await client.getCode({ address: implementation }), implementation };
}
