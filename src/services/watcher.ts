import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAbiItem, type Address } from "viem";
import { config } from "../config.js";
import { getStoreSync } from "../lib/store.js";
import { logger } from "../lib/log.js";
import { alert } from "./alerts.js";
import { m } from "./telemetry.js";

/**
 * The node's own watch over the things that can hurt its users and its operator, checked every WATCH_INTERVAL_MS:
 *  - the registry: halted? solvent for each watched token?
 *  - governance and upgrades: curator events on the registry (halt, deposit cap, ownership), the proxy (Upgraded,
 *    AdminChanged) and the timelock (CallScheduled, CallExecuted, Cancelled). A scheduled upgrade is public seven
 *    days ahead, so the alert is the whole point of the delay.
 *  - the node itself: share of failed sponsored requests over a window, and whether the canary still passes.
 * The reads are injected (`Deps`) so the logic is tested without a chain.
 */
export interface ChainEvent {
  name: string;
  source: "registry" | "proxy" | "timelock";
  id: string; // unique per log, used as the alert key
  detail: string;
  severity: "high" | "info";
}

export interface Deps {
  head(): Promise<bigint>;
  events(from: bigint, to: bigint): Promise<ChainEvent[]>;
  halted(): Promise<boolean>;
  solvent(token: Address): Promise<boolean>;
  /** Sponsored request outcomes since `sinceMs` (from the stats log). */
  recentOutcomes(sinceMs: number): { total: number; failed: number };
  /** Last canary result, or null when none was ever recorded. */
  canary(): { at: number; ok: boolean; error?: string } | null;
  now(): number;
}

export interface WatchState {
  lastBlock: bigint | null;
}

const MAX_SPAN = 2000n;

export async function runWatch(deps: Deps, state: WatchState): Promise<string[]> {
  const raised: string[] = [];
  const raise = (key: string, message: string) => {
    raised.push(key);
    alert(key, message);
  };

  const halted = await deps.halted();
  m.registryHalted.set(halted ? 1 : 0);
  if (halted) raise("registry-halted", `the registry is HALTED by the curator: new subscriptions and deposits are refused; exits stay open.`);

  for (const token of config.watch.tokens.length ? config.watch.tokens : [config.dashboardEarningsToken]) {
    const ok = await deps.solvent(token as Address);
    m.registrySolvent.set(ok ? 1 : 0, { token: token.toLowerCase() });
    if (!ok) raise(`insolvent:${token.toLowerCase()}`, `the registry is INSOLVENT for ${token}: it holds less than it owes. This should never happen; halt and investigate.`);
  }

  const head = await deps.head();
  if (state.lastBlock === null) state.lastBlock = head; // do not replay history on the first run
  else if (head > state.lastBlock) {
    let from = state.lastBlock + 1n;
    if (head - from > MAX_SPAN) from = head - MAX_SPAN; // after a long outage: look at the recent past only
    for (const ev of await deps.events(from, head)) {
      m.chainEvents.inc({ event: ev.name });
      logger.warn("chain_event", { event: ev.name, source: ev.source, detail: ev.detail });
      raise(`event:${ev.id}`, `${ev.severity === "high" ? "ATTENTION " : ""}${ev.source} ${ev.name}: ${ev.detail}`);
    }
    state.lastBlock = head;
  }

  const now = deps.now();
  const { errorWindowMs, errorMinRequests, errorRateThreshold, canaryMaxAgeMs } = config.watch;
  if (errorWindowMs > 0) {
    const { total, failed } = deps.recentOutcomes(now - errorWindowMs);
    if (total >= errorMinRequests && failed / total >= errorRateThreshold) {
      raise("error-rate", `${failed} of the last ${total} sponsored requests failed (${Math.round((failed / total) * 100)}%) in the last ${Math.round(errorWindowMs / 60000)} min.`);
    }
  }

  const c = deps.canary();
  if (c) {
    m.canaryOk.set(c.ok ? 1 : 0);
    if (c.ok) m.canaryLastSuccess.set(Math.floor(c.at / 1000));
  }
  if (canaryMaxAgeMs > 0) {
    if (!c || !c.ok || now - c.at > canaryMaxAgeMs) {
      raise("canary", c ? `the end-to-end canary has not passed in the last ${Math.round(canaryMaxAgeMs / 60000)} min (${c.ok ? "too old" : c.error ?? "failing"}).` : "the end-to-end canary has never run.");
    }
  }

  m.watcherLastRun.set(Math.floor(now / 1000));
  return raised;
}

/** Reads the canary result the `canary` tool leaves in STATE_DIR. */
export function readCanary(dir = config.stateDir): { at: number; ok: boolean; error?: string } | null {
  if (!dir) return null;
  try {
    const v = JSON.parse(readFileSync(join(dir, "canary.json"), "utf8"));
    return typeof v?.at === "number" ? { at: v.at, ok: !!v.ok, error: typeof v.error === "string" ? v.error : undefined } : null;
  } catch {
    return null;
  }
}

