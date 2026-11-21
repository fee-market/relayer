/**
 * Offline tests for the dashboard and metrics hardening: constant-time token comparison, failed-login lockout,
 * security headers, request ids. No chain.
 *   npm run test:security
 */
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import express from "express";

process.env.RPC_URL ??= "http://127.0.0.1:9";
process.env.CHAIN_ID ??= "137";
process.env.STATE_DIR = "";
process.env.RELAYER_PRIVATE_KEY ??= "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
process.env.DELEGATION_MANAGER ??= "0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3";
process.env.DELEGATOR_IMPLEMENTATION ??= "0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B";
process.env.FEE_MARKET_REGISTRY ??= "0x57e6742610229c7Ce09df3028471397DaaE6B9f4";
process.env.REDEEMER_RESTRICTION_ENFORCER ??= "0x5C75d7ee6d3d27634bec15e96538e794F9c7053b";
process.env.SPONSOR_ID ??= "1";

const { safeEqual, bearerToken, sanitizeRequestId, securityHeaders } = await import("../src/lib/security.js");
const { requireToken } = await import("../src/admin.js");
const { Limiter, authFailureLimiter } = await import("../src/services/abuse.js");

let passed = 0;
let total = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  total++;
  try { await fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); process.exitCode = 1; }
}

// ------------------------------------------------------------------------------------------ token comparison
await test("safeEqual: equal strings match, anything else does not", () => {
  assert.equal(safeEqual("s3cret-token-0123456789", "s3cret-token-0123456789"), true);
  assert.equal(safeEqual("s3cret-token-0123456789", "s3cret-token-0123456780"), false, "last character differs");
  assert.equal(safeEqual("s3cret-token-0123456789", "S3cret-token-0123456789"), false, "case matters");
  assert.equal(safeEqual("short", "a-much-longer-token"), false, "different lengths do not throw");
  assert.equal(safeEqual("", "x"), false);
  assert.equal(safeEqual("", ""), true);
});
await test("bearerToken: only a well-formed Bearer header yields a token", () => {
  assert.equal(bearerToken("Bearer abc123"), "abc123");
  assert.equal(bearerToken("Bearer   abc123  "), "abc123");
  assert.equal(bearerToken("Basic abc123"), "");
  assert.equal(bearerToken("abc123"), "");
  assert.equal(bearerToken(undefined), "");
});
await test("sanitizeRequestId: harmless ids are kept, anything else is replaced", () => {
  const gen = () => "generated";
  assert.equal(sanitizeRequestId("abc-123_DEF.9", gen), "abc-123_DEF.9");
  assert.equal(sanitizeRequestId(undefined, gen), "generated");
  assert.equal(sanitizeRequestId("", gen), "generated");
  assert.equal(sanitizeRequestId("a".repeat(65), gen), "generated", "too long");
  assert.equal(sanitizeRequestId("evil\r\nSet-Cookie: x=1", gen), "generated", "header injection");
  assert.equal(sanitizeRequestId("<script>", gen), "generated");
});

// -------------------------------------------------------------------------------------------------- limiter
await test("limiter: isBlocked/hit count failures only, and a window expires", () => {
  const l = new Limiter(() => ({ windowMs: 1000, max: 3 }));
  assert.equal(l.isBlocked("ip", 0), false, "nothing counted yet");
  l.hit("ip", 0); l.hit("ip", 1); l.hit("ip", 2);
  assert.equal(l.isBlocked("ip", 3), true, "three failures in the window");
  assert.equal(l.isBlocked("other", 3), false, "another key is unaffected");
  assert.equal(l.retryAfterSec("ip", 3), 1);
  assert.equal(l.isBlocked("ip", 1001), false, "a new window");
  const off = new Limiter(() => ({ windowMs: 1000, max: 0 }));
  off.hit("ip", 0);
  assert.equal(off.isBlocked("ip", 1), false, "max 0 turns it off");
});

