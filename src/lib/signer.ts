import { createDecipheriv, createCipheriv, pbkdf2Sync, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  type Hex,
  type LocalAccount,
  bytesToHex,
  hexToBytes,
  keccak256,
  parseSignature,
  recoverAddress,
  serializeTransaction,
  concatBytes,
  getAddress,
} from "viem";
import { privateKeyToAccount, toAccount } from "viem/accounts";

/**
 * Where the relayer's signing key comes from. Three sources, chosen by RELAYER_KEY_SOURCE:
 *
 *   env       RELAYER_PRIVATE_KEY in the environment. Simplest; the raw key sits in a file or a process environment.
 *   keystore  RELAYER_KEYSTORE_FILE: a Web3 Secret Storage (v3) JSON file, encrypted with a password supplied from
 *             RELAYER_KEYSTORE_PASSWORD_FILE (a file the secret manager mounts) or RELAYER_KEYSTORE_PASSWORD.
 *             The key on disk is useless without the password; it is decrypted once into memory.
 *   remote    RELAYER_SIGNER_URL: the node never holds the key. For every transaction it sends the 32-byte digest to a
 *             signing service (an HSM, a cloud KMS behind a small adapter, a separate hardened host) and gets a
 *             65-byte signature back. It checks that the signature recovers to RELAYER_SIGNER_ADDRESS, so a faulty or
 *             tampered signer cannot make the node send transactions from some other account.
 *
 * The remote protocol is deliberately tiny:
 *   POST <url>   Authorization: Bearer <RELAYER_SIGNER_TOKEN>   {"address":"0x…","digest":"0x…32 bytes"}
 *   200          {"signature":"0x…65 bytes r||s||v"}   (v may be 0/1 or 27/28)
 *
 * What this does and does not give: a remote signer keeps the key out of this host, so a compromise of the node does
 * not leak it. It signs whatever digest it is given unless it enforces its own policy (an allowlist of `to` addresses,
 * a spend limit), so give it one if it can. It is a gas wallet either way: keep only a few days of gas in it.
 */
export type KeySource = "env" | "keystore" | "remote";

export interface SignerConfig {
  source: KeySource;
  privateKey?: string;
  keystoreFile?: string;
  keystorePassword?: string;
  keystorePasswordFile?: string;
  signerUrl?: string;
  signerToken?: string;
  signerAddress?: string;
  signerTimeoutMs?: number;
}

// ---------------------------------------------------------------------------------------------------------------------
// Web3 Secret Storage v3
// ---------------------------------------------------------------------------------------------------------------------
interface KeystoreV3 {
  version: 3;
  address?: string;
  crypto: {
    cipher: string;
    ciphertext: string;
    cipherparams: { iv: string };
    kdf: "scrypt" | "pbkdf2";
    kdfparams: { dklen: number; salt: string; n?: number; r?: number; p?: number; c?: number; prf?: string };
    mac: string;
  };
}

const strip = (h: string) => h.replace(/^0x/i, "");
const hexBuf = (h: string) => Buffer.from(strip(h), "hex");

function deriveKey(ks: KeystoreV3, password: string): Buffer {
  const { kdf, kdfparams: p } = ks.crypto;
  const salt = hexBuf(p.salt);
  if (kdf === "scrypt") {
    const n = p.n!, r = p.r!, pp = p.p!;
    return scryptSync(password.normalize("NFKC"), salt, p.dklen, { N: n, r, p: pp, maxmem: 128 * n * r * 2 + 64 * 1024 * 1024 });
  }
  if (kdf === "pbkdf2") {
    if (p.prf !== "hmac-sha256") throw new Error(`keystore: unsupported pbkdf2 prf ${p.prf}`);
    return pbkdf2Sync(password.normalize("NFKC"), salt, p.c!, p.dklen, "sha256");
  }
  throw new Error(`keystore: unsupported kdf ${kdf}`);
}

/** Decrypts a v3 keystore to the raw private key. Throws "wrong password" when the MAC does not match. */
export function decryptKeystore(json: string | KeystoreV3, password: string): Hex {
  const ks: KeystoreV3 = typeof json === "string" ? JSON.parse(json) : json;
  if (ks.version !== 3 || !ks.crypto) throw new Error("keystore: not a version 3 keystore");
  if (ks.crypto.cipher !== "aes-128-ctr") throw new Error(`keystore: unsupported cipher ${ks.crypto.cipher}`);
  const dk = deriveKey(ks, password);
  const ciphertext = hexBuf(ks.crypto.ciphertext);
  const mac = hexToBytes(keccak256(concatBytes([dk.subarray(16, 32), ciphertext])));
  const expected = hexBuf(ks.crypto.mac);
  if (mac.length !== expected.length || !timingSafeEqual(Buffer.from(mac), expected)) throw new Error("keystore: wrong password (or a damaged file)");
  const decipher = createDecipheriv("aes-128-ctr", dk.subarray(0, 16), hexBuf(ks.crypto.cipherparams.iv));
  const key = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return bytesToHex(key);
}

/** Encrypts a private key into a v3 keystore (scrypt; `n` is lowered only by tests). */
export function encryptKeystore(privateKey: Hex, password: string, n = 262144): KeystoreV3 {
  const salt = randomBytes(32);
  const iv = randomBytes(16);
  const r = 8, p = 1, dklen = 32;
  const ks: KeystoreV3 = {
    version: 3,
    address: strip(privateKeyToAccount(privateKey).address).toLowerCase(),
    crypto: { cipher: "aes-128-ctr", ciphertext: "", cipherparams: { iv: iv.toString("hex") }, kdf: "scrypt", kdfparams: { dklen, salt: salt.toString("hex"), n, r, p }, mac: "" },
  };
  const dk = deriveKey(ks, password);
  const cipher = createCipheriv("aes-128-ctr", dk.subarray(0, 16), iv);
  const ciphertext = Buffer.concat([cipher.update(hexBuf(privateKey)), cipher.final()]);
  ks.crypto.ciphertext = ciphertext.toString("hex");
  ks.crypto.mac = strip(keccak256(concatBytes([dk.subarray(16, 32), ciphertext])));
  return ks;
}

