# fee.market — Sponsor Node (relayer)

Run your own gas-sponsorship node for [v1.fee.market](../README.md). Users pick you as their sponsor;
your node accepts their signed delegations, **pays the gas**, broadcasts the EIP-7702 (type-4)
redemption of a batch that ends with the user's own `chargeUsage` call. You earn the plan fee.

You never custody user funds and you can't move anything the user didn't sign for — the on-chain
caveat enforcers bound every redemption.

## What this node does

```
wallet / dApp ──POST /relay──▶  [your sponsor node]
                                    1. schema-validate
                                    2. validate vs on-chain subscription/plan (funds, quota, sponsor)
                                    3. preflight estimateGas  (revert ⇒ reject, no gas spent)
                                    4. redeemDelegations  ── type-4 tx, you pay gas
                                       (the signed batch ends with registry.chargeUsage(subId, 1), run by the
                                        user's own account — payment is atomic with the action)
                                 ◀── { redeemTx, gasUsed }
```

**New sponsor? Start with [`docs/sponsor-setup.md`](../docs/sponsor-setup.md)** (requirements, architecture, the short command list).

## Quick start

```bash
git clone <repo> && cd <repo>/relayer && npm run setup
npm run sponsor:init        # writes .env and generates your relayer key (then fund it with a little POL)
npm run sponsor:plans:configure   # interactive: define your profile + plans, writes sponsor.plans.json
npm run sponsor:onboard     # register (or reuse), write SPONSOR_ID, publish metadata; re-runnable
#   ... ask the marketplace curator to verify you ...
npm run sponsor:go          # list plans, start the node, wait for /health
```

On an Ubuntu VPS, three scripts do the whole run with questions and checks: `sudo bash scripts/vps/prepare.sh` (user, SSH, firewall,
Docker, Node), `bash scripts/vps/setup.sh` (the commands above, guided, plus the start) and `bash scripts/vps/check.sh` (read-only
checks, any time). See [`docs/sponsor-vps-checklist.md`](../docs/sponsor-vps-checklist.md).

No VPS? `bash scripts/setup-tunnel.sh relay.yourdomain.com` sets up a stable named Cloudflare Tunnel (survives
restarts/reboots, unlike a quick tunnel) instead of the Caddy+VPS path, and writes `PUBLIC_RELAYER_URL` for you.

Also: `sponsor:doctor` (read-only readiness check), `sponsor:status`, `sponsor:withdraw`, `sponsor:rotate`, `sponsor:accept` (a new key or payout wallet agrees to its role first; the registry refuses one that did not), and the single steps
`sponsor:register`, `sponsor:metadata:publish`, `sponsor:list`. Plans, subscriptions, verification and fee math are explained in
[`docs/sponsor-setup.md`](../docs/sponsor-setup.md). For development: `npm run dev`, then `curl localhost:8787/health`.

## Configuration (`.env`)

