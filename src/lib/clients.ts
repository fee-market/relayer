import {
  type Chain,
  type Hex,
  type SendTransactionParameters,
  createPublicClient,
  createWalletClient,
  fallback,
  http,
} from "viem";
import { config } from "../config.js";
import { loadAccount } from "./signer.js";

export const account = loadAccount(config.signer);
export const relayerAddress = account.address;

export const chain: Chain = {
  id: config.chainId,
  name: `chain-${config.chainId}`,
  nativeCurrency: { name: "native", symbol: "NATIVE", decimals: 18 },
  rpcUrls: { default: { http: [...config.rpcUrls] } },
};

/** Reads and CLI sends: ordered fallback across every configured provider (the first is preferred, the rest only
 * when it errors or times out). One provider is a plain http transport. */
const transport = config.rpcUrls.length > 1
  ? fallback(config.rpcUrls.map((url) => http(url, { timeout: 8000, retryCount: 1 })), { retryCount: 2 })
  : http(config.rpcUrls[0], { timeout: 8000, retryCount: 1 });

export const publicClient = createPublicClient({ transport, chain });
export const walletClient = createWalletClient({ account, transport, chain });

/** One client per provider, for sending the same signed transaction to every one of them (see txManager.broadcast). */
export const providerClients = config.rpcUrls.map((url) => ({
  url,
  client: createPublicClient({ transport: http(url, { timeout: 8000, retryCount: 0 }), chain }),
}));

export interface ProviderStatus {
  /** Host only: RPC URLs usually carry an API key in the path and must never reach /health. */
  host: string;
  up: boolean;
  blockNumber?: string;
  ms?: number;
}

let statusCache: { at: number; value: ProviderStatus[] } | null = null;

/** Probes every provider (eth_blockNumber, 2.5 s timeout), cached for 10 s: /health and the dashboard ask often. */
export async function providerStatuses(now = Date.now()): Promise<ProviderStatus[]> {
  if (statusCache && now - statusCache.at < 10_000) return statusCache.value;
  const value = await Promise.all(
    providerClients.map(async ({ url, client }): Promise<ProviderStatus> => {
      const host = new URL(url).host;
      const started = Date.now();
      try {
        const n = await Promise.race([
          client.getBlockNumber(),
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), 2500)),
        ]);
        return { host, up: true, blockNumber: n.toString(), ms: Date.now() - started };
      } catch {
        return { host, up: false };
      }
    }),
  );
  statusCache = { at: now, value };
  return value;
}

/**
 * Nonce-safe send. Kept for the CLI tools (register, metadata, bootstrap); the implementation (serialized nonces,
 * explicit fees, stuck-transaction replacement) lives in txManager.ts, which is also what the HTTP endpoints use.
 */
export async function sendTransactionSafe(params: Omit<SendTransactionParameters, "account" | "chain">): Promise<Hex> {
  const { send } = await import("./txManager.js");
  return send(params as never);
}
