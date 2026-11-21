/**
 * TTL cache with single-flight: concurrent callers asking for the same key share ONE underlying call, and the result is
 * reused for `ttlMs`. Errors are never cached. Used for reads that change rarely (plans, sponsor status, gas price),
 * so N simultaneous requests cost one RPC call instead of N.
 */
const entries = new Map<string, { at: number; value: unknown }>();
const flights = new Map<string, Promise<unknown>>();

export async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>, now = Date.now()): Promise<T> {
  if (ttlMs <= 0) return fn();
  const hit = entries.get(key);
  if (hit && now - hit.at < ttlMs) return hit.value as T;
  const flying = flights.get(key);
  if (flying) return flying as Promise<T>;
  const p = fn()
    .then((value) => {
      entries.set(key, { at: Date.now(), value });
      return value;
    })
    .finally(() => flights.delete(key));
  flights.set(key, p);
  return p;
}

export function invalidate(prefix = ""): void {
  for (const k of [...entries.keys()]) if (k.startsWith(prefix)) entries.delete(k);
}

/** Test hook. */
export function _clearCache(): void {
  entries.clear();
  flights.clear();
}
