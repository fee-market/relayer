import { createHash, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

/**
 * Constant-time string comparison for secrets (the dashboard and metrics tokens). Both sides are hashed first, so the
 * comparison always looks at 32 bytes whatever the lengths, and `===`'s early exit cannot be used to guess a token one
 * character at a time.
 */
export function safeEqual(a: string, b: string): boolean {
  const da = createHash("sha256").update(a).digest();
  const db = createHash("sha256").update(b).digest();
  return timingSafeEqual(da, db);
}

/** The token from an `Authorization: Bearer <token>` header, or "" when there is none. */
export function bearerToken(header: string | undefined): string {
  return header && header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

/** Dashboard page (inline script and style, no external loads), as opposed to JSON endpoints. */
const PAGE_CSP =
  "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const API_CSP = "default-src 'none'; frame-ancestors 'none'";

/**
 * Headers every response carries. The node serves JSON and one small page, so the policy is strict: nothing may frame it, sniff
 * it or be told where the user came from, and /admin and /metrics responses are never cached by a browser or a proxy.
 */
export function securityHeaders(req: Request, res: Response, next: NextFunction) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  res.setHeader("Cross-Origin-Resource-Policy", "same-site");
  const isPage = req.method === "GET" && (req.path === "/admin" || req.path === "/admin/");
  res.setHeader("Content-Security-Policy", isPage ? PAGE_CSP : API_CSP);
  if (req.path.startsWith("/admin") || req.path === "/metrics") {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Pragma", "no-cache");
  }
  // Only meaningful (and only honoured by browsers) over https; behind a tunnel or proxy the scheme arrives in a header.
  const proto = String(req.headers["x-forwarded-proto"] ?? "").split(",")[0].trim();
  if (req.secure || proto === "https") res.setHeader("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
  next();
}

const REQUEST_ID = /^[A-Za-z0-9._-]{1,64}$/;

/** A caller-supplied request id is kept only if it is short and harmless (it ends up in logs and a response header). */
export function sanitizeRequestId(value: string | undefined, generate: () => string): string {
  return value && REQUEST_ID.test(value) ? value : generate();
}
