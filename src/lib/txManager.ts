import { type Hex, type SendTransactionParameters, type TransactionReceipt, keccak256 } from "viem";
import { config } from "../config.js";
import { alert } from "../services/alerts.js";
import { m } from "../services/telemetry.js";
import { logger } from "./log.js";
import { cached } from "./cache.js";
import { account, providerClients, publicClient, relayerAddress, walletClient } from "./clients.js";
import { getStoreSync } from "./store.js";

/**
 * The relayer's only way to send a transaction. One process owns one key, so it owns that key's nonces:
 *
 *  - Sends are serialized and the next nonce is tracked locally, so concurrent requests never grab the same one.
 *  - Fees are set explicitly (not left to the RPC) and refused above MAX_FEE_PER_GAS_GWEI, rather than overpaying.
 *  - Each signed transaction is sent to EVERY configured provider, so one flaky or censoring provider cannot stop it.
 *  - Every broadcast transaction is remembered until it is mined, and written to the state file, so a restart still
 *    knows about it. One with no receipt after STUCK_AFTER_MS is re-sent with the same nonce and a higher fee, because
 *    a single stuck nonce blocks every later transaction, for every user.
 *  - ONE shared loop (a single eth_getTransactionCount per second) notices what was mined and settles every waiting
 *    request, so a hundred concurrent requests cost the same RPC load as one.
 */

export type SendParams = Omit<SendTransactionParameters, "account" | "chain" | "nonce" | "maxFeePerGas" | "maxPriorityFeePerGas" | "gasPrice">;

export class FeeTooHighError extends Error {
  constructor(public readonly maxFeePerGas: bigint) {
    super(`network fee is ${maxFeePerGas / 1_000_000_000n} gwei, above this sponsor's cap of ${config.policy.maxFeePerGasGwei} gwei`);
    this.name = "FeeTooHighError";
  }
}

export class ReceiptTimeoutError extends Error {
  constructor(public readonly hash: Hex) {
    super(`transaction ${hash} is not confirmed yet`);
    this.name = "ReceiptTimeoutError";
  }
}

