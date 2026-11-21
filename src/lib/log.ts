import { AsyncLocalStorage } from "node:async_hooks";
import { config } from "../config.js";

/** The id of the HTTP request being handled, carried through every await so any log line inside it can name it. */
const als = new AsyncLocalStorage<{ requestId: string }>();
export const runWithRequestId = <T>(requestId: string, fn: () => T): T => als.run({ requestId }, fn);
export const currentRequestId = (): string | undefined => als.getStore()?.requestId;

/**
 * Structured logging: one event per line, with named fields, so a log pipeline (or grep) can follow one request through the node
 * by its request id. Never pass secrets, request bodies, signatures or keys as fields: log what happened, not what was sent.
 *
 *   LOG_FORMAT=json (default): {"ts":"…","level":"info","event":"http","requestId":"…","status":200}
 *   LOG_FORMAT=text          : 2026-10-31T10:00:00.000Z INFO http requestId=… status=200
 *   LOG_LEVEL=debug|info|warn|error
 */
export type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function format(level: Level, event: string, fields: Record<string, unknown> = {}, as: string = config.log.format, now = new Date()): string {
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    clean[k] = typeof v === "bigint" ? v.toString() : v instanceof Error ? v.message : v;
  }
  if (as === "text") {
    const kv = Object.entries(clean).map(([k, v]) => `${k}=${typeof v === "string" && /\s/.test(v) ? JSON.stringify(v) : String(v)}`);
    return [now.toISOString(), level.toUpperCase(), event, ...kv].join(" ");
  }
  return JSON.stringify({ ts: now.toISOString(), level, event, ...clean });
}

export function enabled(level: Level, min: string = config.log.level): boolean {
  return ORDER[level] >= (ORDER[min as Level] ?? ORDER.info);
}

function emit(level: Level, event: string, fields?: Record<string, unknown>): void {
  if (!enabled(level)) return;
  const line = format(level, event, { requestId: currentRequestId(), ...fields });
  if (level === "error" || level === "warn") console.error(line);
  else console.log(line);
}

export const logger = {
  debug: (event: string, fields?: Record<string, unknown>) => emit("debug", event, fields),
  info: (event: string, fields?: Record<string, unknown>) => emit("info", event, fields),
  warn: (event: string, fields?: Record<string, unknown>) => emit("warn", event, fields),
  error: (event: string, fields?: Record<string, unknown>) => emit("error", event, fields),
};
