import { z } from "zod";

const hex = z.string().regex(/^0x[0-9a-fA-F]*$/, "must be 0x-hex");
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "must be an address");

export const caveatSchema = z.object({
  enforcer: address,
  terms: hex,
  args: hex.default("0x"),
});

export const delegationSchema = z.object({
  delegate: address,
  delegator: address,
  authority: hex,
  caveats: z.array(caveatSchema),
  salt: z.string(), // decimal or 0x string -> BigInt
  signature: hex,
});

/**
 * What a user (or dApp / wallet) POSTs to the relayer to be sponsored.
 *  - delegations: leaf->root chain (usually length 1) signed by the user's 7702 account.
 *  - executionCallData: the ERC-7579 Execution[] batch to run.
 *  - authorization: the EIP-7702 authorization tuple, ONLY needed the first time the EOA is upgraded.
 *  - subscriptionId: which marketplace subscription this draws against (its escrow is charged by the batch's last call).
 */
export const relayRequestSchema = z.object({
  subscriptionId: z.string(),
  delegations: z.array(delegationSchema).min(1),
  mode: hex.optional(),
  executionCallData: hex,
  authorization: z
    .object({
      chainId: z.number(),
      address: address, // delegator implementation
      nonce: z.number(),
      r: hex,
      s: hex,
      yParity: z.number(),
    })
    .optional(),
});

/**
 * What a user POSTs to /subscribe to create a new subscription (0 native balance, sponsor pays gas).
 * Same shape as a relay request minus subscriptionId — there isn't one yet, this call creates it.
 * executionCallData MUST decode to exactly one call: FeeMarketRegistry.subscribe(planId, amount) —
 * enforced server-side in subscribeValidator.ts, not by this schema.
 */
export const subscribeRequestSchema = relayRequestSchema.omit({ subscriptionId: true });

/**
 * What a user POSTs to /topup to add escrow to an EXISTING subscription. Same shape as /subscribe —
 * no top-level subscriptionId; it's encoded inside executionCallData as topUp(subscriptionId, amount),
 * enforced server-side in topUpValidator.ts.
 */
export const topUpRequestSchema = subscribeRequestSchema;

export type RelayRequest = z.infer<typeof relayRequestSchema>;
export type SubscribeRequest = z.infer<typeof subscribeRequestSchema>;
export type Delegation = z.infer<typeof delegationSchema>;
export type Caveat = z.infer<typeof caveatSchema>;

/** What redeemer.ts actually needs — satisfied by RelayRequest, SubscribeRequest, and top-up requests. */
export type ExecutionRequest = Omit<RelayRequest, "subscriptionId">;