interface Inflight {
  nonce: number;
  params: SendParams;
  /** Every hash this nonce has been broadcast under (original + replacements); any of them may be the one mined. */
  hashes: Hex[];
  sentAt: number;
  replacements: number;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

interface Waiter {
  nonce: number;
  resolve(r: { hash: Hex; receipt: TransactionReceipt }): void;
  reject(e: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

const GWEI = 1_000_000_000n;
const POLL_MS = 1000;
const inflight = new Map<number, Inflight>();
const waiters = new Set<Waiter>();
const lookups = new Map<number, number>(); // nonce -> polls spent looking for a receipt that should exist
let chainTip: Promise<void> = Promise.resolve();
let nextNonce: number | null = null;
let loop: ReturnType<typeof setInterval> | null = null;
let ticking = false;

const store = getStoreSync(config.stateDir);
store.register("inflight", () => [...inflight.values()]);
const persist = () => store.markDirty();

async function currentFees(): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
  // A couple of seconds of reuse: a burst of requests prices off one fee read, and fees do not move in 2 s.
  return cached("fees", 2000, async () => {
    const fees = await publicClient.estimateFeesPerGas();
    const maxFeePerGas = fees.maxFeePerGas ?? (await publicClient.getGasPrice());
    const maxPriorityFeePerGas = fees.maxPriorityFeePerGas ?? maxFeePerGas / 10n;
    return { maxFeePerGas, maxPriorityFeePerGas };
  });
}

function assertFeeAllowed(maxFeePerGas: bigint): void {
  const cap = BigInt(config.policy.maxFeePerGasGwei) * GWEI;
  if (cap > 0n && maxFeePerGas > cap) throw new FeeTooHighError(maxFeePerGas);
}

const KNOWN = /already known|known transaction|already imported|already in (the )?(mempool|pool)/i;

/**
 * Signs once, then sends the same raw transaction to every provider in parallel. Succeeds if ANY provider accepts it
 * (or already has it). Throws the first error only when every provider refused.
 */
async function signAndBroadcast(params: SendParams, nonce: number, fees: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }): Promise<Hex> {
  const request = await walletClient.prepareTransactionRequest({ ...params, ...fees, nonce, account, chain: walletClient.chain } as never);
  const serialized = await account.signTransaction(request as never);
  const hash = keccak256(serialized);
  const results = await Promise.allSettled(providerClients.map((p) => p.client.sendRawTransaction({ serializedTransaction: serialized })));
  if (results.some((r) => r.status === "fulfilled")) return hash;
  const errors = results.map((r) => (r as PromiseRejectedResult).reason as Error);
  if (errors.some((e) => KNOWN.test(e.message))) return hash; // a provider already had it: it is on its way
  throw errors[0];
}

/** Serialized broadcast. Resolves with the hash as soon as a provider accepted it; confirmation is separate. */
export async function send(params: SendParams): Promise<Hex> {
  let release!: () => void;
  const prev = chainTip;
  chainTip = new Promise<void>((res) => (release = res));
  await prev;
  try {
    const fees = await currentFees();
    assertFeeAllowed(fees.maxFeePerGas);
    if (nextNonce === null) {
      nextNonce = await publicClient.getTransactionCount({ address: relayerAddress, blockTag: "pending" });
    }
    const nonce = nextNonce;
    const hash = await signAndBroadcast(params, nonce, fees);
    nextNonce = nonce + 1;
    inflight.set(nonce, { nonce, params, hashes: [hash], sentAt: Date.now(), replacements: 0, ...fees });
    persist();
    ensureLoop();
    return hash;
  } catch (err) {
    nextNonce = null; // force a resync from the chain next time
    throw err;
  } finally {
    release();
  }
}

async function findReceipt(hashes: Hex[]): Promise<TransactionReceipt | null> {
  // Newest first: after a replacement that is the likeliest winner.
  for (const hash of [...hashes].reverse()) {
    try {
      return await publicClient.getTransactionReceipt({ hash });
    } catch {
      // not mined under this hash (yet)
    }
  }
  return null;
}

/** Sends and waits for the receipt (of whichever hash for that nonce is mined). Throws ReceiptTimeoutError
 * after `timeoutMs`; the transaction stays managed (and is replaced if stuck) after that. */
export async function sendAndConfirm(params: SendParams, timeoutMs = config.policy.receiptWaitMs): Promise<{ hash: Hex; receipt: TransactionReceipt }> {
  const first = await send(params);
  const entry = [...inflight.values()].find((f) => f.hashes[0] === first);
  if (!entry) {
    // Mined and pruned already (a very fast block): the receipt is there.
    const receipt = await findReceipt([first]);
    if (receipt) return { hash: receipt.transactionHash, receipt };
    throw new ReceiptTimeoutError(first);
  }
  return new Promise((resolve, reject) => {
    const waiter: Waiter = {
      nonce: entry.nonce,
      resolve,
      reject,
      timer: setTimeout(() => {
        waiters.delete(waiter);
        reject(new ReceiptTimeoutError(entry.hashes[entry.hashes.length - 1]));
      }, timeoutMs),
    };
    waiters.add(waiter);
    ensureLoop();
  });
}

function ensureLoop(): void {
  if (loop) return;
  loop = setInterval(() => void tick().catch((e) => console.error("[txManager]", (e as Error).message)), POLL_MS);
  loop.unref?.();
}

/**
 * One pass of the shared loop: ONE call to learn how many of our transactions are mined, then settle what is mined and
 * replace what is stuck. Exported for tests.
 */
export async function tick(now = Date.now()): Promise<void> {
  if (ticking || (inflight.size === 0 && waiters.size === 0)) return;
  ticking = true;
  try {
    const mined = await publicClient.getTransactionCount({ address: relayerAddress, blockTag: "latest" });

    for (const f of [...inflight.values()].sort((a, b) => a.nonce - b.nonce)) {
      if (f.nonce >= mined) continue;
      const mine = [...waiters].filter((w) => w.nonce === f.nonce);
      if (mine.length > 0) {
        const receipt = await findReceipt(f.hashes);
        if (!receipt) {
          // Mined per the nonce count but the receipt is not visible on this provider yet: try again next tick.
          const tries = (lookups.get(f.nonce) ?? 0) + 1;
          lookups.set(f.nonce, tries);
          if (tries < 30) continue;
        } else {
          for (const w of mine) {
            clearTimeout(w.timer);
            waiters.delete(w);
            w.resolve({ hash: receipt.transactionHash, receipt });
          }
        }
      }
      lookups.delete(f.nonce);
      inflight.delete(f.nonce);
      persist();
    }
    if (inflight.size === 0 && waiters.size === 0 && loop) {
      clearInterval(loop);
      loop = null;
    }

    // Only the lowest unmined nonce can be "the" blocker; replacing it unblocks the rest.
    const lowest = [...inflight.values()].sort((a, b) => a.nonce - b.nonce)[0];
    if (lowest && now - lowest.sentAt >= config.policy.stuckAfterMs) await replace(lowest, now);
  } finally {
    ticking = false;
  }
}

async function replace(f: Inflight, now: number): Promise<void> {
  if (f.replacements >= config.policy.maxReplacements) {
    nextNonce = null;
    m.txStuck.inc();
    alert(`stuck:${f.nonce}`, `transaction nonce ${f.nonce} is still unconfirmed after ${f.replacements} replacements (${f.hashes[f.hashes.length - 1]}). Later sponsored sends will queue behind it.`);
    return;
  }
  const bump = BigInt(100 + config.policy.replacementBumpPercent);
  let maxFeePerGas = (f.maxFeePerGas * bump) / 100n;
  let maxPriorityFeePerGas = (f.maxPriorityFeePerGas * bump) / 100n;
  // Never replace below the network's current price either: a replacement must also be competitive.
  const fees = await currentFees();
  if (fees.maxFeePerGas > maxFeePerGas) maxFeePerGas = fees.maxFeePerGas;
  if (fees.maxPriorityFeePerGas > maxPriorityFeePerGas) maxPriorityFeePerGas = fees.maxPriorityFeePerGas;
  const cap = BigInt(config.policy.maxFeePerGasGwei) * GWEI;
  if (cap > 0n && maxFeePerGas > cap) {
    m.txStuck.inc();
    alert(`stuck-cap:${f.nonce}`, `transaction nonce ${f.nonce} is stuck and replacing it would exceed MAX_FEE_PER_GAS_GWEI (${config.policy.maxFeePerGasGwei}).`);
    return;
  }
  try {
    const hash = await signAndBroadcast(f.params, f.nonce, { maxFeePerGas, maxPriorityFeePerGas });
    if (!f.hashes.includes(hash)) f.hashes.push(hash);
    f.replacements++;
    f.sentAt = now;
    f.maxFeePerGas = maxFeePerGas;
    f.maxPriorityFeePerGas = maxPriorityFeePerGas;
    persist();
    m.txReplacements.inc();
    logger.warn("tx_replaced", { nonce: f.nonce, replacements: f.replacements, hash, gwei: String(maxFeePerGas / GWEI) });
  } catch (e) {
    const msg = (e as Error).message;
    // "nonce too low" means it was mined meanwhile: the next tick settles it.
    if (!/nonce too low|already known|already imported/i.test(msg)) console.error(`[txManager] replacement of nonce ${f.nonce} failed: ${msg.split("\n")[0]}`);
  }
}

/**
 * Takes back the transactions a previous run left in flight (from the state file): anything already mined is
 * forgotten, the rest is tracked again (and replaced if stuck) exactly as if this process had sent it. Call once at
 * startup. Returns how many were adopted.
 */
export async function adoptPersisted(): Promise<number> {
  const saved = store.section<Inflight[]>("inflight");
  if (!Array.isArray(saved) || saved.length === 0) return 0;
  const mined = await publicClient.getTransactionCount({ address: relayerAddress, blockTag: "latest" });
  let adopted = 0;
  for (const f of saved) {
    if (!f || typeof f.nonce !== "number" || !Array.isArray(f.hashes) || f.hashes.length === 0) continue;
    if (f.nonce < mined || inflight.has(f.nonce)) continue;
    inflight.set(f.nonce, { ...f, maxFeePerGas: BigInt(f.maxFeePerGas), maxPriorityFeePerGas: BigInt(f.maxPriorityFeePerGas) });
    adopted++;
  }
  if (adopted > 0) {
    nextNonce = null; // resync from the chain's pending count (it includes these)
    ensureLoop();
    persist();
    console.warn(`[txManager] adopted ${adopted} unconfirmed transaction(s) from the previous run`);
  }
  return adopted;
}

/** Transactions currently being managed (for /health and shutdown). */
export function inflightCount(): number {
  return inflight.size;
}

/** Test hooks. */
export function _state() {
  return { nextNonce, inflight: [...inflight.values()], waiters: waiters.size };
}
export function _reset() {
  inflight.clear();
  waiters.forEach((w) => clearTimeout(w.timer));
  waiters.clear();
  lookups.clear();
  nextNonce = null;
  if (loop) clearInterval(loop);
  loop = null;
  ticking = false;
  chainTip = Promise.resolve();
}
export { account };
