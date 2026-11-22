import "dotenv/config";
import { type Address, type Hex, getAddress } from "viem";

function env(key: string, fallback?: string): string {
  const v = process.env[key] ?? fallback;
  if (v === undefined) throw new Error(`Missing required env var ${key}`);
  return v;
}

function envAddr(key: string, fallback?: string): Address {
  return getAddress(env(key, fallback));
}

function envBool(key: string, fallback: string): boolean {
  return env(key, fallback).toLowerCase() === "true";
}

/** A decimal amount in whole units ("0.1", "5", "0.003") as its smallest unit. Refuses anything else, naming the variable. */
export function parseDecimalUnits(key: string, value: string, decimals: number): bigint {
  const v = value.trim().replace(/_/g, "");
  if (!/^\d+(\.\d+)?$/.test(v)) throw new Error(`${key}=${value}: expected a plain number like 0.1, 5 or 0.003`);
  const [whole, frac = ""] = v.split(".");
  if (frac.length > decimals) throw new Error(`${key}=${value}: at most ${decimals} decimal places`);
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
}

/** A native-token (POL) amount: `<polKey>` as a decimal if set, else the older `<weiKey>` in wei, else `fallbackPol`. */
function envNative(polKey: string, weiKey: string, fallbackPol: string): bigint {
  const pol = process.env[polKey]?.trim();
  if (pol) return parseDecimalUnits(polKey, pol, 18);
  const wei = process.env[weiKey]?.trim();
  if (wei) {
    if (!/^\d+$/.test(wei)) throw new Error(`${weiKey}=${wei}: must be whole wei; for a decimal amount like 0.1 use ${polKey}=0.1`);
    return BigInt(wei);
  }
  return parseDecimalUnits(polKey, fallbackPol, 18);
}

const maxFeePerGasGwei = env("MAX_FEE_PER_GAS_GWEI", "500");

const rpcUrl = env("RPC_URL");
/** RPC_URL first, then any RPC_URLS fallbacks (comma-separated), without duplicates. */
const rpcUrls = [...new Set([rpcUrl, ...env("RPC_URLS", "").split(",").map((s) => s.trim()).filter(Boolean)])];

