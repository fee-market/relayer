# fee.market — Sponsor Relayer

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Sponsor-side node for [fee.market](https://fee.market): validates user EIP-7702 / ERC-7710 delegations, **pays gas**, and broadcasts type-4 redemptions. You earn the plan fee; you never custody user funds — on-chain caveat enforcers bound every redemption.

```
wallet ──POST /relay──▶  your node ──▶ redeemDelegations (type-4, you pay gas)
                         validate · simulate · broadcast · chargeUsage
```

Full command reference: **[COMMANDS.md](COMMANDS.md)**.

## Go-live flow (URL first)

Bring up a **reachable HTTPS endpoint**, then configure plans and register. Profile name/region live in `sponsor.plans.json`, not in `.env`.

### 1. Machine + secrets

```bash
git clone https://github.com/fee-market/relayer.git && cd relayer
# VPS (once, as root): sudo bash scripts/vps/prepare.sh
npm run setup
npm run sponsor:init          # .env: relayer key, payout, RPC, IPFS key
# fund the printed relayer address with POL
```

### 2. Public URL (before plans / onboard)

Point DNS at this host, then terminate HTTPS and keep the process running:

```bash
# Caddy + Docker
npm run sponsor:serve

# or nginx / Apache (Certbot, import PEM, self-signed, or Cloudflare Flexible)
sudo bash scripts/vps/setup-proxy.sh apache --domain node.example.com
npm run sponsor:ensure-running

npm run sponsor:check-endpoint   # local + DNS + HTTPS; copyable Cloudflare/.env values
```

Tunnel alternative: `bash scripts/setup-tunnel.sh node.example.com`.

This sets `PUBLIC_DOMAIN` / `PUBLIC_RELAYER_URL` (no `/relay` path). The node should answer `https://your.domain/live` and `/health` while you wait for the curator.

### 3. Plans + on-chain registration

```bash
npm run sponsor:plans:configure   # uses the URL from .env; writes sponsor.plans.json
npm run sponsor:onboard           # register + metadata → PENDING; keeps node running
npm run sponsor:status            # PENDING | VERIFIED | …
# ask the marketplace curator to verify you
npm run sponsor:go                # after VERIFIED: listPlan + start
```

**Verification:** the HTTP process does **not** require VERIFIED — keep it up so the curator can probe you. On-chain `listPlan` (and `sponsor:go`) **does** require VERIFIED.

### Local dev

```bash
npm run setup && npm run sponsor:init
npm run dev
curl localhost:8787/health
```

### Updating a live node

```bash
npm run update    # not bare git pull
```

Resets regenerable lockfile noise, `git pull --ff-only`, `npm ci`, then restarts Docker Compose or `feemarket-relayer.service`. Leaves `.env`, `sponsor.plans.json`, `data/`, and `secrets/` alone.

## Configuration

Copy [`.env.example`](.env.example). Minimum:

| Var | Purpose |
|-----|---------|
| `RPC_URL` | Paid Polygon RPC preferred |
| `RELAYER_PRIVATE_KEY` | Hot key that pays gas (**fund it**) |
| Framework addresses | Defaults for Polygon in `.env.example` |
| `PUBLIC_RELAYER_URL` / `PUBLIC_DOMAIN` | Set after HTTPS works |
| `SPONSOR_ID` | Written by `sponsor:onboard` |
| `SPONSOR_PAYOUT_ADDRESS` | Cold wallet for earnings |
| `DASHBOARD_TOKEN` | Optional `/admin` |

**Not in `.env`:** sponsor name, region, description, website, support URL, plan terms → `sponsor.plans.json` via `sponsor:plans:configure`.

## Common commands

| Script | Role |
|--------|------|
| `sponsor:init` | Write `.env` + relayer key |
| `sponsor:serve` / `ensure-running` | Public HTTPS + background node |
| `sponsor:check-endpoint` | Validate public URL |
| `sponsor:plans:configure` | Profile + plans → JSON |
| `sponsor:onboard` | Register / metadata / keep node up |
| `sponsor:status` / `doctor` | Status & readiness |
| `sponsor:go` | After VERIFIED: list plans + start |

See [COMMANDS.md](COMMANDS.md) for the full list (proxy, rotate, withdraw, tests, …).

## API

| Endpoint | Role |
|----------|------|
| `GET /live` | Process up |
| `GET /health` | Ready to sponsor (RPC + balance); `503` when not |
| `POST /relay` | Redeem a sponsored user batch |
| `POST /subscribe` | Bootstrap subscription |
| `POST /topup` | Add escrow |
| `GET /admin/` | Token-gated dashboard |

Common responses: `200` · `422` validation · `429` rate limit · `503` busy/low balance · `504` sent, not yet confirmed.

## Ops notes

- Keep the relayer key hot with a **limited** balance; top up from cold storage.
- Cap spend with `MAX_GAS_WEI` / `MAX_GAS_UNITS`.
- One relayer key per process.
- Publishing new metadata or rotating keys returns a VERIFIED sponsor to **PENDING** until re-verified.