| Var | Meaning |
|---|---|
| `RPC_URL`, `CHAIN_ID`, `CONFIRMATIONS` | Chain connection. |
| `RELAYER_PRIVATE_KEY` | The key that pays gas & submits txns. **Fund it.** Keep it secret. |
| `DELEGATION_MANAGER`, `DELEGATOR_IMPLEMENTATION` | MetaMask framework addresses (defaults = Polygon). |
| `FEE_MARKET_REGISTRY`, `REDEEMER_RESTRICTION_ENFORCER` | Deploy from [`../contracts`](../contracts) and paste here. |
| `LIMITED_CALLS_ENFORCER`, `EXACT_EXECUTION_BATCH_ENFORCER`, `TIMESTAMP_ENFORCER` | MetaMask caveat enforcers (defaults = Polygon). Every delegation must carry them plus the redeemer restriction; the relayer rejects anything else. |
| `MAX_DELEGATION_TTL_SECONDS` | Longest delegation lifetime accepted (default 3600). |
| `SPONSOR_PAYOUT_ADDRESS` | Cold wallet that receives earnings (used by `sponsor:register`; defaults to the relayer address). |
| `TRUST_PROXY` | Reverse-proxy hops in front of the node (`1` behind Caddy/nginx). Needed for correct per-IP rate limits. |
| `SPONSOR_ID` | Your id from `registerSponsor` (see `sponsor:register` output / events). |
| `SPONSOR_ADMIN_PRIVATE_KEY` | Only for `npm run sponsor:rotate` and `sponsor:relayers -- add|remove`: your payout (cold) key. Not needed to run the node. |
| `SPONSOR_NEW_PAYOUT_PRIVATE_KEY` | Only for `npm run sponsor:accept -- payout`: the NEW payout wallet's key, accepting the role before the old payout key moves control to it. A Safe uses `--safe-batch` instead. |
| `CORS_ORIGINS` | Allowed browser origins (`*` for any). |
| `MAX_GAS_WEI` | Reject redemptions whose estimated cost exceeds this (default 0.1 of the native token; 0 = no cap, not advised). |
| `MAX_GAS_UNITS` | Hard ceiling on gas units for one redemption (default 600000). Also the transaction's own gas limit, so a heavy batch can never burn more. |
| `MAX_BATCH_CALLS`, `MAX_BATCH_CALLDATA_BYTES` | Bound what one sponsored batch may contain (defaults 8 calls, 8192 bytes). |
| `ALLOWED_TARGETS` | Optional comma-separated allowlist for the batch's action calls (the registry is always allowed). Empty = any. |
| `MIN_RELAYER_BALANCE_WEI` | Pause sponsored sends (503) and report unhealthy while the relayer holds less than this. |
| `MAX_FEE_PER_GAS_GWEI` | Do not broadcast while the network's max fee is above this (default 500; 0 = off). |
| `RECEIPT_WAIT_MS`, `STUCK_AFTER_MS`, `MAX_REPLACEMENTS`, `REPLACEMENT_BUMP_PERCENT` | How long a request waits (answers 504 after), when a silent transaction is replaced with a higher fee, how often, and by how much. |
| `RPC_URL`, `RPC_URLS` | The preferred RPC provider and optional comma-separated fallbacks. Reads fail over down the list; **every transaction is sent to all of them**. Use a paid provider first; `sponsor:doctor` fails a published node that only has free public endpoints. |
| `STATE_DIR` | Where in-flight transactions and the dashboard history are kept so they survive a restart (default `./data`; a volume in Docker; empty = not persisted). On start the node re-adopts what a previous run left unconfirmed and still replaces it if stuck. |
| `DRAIN_MS` | On SIGTERM, how long (ms) running requests may finish before exit (default 20000). |
| `CLIENT_IP_HEADER` | Real-client-IP header when all traffic comes through an edge you control (Cloudflare: `cf-connecting-ip`; `setup-tunnel.sh` sets it). Otherwise a tunnel puts every user in one per-IP bucket. |
| `RATE_LIMIT_DELEGATOR_MAX` | Per-account budget per window (default 10), alongside the per-IP one. |
| `MAX_CONCURRENT_SPONSORED`, `MAX_QUEUED_SPONSORED` | Sponsored requests processed at once (8) and allowed to wait (16); beyond that, 503 + `Retry-After`. |
| `IDEMPOTENCY_TTL_MS`, `READ_CACHE_MS` | How long a retried request replays its original answer (10 min), and how long plans / gas price are reused (15 s). |
| `ALERT_WEBHOOK_URL` | Optional Slack/Discord/JSON webhook told about low balance and stuck transactions. |
| `REQUIRE_REDEEMER_RESTRICTION` | Require the delegation to be locked to your relayer. |
| `SIMULATE_BEFORE_SEND` | `eth_call` before broadcasting so reverts never cost gas. |
| `RATE_LIMIT_*` | Per-IP request budget. |

## Metadata integrity and key rotation

The registry commits the keccak256 of your published metadata and the curator's approval is pinned to
that hash. Publishing different content, or rotating your relayer/payout key, sends a VERIFIED sponsor back
to PENDING until the curator re-verifies (user funds stay refundable meanwhile). Re-publishing identical
bytes at a new URL does not. Rotate keys with the payout key: `SPONSOR_ADMIN_PRIVATE_KEY=0x… npm run
sponsor:rotate -- relayer 0xNewRelayer`. See `docs/audit/AUDIT-REPORT.md` (M-05, L-04).

## Defining your plans

Edit `PLANS` in [`src/sponsor/register.ts`](src/sponsor/register.ts) (per-txn, bulk, or subscription),
then `npm run sponsor:list`. Preview the generated metadata + `listPlan` args without sending txns with:

```bash
npm run listing:gen
```

## API

### `GET /live`
Process liveness only (used by the container healthcheck). Always `200 {ok:true}` while the node runs.

### `GET /health`
Readiness: an RPC provider answers **and** the relayer can pay for sponsored work. Returns relayer address, sponsorId,
current block, relayer balance, each RPC provider's status (host only, never the URL), transactions in flight and current
load. Answers `503` (with `problems`) when the relayer balance is below `MIN_RELAYER_BALANCE_WEI`, no provider is
reachable, or the node is restarting, so wallets show the sponsor as down and offer a self-paid send instead of making
the user wait. Rate-limited.

### `POST /relay`
```jsonc
{
  "subscriptionId": "1",
  "delegations": [ /* leaf->root, signed by the user's 7702 account */ ],
  "mode": "0x0100…00",          // optional, defaults to single-batch
  "executionCallData": "0x…",   // ERC-7579 Execution[]
  "authorization": { /* EIP-7702 tuple, first use only */ }
}
```
Responses: `200 {ok,redeemTx,gasUsed}` · `400` bad body · `422` validation/preflight reject ·
`502` on-chain revert · `429` rate-limited · `409` the same request, or another for the same subscription, is already being processed · `503` the sponsor cannot take it right now (busy: `Retry-After`; low relayer balance; restarting; or fees above
`MAX_FEE_PER_GAS_GWEI`) · `504 {ok:false,pending:true,redeemTx}` the transaction was sent but not confirmed within
`RECEIPT_WAIT_MS` — it is on its way (the node replaces it with a higher fee if it gets stuck), so treat it as pending,
not failed. `/subscribe` and `/topup` answer the same way.

