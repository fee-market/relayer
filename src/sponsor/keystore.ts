/**
 * Moves the relayer key out of a plain environment variable into an encrypted keystore, and checks one.
 *
 *   RELAYER_PRIVATE_KEY=0x… npm run key:encrypt -- --out ./secrets/relayer.keystore.json --password-file ./secrets/relayer.pass
 *   npm run key:check -- --file ./secrets/relayer.keystore.json --password-file ./secrets/relayer.pass
 *
 * `encrypt` reads the key from RELAYER_PRIVATE_KEY (never from an argument, which would end up in shell history), writes
 * the keystore with mode 0600 and prints only the address. The password file is yours: create it from your secret manager
 * (it must be a file the node can read at start, not the keystore's neighbour in git). `check` decrypts and prints only the address.
 * Then set, and delete RELAYER_PRIVATE_KEY:
 *   RELAYER_KEY_SOURCE=keystore  RELAYER_KEYSTORE_FILE=…  RELAYER_KEYSTORE_PASSWORD_FILE=…
 */
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { decryptKeystore, encryptKeystore } from "../lib/signer.js";

const [cmd, ...rest] = process.argv.slice(2);
const flag = (n: string) => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : undefined; };
const pw = () => {
  const f = flag("--password-file");
  if (!f) throw new Error("--password-file <file> is required");
  return readFileSync(f, "utf8").replace(/\r?\n$/, "");
};

try {
  if (cmd === "encrypt") {
    const key = process.env.RELAYER_PRIVATE_KEY as Hex | undefined;
    const out = flag("--out");
    if (!key || !out) throw new Error("usage: RELAYER_PRIVATE_KEY=0x… key:encrypt -- --out <file> --password-file <file>");
    if (existsSync(out)) throw new Error(`${out} exists; refusing to overwrite it`);
    const password = pw();
    if (password.length < 12) throw new Error("the password must be at least 12 characters");
    writeFileSync(out, JSON.stringify(encryptKeystore(key, password)), { mode: 0o600 });
    chmodSync(out, 0o600);
    // Prove it opens before telling the operator it is safe to delete the raw key.
    const again = privateKeyToAccount(decryptKeystore(readFileSync(out, "utf8"), password)).address;
    if (again !== privateKeyToAccount(key).address) throw new Error("round trip failed; do not use this file");
    console.log(`✓ wrote ${out} for ${again}. Now set RELAYER_KEY_SOURCE=keystore and remove RELAYER_PRIVATE_KEY from the environment and from any .env file.`);
  } else if (cmd === "check") {
    const file = flag("--file");
    if (!file) throw new Error("usage: key:check -- --file <keystore> --password-file <file>");
    console.log(`✓ keystore opens; address ${privateKeyToAccount(decryptKeystore(readFileSync(file, "utf8"), pw())).address}`);
  } else {
    throw new Error("usage: key:encrypt | key:check");
  }
} catch (e) {
  console.error("✗", (e as Error).message);
  process.exit(1);
}
