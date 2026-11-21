import { config } from "../config.js";
import { getStoreSync } from "../lib/store.js";
import { currentRequestId, logger } from "../lib/log.js";
import { m } from "./telemetry.js";

/**
 * Operational telemetry for the sponsor dashboard. Single-process; for multi-instance deployments push these into a
 * shared store (Redis/Postgres). Counters and the last logs are kept in the node's state file (see lib/store.ts) so a
 * restart does not wipe the dashboard: `startedAt` is the first start, `uptimeSec` counts from this process.
 */

export type RelayOutcome = "success" | "rejected" | "reverted" | "error";

export interface RelayLog {
  ts: number;
  outcome: RelayOutcome;
  subscriptionId?: string;
  delegator?: string;
  redeemTx?: string;
  gasUsedWei?: string;
  reason?: string;
  /** The x-request-id of the HTTP request that produced this entry (when there was one). */
  requestId?: string;
}

interface Counters {
  startedAt: number;
  total: number;
  success: number;
  rejected: number;
  reverted: number;
  error: number;
  totalGasUsedWei: bigint;
}

const MAX_LOGS = 500;
const store = getStoreSync(config.stateDir);
const processStartedAt = Date.now();

const saved = store.section<{ logs?: RelayLog[]; counters?: Partial<Counters> }>("stats");
const logs: RelayLog[] = Array.isArray(saved?.logs) ? saved!.logs!.slice(0, MAX_LOGS) : [];
const counters: Counters = {
  startedAt: saved?.counters?.startedAt ?? Date.now(),
  total: saved?.counters?.total ?? 0,
  success: saved?.counters?.success ?? 0,
  rejected: saved?.counters?.rejected ?? 0,
  reverted: saved?.counters?.reverted ?? 0,
  error: saved?.counters?.error ?? 0,
  totalGasUsedWei: typeof saved?.counters?.totalGasUsedWei === "bigint" ? saved.counters.totalGasUsedWei : 0n,
};
store.register("stats", () => ({ logs, counters }));

export function record(entry: Omit<RelayLog, "ts">): void {
  const log: RelayLog = { ts: Date.now(), requestId: currentRequestId(), ...entry };
  logs.unshift(log);
  if (logs.length > MAX_LOGS) logs.pop();

  m.relayRequests.inc({ outcome: entry.outcome });
  if (entry.gasUsedWei) m.gasUsedWei.inc({}, Number(entry.gasUsedWei));
  // The outcome and where it happened, never the request itself. The id ties it to the access line of the same request.
  logger[entry.outcome === "success" || entry.outcome === "rejected" ? "info" : "warn"]("relay", { outcome: entry.outcome, subscriptionId: entry.subscriptionId, redeemTx: entry.redeemTx, reason: entry.reason });
  counters.total++;
  counters[entry.outcome]++;
  if (entry.gasUsedWei) counters.totalGasUsedWei += BigInt(entry.gasUsedWei);
  store.markDirty();
}

export function getLogs(limit = 100, outcome?: RelayOutcome): RelayLog[] {
  const filtered = outcome ? logs.filter((l) => l.outcome === outcome) : logs;
  return filtered.slice(0, limit);
}

export function getCounters() {
  return {
    startedAt: counters.startedAt,
    uptimeSec: Math.floor((Date.now() - processStartedAt) / 1000),
    total: counters.total,
    success: counters.success,
    rejected: counters.rejected,
    reverted: counters.reverted,
    error: counters.error,
    successRate: counters.total ? counters.success / counters.total : 0,
    totalGasUsedWei: counters.totalGasUsedWei.toString(),
  };
}
