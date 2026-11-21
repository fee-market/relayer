/**
 * End-to-end canary: the checks a wallet's first request would hit, run against a live node from the outside, on a
 * schedule (cron, a monitor, a CI job). Every run writes the result to STATE_DIR/canary.json, which the node's watcher
 * reads (set CANARY_MAX_AGE_MS to be alerted when it stops passing) and exposes as feemarket_canary_* metrics.
 *
 *   npm run canary -- https://relayer.example.com [--state-dir ./state] [--token <METRICS_TOKEN>]
 *
 * What it proves, without spending any gas:
 *   1. GET /health answers 200 and ready (RPC reachable, relayer funded) and reports the expected sponsor id
 *   2. the request pipeline is alive: a deliberately malformed POST /relay is refused with a 4xx JSON error (not a 5xx,
 *      not a timeout, not an HTML page from a proxy in front)
 *   3. CORS and security headers are present, and the dashboard and metrics are not open without a token
 *   4. (with --token) /metrics answers with the Prometheus format
 * What it does NOT prove: that a real sponsored transaction confirms. That needs a funded canary subscription; run
 * `npm run e2e:mainnet-transfer` for it, and record the result the same way (--record-only ok|fail "reason").
 * Exit code 0 = all passed, 1 = something failed.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const url = args.find((a) => /^https?:\/\//.test(a))?.replace(/\/$/, "");
const stateDir = flag("--state-dir") ?? process.env.STATE_DIR ?? "";
const token = flag("--token") ?? process.env.METRICS_TOKEN ?? "";
const expectSponsor = flag("--sponsor-id") ?? process.env.SPONSOR_ID;
const record = args.indexOf("--record-only");

function write(ok: boolean, error?: string, ms?: number) {
  if (!stateDir) return;
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "canary.json"), JSON.stringify({ at: Date.now(), ok, ...(error ? { error } : {}), ...(ms !== undefined ? { ms } : {}) }));
}

if (record >= 0) {
  const ok = args[record + 1] === "ok";
  write(ok, ok ? undefined : args[record + 2] ?? "recorded as failed");
  console.log(`recorded: ${ok ? "ok" : "fail"}`);
  process.exit(ok ? 0 : 1);
}
if (!url) {
  console.error("usage: npm run canary -- <node url> [--state-dir DIR] [--token METRICS_TOKEN] [--sponsor-id N]");
  process.exit(2);
}

const started = Date.now();
const problems: string[] = [];
const check = (ok: boolean, what: string, detail = "") => { console.log(`  ${ok ? "✓" : "✗"} ${what}${!ok && detail ? ` (${detail})` : ""}`); if (!ok) problems.push(`${what}${detail ? `: ${detail}` : ""}`); };
const get = (path: string, init: RequestInit = {}) => fetch(url + path, { ...init, signal: AbortSignal.timeout(10_000) });

try {
  const h = await get("/health", { headers: { origin: "https://canary.invalid" } });
  const body: any = await h.json().catch(() => null);
  check(h.status === 200 && body?.ok === true, "/health is ready", `status ${h.status}${body?.problems ? " " + body.problems.join("; ") : ""}`);
  if (expectSponsor) check(body?.sponsorId === expectSponsor, "/health reports the expected sponsor id", `got ${body?.sponsorId}`);
  check(h.headers.get("x-content-type-options") === "nosniff", "security headers are set");
  check(!!h.headers.get("x-request-id"), "responses carry a request id");
  check(h.headers.get("access-control-allow-origin") !== "*", "CORS is not wide open");

  const bad = await get("/relay", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ canary: true }) });
  const badBody: any = await bad.json().catch(() => null);
  check(bad.status >= 400 && bad.status < 500 && badBody?.ok === false, "a malformed /relay request is refused cleanly", `status ${bad.status}`);

  const admin = await get("/admin/stats");
  check(admin.status === 401 || admin.status === 503, "the dashboard API is closed without a token", `status ${admin.status}`);
  const metrics = await get("/metrics");
  check(metrics.status === 401 || metrics.status === 503, "/metrics is closed without a token", `status ${metrics.status}`);

  if (token) {
    const mt = await get("/metrics", { headers: { authorization: `Bearer ${token}` } });
    const text = await mt.text();
    check(mt.status === 200 && text.includes("feemarket_relayer_balance_wei"), "/metrics answers with the token");
  }
} catch (e) {
  check(false, "the node answered", (e as Error).message);
}

const ms = Date.now() - started;
write(problems.length === 0, problems.join(" | ") || undefined, ms);
console.log(problems.length === 0 ? `canary passed in ${ms} ms` : `canary FAILED: ${problems.length} problem(s)`);
process.exit(problems.length === 0 ? 0 : 1);
