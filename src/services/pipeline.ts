import type { Response } from "express";
import { config } from "../config.js";
import { asyncHandler } from "../middleware.js";
import { delegatorLimiter, fingerprint, gate, idempotency, locks, type StoredResponse } from "./abuse.js";
import { assertCanSponsor } from "./guard.js";

/**
 * The shared front of every sponsored endpoint. Cheap checks first, so abuse never reaches the RPC or the gas:
 *   draining / out of funds -> 503 · body shape -> 400 · per-delegator budget -> 429 · a retry of a request already
 *   answered gets the SAME answer (and one still running gets 409) · one request at a time per subscription (or per
 *   user for /subscribe) -> 409 · bounded concurrency with a bounded queue -> 503 + Retry-After.
 * Only a success (or a "sent, not confirmed yet") is remembered for replay; a rejection lets the caller try again.
 */
export function sponsoredEndpoint<T extends { delegations: { delegator: string; salt: string; signature: string }[]; executionCallData: string }>(
  schema: { safeParse(v: unknown): { success: true; data: T } | { success: false; error: { flatten(): unknown } } },
  lockKey: (data: T, delegator: string) => string,
  handle: (data: T, delegator: string, res: Response) => Promise<void>,
  prechecks: () => Promise<void> = assertCanSponsor,
) {
  return asyncHandler(async (req, res) => {
    await prechecks();
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ ok: false, error: parsed.error.flatten() });
    const data = parsed.data;
    const delegator = data.delegations[data.delegations.length - 1].delegator;

    if (!delegatorLimiter.allow(delegator.toLowerCase())) {
      res.setHeader("Retry-After", String(Math.ceil(config.policy.rateLimitWindowMs / 1000)));
      return void res.status(429).json({ ok: false, error: "too many requests for this account, slow down" });
    }

    const fp = fingerprint(data);
    const prior = idempotency.begin(fp);
    if (prior.state === "done") {
      res.setHeader("x-idempotent-replay", "true");
      return void res.status(prior.response.status).json(prior.response.body);
    }
    if (prior.state === "inflight") return void res.status(409).json({ ok: false, error: "this request is already being processed" });

    const release = locks.acquire(lockKey(data, delegator));
    if (!release) {
      idempotency.abort(fp);
      return void res.status(409).json({ ok: false, error: "another request for this subscription is already being processed" });
    }

    // Remember what was sent so a replay can return it.
    let captured: StoredResponse | null = null;
    const json = res.json.bind(res);
    res.json = ((body: unknown) => {
      captured = { status: res.statusCode, body };
      return json(body);
    }) as Response["json"];

    try {
      await gate.run(() => handle(data, delegator, res));
    } finally {
      release();
      const c = captured as StoredResponse | null;
      const replayable = c && (c.status === 200 || (c.status === 504 && (c.body as { pending?: boolean }).pending === true));
      if (c && replayable) idempotency.finish(fp, c);
      else idempotency.abort(fp);
    }
  });
}

