import { logger } from "./lib/log.js";
import type { NextFunction, Request, Response } from "express";
import { config } from "./config.js";
import { ipLimiter } from "./services/abuse.js";

/** Minimal CORS so the dApp + wallet can call the relayer from a browser. */
export function cors(req: Request, res: Response, next: NextFunction) {
  const origin = req.headers.origin;
  const allowed = config.corsOrigins;
  if (allowed.includes("*")) {
    res.setHeader("Access-Control-Allow-Origin", "*");
  } else if (origin && allowed.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
}

/** The caller's address for rate limiting. Behind Cloudflare (or another edge you fully control) set CLIENT_IP_HEADER so
 * the real client is used; otherwise Express's `req.ip` (which honours TRUST_PROXY). */
export function clientIp(req: Request): string {
  const h = config.clientIpHeader;
  if (h) {
    const v = req.headers[h];
    const first = (Array.isArray(v) ? v[0] : v)?.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.ip ?? "unknown";
}

/** Per-IP budget (in-memory; swap for Redis if you run several instances). */
export function rateLimit(req: Request, res: Response, next: NextFunction) {
  if (!ipLimiter.allow(clientIp(req))) {
    res.setHeader("Retry-After", String(Math.ceil(config.policy.rateLimitWindowMs / 1000)));
    return res.status(429).json({ ok: false, error: "rate limit exceeded" });
  }
  next();
}

/** Wrap async route handlers so rejected promises hit the error handler instead of hanging. */
export function asyncHandler(fn: (req: Request, res: Response) => Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction) => fn(req, res).catch(next);
}

export function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction) {
  const status = (err as { status?: number }).status;
  const retryAfter = (err as { retryAfter?: number }).retryAfter;
  if (retryAfter) res.setHeader("Retry-After", String(retryAfter));
  if (status) {
    // An explicit status is an expected refusal (busy, out of funds, restarting...), not a crash: no stack trace.
    res.status(status).json({ ok: false, error: err.message });
    return;
  }
  logger.error("request_failed", { requestId: res.locals.requestId, error: err.message, stack: err.stack?.split("\n").slice(0, 4).join(" | ") });
  res.status(500).json({ ok: false, error: err.message });
}