A request is answered **once**: a wallet that gave up waiting and sends the same signed delegation again gets the original
answer back (header `x-idempotent-replay: true`, same hash) instead of a second redemption. Only successes and 504-pending
answers are remembered; a rejection can be retried once the problem is fixed.

What the node checks before spending any gas on a request: the delegation pins the batch, one use, the redeemer and a
deadline; the batch is within `MAX_BATCH_CALLS` / `MAX_BATCH_CALLDATA_BYTES` (and `ALLOWED_TARGETS`); the subscription
exists, has escrow, has not ended and belongs to this sponsor; for `/subscribe` and `/topup` the user holds and has
approved the amount (and for `/topup` is the subscription's owner); a first-use EIP-7702 authorization names this chain
and our delegator implementation, was signed by the delegator and carries the account's current nonce; and the
redemption is **simulated, including a first-use upgrade** (state override of the account's code), with the estimate
(+25%) fixed as the transaction's gas limit and refused above `MAX_GAS_UNITS`.

### `POST /subscribe`
Bootstraps a new subscription for a user with **zero prior on-chain history** — no `subscriptionId`
exists yet, so unlike `/relay` there's nothing to check funds against. Instead the execution batch
itself is strictly validated: it must be exactly `[subscribe(planId, amount)]` or
`[paymentToken.approve(registry, amount), subscribe(planId, amount)]`, targeting one of *this*
sponsor's active plans, with `amount` covering the plan's price for Bulk/Subscription models. Any
other shape is rejected — this endpoint does not sponsor arbitrary batches.

```jsonc
{
  "delegations": [ /* leaf->root, signed by the user's 7702 account */ ],
  "executionCallData": "0x…",   // [subscribe] or [approve, subscribe]
  "authorization": { /* EIP-7702 tuple, first use only */ }
}
```
Responses: `200 {ok,redeemTx,subscriptionId,planId,gasUsed}` · `400` bad body ·
`422` validation/preflight reject (e.g. `"amount 0 is below plan price 10000000"`) ·
`502` on-chain revert · `429` rate-limited.

### `POST /topup`
Adds escrow to an **existing** subscription — still 0 native balance for the caller, sponsor pays gas.
The `subscriptionId` is decoded from the batch's `topUp()` call, and its owning plan is looked up
on-chain (never trusted from the request body). The batch must be exactly `[topUp(subscriptionId, amount)]`
or `[paymentToken.approve(registry, amount), topUp(subscriptionId, amount)]`, for a subscription whose
plan belongs to this sponsor and is active. `amount` must be `> 0`.

```jsonc
{
  "delegations": [ /* leaf->root, signed by the user's 7702 account */ ],
  "executionCallData": "0x…"   // [topUp] or [approve, topUp]
}
```
Responses: `200 {ok,redeemTx,subscriptionId,amount,gasUsed}` · `400` bad body ·
`422` validation/preflight reject (e.g. `"amount must be greater than 0"`) ·
`502` on-chain revert · `429` rate-limited.

## Sponsor dashboard (`/admin`)

A built-in, token-protected dashboard to watch your node. Set a token and open it in a browser:

```bash
# in .env
DASHBOARD_TOKEN=choose-a-long-random-secret
```
Then visit **`http://localhost:8787/admin/`** and paste the token. It shows:

- **On-chain:** verification status (UNVERIFIED/PENDING/VERIFIED/REVOKED), relayer native balance,
  claimable earnings (USDC by default — set `DASHBOARD_EARNINGS_TOKEN`).
- **Counters:** total relayed, success rate, rejected/reverted, total gas spent, uptime.
- **Relay log:** the last 500 requests (time, outcome, subscription, delegator, redeem tx, gas, reason),
  filterable by outcome. Auto-refreshes every 5s.

Auth model: the HTML page is public (it only contains a token field); the **data** endpoints
(`GET /admin/stats`, `GET /admin/logs`) require `Authorization: Bearer <DASHBOARD_TOKEN>`. If
`DASHBOARD_TOKEN` is unset the dashboard **fails closed** (503) so stats are never exposed by accident.
Telemetry is in-memory (resets on restart); persist it to Redis/Postgres for multi-instance or history.

## Docker

```bash
docker build -t feemarket-sponsor .
docker run --env-file .env -p 8787:8787 feemarket-sponsor
```

For HTTPS in one step use `docker compose up -d --build` (Caddy in front; set `PUBLIC_DOMAIN` in `.env`).

## Operating notes

- **Nonce safety:** sends are serialized with a local nonce that resyncs on error
  ([`src/lib/clients.ts`](src/lib/clients.ts)). For multiple instances behind a load balancer, give
  each its own relayer key or move nonce tracking to shared state.
- **Profitability:** set `MAX_GAS_WEI` from your fee math so volatile gas can't make a redemption
  unprofitable. Cross-asset (gas in native vs. fee in USDC) pricing needs an oracle — out of scope here.
- **Keys:** use a dedicated hot key with a limited balance; top it up from cold storage.