// ---------------------------------------------------------------------------------------------------------------------
// Remote digest signer
// ---------------------------------------------------------------------------------------------------------------------
/** Asks the signing service for a signature over `digest` and checks it recovers to `address`. */
export async function remoteSignDigest(cfg: Required<Pick<SignerConfig, "signerUrl" | "signerAddress">> & SignerConfig, digest: Hex): Promise<Hex> {
  const res = await fetch(cfg.signerUrl, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cfg.signerToken ? { authorization: `Bearer ${cfg.signerToken}` } : {}) },
    body: JSON.stringify({ address: cfg.signerAddress, digest }),
    signal: AbortSignal.timeout(cfg.signerTimeoutMs ?? 10_000),
  });
  if (!res.ok) throw new Error(`remote signer answered ${res.status}`);
  const body = (await res.json().catch(() => null)) as { signature?: string } | null;
  const sig = body?.signature;
  if (typeof sig !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(sig)) throw new Error("remote signer returned no 65-byte signature");
  const parsed = parseSignature(sig as Hex);
  const recovered = await recoverAddress({ hash: digest, signature: sig as Hex });
  if (getAddress(recovered) !== getAddress(cfg.signerAddress)) throw new Error(`remote signer signed with ${recovered}, not the configured ${cfg.signerAddress}`);
  void parsed;
  return sig as Hex;
}

function remoteAccount(cfg: SignerConfig): LocalAccount {
  if (!cfg.signerUrl) throw new Error("RELAYER_SIGNER_URL is required when RELAYER_KEY_SOURCE=remote");
  if (!cfg.signerAddress) throw new Error("RELAYER_SIGNER_ADDRESS is required when RELAYER_KEY_SOURCE=remote");
  const c = { ...cfg, signerUrl: cfg.signerUrl, signerAddress: cfg.signerAddress };
  const unsupported = (what: string) => async () => {
    throw new Error(`the remote signer account does not sign ${what}: the relayer only signs transactions`);
  };
  return toAccount({
    address: getAddress(cfg.signerAddress),
    signMessage: unsupported("messages"),
    signTypedData: unsupported("typed data"),
    async signTransaction(transaction, options) {
      const serializer = (options?.serializer ?? serializeTransaction) as typeof serializeTransaction;
      const unsigned = (transaction as { type?: string }).type === "eip4844" ? ({ ...transaction, sidecars: false } as typeof transaction) : transaction;
      const signature = await remoteSignDigest(c, keccak256(serializer(unsigned as never)));
      return serializer(transaction as never, parseSignature(signature));
    },
  }) as LocalAccount;
}

// ---------------------------------------------------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------------------------------------------------
export function describeSource(cfg: SignerConfig): string {
  return cfg.source === "env" ? "RELAYER_PRIVATE_KEY (raw key in the environment)" : cfg.source === "keystore" ? `encrypted keystore ${cfg.keystoreFile}` : `remote signer ${cfg.signerUrl ? new URL(cfg.signerUrl).host : "?"}`;
}

/** Builds the relayer's account from the configured source. Synchronous: it runs once at startup. */
export function loadAccount(cfg: SignerConfig): LocalAccount {
  switch (cfg.source) {
    case "env": {
      if (!cfg.privateKey) throw new Error("RELAYER_PRIVATE_KEY is required (or set RELAYER_KEY_SOURCE=keystore|remote)");
      return privateKeyToAccount(cfg.privateKey as Hex);
    }
    case "keystore": {
      if (!cfg.keystoreFile) throw new Error("RELAYER_KEYSTORE_FILE is required when RELAYER_KEY_SOURCE=keystore");
      const password = cfg.keystorePasswordFile ? readFileSync(cfg.keystorePasswordFile, "utf8").replace(/\r?\n$/, "") : cfg.keystorePassword;
      if (!password) throw new Error("set RELAYER_KEYSTORE_PASSWORD_FILE (preferred) or RELAYER_KEYSTORE_PASSWORD to unlock the keystore");
      const account = privateKeyToAccount(decryptKeystore(readFileSync(cfg.keystoreFile, "utf8"), password));
      const stated = (JSON.parse(readFileSync(cfg.keystoreFile, "utf8")) as KeystoreV3).address;
      if (stated && getAddress(`0x${strip(stated)}`) !== account.address) throw new Error("keystore: the address in the file does not match its key");
      return account;
    }
    case "remote":
      return remoteAccount(cfg);
    default:
      throw new Error(`RELAYER_KEY_SOURCE must be env, keystore or remote (got ${cfg.source})`);
  }
}

/**
 * Proves a remote signer works before the node takes traffic: signs a throwaway digest and checks the recovered address.
 * For the other sources there is nothing to prove. Returns the address.
 */
export async function verifySigner(cfg: SignerConfig, account: LocalAccount): Promise<string> {
  if (cfg.source === "remote") await remoteSignDigest({ ...cfg, signerUrl: cfg.signerUrl!, signerAddress: cfg.signerAddress! }, keccak256(bytesToHex(randomBytes(32))));
  return account.address;
}