export const config = {
  // --- chain ---
  rpcUrl,
  // Every provider, in order of preference. Reads fail over down the list; a transaction is broadcast to ALL of
  // them, so a single flaky or censoring provider cannot stop a send (or leave it unseen by the network).
  rpcUrls,
  chainId: Number(env("CHAIN_ID", "137")),
  confirmations: Number(env("CONFIRMATIONS", "1")),

  // --- relayer identity (pays gas, submits type-4 txns) ---
  // Where the signing key comes from: env (RELAYER_PRIVATE_KEY), keystore (encrypted file) or remote (signing service).
  // See src/lib/signer.ts. Only the variables of the chosen source are required.
  signer: {
    source: env("RELAYER_KEY_SOURCE", "env") as "env" | "keystore" | "remote",
    privateKey: process.env.RELAYER_PRIVATE_KEY ?? "",
    keystoreFile: process.env.RELAYER_KEYSTORE_FILE ?? "",
    keystorePassword: process.env.RELAYER_KEYSTORE_PASSWORD ?? "",
    keystorePasswordFile: process.env.RELAYER_KEYSTORE_PASSWORD_FILE ?? "",
    signerUrl: process.env.RELAYER_SIGNER_URL ?? "",
    signerToken: process.env.RELAYER_SIGNER_TOKEN ?? "",
    signerAddress: process.env.RELAYER_SIGNER_ADDRESS ?? "",
  },

  // --- framework + marketplace addresses ---
  delegationManager: envAddr("DELEGATION_MANAGER"),
  delegatorImplementation: envAddr("DELEGATOR_IMPLEMENTATION"),
  feeMarketRegistry: envAddr("FEE_MARKET_REGISTRY"),
  redeemerRestrictionEnforcer: envAddr("REDEEMER_RESTRICTION_ENFORCER"),
  // MetaMask Delegation Framework caveat enforcers every user delegation must carry (Polygon defaults;
  // deployments/137.json). The delegation pins the exact batch, a single use and a deadline, so the
  // redeemer (this relayer) cannot substitute a different batch or replay it.
  limitedCallsEnforcer: envAddr("LIMITED_CALLS_ENFORCER", "0x04658B29F6b82ed55274221a06Fc97D318E25416"),
  exactExecutionBatchEnforcer: envAddr("EXACT_EXECUTION_BATCH_ENFORCER", "0x1e141e455d08721Dd5BCDA1BaA6Ea5633Afd5017"),
  timestampEnforcer: envAddr("TIMESTAMP_ENFORCER", "0x1046bb45C8d673d4ea75321280DB34899413c069"),
  // Locks a delegation to a SPONSOR (any key in its relayer set) instead of one relayer key. Accepted in place of
  // RedeemerRestrictionEnforcer; terms = registry + sponsorId. Default: the closed-test deployment on Polygon.
  sponsorRelayerEnforcer: envAddr("SPONSOR_RELAYER_ENFORCER", "0x051F314E5312341B3F0e0da2024a56A0cD0cacBB"),

  // --- this sponsor ---
  sponsorId: BigInt(env("SPONSOR_ID", "1")),

  // --- sponsor dashboard ---
  // Bearer token guarding /admin/* and the dashboard. REQUIRED to expose the dashboard.
  dashboardToken: process.env.DASHBOARD_TOKEN ?? "",
  // Payment token shown in the earnings panel (defaults to USDC on Polygon).
  dashboardEarningsToken: envAddr("DASHBOARD_EARNINGS_TOKEN", "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359"),

  // --- profit guard ---
  // Refuse a sponsored request whose gas costs more than `maxMultiple` times what the plan pays for that request
  // (the plan's price per transaction, converted to the native token by a price oracle). 0 = off. A gas spike or a
  // cheap plan can otherwise make every sponsored send a loss. Only /relay is guarded: it is the call that earns the
  // per-request price; /subscribe and /topup are the cost of getting a customer and are bounded by MAX_GAS_POL.
  profit: {
    maxMultiple: Number(env("PROFIT_GUARD_MAX_MULTIPLE", "0")),
    // chainlink: read NATIVE_USD_FEED; fixed: NATIVE_PRICE_USD (a number, for a chain without a feed); off: no price known
    oracle: env("PRICE_ORACLE", "chainlink") as "chainlink" | "fixed" | "off",
    // Chainlink MATIC/USD on Polygon (8 decimals). Override for another chain.
    nativeUsdFeed: env("NATIVE_USD_FEED", "0xAB594600376Ec9fD91F8e885dADF0CE036862dE0"),
    fixedNativeUsd: env("NATIVE_PRICE_USD", ""),
    maxAgeSec: Number(env("ORACLE_MAX_AGE_SEC", "7200")),
    // Payment tokens treated as worth 1 USD (the guard compares in dollars). Default: the Polygon stablecoins.
    stableTokens: env("STABLE_TOKENS", "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359,0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174,0xc2132D05D31c914a87C6611C10748AEb04B58e8F,0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063").split(",").map((t) => t.trim().toLowerCase()).filter(Boolean),
    // What to do when the guard is on but the price or the token cannot be priced: allow (default; the plain MAX_GAS_POL cap
    // still applies) or refuse (strict: no price, no sponsorship).
    unpriced: env("PROFIT_GUARD_UNPRICED", "allow") as "allow" | "refuse",
  },

  // --- monitoring ---
  // Bearer token for GET /metrics (Prometheus text format). Empty = /metrics is disabled (fail closed).
  metricsToken: process.env.METRICS_TOKEN ?? "",
  // Etherscan v2 key for the wallet's history and usage reads (GET /explorer). Off (503) without it.
  etherscanApiKey: process.env.ETHERSCAN_API_KEY ?? "",
  log: {
    // debug | info | warn | error
    level: env("LOG_LEVEL", "info"),
    // json: one JSON object per line (for a log pipeline); text: readable lines
    format: env("LOG_FORMAT", "json"),
  },
  watch: {
    // How often the node checks the registry, the sponsor and the RPC providers and raises alerts. 0 = off.
    intervalMs: Number(env("WATCH_INTERVAL_MS", "60000")),
    // Tokens whose registry solvency is checked (comma-separated). Default: the dashboard's earnings token.
    tokens: env("WATCH_TOKENS", "").split(",").map((t) => t.trim()).filter(Boolean),
    // The upgrade timelock to watch for scheduled upgrades (empty = not watched).
    upgradeTimelock: process.env.UPGRADE_TIMELOCK ?? "",
    // Alert when, over the last window, at least `errorMinRequests` sponsored requests were seen and this share failed.
    errorWindowMs: Number(env("WATCH_ERROR_WINDOW_MS", "600000")),
    errorMinRequests: Number(env("WATCH_ERROR_MIN_REQUESTS", "6")),
    errorRateThreshold: Number(env("WATCH_ERROR_RATE", "0.5")),
    // The canary (npm run canary) writes its result to STATE_DIR; alert if it has not succeeded within this time (0 = ignore).
    canaryMaxAgeMs: Number(env("CANARY_MAX_AGE_MS", "0")),
  },

  // --- state ---
  // Where the node keeps what must survive a restart: transactions still in flight (so a stuck one is still
  // replaced) and the dashboard's counters and logs. Mount a volume here in Docker.
  stateDir: env("STATE_DIR", "./data"),
  // On SIGTERM: stop taking new work and give in-flight requests this long (ms) to finish before exiting.
  drainMs: Number(env("DRAIN_MS", "20000")),

  // --- server ---
  port: Number(env("PORT", "8787")),
  // Interface to listen on. 0.0.0.0 (all) by default, which Docker needs. Behind a tunnel or reverse proxy on the same
  // machine use 127.0.0.1 so nothing but the proxy can reach the node (and nobody can forge CLIENT_IP_HEADER).
  host: env("HOST", "0.0.0.0"),
  // Header carrying the real client IP when a trusted edge sets it (Cloudflare: `cf-connecting-ip`). Only set it when
  // ALL traffic comes through that edge; otherwise a caller could forge it to dodge the per-IP limit. Empty = use
  // Express's `req.ip` (see TRUST_PROXY).
  clientIpHeader: (process.env.CLIENT_IP_HEADER ?? "").toLowerCase(),
  // Reverse-proxy hops in front of the node (0 = none, 1 = Caddy/nginx). Needed so the per-IP rate limit sees
  // the real client address instead of the proxy.
  trustProxy: Number(env("TRUST_PROXY", "0")),
  // Public URL users reach this node at (informational; `sponsor:doctor` checks it).
  publicRelayerUrl: process.env.PUBLIC_RELAYER_URL ?? "",
  corsOrigins: env("CORS_ORIGINS", "*")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),

  // --- policy: protect the sponsor from losing money / being abused ---
  policy: {
    // Refuse to redeem if estimated gas cost (gas * gasPrice) exceeds this cap, held in wei. Set as MAX_GAS_POL=0.1
    // (MAX_GAS_WEI still works). 0 = no cap (not advised: `sponsor:doctor` warns). Default 0.1 POL, ~500k gas at 200 gwei.
    maxGasWei: envNative("MAX_GAS_POL", "MAX_GAS_WEI", "0.1"),
    // Hard ceiling on gas units for one redemption. It is also set as the transaction's own gas limit, so a
    // user-crafted heavy batch can never consume more than this, whatever the simulation said.
    maxGasUnits: BigInt(env("MAX_GAS_UNITS", "600000")),
    // The same ceiling for /subscribe and /topup. Their batch shape is fixed and validated (one registry call for
    // this sponsor's plan), and a first subscribe also installs the account upgrade, so they need more than a /relay.
    maxGasUnitsSubscribe: BigInt(env("MAX_GAS_UNITS_SUBSCRIBE", "1200000")),
    // A sponsored batch is one charged operation however much it does, so bound what one batch may contain:
    // number of calls (including the final chargeUsage) and total calldata bytes.
    maxBatchCalls: Number(env("MAX_BATCH_CALLS", "8")),
    maxBatchCalldataBytes: Number(env("MAX_BATCH_CALLDATA_BYTES", "8192")),
    // Optional target allowlist for the action calls (comma-separated addresses; empty = any target). The
    // FeeMarketRegistry is always allowed (the charge call). Mirrors the caveat policy a plan advertises.
    allowedTargets: env("ALLOWED_TARGETS", "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    // Refuse new sponsored requests while the relayer holds less than this (wei): better a clear 503 than
    // accepting work that cannot be paid for. 0 = off.
    minRelayerBalanceWei: envNative("MIN_RELAYER_BALANCE_POL", "MIN_RELAYER_BALANCE_WEI", "0.3"),
    // Do not broadcast when the network's max fee per gas is above this (gwei). 0 = off.
    // Decimals allowed (e.g. 0.5 gwei on a cheap chain); validated here so a typo fails at startup.
    maxFeePerGasGwei: (parseDecimalUnits("MAX_FEE_PER_GAS_GWEI", maxFeePerGasGwei, 9), Number(maxFeePerGasGwei)),
    // Require the user delegation to carry the RedeemerRestrictionEnforcer caveat locked to us.
    requireRedeemerRestriction: envBool("REQUIRE_REDEEMER_RESTRICTION", "true"),
    // Longest deadline (seconds from now) a delegation may carry; a relayer must not be able to sit on a
    // signed delegation and redeem it much later.
    maxDelegationTtlSeconds: Number(env("MAX_DELEGATION_TTL_SECONDS", "3600")),
    // Simulate the redemption (eth_call) before broadcasting, so reverts never cost gas.
    simulateBeforeSend: envBool("SIMULATE_BEFORE_SEND", "true"),
    // How long a request waits for its receipt before answering 504 (the wallet gives up at 20s). The transaction
    // keeps being managed (replaced if stuck) after the response, so a 504 is "not confirmed yet", not "failed".
    receiptWaitMs: Number(env("RECEIPT_WAIT_MS", "18000")),
    // A broadcast transaction with no receipt after this long is replaced with a higher fee (same nonce), up to
    // `maxReplacements` times, `replacementBumpPercent` more each time. One stuck nonce blocks every later one.
    stuckAfterMs: Number(env("STUCK_AFTER_MS", "20000")),
    maxReplacements: Number(env("MAX_REPLACEMENTS", "3")),
    replacementBumpPercent: Number(env("REPLACEMENT_BUMP_PERCENT", "25")),
    // Optional webhook (Slack/Discord/generic JSON POST) told about low balance and stuck transactions.
    alertWebhookUrl: process.env.ALERT_WEBHOOK_URL ?? "",
    alertCooldownMs: Number(env("ALERT_COOLDOWN_MS", "600000")),
    // Per-IP request budget.
    rateLimitWindowMs: Number(env("RATE_LIMIT_WINDOW_MS", "60000")),
    rateLimitMax: Number(env("RATE_LIMIT_MAX", "30")),
    // Per-delegator (the user's account) budget over the same window: one user cannot burn the sponsor's gas by
    // hammering from many IPs. 0 = off.
    rateLimitDelegatorMax: Number(env("RATE_LIMIT_DELEGATOR_MAX", "10")),
    // How many sponsored requests are processed at once, and how many may wait behind them. Beyond that the node
    // answers 503 with Retry-After instead of building an unbounded backlog (each waiting request holds a connection
    // and RPC calls). 0 for the queue = reject immediately when all slots are busy.
    maxConcurrentSponsored: Number(env("MAX_CONCURRENT_SPONSORED", "8")),
    maxQueuedSponsored: Number(env("MAX_QUEUED_SPONSORED", "16")),
    // A signed delegation is remembered this long: a wallet retrying the same request (it gave up waiting) gets the
    // original answer back instead of a second, doomed redemption that costs gas.
    idempotencyTtlMs: Number(env("IDEMPOTENCY_TTL_MS", "600000")),
    // How long on-chain reads that change rarely (plans, sponsor status, gas price) are reused.
    readCacheMs: Number(env("READ_CACHE_MS", "15000")),
  },
} as const;

// Special constants from MetaMask's DelegationManager
export const ANY_DELEGATE = "0x0000000000000000000000000000000000000a11" as Address;
export const ROOT_AUTHORITY =
  "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff" as Hex;
// ERC-7579 mode: single-batch, default exec type
export const BATCH_DEFAULT_MODE =
  "0x0100000000000000000000000000000000000000000000000000000000000000" as Hex;

// Marketplace pricing models — mirror IFeeMarket.PricingModel ordering.
export enum PricingModel {
  PER_TXN = 0,
  BULK = 1,
  SUBSCRIPTION = 2,
}
