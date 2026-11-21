/**
 * Offline tests for key management: the encrypted keystore, the remote digest signer (against a real local HTTP signer),
 * Safe batches for the payout wallet, and the doctor's key/payout/monitoring checks. No chain.
 *   npm run test:signer
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeFunctionData, getAddress, keccak256, parseTransaction, recoverTransactionAddress, serializeTransaction, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount, sign } from "viem/accounts";

const { decryptKeystore, encryptKeystore, loadAccount, verifySigner, describeSource } = await import("../src/lib/signer.js");
const { batch, withdrawTxs, rotateTx, classifyAccount, acceptRoleTx, consentProblem, sponsorProblem, describeSponsor, ROLE_PAYOUT, ROLE_RELAYER } = await import("../src/sponsor/safeBatch.js");
const { lintPolicy, checkPayoutWallet } = await import("../src/sponsor/doctorChecks.js");
const { feeMarketRegistryAbi } = await import("../src/abi.js");

let passed = 0, total = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  total++;
  try { await fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); process.exitCode = 1; }
}

const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex;
const ADDR = privateKeyToAccount(KEY).address;
const dir = mkdtempSync(join(tmpdir(), "signer-"));

console.log("keystore");
await test("encrypt then decrypt returns the same key", () => {
  const ks = encryptKeystore(KEY, "correct horse battery", 1024);
  assert.equal(decryptKeystore(ks, "correct horse battery"), KEY);
  assert.equal(`0x${ks.address}`, ADDR.toLowerCase());
});
await test("a wrong password is refused, not decrypted to garbage", () => {
  const ks = encryptKeystore(KEY, "correct horse battery", 1024);
  assert.throws(() => decryptKeystore(ks, "wrong password!!"), /wrong password/);
});
await test("a tampered ciphertext is refused by the MAC", () => {
  const ks = encryptKeystore(KEY, "correct horse battery", 1024);
  ks.crypto.ciphertext = ks.crypto.ciphertext.replace(/^../, (b) => (b === "00" ? "01" : "00"));
  assert.throws(() => decryptKeystore(ks, "correct horse battery"), /wrong password|damaged/);
});
await test("the file holds no trace of the raw key", () => {
  const ks = JSON.stringify(encryptKeystore(KEY, "correct horse battery", 1024));
  assert.ok(!ks.includes(KEY.slice(2)));
});
await test("a known geth-format pbkdf2 keystore (from the Web3 Secret Storage spec) decrypts", () => {
  const spec = {
    crypto: {
      cipher: "aes-128-ctr",
      cipherparams: { iv: "6087dab2f9fdbbfaddc31a909735c1e6" },
      ciphertext: "5318b4d5bcd28de64ee5559e671353e16f075ecae9f99c7a79a38af5f869aa46",
      kdf: "pbkdf2",
      kdfparams: { c: 262144, dklen: 32, prf: "hmac-sha256", salt: "ae3cd4e7013836a3df6bd7241b12db061dbe2c6785853cce422d148a624ce0bd" },
      mac: "517ead924a9d0dc3124507e3393d175ce3ff7c1e96529c6c555ce9e51205e9b2",
    },
    id: "3198bc9c-6672-5ab3-d995-4942343ae5b6",
    version: 3,
  };
  assert.equal(decryptKeystore(spec as never, "testpassword"), "0x7a28b5ba57c53603b0b07b56bba752f7784bf506fa95edc395f5cf6c7514fe9d");
});
await test("loadAccount reads the keystore file with a password FILE and checks the stated address", () => {
  const file = join(dir, "ks.json"), pass = join(dir, "pass");
  writeFileSync(file, JSON.stringify(encryptKeystore(KEY, "correct horse battery", 1024)));
  writeFileSync(pass, "correct horse battery\n");
  const a = loadAccount({ source: "keystore", keystoreFile: file, keystorePasswordFile: pass });
  assert.equal(a.address, ADDR);
  assert.throws(() => loadAccount({ source: "keystore", keystoreFile: file }), /RELAYER_KEYSTORE_PASSWORD/);
  const forged = encryptKeystore(KEY, "correct horse battery", 1024);
  forged.address = "00".repeat(20);
  writeFileSync(file, JSON.stringify(forged));
  assert.throws(() => loadAccount({ source: "keystore", keystoreFile: file, keystorePasswordFile: pass }), /does not match/);
});
await test("each source fails with a message naming what is missing", () => {
  assert.throws(() => loadAccount({ source: "env" }), /RELAYER_PRIVATE_KEY is required/);
  assert.throws(() => loadAccount({ source: "remote" }), /RELAYER_SIGNER_URL/);
  assert.throws(() => loadAccount({ source: "remote", signerUrl: "http://x" }), /RELAYER_SIGNER_ADDRESS/);
  assert.throws(() => loadAccount({ source: "nope" as never }), /RELAYER_KEY_SOURCE/);
});

console.log("remote signer");
let calls = 0;
let mode: "good" | "wrong-key" | "garbage" | "down" | "no-auth" = "good";
const seen: { auth?: string; digest?: string }[] = [];
const server: Server = createServer(async (req, res) => {
  calls++;
  let body = "";
  for await (const c of req) body += c;
  const { digest } = JSON.parse(body);
  seen.push({ auth: req.headers.authorization, digest });
  if (mode === "down") return void res.writeHead(503).end();
  if (mode === "no-auth" && req.headers.authorization !== "Bearer s3cret") return void res.writeHead(401).end();
  if (mode === "garbage") return void res.end(JSON.stringify({ signature: "0x1234" }));
  const key = mode === "wrong-key" ? generatePrivateKey() : KEY;
  const signature = await sign({ hash: digest, privateKey: key, to: "hex" });
  res.setHeader("content-type", "application/json").end(JSON.stringify({ signature }));
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/sign`;
const remote = { source: "remote" as const, signerUrl: url, signerAddress: ADDR, signerToken: "s3cret" };
const tx = { type: "eip1559" as const, chainId: 137, nonce: 7, to: getAddress("0x000000000000000000000000000000000000dEaD"), value: 1n, gas: 21000n, maxFeePerGas: 50_000_000_000n, maxPriorityFeePerGas: 30_000_000_000n };

await test("a transaction signed remotely is valid and recovers to the relayer address", async () => {
  mode = "good";
  const acct = loadAccount(remote);
  assert.equal(acct.address, ADDR);
  const raw = await acct.signTransaction(tx as never);
  assert.equal(await recoverTransactionAddress({ serializedTransaction: raw as never }), ADDR);
  assert.equal(parseTransaction(raw).nonce, 7);
  // The signer was asked for the digest of the UNSIGNED transaction and nothing else, with the token.
  assert.equal(seen.at(-1)!.digest, keccak256(serializeTransaction(tx as never)));
  assert.equal(seen.at(-1)!.auth, "Bearer s3cret");
});
await test("the same signature as a local key would produce", async () => {
  const local = await privateKeyToAccount(KEY).signTransaction(tx as never);
  assert.equal(await loadAccount(remote).signTransaction(tx as never), local);
});
await test("a signer that signs with a different key is refused (cannot spend from another account)", async () => {
  mode = "wrong-key";
  await assert.rejects(() => loadAccount(remote).signTransaction(tx as never), /not the configured/);
});
await test("a signer that returns garbage or is down is an error, never a silent unsigned send", async () => {
  mode = "garbage";
  await assert.rejects(() => loadAccount(remote).signTransaction(tx as never), /65-byte/);
  mode = "down";
  await assert.rejects(() => loadAccount(remote).signTransaction(tx as never), /503/);
});
await test("a wrong token is rejected by the signer and surfaces as an error", async () => {
  mode = "no-auth";
  await assert.rejects(() => loadAccount({ ...remote, signerToken: "nope" }).signTransaction(tx as never), /401/);
});
await test("verifySigner proves the signer at startup and fails when it is wrong", async () => {
  mode = "good";
  assert.equal(await verifySigner(remote, loadAccount(remote)), ADDR);
  mode = "wrong-key";
  await assert.rejects(() => verifySigner(remote, loadAccount(remote)), /not the configured/);
});
await test("a remote account refuses to sign messages (the relayer only signs transactions)", async () => {
  const before = calls;
  await assert.rejects(() => loadAccount(remote).signMessage({ message: "hi" }), /only signs transactions/);
  assert.equal(calls, before);
});
await test("the description names the source and host, never a secret", () => {
  const d = describeSource(remote);
  assert.match(d, /remote signer 127\.0\.0\.1/);
  assert.ok(!d.includes("s3cret"));
});
server.close();

console.log("safe batches");
const REG = getAddress("0x57e6742610229c7Ce09df3028471397DaaE6B9f4");
const USDC = getAddress("0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359");
await test("a withdraw batch encodes withdraw(sponsorId, token) to the registry, value 0", () => {
  const [t] = withdrawTxs(REG, 1n, [USDC]);
  assert.equal(t.to, REG);
  assert.equal(t.value, "0");
  const d = decodeFunctionData({ abi: feeMarketRegistryAbi, data: t.data });
  assert.equal(d.functionName, "withdraw");
  assert.deepEqual(d.args, [1n, USDC]);
});
await test("a rotate batch encodes setPayoutAddress / setRelayer", () => {
  const p = decodeFunctionData({ abi: feeMarketRegistryAbi, data: rotateTx(REG, 1n, "payout", USDC).data });
  assert.equal(p.functionName, "setPayoutAddress");
  assert.equal(decodeFunctionData({ abi: feeMarketRegistryAbi, data: rotateTx(REG, 1n, "relayer", USDC).data }).functionName, "setRelayer");
});
await test("an accept batch encodes acceptRole(sponsorId, roles); consent problems name the role and the way out", () => {
  const t = acceptRoleTx(REG, 7n, ROLE_PAYOUT);
  assert.equal(t.to, REG);
  const d = decodeFunctionData({ abi: feeMarketRegistryAbi, data: t.data });
  assert.equal(d.functionName, "acceptRole");
  assert.deepEqual(d.args, [7n, 2]);
  assert.equal(consentProblem("relayer", ROLE_RELAYER, USDC, 7n, REG), null);
  assert.equal(consentProblem("payout", ROLE_RELAYER | ROLE_PAYOUT, USDC, 7n, REG), null);
  assert.match(consentProblem("payout", ROLE_RELAYER, USDC, 7n, REG)!, /not accepted the payout role for sponsor #7/);
  assert.match(consentProblem("relayer", 0, USDC, 7n, REG)!, /acceptRole\(uint256,uint8\)" 7 1/);
});
await test("an acceptance names the sponsor, and a sponsor that does not exist is refused before anything is sent", () => {
  const real = [USDC, REG, "ipfs://meta", 2, true] as const;
  assert.equal(sponsorProblem(7n, real), null);
  assert.match(sponsorProblem(0n, real)!, /sponsor #0 does not exist/);
  // `sponsors(n)` of a number the registry has not issued is all zeros
  assert.match(sponsorProblem(8n, ["0x0000000000000000000000000000000000000000", "0x0000000000000000000000000000000000000000", "", 0, false])!, /sponsor #8 does not exist/);
  assert.match(sponsorProblem(8n, undefined)!, /does not exist/);
  const line = describeSponsor(7n, real);
  assert.match(line, /sponsor #7 \(verified\)/);
  assert.ok(line.includes(USDC) && line.includes(REG) && line.includes("ipfs://meta"));
  assert.match(describeSponsor(7n, [USDC, REG, "", 9, false]), /status 9/);
});
await test("the batch file has the shape the Safe Transaction Builder imports", () => {
  const b = batch(137, "n", "d", withdrawTxs(REG, 1n, [USDC]));
  assert.equal(b.version, "1.0");
  assert.equal(b.chainId, "137");
  assert.ok(b.meta.name && Array.isArray(b.transactions) && b.transactions.length === 1);
});
await test("a delegated (EIP-7702) key is not mistaken for a multisig", () => {
  assert.equal(classifyAccount("0x"), "eoa");
  assert.equal(classifyAccount(undefined), "eoa");
  assert.equal(classifyAccount(("0xef0100" + "ab".repeat(20)) as Hex), "delegated-eoa");
  assert.equal(classifyAccount("0x608060405234801561001057600080fd5b50" as Hex), "contract");
});

console.log("doctor checks");
const good = {
  dashboardToken: "x".repeat(32), corsOrigins: ["https://app.realsponsor.io"], maxGasWei: 1n, publicRelayerUrl: "https://relay.realsponsor.io",
  requireRedeemerRestriction: true, simulateBeforeSend: true, trustProxy: 0, maxDelegationTtlSeconds: 600, clientIpHeader: "cf-connecting-ip",
};
await test("a raw env key on a published node is a warning; a keystore or remote signer is fine", () => {
  assert.ok(lintPolicy({ ...good, signerSource: "env" }).some((f) => f.level === "warn" && /raw RELAYER_PRIVATE_KEY/.test(f.msg)));
  assert.ok(!lintPolicy({ ...good, signerSource: "keystore" }).some((f) => f.level !== "ok" && /key/i.test(f.msg)));
  assert.ok(!lintPolicy({ ...good, publicRelayerUrl: "", signerSource: "env" }).some((f) => f.level === "warn" && /raw RELAYER_PRIVATE_KEY/.test(f.msg)));
});
await test("metrics token and watcher settings are checked", () => {
  assert.ok(lintPolicy({ ...good, metricsToken: "" }).some((f) => f.level === "warn" && /METRICS_TOKEN/.test(f.msg)));
  assert.ok(lintPolicy({ ...good, metricsToken: "short" }).some((f) => f.level === "fail" && /METRICS_TOKEN/.test(f.msg)));
  assert.ok(lintPolicy({ ...good, metricsToken: "m".repeat(32) }).some((f) => f.level === "ok" && /metrics/.test(f.msg)));
  assert.ok(lintPolicy({ ...good, watchIntervalMs: 0 }).some((f) => f.level === "warn" && /WATCH_INTERVAL_MS/.test(f.msg)));
});
await test("a trusted client-IP header while listening on every interface is flagged", () => {
  assert.ok(lintPolicy({ ...good, host: "0.0.0.0" }).some((f) => f.level === "warn" && /forge that header/.test(f.msg)));
  assert.ok(!lintPolicy({ ...good, host: "127.0.0.1" }).some((f) => /forge that header/.test(f.msg)));
});
await test("the payout wallet: a contract is ok, a single key is a warning once published", () => {
  assert.equal(checkPayoutWallet("contract", true).level, "ok");
  assert.equal(checkPayoutWallet("eoa", true).level, "warn");
  assert.equal(checkPayoutWallet("delegated-eoa", true).level, "warn");
  assert.equal(checkPayoutWallet("eoa", false).level, "ok");
});

console.log(`\n${passed}/${total} passed`);
if (passed !== total) process.exit(1);
