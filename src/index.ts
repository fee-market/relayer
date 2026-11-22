import express, { type Response } from "express";
import { config } from "./config.js";
import { relayRequestSchema, subscribeRequestSchema, topUpRequestSchema, type ExecutionRequest } from "./types.js";
import { validateRelayRequest } from "./services/validator.js";
import { validateSubscribeRequest } from "./services/subscribeValidator.js";
import { validateTopUpRequest } from "./services/topUpValidator.js";
import { validateAuthorization } from "./services/authorization.js";
import { findSubscriptionId, preflight, redeemAndConfirm, relayerAddress, suggestedGasCap } from "./services/redeemer.js";
import { alert } from "./services/alerts.js";
import { FeeTooHighError, ReceiptTimeoutError, adoptPersisted, inflightCount } from "./lib/txManager.js";
import { readiness, setDraining } from "./services/guard.js";
import { gate } from "./services/abuse.js";
import { sponsoredEndpoint } from "./services/pipeline.js";
import { getStoreSync } from "./lib/store.js";
import { publicClient } from "./lib/clients.js";
import { buildExplorerQuery, explorerFetch } from "./services/explorerProxy.js";
import { asyncHandler, cors, errorHandler, rateLimit } from "./middleware.js";
import { sanitizeRequestId, securityHeaders } from "./lib/security.js";
import { logger, runWithRequestId } from "./lib/log.js";
import { m, registry, uptimeSec } from "./services/telemetry.js";
import { requireToken } from "./admin.js";
import { startWatcher, stopWatcher } from "./services/watcher.js";
import { isDraining, relayerBalance } from "./services/guard.js";
import { account, providerStatuses } from "./lib/clients.js";
import { describeSource, verifySigner } from "./lib/signer.js";
import { randomUUID } from "node:crypto";
import { adminRouter } from "./admin.js";
import { getCounters, record } from "./services/stats.js";
import { profitCheck } from "./services/profit.js";
import { usesSponsorLevelLock } from "./services/batchValidation.js";
import { isSponsorRelayer } from "./services/registry.js";
import type { Plan } from "./services/registry.js";

const app = express();
app.disable("x-powered-by");
if (config.trustProxy > 0) app.set("trust proxy", config.trustProxy);
app.use(securityHeaders);

/**
 * Request id + access log + metrics for every request. The id comes from the caller's X-Request-Id when it is a safe
 * token (so a wallet or proxy can follow one request end to end), otherwise a fresh UUID; it is echoed in the response
 * header and carried through every log line of that request. Routes are labelled by their pattern, never the raw URL,
 * so ids and addresses in paths cannot blow up the number of metric series.
 */
app.use((req, res, next) => {
  const requestId = sanitizeRequestId(req.headers["x-request-id"] as string | undefined, randomUUID);
  res.locals.requestId = requestId;
  res.setHeader("X-Request-Id", requestId);
  const started = process.hrtime.bigint();
  res.on("finish", () => {
    const route = req.route?.path ? `${req.baseUrl}${req.route.path}` : req.baseUrl ? req.baseUrl : "unmatched";
    const seconds = Number(process.hrtime.bigint() - started) / 1e9;
    m.http.inc({ route, status: `${Math.floor(res.statusCode / 100)}xx` });
    m.httpDuration.observe(seconds, { route });
    if (route !== "/live") runWithRequestId(requestId, () => logger.info("http", { method: req.method, route, status: res.statusCode, ms: Math.round(seconds * 1000) }));
  });
  runWithRequestId(requestId, next);
});
app.use(cors);
app.use(express.json({ limit: "256kb" }));

/**
 * Prometheus metrics. Token-protected (METRICS_TOKEN) and OFF when no token is set, like the dashboard: counts of
 * requests, balances and registry state are operational data, not public. Scrape with
 * `authorization: Bearer <METRICS_TOKEN>` (Prometheus: `authorization.credentials`).
 */
app.get("/metrics", requireToken(config.metricsToken, "metrics disabled: set METRICS_TOKEN", "metrics"), asyncHandler(async (_req, res) => {
  res.type("text/plain; version=0.0.4").send(await registry.render());
}));

registry.onCollect(async () => {
  m.uptime.set(uptimeSec());
  m.draining.set(isDraining() ? 1 : 0);
  m.inflight.set(inflightCount());
  m.relayerBalanceMinWei.set(Number(config.policy.minRelayerBalanceWei));
  m.relayerBalanceWei.set(Number(await relayerBalance()));
  for (const p of await providerStatuses()) m.providerUp.set(p.up ? 1 : 0, { host: p.host });
});