// ------------------------------------------------------------------------------------------- over real HTTP
const TOKEN = "correct-horse-battery-staple-token";
const app = express();
app.use(securityHeaders);
app.get("/admin", (_req, res) => res.send("<html></html>"));
app.get("/admin/stats", requireToken(TOKEN, "disabled"), (_req, res) => res.json({ ok: true }));
app.get("/open", (_req, res) => res.json({ ok: true }));
const off = express();
off.get("/admin/stats", requireToken("", "dashboard disabled: set DASHBOARD_TOKEN"), (_req, res) => res.json({ ok: true }));
const server = app.listen(0);
const offServer = off.listen(0);
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const offBase = `http://127.0.0.1:${(offServer.address() as AddressInfo).port}`;
const get = (path: string, token?: string, extra: Record<string, string> = {}) =>
  fetch(`${base}${path}`, { headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra } });

await test("the dashboard and metrics tokens are only ever compared with safeEqual (timing differences cannot be tested, so the source is checked)", () => {
  for (const file of ["../src/admin.ts", "../src/index.ts", "../src/lib/security.ts"]) {
    const src = readFileSync(new URL(file, import.meta.url), "utf8").replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    assert.doesNotMatch(src, /[!=]==?\s*(expected|config\.dashboardToken|config\.metricsToken)\b/, `${file} compares a secret token with an equality operator`);
    assert.doesNotMatch(src, /\b(expected|config\.dashboardToken|config\.metricsToken)\s*[!=]==?/, `${file} compares a secret token with an equality operator`);
  }
  assert.match(readFileSync(new URL("../src/admin.ts", import.meta.url), "utf8"), /safeEqual\(/);
});
await test("headers: every response is nosniff, unframeable, and referrer-free", async () => {
  const r = await get("/open");
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  assert.equal(r.headers.get("x-frame-options"), "DENY");
  assert.equal(r.headers.get("referrer-policy"), "no-referrer");
  assert.match(r.headers.get("content-security-policy") ?? "", /default-src 'none'/);
  assert.match(r.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
  assert.equal(r.headers.get("cache-control"), null, "ordinary endpoints are not forced uncacheable");
});
await test("headers: /admin is never cached, and only the dashboard page may run its own inline script", async () => {
  const page = await get("/admin");
  assert.equal(page.headers.get("cache-control"), "no-store");
  assert.match(page.headers.get("content-security-policy") ?? "", /script-src 'self' 'unsafe-inline'/);
  assert.doesNotMatch(page.headers.get("content-security-policy") ?? "", /unsafe-eval/);
  const data = await get("/admin/stats", TOKEN);
  assert.equal(data.headers.get("cache-control"), "no-store");
  assert.doesNotMatch(data.headers.get("content-security-policy") ?? "", /script-src/, "JSON endpoints allow no script at all");
});
await test("headers: HSTS only when the request came over https", async () => {
  assert.equal((await get("/open")).headers.get("strict-transport-security"), null);
  const secure = await get("/open", undefined, { "x-forwarded-proto": "https" });
  assert.match(secure.headers.get("strict-transport-security") ?? "", /max-age=\d+/);
});
await test("auth: no token configured means the dashboard is disabled (fail closed)", async () => {
  const r = await fetch(`${offBase}/admin/stats`, { headers: { authorization: "Bearer anything" } });
  assert.equal(r.status, 503);
});
await test("auth: missing, wrong and right tokens", async () => {
  assert.equal((await get("/admin/stats")).status, 401);
  assert.equal((await get("/admin/stats", "wrong")).status, 401);
  assert.equal((await get("/admin/stats", TOKEN)).status, 200);
});
await test("auth: ten wrong tokens lock the address out, even for the right token, with Retry-After", async () => {
  // the loopback address used by this test has already failed twice above
  for (let i = 0; i < 12; i++) await get("/admin/stats", `guess-${i}`);
  const locked = await get("/admin/stats", TOKEN);
  assert.equal(locked.status, 429, "the right token is refused while locked out");
  assert.ok(Number(locked.headers.get("retry-after")) >= 1);
  assert.equal(authFailureLimiter.isBlocked("::ffff:127.0.0.1") || authFailureLimiter.isBlocked("127.0.0.1") || authFailureLimiter.isBlocked("::1"), true);
});

server.close();
offServer.close();
console.log(`\n${passed}/${total} passed`);
if (passed !== total) process.exitCode = 1;
