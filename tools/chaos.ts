/**
 * Load and failure-injection test, fully offline. Starts a REAL node process against a fake JSON-RPC server that this
 * script controls, then measures the node under load and breaks its RPC on purpose:
 *
 *   baseline load      many concurrent clients on /live and a malformed /relay: throughput, latency percentiles, no 5xx
 *   RPC down           /health must say 503 (not hang, not crash), /live keeps answering
 *   RPC slow           /health answers within a bound even when the provider never does
 *   RPC garbage        non-JSON and JSON-RPC errors do not crash the node
 *   recovery           /health returns to 200 once the RPC is back
 *   rate limit         a burst past RATE_LIMIT_MAX gets 429 with Retry-After
 *   graceful stop      SIGTERM exits 0 inside the drain window and leaves a valid state file
 *
 *   npm run chaos            (about 1-2 minutes; prints the numbers it measured)
 * What it does NOT cover: real chain behaviour (nonce races, stuck-transaction replacement are in test:txmanager and
 * test:resilience), or a network far from the node.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Mode = "ok" | "down" | "slow" | "garbage" | "rpcerror";
let mode: Mode = "ok";
const hex = (n: bigint | number) => "0x" + BigInt(n).toString(16);

// ---- fake RPC --------------------------------------------------------------------------------------------------------
const rpc: Server = createServer(async (req, res) => {
  if (mode === "down") return void req.socket.destroy();
  if (mode === "slow") return void setTimeout(() => res.destroy(), 30_000).unref();
  let body = "";
  for await (const c of req) body += c;
  if (mode === "garbage") return void res.writeHead(200, { "content-type": "text/html" }).end("<html>bad gateway</html>");
  const one = (r: { id: number; method: string }) => {
    if (mode === "rpcerror") return { jsonrpc: "2.0", id: r.id, error: { code: -32000, message: "header not found" } };
    const result =
      r.method === "eth_chainId" ? hex(137)
      : r.method === "eth_blockNumber" ? hex(96_000_000)
      : r.method === "eth_getBalance" ? hex(10n ** 19n)
      : r.method === "eth_getTransactionCount" ? hex(5)
      : r.method === "eth_gasPrice" ? hex(50_000_000_000n)
      : r.method === "eth_maxPriorityFeePerGas" ? hex(30_000_000_000n)
      : r.method === "eth_call" ? "0x" + "0".repeat(63) + "1"
      : "0x0";
    return { jsonrpc: "2.0", id: r.id, result };
  };
  const parsed = JSON.parse(body);
  res.setHeader("content-type", "application/json").end(JSON.stringify(Array.isArray(parsed) ? parsed.map(one) : one(parsed)));
});
await new Promise<void>((r) => rpc.listen(0, "127.0.0.1", r));
const rpcUrl = `http://127.0.0.1:${(rpc.address() as AddressInfo).port}`;

// ---- node process ----------------------------------------------------------------------------------------------------
const stateDir = mkdtempSync(join(tmpdir(), "chaos-state-"));
const port = 20000 + Math.floor(Math.random() * 20000);
let node: ChildProcess;
let nodeLog = "";
const base = `http://127.0.0.1:${port}`;

function start(extra: Record<string, string> = {}) {
  // The node itself, not `npx tsx`: on some npm versions npx forks the server as a child, so a SIGTERM to this process killed only the
  // wrapper (exit null after a few ms) and left the real server running on the port, which made every later check hit the old node.
  node = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: {
      PATH: process.env.PATH!, HOME: process.env.HOME!,
      // Nothing from a real .env may leak in: this run is offline and talks only to the fake RPC.
      DOTENV_CONFIG_PATH: "/dev/null", RPC_URLS: "", CLIENT_IP_HEADER: "", TRUST_PROXY: "0", DASHBOARD_TOKEN: "", PUBLIC_RELAYER_URL: "", ALERT_WEBHOOK_URL: "",
      RPC_URL: rpcUrl, CHAIN_ID: "137", PORT: String(port), HOST: "127.0.0.1", STATE_DIR: stateDir,
      RELAYER_PRIVATE_KEY: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
      DELEGATION_MANAGER: "0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3", DELEGATOR_IMPLEMENTATION: "0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B",
      FEE_MARKET_REGISTRY: "0x57e6742610229c7Ce09df3028471397DaaE6B9f4", REDEEMER_RESTRICTION_ENFORCER: "0x5C75d7ee6d3d27634bec15e96538e794F9c7053b",
      SPONSOR_ID: "1", WATCH_INTERVAL_MS: "0", LOG_LEVEL: "warn", DRAIN_MS: "3000", METRICS_TOKEN: "chaos-token-0123456789",
      RATE_LIMIT_MAX: "1000000", RATE_LIMIT_WINDOW_MS: "60000", MIN_RELAYER_BALANCE_WEI: "0", ...extra,
    },
  });
  node.stdout?.on("data", (d) => (nodeLog += d));
  node.stderr?.on("data", (d) => (nodeLog += d));
}
async function waitUp(ms = 30_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if ((await fetch(`${base}/live`)).ok) return; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`node did not start:\n${nodeLog.slice(-1500)}`);
}

// ---- helpers ---------------------------------------------------------------------------------------------------------
const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? `  (${detail})` : ""}`);
}
const pct = (xs: number[], p: number) => xs.slice().sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((xs.length * p) / 100))] ?? 0;

async function load(path: string, init: RequestInit, clients: number, seconds: number) {
  const lat: number[] = [], status: Record<string, number> = {};
  const end = Date.now() + seconds * 1000;
  await Promise.all(Array.from({ length: clients }, async () => {
    while (Date.now() < end) {
      const t = performance.now();
      try {
        const r = await fetch(base + path, { ...init, signal: AbortSignal.timeout(15_000) });
        await r.arrayBuffer();
        status[r.status] = (status[r.status] ?? 0) + 1;
      } catch { status.error = (status.error ?? 0) + 1; }
      lat.push(performance.now() - t);
    }
  }));
  return { n: lat.length, rps: Math.round(lat.length / seconds), p50: Math.round(pct(lat, 50)), p95: Math.round(pct(lat, 95)), p99: Math.round(pct(lat, 99)), status };
}
const health = async () => { const t = Date.now(); const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(30_000) }); return { status: r.status, ms: Date.now() - t, body: await r.json().catch(() => null) as any }; };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => Promise<boolean>, ms: number) { const end = Date.now() + ms; while (Date.now() < end) { if (await fn().catch(() => false)) return true; await wait(500); } return false; }

// ---- scenarios -------------------------------------------------------------------------------------------------------
try {
  start();
  await waitUp();
  console.log(`node up on :${port}, fake RPC on ${rpcUrl}\n`);

  console.log("baseline load (20 clients, 6 s each)");
  const live = await load("/live", {}, 20, 6);
  console.log(`    /live   ${live.rps} req/s  p50 ${live.p50} ms  p95 ${live.p95} ms  p99 ${live.p99} ms  ${JSON.stringify(live.status)}`);
  check("/live: every request answered 200", live.status[200] === live.n, `${live.n} requests`);
  check("/live: p99 under 500 ms", live.p99 < 500, `p99 ${live.p99} ms`);
  const bad = await load("/relay", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ junk: true }) }, 20, 6);
  console.log(`    /relay (malformed)  ${bad.rps} req/s  p50 ${bad.p50} ms  p95 ${bad.p95} ms  p99 ${bad.p99} ms  ${JSON.stringify(bad.status)}`);
  const fiveXX = Object.entries(bad.status).filter(([s]) => /^5|error/.test(s)).reduce((a, [, n]) => a + n, 0);
  check("/relay malformed: only 400/429, never a 5xx or a dropped connection", fiveXX === 0, JSON.stringify(bad.status));
  check("/relay malformed: p99 under 1 s", bad.p99 < 1000, `p99 ${bad.p99} ms`);
  const h0 = await health();
  check("/health is 200 with a healthy RPC", h0.status === 200, `${h0.ms} ms`);

  console.log("\nRPC down");
  mode = "down"; await wait(10_500); // the provider probe is cached for 10 s
  const h1 = await health();
  check("/health answers 503 (not a hang, not a crash)", h1.status === 503, `status ${h1.status} in ${h1.ms} ms`);
  check("/health says why", Array.isArray(h1.body?.problems) && h1.body.problems.length > 0, JSON.stringify(h1.body?.problems));
  check("/health answers within 15 s", h1.ms < 15_000, `${h1.ms} ms`);
  check("/live still answers 200", (await fetch(`${base}/live`)).status === 200);
  check("the node process is still running", node!.exitCode === null);

  console.log("\nRPC slow (never answers)");
  mode = "slow"; await wait(10_500);
  const h2 = await health();
  check("/health gives up within 8 s instead of hanging, with a 503", h2.ms < 8_000 && h2.status === 503, `status ${h2.status} in ${h2.ms} ms`);
  check("/live still answers during the slow RPC", (await fetch(`${base}/live`)).status === 200);

  console.log("\nRPC garbage");
  mode = "garbage"; await wait(10_500);
  const h3 = await health();
  check("HTML instead of JSON: /health answers 503, not a crash", h3.status === 503 && node!.exitCode === null, `status ${h3.status}`);
  mode = "rpcerror"; await wait(10_500);
  const h4 = await health();
  check("JSON-RPC errors: /health answers 503, not a crash", h4.status === 503 && node!.exitCode === null, `status ${h4.status}`);
  const bad2 = await load("/relay", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }, 5, 2);
  // While the node cannot reach its RPC it turns sponsored requests away up front with a 503 (+ Retry-After): clean, never a dropped connection or a 500.
  check("/relay refuses cleanly (400/429/503 only) while the RPC is broken", !("error" in bad2.status) && Object.keys(bad2.status).every((s) => ["400", "429", "503"].includes(s)), JSON.stringify(bad2.status));

  console.log("\nrecovery");
  mode = "ok";
  const recovered = await until(async () => (await health()).status === 200, 30_000);
  check("/health returns to 200 once the RPC is back", recovered);
  const metrics = await (await fetch(`${base}/metrics`, { headers: { authorization: "Bearer chaos-token-0123456789" } })).text();
  check("/metrics reports the provider and the 5xx/4xx it served", /feemarket_rpc_provider_up/.test(metrics) && /feemarket_http_requests_total/.test(metrics));

  console.log("\ngraceful stop");
  const t0 = Date.now();
  const exited = new Promise<number | null>((r) => node!.on("exit", (c) => r(c)));
  node!.kill("SIGTERM");
  const code = await Promise.race([exited, wait(10_000).then(() => "timeout" as const)]);
  check("SIGTERM exits 0 inside the drain window", code === 0 && Date.now() - t0 < 8000, `exit ${code} after ${Date.now() - t0} ms`);
  let stateOk = false;
  try { JSON.parse(readFileSync(join(stateDir, "state.json"), "utf8")); stateOk = true; } catch { /* missing or invalid */ }
  check("the state file is valid JSON after the stop", stateOk);

  console.log("\nrestart");
  start({ RATE_LIMIT_MAX: "50" }); await waitUp();
  check("the node starts again from that state", (await fetch(`${base}/live`)).status === 200);

  console.log("\nrate limit (restarted with RATE_LIMIT_MAX=50)");
  const burst = await load("/health", {}, 10, 3);
  check("a burst past RATE_LIMIT_MAX gets 429", (burst.status[429] ?? 0) > 0, JSON.stringify(burst.status));
  check("it lets the allowed requests through first", (burst.status[200] ?? 0) > 0 && (burst.status[200] ?? 0) <= 50, `${burst.status[200] ?? 0} x 200`);
  const r429 = await fetch(`${base}/health`);
  check("429 carries Retry-After", r429.status === 429 && !!r429.headers.get("retry-after"));
  check("/live is not rate limited", (await fetch(`${base}/live`)).status === 200);

} catch (e) {
  check("scenario run", false, (e as Error).message);
} finally {
  node!?.kill("SIGKILL");
  rpc.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) { console.error(`failed:\n${failed.map((f) => ` - ${f.name} ${f.detail}`).join("\n")}\n\nnode log tail:\n${nodeLog.slice(-1200)}`); process.exit(1); }
process.exit(0);