/**
 * Public totals for the project website: how many transactions this node sponsored and what it paid in gas for them.
 * Aggregates only (no addresses, no request data), so it is safe to publish; rate-limited and cacheable.
 */
app.get("/stats", rateLimit, (_req, res) => {
  const c = getCounters();
  res.set("cache-control", "public, max-age=30");
  res.json({ sponsorId: config.sponsorId.toString(), chainId: config.chainId, sponsoredTransactions: c.success, gasPaidWei: c.totalGasUsedWei, since: c.startedAt });
});

/** Liveness only: the process is up. Cheap and dependency-free, for the container healthcheck. */
app.get("/live", (_req, res) => {
  res.json({ ok: true });
});

/**
 * Readiness: can this node take sponsored work right now (RPC reachable AND the relayer can pay for it). Answers 503
 * when it cannot, so a wallet's pre-flight check sees the problem up front and can offer a self-paid send instead of
 * making the user wait. Rate-limited and cached: it reads the chain, and anyone can call it.
 */
app.get("/health", rateLimit, asyncHandler(async (_req, res) => {
  // Bounded: a provider that hangs must produce a fast 503 (the wallet waits only a few seconds for this), not a 16 s wait and a 500.
  const bounded = <T,>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), ms).unref())]);
  let blockNumber: bigint;
  let ready: Awaited<ReturnType<typeof readiness>>;
  try {
    [blockNumber, ready] = await bounded(Promise.all([publicClient.getBlockNumber(), readiness()]), 6000);
  } catch (e) {
    res.status(503).json({ ok: false, relayer: relayerAddress, sponsorId: config.sponsorId.toString(), chainId: config.chainId, problems: [`the RPC is not answering (${(e as Error).message.split("\n")[0]})`], inflight: inflightCount(), load: gate.stats() });
    return;
  }
  res.status(ready.ready ? 200 : 503).json({
    ok: ready.ready,
    relayer: relayerAddress,
    sponsorId: config.sponsorId.toString(),
    chainId: config.chainId,
    blockNumber: blockNumber.toString(),
    relayerBalanceWei: ready.balanceWei.toString(),
    providers: ready.providers,
    inflight: inflightCount(),
    load: gate.stats(),
    ...(ready.problems.length ? { problems: ready.problems } : {}),
  });
}));

interface Ctx {
  subscriptionId?: string;
  delegator?: string;
  label: string; // "redemption" | "subscribe" | "topUp", used in error text
  plan?: Plan; // set for /relay: the plan whose per-request price the profit guard compares gas against
}

/**
 * The shared tail of every sponsored endpoint, after the request-specific validation passed:
 *   authorization check -> simulation + gas limit -> broadcast -> wait (bounded) -> respond.
 * Returns the receipt on success, or null when it already answered (rejected, reverted, pending, fee cap).
 */
async function executeSponsored(res: Response, req: ExecutionRequest, ctx: Ctx) {
  const reject = (status: number, reason: string, outcome: "rejected" | "error" = "rejected") => {
    record({ outcome, subscriptionId: ctx.subscriptionId, delegator: ctx.delegator, reason });
    res.status(status).json({ ok: false, error: reason });
    return null;
  };

  // A delegation locked to the sponsor's relayer set only works while THIS node's key is in that set (it may have been
  // removed): say so here instead of paying for a simulation that reverts inside the enforcer.
  if (usesSponsorLevelLock(req.delegations) && (await isSponsorRelayer(relayerAddress)) === false) {
    return reject(503, "this node's key is not a relayer of the sponsor right now");
  }

  const auth = await validateAuthorization(req);
  if (!auth.ok) return reject(422, auth.reason);

  const limit = ctx.label === "redemption"
    ? { cap: config.policy.maxGasUnits, name: "MAX_GAS_UNITS" }
    : { cap: config.policy.maxGasUnitsSubscribe, name: "MAX_GAS_UNITS_SUBSCRIBE" };
  const pf = await preflight(req, limit);
  if (!pf.ok) {
    if (pf.overUnitCap && pf.gas !== undefined) {
      alert(
        `gas-units:${limit.name}`,
        `A ${ctx.label} needed ${pf.gas} gas, above ${limit.name}=${limit.cap}, and was refused. If this is a normal action, ` +
          `set ${limit.name}=${suggestedGasCap(pf.gas)} in .env and run \`npm run sponsor:ensure-running\`. MAX_GAS_POL still caps the cost.`,
      );
    }
    return reject(422, pf.reason ?? "simulation failed");
  }

  const profit = await profitCheck(ctx.plan, pf.gasCostWei!);
  if (!profit.ok) {
    res.setHeader("Retry-After", "120");
    return reject(503, profit.reason);
  }

  try {
    const { hash, receipt } = await redeemAndConfirm(req, pf.gas!);
    if (receipt.status !== "success") {
      record({ outcome: "reverted", subscriptionId: ctx.subscriptionId, delegator: ctx.delegator, redeemTx: hash });
      res.status(502).json({ ok: false, error: `${ctx.label} reverted`, redeemTx: hash });
      return null;
    }
    return { hash, receipt };
  } catch (err) {
    if (err instanceof ReceiptTimeoutError) {
      // Not a failure: the transaction is out there and the node keeps replacing it if it is stuck. Say so, with the hash.
      record({ outcome: "error", subscriptionId: ctx.subscriptionId, delegator: ctx.delegator, redeemTx: err.hash, reason: "not confirmed within the wait window" });
      res.status(504).json({ ok: false, pending: true, error: "transaction sent but not confirmed yet", redeemTx: err.hash });
      return null;
    }
    if (err instanceof FeeTooHighError) return reject(503, err.message, "error");
    record({ outcome: "error", subscriptionId: ctx.subscriptionId, delegator: ctx.delegator, reason: (err as Error).message });
    throw err;
  }
}

