# fee.market — Sponsor Relayer

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Sponsor-side node for [fee.market](https://fee.market): validates user EIP-7702 / ERC-7710 delegations, **pays gas**, and broadcasts type-4 redemptions. You earn the plan fee; you never custody user funds — on-chain caveat enforcers bound every redemption.

```
wallet ──POST /relay──▶  your node ──▶ redeemDelegations (type-4, you pay gas)
                         validate · simulate · broadcast · chargeUsage
```

Full command reference: **[COMMANDS.md](COMMANDS.md)**.

## Setup in one command

On a fresh Ubuntu VPS, as root:

```bash
git clone https://github.com/fee-market/relayer.git && cd relayer
sudo bash scripts/vps/setup.sh
```

If the server is already prepared, run it as the node user instead: `npm run sponsor:setup`.

**Cloned as root?** That's expected. The root part copies the repo to `/home/<node user>/relayer`, owned by that user, and continues there. If the root clone already holds a `.env`, `sponsor.plans.json`, or `secrets/`, they're moved over. From then on the node runs only from the node user's copy (never as root), and the `/root` clone can be deleted. If an older systemd unit still points at the root clone, `sponsor:ensure-running` re-points it automatically. Later commands run as that user: `sudo -iu sponsor`, then `cd ~/relayer`.

It walks through everything in order, and you can re-run it at any point because it picks up where it left off:

1. Server hardening, Docker, and Node LTS (root part, via `prepare.sh`), then it switches to the node user.
2. Installs packages and builds the node.
3. Writes `.env` (domain, payout address, RPC, thirdweb key).
4. Shows the relayer address and waits until it's funded.
5. Asks how wallets reach the node (Caddy/Docker, nginx, Apache, or Cloudflare Tunnel).
6. Brings up public HTTPS, keeps the node running in the background, and checks the URL. If the check fails, it stays open with retry options.
7. Asks for your profile and plans (`sponsor.plans.json`).
8. Registers you on Polygon (shows a dry run first and asks you to confirm).
9. Shows your status. If you're PENDING, it prints the details to send the curator and can wait for you. Once you're VERIFIED, it lists your plans and you're live.

Run it again after the curator verifies you, or jump straight to that step with `npm run sponsor:setup -- --go-live`.

The steps below are the same flow, done by hand.

## Manual flow (URL first)

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

## Changing configuration later

Run these as the node user, in `~/relayer`. The node reads `.env` only when it starts. Plans and profile live on chain, so changing them doesn't need a restart.

| You want to change | Do this | Restart? | Verification |
|---|---|---|---|
| Limits, RPC, CORS, alerts, dashboard token (anything in `.env`) | Edit `.env`, then `npm run sponsor:ensure-running` | Yes, done by that command | Unchanged |
| Code version | `npm run update` | Yes, done by that command | Unchanged |
| Plans, name, region, description, website | `npm run sponsor:plans:configure`, then `npm run sponsor:onboard -- --reverify`. After the curator re-verifies, run `npm run sponsor:setup -- --go-live` to list the new plans. | No | **Back to PENDING** |
| Domain / public URL | `npm run sponsor:setup` and pick the new domain (HTTPS + node), then the plans row above for the new URL | Yes, done by setup | **Back to PENDING** |
| Proxy or certificate (nginx, Apache, Caddy, tunnel) | `npm run sponsor:setup` and answer no to "Publish the node with …?" | Yes, done by setup | Unchanged |
| Relayer key or payout wallet | `npm run sponsor:rotate` from the payout wallet (see [COMMANDS.md](COMMANDS.md)), then update `.env` and run `npm run sponsor:onboard -- --reverify` | Yes (`sponsor:ensure-running`) | **Back to PENDING** |

When in doubt:
- `npm run sponsor:setup` re-checks everything and only redoes what changed.
- `npm run sponsor:onboard -- --dry-run` shows whether a change would reset your verification, without sending anything.
- `npm run sponsor:check-endpoint` confirms the node still answers publicly.

## Common commands

| Script | Role |
|--------|------|
| `sponsor:setup` | **Everything, in order, resumable** (root: `sudo bash scripts/vps/setup.sh`) |
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
