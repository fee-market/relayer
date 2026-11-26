import { Router, type NextFunction, type Request, type Response } from "express";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { config } from "./config.js";
import { asyncHandler, clientIp } from "./middleware.js";
import { adminLimiter, authFailureLimiter } from "./services/abuse.js";
import { m } from "./services/telemetry.js";
import { bearerToken, safeEqual } from "./lib/security.js";
import { getCounters, getLogs, type RelayOutcome } from "./services/stats.js";
import { getEarnings, getSponsorStatus } from "./services/registry.js";
import { chainSettleDeps, knownTimePlanSubs, pendingEarnings } from "./services/timePlans.js";
import { cached } from "./lib/cache.js";
import { publicClient, relayerAddress } from "./lib/clients.js";

const STATUS_LABELS = ["UNVERIFIED", "PENDING", "VERIFIED", "REVOKED"];

/**
 * Bearer-token auth for the dashboard data. Compare against DASHBOARD_TOKEN in constant time. If no token is configured,
 * /admin is disabled entirely (fail closed) so a misconfigured node never exposes stats publicly. Wrong tokens are counted
 * per IP: after 10 in 15 minutes that IP gets 429 until the window ends, so a token cannot be guessed by brute force.
 */
export function requireToken(expected: string, disabledMessage: string, area = "admin") {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!expected) return res.status(503).json({ ok: false, error: disabledMessage });
    const ip = clientIp(req);
    if (authFailureLimiter.isBlocked(ip)) {
      res.setHeader("Retry-After", String(authFailureLimiter.retryAfterSec(ip)));
      return res.status(429).json({ ok: false, error: "too many failed attempts, try again later" });
    }
    if (!safeEqual(bearerToken(req.headers.authorization), expected)) {
      authFailureLimiter.hit(ip);
      m.authFailures.inc({ area });
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }
    next();
  };
}

const requireAuth = (req: Request, res: Response, next: NextFunction) =>
  requireToken(config.dashboardToken, "dashboard disabled: set DASHBOARD_TOKEN")(req, res, next);

/** A generous per-IP ceiling on everything under /admin. */
function adminRateLimit(req: Request, res: Response, next: NextFunction) {
  if (!adminLimiter.allow(clientIp(req))) {
    res.setHeader("Retry-After", "60");
    return res.status(429).json({ ok: false, error: "rate limit exceeded" });
  }
  next();
}

export function adminRouter(): Router {
  const router = Router();
  const here = dirname(fileURLToPath(import.meta.url));
  router.use(adminRateLimit);

  // The dashboard HTML is public (it only holds a token input); the DATA endpoints are protected.
  router.get("/", (_req, res) => res.sendFile(join(here, "public", "dashboard.html")));

  router.get(
    "/stats",
    requireAuth,
    asyncHandler(async (_req, res) => {
      const [balance, blockNumber, sponsor, earnings, pending] = await Promise.all([
        publicClient.getBalance({ address: relayerAddress }),
        publicClient.getBlockNumber(),
        getSponsorStatus().catch(() => null),
        getEarnings(config.dashboardEarningsToken).catch(() => 0n),
        // One read per known time-plan subscription, and the page polls every few seconds: shared for a minute.
        cached(`pendingTimePlanEarnings:${config.dashboardEarningsToken}`, 60_000, async () =>
          knownTimePlanSubs.size() === 0 ? 0n : pendingEarnings((await chainSettleDeps()).details, knownTimePlanSubs, config.dashboardEarningsToken),
        ).catch(() => 0n),
      ]);
      res.json({
        ok: true,
        node: {
          relayer: relayerAddress,
          sponsorId: config.sponsorId.toString(),
          chainId: config.chainId,
          blockNumber: blockNumber.toString(),
          relayerBalanceWei: balance.toString(),
        },
        onchain: {
          status: sponsor ? (STATUS_LABELS[sponsor.status] ?? String(sponsor.status)) : "unknown",
          active: sponsor?.active ?? false,
          payout: sponsor?.payout ?? null,
          earningsToken: config.dashboardEarningsToken,
          claimableEarnings: earnings.toString(),
          // Earned by time plans but not yet moved to the claimable earnings (the node settles on SETTLE_INTERVAL_MS).
          pendingTimePlanEarnings: pending.toString(),
          timePlanSubscriptions: knownTimePlanSubs.size(),
        },
        counters: getCounters(),
      });
    }),
  );

  router.get("/logs", requireAuth, (req, res) => {
    const limit = Math.min(Number(req.query.limit ?? 100), 500);
    const outcome = req.query.outcome as RelayOutcome | undefined;
    res.json({ ok: true, logs: getLogs(limit, outcome) });
  });

  return router;
}