const gasUsedWei = (r: { gasUsed: bigint; effectiveGasPrice: bigint }) => (r.gasUsed * r.effectiveGasPrice).toString();

/**
 * POST /relay
 * The wallet/dApp posts the user's signed delegation + execution batch. The node:
 *   1. refuses when it cannot pay (relayer balance below the minimum)
 *   2. schema-validates the body
 *   3. validates statically + against the on-chain subscription/plan (funds, sponsor, quota, not ended)
 *   4. checks any first-use EIP-7702 authorization, simulates the redemption (including the upgrade) and fixes its gas
 *   5. broadcasts the gasless type-4 redemption (sponsor pays gas), replacing it with a higher fee if it gets stuck
 *      The user-signed batch ends with registry.chargeUsage(subId, 1), run by the user's own account, so
 *      payment is atomic with the action and the relayer never reports usage itself.
 */
/** Explorer reads for the wallet, so the app carries no explorer key. Allow-listed shapes only (services/explorerProxy.ts). */
app.get("/explorer", rateLimit, asyncHandler(async (req, res) => {
  const q = buildExplorerQuery(req.query as Record<string, unknown>);
  if (typeof q === "string") return void res.status(400).json({ status: "0", message: q, result: [] });
  const out = await explorerFetch(q);
  res.status(out.status).type("application/json").send(out.body);
}));

app.post("/relay", rateLimit, sponsoredEndpoint(
  relayRequestSchema,
  (d) => `sub:${d.subscriptionId}`,
  async (relayReq, delegator, res) => {
    const validation = await validateRelayRequest(relayReq);
    if (!validation.ok) {
      record({ outcome: "rejected", subscriptionId: relayReq.subscriptionId, delegator, reason: validation.reason });
      return void res.status(422).json({ ok: false, error: validation.reason });
    }
    const done = await executeSponsored(res, relayReq, { subscriptionId: relayReq.subscriptionId, delegator, label: "redemption", plan: validation.plan });
    if (!done) return;
    record({ outcome: "success", subscriptionId: relayReq.subscriptionId, delegator, redeemTx: done.hash, gasUsedWei: gasUsedWei(done.receipt) });
    res.json({ ok: true, redeemTx: done.hash, gasUsed: done.receipt.gasUsed.toString() });
  },
));

/**
 * POST /subscribe
 * Bootstraps a new subscription for a 0-native-balance user — this is what /relay can't do, since
 * /relay requires an EXISTING subscriptionId to check funds against. Here there is none yet; instead
 * the batch itself is strictly validated (subscribeValidator.ts): it must be exactly one call to
 * THIS sponsor's FeeMarketRegistry.subscribe(planId, amount), for one of this sponsor's active plans,
 * with `amount` covering the plan's price for Bulk/Subscription models, and the user must actually hold (and have
 * approved) that amount. Without those checks this endpoint would sponsor arbitrary or doomed batches.
 */