const EVENTS = {
  HaltedChanged: parseAbiItem("event HaltedChanged(bool halted)"),
  DepositCapSet: parseAbiItem("event DepositCapSet(address indexed token, uint256 cap)"),
  OwnershipTransferStarted: parseAbiItem("event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner)"),
  OwnershipTransferred: parseAbiItem("event OwnershipTransferred(address indexed previousOwner, address indexed newOwner)"),
  Upgraded: parseAbiItem("event Upgraded(address indexed implementation)"),
  AdminChanged: parseAbiItem("event AdminChanged(address previousAdmin, address newAdmin)"),
} as const;
const TIMELOCK = {
  CallScheduled: parseAbiItem("event CallScheduled(bytes32 indexed id, uint256 indexed index, address target, uint256 value, bytes data, bytes32 predecessor, uint256 delay)"),
  CallExecuted: parseAbiItem("event CallExecuted(bytes32 indexed id, uint256 indexed index, address target, uint256 value, bytes data)"),
  Cancelled: parseAbiItem("event Cancelled(bytes32 indexed id)"),
} as const;

/** Turns a decoded log into a ChainEvent (exported for tests). */
export function describe(source: ChainEvent["source"], name: string, args: Record<string, unknown>, id: string): ChainEvent {
  const a = args as Record<string, any>;
  const high = new Set(["CallScheduled", "CallExecuted", "Upgraded", "AdminChanged", "OwnershipTransferStarted", "OwnershipTransferred", "HaltedChanged"]);
  let detail = "";
  switch (name) {
    case "HaltedChanged": detail = a.halted ? "the registry was halted" : "the registry was resumed"; break;
    case "DepositCapSet": detail = `deposit cap for ${a.token} set to ${a.cap}`; break;
    case "OwnershipTransferStarted": detail = `curator change started: ${a.previousOwner} -> ${a.newOwner} (not final until accepted)`; break;
    case "OwnershipTransferred": detail = `curator is now ${a.newOwner} (was ${a.previousOwner})`; break;
    case "Upgraded": detail = `logic upgraded to ${a.implementation}`; break;
    case "AdminChanged": detail = `proxy admin changed ${a.previousAdmin} -> ${a.newAdmin}`; break;
    case "CallScheduled": detail = `operation ${a.id} scheduled on ${a.target} executable in ${a.delay}s (public notice: this is the upgrade window)`; break;
    case "CallExecuted": detail = `operation ${a.id} executed on ${a.target}`; break;
    case "Cancelled": detail = `operation ${a.id} cancelled`; break;
    default: detail = JSON.stringify(a, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  }
  return { name, source, id, detail, severity: high.has(name) ? "high" : "info" };
}

let timer: NodeJS.Timeout | null = null;

/** Starts the periodic watch against the real chain. No-op when WATCH_INTERVAL_MS is 0. */
export async function startWatcher(): Promise<void> {
  if (config.watch.intervalMs <= 0 || timer) return;
  const { publicClient } = await import("../lib/clients.js");
  const { feeMarketRegistryAbi } = await import("../generated/feeMarketRegistryAbi.js");
  const { getLogs: recent } = await import("./stats.js").then((s) => ({ getLogs: s.getLogs }));
  const registry = config.feeMarketRegistry as Address;
  const timelock = config.watch.upgradeTimelock ? (config.watch.upgradeTimelock as Address) : null;

  const store = getStoreSync(config.stateDir);
  const saved = store.section<{ lastBlock?: string }>("watcher");
  const state: WatchState = { lastBlock: saved?.lastBlock ? BigInt(saved.lastBlock) : null };
  store.register("watcher", () => ({ lastBlock: state.lastBlock?.toString() }));

  const deps: Deps = {
    head: () => publicClient.getBlockNumber(),
    halted: () => publicClient.readContract({ address: registry, abi: feeMarketRegistryAbi, functionName: "halted" }) as Promise<boolean>,
    solvent: (token) => publicClient.readContract({ address: registry, abi: feeMarketRegistryAbi, functionName: "isSolvent", args: [token] }) as Promise<boolean>,
    events: async (from, to) => {
      const out: ChainEvent[] = [];
      const pull = async (address: Address, source: ChainEvent["source"], items: Record<string, any>) => {
        for (const [name, event] of Object.entries(items)) {
          const logs = await publicClient.getLogs({ address, event, fromBlock: from, toBlock: to });
          for (const l of logs) out.push(describe(source, name, (l as any).args ?? {}, `${l.transactionHash}:${l.logIndex}`));
        }
      };
      await pull(registry, "registry", { HaltedChanged: EVENTS.HaltedChanged, DepositCapSet: EVENTS.DepositCapSet, OwnershipTransferStarted: EVENTS.OwnershipTransferStarted, OwnershipTransferred: EVENTS.OwnershipTransferred });
      await pull(registry, "proxy", { Upgraded: EVENTS.Upgraded, AdminChanged: EVENTS.AdminChanged });
      if (timelock) await pull(timelock, "timelock", TIMELOCK);
      return out;
    },
    recentOutcomes: (since) => {
      const l = recent(500).filter((x) => x.ts >= since && x.outcome !== "rejected");
      return { total: l.length, failed: l.filter((x) => x.outcome !== "success").length };
    },
    canary: () => readCanary(),
    now: () => Date.now(),
  };

  const pass = async () => {
    try {
      await runWatch(deps, state);
      store.markDirty();
    } catch (e) {
      m.watcherErrors.inc();
      logger.error("watcher_failed", { error: (e as Error).message });
    }
  };
  timer = setInterval(() => void pass(), config.watch.intervalMs);
  timer.unref?.();
  void pass();
  logger.info("watcher_started", { intervalMs: config.watch.intervalMs, timelock: timelock ?? "(not watched)" });
}

export function stopWatcher(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
