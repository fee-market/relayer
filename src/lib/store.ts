import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * A small crash-safe state file for what must survive a restart: transactions still in flight (so a stuck one is
 * still replaced after a restart) and the dashboard's counters and logs.
 *
 * One JSON document, written atomically (write a temp file, fsync it, rename over the old one), so a crash mid-write
 * leaves the previous good file, never a torn one. It is rewritten at most about once a second. No native dependency:
 * the whole state is a few hundred KB at most. An unreadable file is moved aside (not deleted) and the node starts
 * empty, because refusing to boot over a corrupt cache would be worse than losing it.
 *
 * STATE_DIR="" turns persistence off (tests, one-off scripts).
 */

const TAG = "$bigint";

/** JSON that round-trips bigint (transaction values and gas are bigint). */
export function encode(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? { [TAG]: v.toString() } : v));
}
export function decode<T = unknown>(text: string): T {
  return JSON.parse(text, (_k, v) => (v && typeof v === "object" && typeof (v as Record<string, unknown>)[TAG] === "string" ? BigInt((v as Record<string, string>)[TAG]) : v)) as T;
}

type Provider = () => unknown;

export class StateStore {
  readonly file: string | null;
  private sections = new Map<string, Provider>();
  private loaded: Record<string, unknown> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;

  constructor(dir: string) {
    this.file = dir ? join(resolve(dir), "state.json") : null;
    if (this.file) process.on("exit", () => this.flushSync());
  }

  /** Reads the file once. Returns {} when persistence is off, the file is missing, or it is unreadable. */
  load(): Record<string, unknown> {
    if (this.loaded) return this.loaded;
    this.loaded = {};
    if (!this.file || !existsSync(this.file)) return this.loaded;
    try {
      const doc = decode<{ version?: number; sections?: Record<string, unknown> }>(readFileSync(this.file, "utf8"));
      if (doc.version === 1 && doc.sections) this.loaded = doc.sections;
    } catch (e) {
      const aside = `${this.file}.corrupt-${Date.now()}`;
      try { renameSync(this.file, aside); } catch { /* best effort */ }
      console.error(`[store] ${this.file} was unreadable (${(e as Error).message}); moved to ${aside}, starting empty`);
    }
    return this.loaded;
  }

  /** Forget the cached read so the next `load()` re-reads the file (tests simulating a restart). */
  reload(): void {
    this.loaded = null;
  }

  section<T>(name: string): T | undefined {
    return this.load()[name] as T | undefined;
  }

  /** A section's content is produced on demand each time the file is written. */
  register(name: string, provider: Provider): void {
    this.sections.set(name, provider);
  }

  /** Something changed: write soon (coalesced to about once a second). */
  markDirty(): void {
    if (!this.file) return;
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flushSync();
    }, 1000);
    this.timer.unref?.();
  }

  flushSync(): void {
    if (!this.file || !this.dirty) return;
    this.dirty = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    try {
      const sections: Record<string, unknown> = { ...this.load() };
      for (const [name, provider] of this.sections) sections[name] = provider();
      const dir = this.file.slice(0, this.file.lastIndexOf("/"));
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.tmp`;
      const fd = openSync(tmp, "w", 0o600);
      try {
        writeSync(fd, encode({ version: 1, savedAt: Date.now(), sections }));
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(tmp, this.file);
    } catch (e) {
      console.error(`[store] could not write ${this.file}: ${(e as Error).message}`);
    }
  }
}

let defaultStore: StateStore | null = null;
/** The node's own store, created on first use so STATE_DIR is read after env is loaded. */
export async function getStore(): Promise<StateStore> {
  if (!defaultStore) {
    const { config } = await import("../config.js");
    defaultStore = new StateStore(config.stateDir);
  }
  return defaultStore;
}
/** Synchronous variant for modules that already imported config. */
export function getStoreSync(stateDir: string): StateStore {
  if (!defaultStore) defaultStore = new StateStore(stateDir);
  return defaultStore;
}
/** Test hook. */
export function _resetStore(): void {
  defaultStore = null;
}