app.post("/subscribe", rateLimit, sponsoredEndpoint(
  subscribeRequestSchema,
  (_d, delegator) => `user:${delegator.toLowerCase()}`,
  async (subReq, delegator, res) => {
    const validation = await validateSubscribeRequest(subReq);
    if (!validation.ok) {
      record({ outcome: "rejected", delegator, reason: validation.reason });
      return void res.status(422).json({ ok: false, error: validation.reason });
    }
    const done = await executeSponsored(res, subReq, { delegator, label: "subscribe" });
    if (!done) return;
    const subscriptionId = findSubscriptionId(done.receipt.logs);
    record({ outcome: "success", subscriptionId: subscriptionId?.toString(), delegator, redeemTx: done.hash, gasUsedWei: gasUsedWei(done.receipt) });
    res.json({
      ok: true,
      redeemTx: done.hash,
      subscriptionId: subscriptionId?.toString(),
      planId: validation.planId?.toString(),
      gasUsed: done.receipt.gasUsed.toString(),
    });
  },
));

/**
 * POST /topup
 * Adds escrow to an EXISTING subscription — also 0-native-balance, sponsor pays gas. Unlike
 * /subscribe, the subscriptionId comes from decoding the batch's topUp() call, and its owning plan
 * is looked up on-chain (topUpValidator.ts) rather than trusted from the request: the batch must be
 * exactly [topUp] or [approve, topUp], targeting THIS sponsor's FeeMarketRegistry, by the subscription's own
 * owner, for a live subscription whose plan belongs to this sponsor and is active.
 */
app.post("/topup", rateLimit, sponsoredEndpoint(
  topUpRequestSchema,
  (_d, delegator) => `user:${delegator.toLowerCase()}`,
  async (topUpReq, delegator, res) => {
    const validation = await validateTopUpRequest(topUpReq);
    const subscriptionId = validation.subscriptionId?.toString();
    if (!validation.ok) {
      record({ outcome: "rejected", subscriptionId, delegator, reason: validation.reason });
      return void res.status(422).json({ ok: false, error: validation.reason });
    }
    const done = await executeSponsored(res, topUpReq, { subscriptionId, delegator, label: "topUp" });
    if (!done) return;
    record({ outcome: "success", subscriptionId, delegator, redeemTx: done.hash, gasUsedWei: gasUsedWei(done.receipt) });
    res.json({
      ok: true,
      redeemTx: done.hash,
      subscriptionId,
      amount: validation.amount?.toString(),
      gasUsed: done.receipt.gasUsed.toString(),
    });
  },
));

// Sponsor dashboard (token-protected data endpoints + static page).
app.use("/admin", adminRouter());

app.use(errorHandler);

// A remote signer is proven before the node takes any traffic: better to refuse to start than to accept sponsored work it cannot sign.
await verifySigner(config.signer, account);

// Take back anything a previous run left in flight before serving, so a stuck transaction from before a restart is
// still replaced and its nonce is not reused underneath it.
try {
  await adoptPersisted();
} catch (e) {
  console.error("[startup] could not adopt in-flight transactions:", (e as Error).message);
}

const server = app.listen(config.port, config.host, () => {
  console.log(`feemarket sponsor node listening on ${config.host}:${config.port}`);
  void startWatcher();
  console.log(`  relayer address : ${relayerAddress}`);
  console.log(`  signing key     : ${describeSource(config.signer)}`);
  console.log(`  sponsorId       : ${config.sponsorId}`);
  console.log(`  chainId         : ${config.chainId}`);
  console.log(`  registry        : ${config.feeMarketRegistry}`);
  console.log(`  rpc providers   : ${config.rpcUrls.length}`);
  console.log(`  state           : ${config.stateDir || "(not persisted)"}`);
});

/**
 * SIGTERM/SIGINT: stop taking new sponsored work (and report unhealthy so the proxy stops routing here), let requests
 * already running finish for up to DRAIN_MS, write the state file, exit. Transactions still unconfirmed are NOT waited
 * for: they are in the state file and the next start re-adopts them.
 */
let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  console.log(`${signal}: draining (up to ${config.drainMs} ms, ${gate.active()} request(s) running, ${inflightCount()} transaction(s) in flight)`);
  setDraining();
  stopWatcher();
  server.close();
  server.closeIdleConnections?.();
  const deadline = Date.now() + config.drainMs;
  while (gate.active() > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
  if (gate.active() > 0) console.warn(`[shutdown] ${gate.active()} request(s) still running at the deadline; their transactions are in the state file`);
  const store = getStoreSync(config.stateDir);
  store.markDirty();
  store.flushSync();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
