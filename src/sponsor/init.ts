/**
 * Writes .env for a new sponsor node. Never imports config (it must run before a .env exists).
 *
 *   npm run sponsor:init                 # interactive
 *   npm run sponsor:init -- --yes        # accept defaults, generate a new relayer key and dashboard token
 *   flags: --force  --rpc <url>  --public-url <https://...>  --payout <0x...>  --sponsor-id <n>
 *
 * The generated relayer key is printed once as an address to fund; the secret only goes into .env (mode 0600).
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { getAddress, isAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { setEnv } from "./envFile.js";

const argv = process.argv.slice(2);
const flag = (n: string) => argv.includes(`--${n}`);
const opt = (n: string) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

const ENV_PATH = new URL("../../.env", import.meta.url);
const TEMPLATE = new URL("../../.env.example", import.meta.url);

async function main() {
  if (existsSync(ENV_PATH) && !flag("force")) {
    console.error(".env already exists; refusing to overwrite it (use --force to replace).");
    process.exit(1);
  }
  const yes = flag("yes");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (q: string, def = "") => {
    if (yes) return def;
    const a = (await rl.question(def ? `${q} [${def}]: ` : `${q}: `)).trim();
    return a || def;
  };

  let text = readFileSync(TEMPLATE, "utf8");

  const rpc = opt("rpc") ?? (await ask("Polygon RPC URL (use a paid provider for production)", "https://polygon-bor-rpc.publicnode.com"));
  text = setEnv(text, "RPC_URL", rpc);

  let key = process.env.RELAYER_PRIVATE_KEY;
  if (!key) {
    const given = yes ? "" : await ask("Relayer private key (leave empty to generate a new one)");
    key = given || generatePrivateKey();
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("relayer key must be 0x + 64 hex characters");
  const relayer = privateKeyToAccount(key as `0x${string}`).address;
  text = setEnv(text, "RELAYER_PRIVATE_KEY", key);

  const payout = opt("payout") ?? (await ask("Payout address (cold wallet that receives earnings)", relayer));
  if (!isAddress(payout)) throw new Error("payout is not a valid address");
  text = setEnv(text, "SPONSOR_PAYOUT_ADDRESS", getAddress(payout));

  const url = opt("public-url") ?? (await ask("Public URL users will reach this node at (https://...)", ""));
  if (url) text = setEnv(text, "PUBLIC_RELAYER_URL", url);

  text = setEnv(text, "SPONSOR_ID", opt("sponsor-id") ?? "1");
  text = setEnv(text, "DASHBOARD_TOKEN", randomBytes(24).toString("hex"));

  // Metadata defaults to IPFS (publicly fetchable, no storage keys needed by anyone reading it); a
  // thirdweb key is what authenticates the *upload*, free at https://thirdweb.com/dashboard.
  const thirdwebKey = opt("thirdweb-secret-key") ?? (await ask("Thirdweb secret key, for publishing metadata to IPFS (leave empty to set up later)"));
  if (thirdwebKey) text = setEnv(text, "THIRDWEB_SECRET_KEY", thirdwebKey);
  rl.close();

  writeFileSync(ENV_PATH, text, { mode: 0o600 });
  console.log(`\n✓ wrote .env (mode 600)`);
  console.log(`  relayer address (fund this with POL for gas): ${relayer}`);
  console.log(`  payout address: ${getAddress(payout)}${getAddress(payout) === relayer ? "  (same as relayer: fine for tests, use a cold wallet in production)" : ""}`);
  console.log(`  dashboard token: saved in .env as DASHBOARD_TOKEN`);
  if (!thirdwebKey) {
    console.log(`  metadata storage: no THIRDWEB_SECRET_KEY/THIRDWEB_CLIENT_ID yet — get one free at https://thirdweb.com/dashboard before \`sponsor:onboard\`, or set METADATA_STORAGE=filone to use your own S3 bucket instead.`);
  }
  console.log(`\nNext:`);
  console.log(`  1. Fund the relayer address with POL`);
  console.log(`  2. Bring up HTTPS (DNS + npm run sponsor:serve  or  setup-proxy) → set PUBLIC_RELAYER_URL`);
  console.log(`  3. npm run sponsor:check-endpoint`);
  console.log(`  4. npm run sponsor:plans:configure`);
  console.log(`  5. npm run sponsor:onboard`);
  console.log(`  See COMMANDS.md / README.md for the full flow.`);
}

// Only run as a script, so tests can import setEnv.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((e) => {
    console.error("✗", (e as Error).message);
    process.exit(1);
  });
}
