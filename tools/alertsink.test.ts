/**
 * The local alert receiver writes what the relay sends, and refuses what it should.
 *   npm run test:alertsink
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

const { startSink } = await import("./alertsink.js");
const file = join(mkdtempSync(join(tmpdir(), "sink-")), "alerts.log");
const server = await startSink(0, file);
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
let passed = 0, total = 0;
async function test(name: string, fn: () => Promise<void>) {
  total++;
  try { await fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); process.exitCode = 1; }
}
const post = (body: string, path = "/alert") => fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body });

await test("an alert in the relay's shape is appended as one JSON line", async () => {
  const r = await post(JSON.stringify({ text: "[fee.market sponsor 1] x", content: "x", key: "k1", message: "registry halted" }));
  assert.equal(r.status, 204);
  const lines = readFileSync(file, "utf8").trim().split("\n");
  const last = JSON.parse(lines[lines.length - 1]);
  assert.equal(last.key, "k1"); assert.equal(last.message, "registry halted"); assert.ok(last.ts);
});
await test("bad JSON is a 400 and writes nothing", async () => {
  const before = readFileSync(file, "utf8");
  assert.equal((await post("{nope")).status, 400);
  assert.equal(readFileSync(file, "utf8"), before);
});
await test("other paths and methods are refused", async () => {
  assert.equal((await post("{}", "/other")).status, 404);
  assert.equal((await fetch(base + "/alert")).status, 404);
  assert.equal((await fetch(base + "/health")).status, 200);
});
await test("an oversized body is refused", async () => {
  const r = await post(JSON.stringify({ message: "x".repeat(40_000) })).catch(() => ({ status: 413 }));
  assert.equal(r.status, 413);
});
assert.ok(existsSync(file));
server.close();
console.log(`\n${passed}/${total} passed`);
