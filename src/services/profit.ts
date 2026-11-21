import { parseAbi, type Address } from "viem";
import { config, PricingModel } from "../config.js";
import { cached } from "../lib/cache.js";
import { logger } from "../lib/log.js";
import type { Plan } from "./registry.js";
import { m } from "./telemetry.js";

/**
 * The profit guard. A sponsored request is paid by the user with a fixed amount of a payment token; the sponsor pays gas
 * in the native token. In a gas spike (or on a cheap plan) the second can exceed the first, and every request is a loss.
 * The guard refuses a request when its gas cost, valued in the plan's token, exceeds `PROFIT_GUARD_MAX_MULTIPLE` times
 * what the plan pays for it. 0 turns it off. It compares dollars: the price oracle gives native/USD, and the plan's token
 * must be one of STABLE_TOKENS (worth 1 USD). Anything it cannot price follows PROFIT_GUARD_UNPRICED.
 */

/** What one request earns the sponsor, in the payment token's base units; null when it cannot be known per request. */
export function revenuePerRequest(plan: Pick<Plan, "model" | "price" | "quota">): bigint | null {
  if (plan.model === PricingModel.PER_TXN) return plan.price;
  // BULK releases price / quota per transaction. A SUBSCRIPTION with a quota earns by time, at most price / quota per use;
  // without a quota there is no per-request amount.
  if ((plan.model === PricingModel.BULK || plan.model === PricingModel.SUBSCRIPTION) && plan.quota > 0n) return plan.price / plan.quota;
  return null;
}

/**
 * Gas cost in the payment token's base units: wei * (USD per native, as an integer with `feedDecimals`) * 10^tokenDecimals
 * / (1e18 * 10^feedDecimals). Rounded up, so the guard never under-states a cost.
 */
export function gasCostInToken(gasCostWei: bigint, nativeUsd: bigint, feedDecimals: number, tokenDecimals: number): bigint {
  const num = gasCostWei * nativeUsd * 10n ** BigInt(tokenDecimals);
  const den = 10n ** 18n * 10n ** BigInt(feedDecimals);
  return (num + den - 1n) / den;
}

export type Decision =
  | { ok: true; checked: boolean; reason?: string }
  | { ok: false; reason: string; costToken: bigint; revenue: bigint };

export interface Prices {
  /** USD per native token as an integer with `decimals` decimals. */
  nativeUsd: bigint;
  decimals: number;
}

export interface Env {
  prices(): Promise<Prices | null>;
  tokenDecimals(token: Address): Promise<number | null>;
}

export async function decide(
  plan: Pick<Plan, "model" | "price" | "quota" | "paymentToken"> | undefined,
  gasCostWei: bigint,
  env: Env,
  cfg = config.profit,
): Promise<Decision> {
  if (cfg.maxMultiple <= 0 || !plan) return { ok: true, checked: false };
  const unpriced = (why: string): Decision => {
    m.profitGuard.inc({ result: "unpriced" });
    return cfg.unpriced === "refuse" ? { ok: false, reason: `cannot check this request against the plan price (${why}); this sponsor is not accepting unchecked requests`, costToken: 0n, revenue: 0n } : { ok: true, checked: false, reason: why };
  };
  const revenue = revenuePerRequest(plan);
  if (revenue === null) return unpriced("the plan has no per-request price");
  if (!cfg.stableTokens.includes(plan.paymentToken.toLowerCase())) return unpriced("the plan's token is not a known stablecoin");
  const [prices, tokenDecimals] = await Promise.all([env.prices().catch(() => null), env.tokenDecimals(plan.paymentToken).catch(() => null)]);
  if (!prices) return unpriced("no fresh native price");
  if (tokenDecimals === null) return unpriced("token decimals unknown");

  const costToken = gasCostInToken(gasCostWei, prices.nativeUsd, prices.decimals, tokenDecimals);
  // multiple is a decimal (e.g. 2.5): compare in thousandths to stay in integers.
  const limit = (revenue * BigInt(Math.round(cfg.maxMultiple * 1000))) / 1000n;
  if (costToken > limit) {
    m.profitGuard.inc({ result: "refused" });
    return { ok: false, reason: "network fees are too high right now for this plan's price; try again in a few minutes", costToken, revenue };
  }
  m.profitGuard.inc({ result: "allowed" });
  return { ok: true, checked: true };
}

// ---- live oracle -----------------------------------------------------------------------------------------------------
const feedAbi = parseAbi([
  "function decimals() view returns (uint8)",
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
]);
const erc20Abi = parseAbi(["function decimals() view returns (uint8)"]);

export interface Round { answer: bigint; updatedAt: bigint; roundId: bigint; answeredInRound: bigint }

/** Validates a Chainlink round: positive, complete, and fresh. Exported for tests. */
export function usableRound(r: Round, nowSec: number, maxAgeSec: number): boolean {
  if (r.answer <= 0n) return false;
  if (r.answeredInRound < r.roundId) return false;
  if (maxAgeSec > 0 && BigInt(nowSec) - r.updatedAt > BigInt(maxAgeSec)) return false;
  return true;
}

export const liveEnv: Env = {
  async prices() {
    const { oracle, nativeUsdFeed, fixedNativeUsd, maxAgeSec } = config.profit;
    if (oracle === "off") return null;
    if (oracle === "fixed") {
      const n = Number(fixedNativeUsd);
      if (!(n > 0)) return null;
      return { nativeUsd: BigInt(Math.round(n * 1e8)), decimals: 8 };
    }
    return cached("native-usd", 30_000, async () => {
      const { publicClient } = await import("../lib/clients.js");
      const feed = nativeUsdFeed as Address;
      const [decimals, round] = await Promise.all([
        cached("native-usd-decimals", 3_600_000, () => publicClient.readContract({ address: feed, abi: feedAbi, functionName: "decimals" })),
        publicClient.readContract({ address: feed, abi: feedAbi, functionName: "latestRoundData" }),
      ]);
      const r = { roundId: round[0], answer: round[1], updatedAt: round[3], answeredInRound: round[4] };
      if (!usableRound(r, Math.floor(Date.now() / 1000), maxAgeSec)) {
        logger.warn("price_feed_unusable", { answer: r.answer.toString(), updatedAt: r.updatedAt.toString() });
        return null;
      }
      return { nativeUsd: r.answer, decimals: Number(decimals) };
    });
  },
  async tokenDecimals(token) {
    const { publicClient } = await import("../lib/clients.js");
    return cached(`decimals:${token.toLowerCase()}`, 86_400_000, async () => Number(await publicClient.readContract({ address: token, abi: erc20Abi, functionName: "decimals" })));
  },
};

export const profitCheck = (plan: Plan | undefined, gasCostWei: bigint): Promise<Decision> => decide(plan, gasCostWei, liveEnv);
