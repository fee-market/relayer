# fee.market — Sponsor Relayer

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Sponsor-side node for [fee.market](https://fee.market): validates user EIP-7702 / ERC-7710 delegations, **pays gas**, and broadcasts type-4 redemptions. You earn the plan fee; you never custody user funds — on-chain caveat enforcers bound every redemption.

```
wallet ──POST /relay──▶  your node ──▶ redeemDelegations (type-4, you pay gas)
                         validate · simulate · broadcast · chargeUsage
```

## Quick start

```bash
git clone https://github.com/fee-market/relayer.git && cd relayer
npm run setup
cp .env.example .env          # or: npm run sponsor:init
npm run sponsor:plans:configure
npm run sponsor:onboard       # register, publish metadata (re-runnable)
# ask the marketplace curator to verify you
npm run sponsor:go            # list plans + start the node
```

Dev: `npm run dev` then `curl localhost:8787/health`.

### VPS / tunnel

| Path | Command |
|------|---------|
| Ubuntu VPS (full guided) | `sudo bash scripts/vps/prepare.sh` then `npm run sponsor:vps` |
| Plans + HTTPS on this box | `npm run sponsor:plans:configure` (writes plans, syncs `.env`, can start **Caddy** via Docker) |
| HTTPS only | `npm run sponsor:serve` (Caddy + relayer; not Apache/nginx) |
| Cloudflare Tunnel | `bash scripts/setup-tunnel.sh relay.yourdomain.com` |

### Updating a live node

Do **not** run bare `git pull` on the server — `npm install` often dirties `package-lock.json` and blocks the merge. Use:

```bash
npm run update
# or: bash scripts/update.sh
```

That resets regenerable lockfile noise, `git pull --ff-only`, runs `npm ci`, then `docker compose up -d --build`. Your `.env`, `sponsor.plans.json`, `data/`, and `secrets/` are left alone. If you edited tracked source on the box, the script stops; pass `--force` only if you mean to discard those edits.

## Configuration

Copy [`.env.example`](.env.example) — every variable is documented there. Minimum to run:

| Var | Purpose |
|-----|---------|
| `RPC_URL` | Paid Polygon RPC preferred |
| `RELAYER_PRIVATE_KEY` | Hot key that pays gas (**fund it**) |
| `FEE_MARKET_REGISTRY` + framework addresses | Defaults for Polygon are in `.env.example` |
| `SPONSOR_ID` | Set by `sponsor:onboard` |
| `DASHBOARD_TOKEN` | Optional; unlocks `/admin` |

## Commands

| Script | What it does |
|--------|----------------|
| `sponsor:init` | Write `.env`, generate relayer key |
| `sponsor:plans:configure` | Profile + plans → `sponsor.plans.json`; syncs public URL; can start Caddy |
| `sponsor:serve` | Start/rebuild public HTTPS (Caddy + relayer via Docker Compose) |
| `sponsor:vps` | Full guided VPS setup (`scripts/vps/setup.sh`) |
| `sponsor:onboard` | Register / reuse sponsor, publish metadata |
| `sponsor:go` | List plans and start the node |
| `sponsor:doctor` | Read-only readiness check |
| `sponsor:status` / `withdraw` / `rotate` / `accept` / `relayers` | Ops & key management |
| `listing:gen` | Preview metadata + `listPlan` args (no txs) |

## API

| Endpoint | Role |
|----------|------|
| `GET /live` | Process up (container healthcheck) |
| `GET /health` | Ready to sponsor (RPC + balance); `503` when not |
| `POST /relay` | Redeem a sponsored user batch |
| `POST /subscribe` | Bootstrap subscription (`[subscribe]` or `[approve, subscribe]`) |
| `POST /topup` | Add escrow (`[topUp]` or `[approve, topUp]`) |
| `GET /admin/` | Token-gated dashboard (`DASHBOARD_TOKEN`) |

**`POST /relay` body (sketch):**

```jsonc
{
  "subscriptionId": "1",
  "delegations": [/* leaf→root, user-signed */],
  "executionCallData": "0x…",
  "authorization": {/* EIP-7702, first use only */}
}
```

Common responses: `200` success · `422` validation/preflight · `429` rate limit · `503` busy/low balance · `504` sent, not yet confirmed (idempotent on retry).

## Ops notes

- Keep the relayer key hot with a **limited** balance; top up from cold storage.
- Cap spend with `MAX_GAS_WEI` / `MAX_GAS_UNITS`; optional profit guard in `.env.example`.
- One relayer key per process — do not share a key across load-balanced instances.
- Publishing new metadata or rotating keys returns a VERIFIED sponsor to PENDING until re-verified.
