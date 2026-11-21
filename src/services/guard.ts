import { config } from "../config.js";
import { providerStatuses, publicClient, relayerAddress } from "../lib/clients.js";
import { alert } from "./alerts.js";

/** An error that carries the HTTP status the endpoint should answer with. */
export class HttpError extends Error {
  /** Seconds the client should wait before retrying (sent as Retry-After). */
  constructor(public readonly status: number, message: string, public readonly retryAfter?: number) {
    super(message);
    this.name = "HttpError";
  }
}

const CACHE_MS = 5000;
let cached: { at: number; balance: bigint } | null = null;

/** Relayer balance, cached briefly: every sponsored request and every /health hit asks, and the RPC need not be. */
export async function relayerBalance(now = Date.now()): Promise<bigint> {
  if (cached && now - cached.at < CACHE_MS) return cached.balance;
  const balance = await publicClient.getBalance({ address: relayerAddress });
  cached = { at: now, balance };
  return balance;
}

let draining = false;
/** Called on SIGTERM: the node finishes what it has but takes nothing new, and reports unhealthy so the proxy or
 * load balancer stops sending it traffic. */
export function setDraining(): void {
  draining = true;
}
export function isDraining(): boolean {
  return draining;
}

export interface Readiness {
  /** Can this node take sponsored work right now. */
  ready: boolean;
  balanceWei: bigint;
  problems: string[];
  providers: { host: string; up: boolean; blockNumber?: string; ms?: number }[];
}

export async function readiness(): Promise<Readiness> {
  const [balanceWei, providers] = await Promise.all([relayerBalance().catch(() => 0n), providerStatuses()]);
  const problems: string[] = [];
  if (draining) problems.push("restarting: not taking new requests");
  if (providers.length > 0 && providers.every((p) => !p.up)) problems.push("no RPC provider is reachable");
  const min = config.policy.minRelayerBalanceWei;
  if (min > 0n && balanceWei < min) {
    problems.push(`relayer balance ${balanceWei} is below the minimum ${min}`);
    alert("low-balance", `relayer ${relayerAddress} is low on gas funds: ${balanceWei} wei (minimum ${min}). Sponsored sends are paused until it is topped up.`);
  }
  return { ready: problems.length === 0, balanceWei, problems, providers };
}

/** Refuse new sponsored work while the node cannot pay for it: a clear 503 beats accepting a request that then fails. */
export async function assertCanSponsor(): Promise<void> {
  if (draining) throw new HttpError(503, "this sponsor is restarting, try again in a moment", 5);
  const r = await readiness();
  if (!r.ready) throw new HttpError(503, r.problems.some((p) => /balance/.test(p)) ? "this sponsor is temporarily out of gas funds" : r.problems[0], 10);
}

/** Test hook. */
export function _resetGuard(): void {
  cached = null;
}
