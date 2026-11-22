# Sponsor commands and flow

How to bring up a fee.market sponsor node: get a **live public URL first**, then configure plans and onboard. Profile name / region / blurb live in `sponsor.plans.json`, not in `.env`.

---

## One command

```bash
sudo bash scripts/vps/setup.sh       # fresh Ubuntu VPS (prepares as root, continues as the node user)
npm run sponsor:setup                # node user, server already prepared
npm run sponsor:setup -- --go-live   # only the status / go-live step
```

It runs every step below in order, checks first whether each one is already done, and stays open with options when something fails (DNS, certificate, endpoint). After the curator verifies you, run it again and it lists your plans. `sponsor:vps` is the same command under its old name.

Running it again on a finished node is safe, and nothing is sent unless something actually changed:
- `.env`, your domain, and the relayer key are kept.
- A URL that already works is left alone.
- The node service is restarted only if the build or `.env` changed since it last started.
- Plans are kept unless you choose to edit them.
- Registration is skipped when your on-chain data matches.
- If you're VERIFIED and every plan is listed, it just confirms you're live.

Choosing a different publishing method (e.g. nginx → Caddy) shuts down the old one first. Re-running the HTTPS setup keeps a valid certificate instead of requesting a new one.

If you clone as root, the root part copies the repo to `/home/<node user>/relayer` and moves over any `.env`, `sponsor.plans.json`, or `secrets/` already in the root clone. Everything afterwards, including the systemd service, runs as the node user from that copy. Run later commands there (`sudo -iu sponsor`, then `cd ~/relayer`); the root clone can be deleted.

## The flow it runs (or do it by hand)

```text
1. Server + deps     prepare.sh / setup / Node LTS
2. Secrets           sponsor:init  →  .env (key, RPC, payout, IPFS key)
3. Public HTTPS      DNS A record → VPS
                     sponsor:serve  or  setup-proxy (nginx|apache) + ensure-running
                     sponsor:check-endpoint
4. Plans + profile   sponsor:plans:configure  (uses PUBLIC_RELAYER_URL; writes sponsor.plans.json)
5. On-chain          sponsor:onboard  → PENDING, starts/keeps background node
6. Wait              curator verifies; poll with sponsor:status / onboard
7. Go live           sponsor:go  → listPlan + (re)start
```

**Why URL before plans?** Metadata and the registry endpoint must advertise a real `https://…` that the curator can open (`/live`, `/health`). Configure DNS + TLS + the background process, then put that URL into plans and onboard.

**Dev-only (no public URL):** `npm run setup && npm run sponsor:init && npm run dev` then `curl localhost:8787/health`.

---

## Lifecycle commands

| Command | What it does |
|---------|----------------|
| `npm run setup` | `npm ci` — install deps (quiet). |
| `npm run sponsor:init` | Create `.env` (relayer key, payout, optional public URL / thirdweb). Does **not** set profile name. |
| `npm run sponsor:plans:configure` | Interactive `sponsor.plans.json`: public URL, name, region, optional description/website/support, plans. Syncs `PUBLIC_*` into `.env`. Can refresh HTTPS. |
| `npm run sponsor:onboard` | Register (or reuse), publish metadata, publish endpoint if needed; then **ensure the node is running** for the curator. Idempotent; re-run to see status. |
| `npm run sponsor:status` | Print on-chain status: `UNVERIFIED` / `PENDING` / `VERIFIED` / `REVOKED`. `-- --short` prints only the word. |
| `npm run sponsor:doctor` | Read-only readiness (RPC, balance, registry, config). |
| `npm run sponsor:go` | **After VERIFIED:** `listPlan` on-chain, then start node (Docker or foreground). `--no-start` = list only. `--dry-run` = print plan. |
| `npm run update` | Safe VPS upgrade (`git pull` + `npm ci` + restart Compose or systemd). Prefer over bare `git pull`. |

---

## Public endpoint / process

| Command | What it does |
|---------|----------------|
| `npm run sponsor:serve` | Public HTTPS from `PROXY_KIND`: Caddy+Docker, or nginx/apache + **systemd** `feemarket-relayer`. |
| `npm run sponsor:ensure-running` | Start/restart background node (Compose or systemd; nohup fallback). |
| `npm run sponsor:proxy` | `sudo` helper → `scripts/vps/setup-proxy.sh` (nginx\|apache, certbot / import / self-signed / CF Flexible). Installs TLS + starts `feemarket-relayer`. |
| `npm run sponsor:check-endpoint` | Local `/live`, DNS, public HTTPS; optional `--print-settings` for Cloudflare / `.env` copy-paste. |
| `npm run sponsor:setup` / `sponsor:vps` | The one-command setup above (`scripts/vps/setup.sh`). |
| `bash scripts/vps/prepare.sh` | Root part only: user, SSH, firewall, Docker/Node, copy repo to the node user. `setup.sh` runs it for you. |
| `bash scripts/vps/install-relayer-service.sh` | Root: install the `feemarket-relayer` systemd unit (used by proxy / ensure-running). |
| `bash scripts/setup-tunnel.sh <domain>` | Cloudflare Tunnel (+ optional user systemd unit). |

**Background process**

- **Caddy:** `docker compose up -d` (`restart: unless-stopped`).
- **nginx/apache:** `feemarket-relayer.service` (`Restart=always`). Logs: `journalctl -u feemarket-relayer -f`.

---

## On-chain / ops (usually after onboard)

| Command | What it does |
|---------|----------------|
| `npm run sponsor:register` | Low-level register (prefer `onboard`). |
| `npm run sponsor:list` | `listPlan` for plans in config (**needs VERIFIED**). |
| `npm run sponsor:metadata:upload` / `:set` / `:publish` | Pin + commit metadata (prefer `onboard`). |
| `npm run sponsor:endpoint` | Publish relay URL on-chain (payout key if not same as relayer). |
| `npm run sponsor:rotate` | Rotate relayer or payout (→ PENDING again). Needs `SPONSOR_ADMIN_PRIVATE_KEY` on the CLI. |
| `npm run sponsor:accept` | Accept pending payout role. |
| `npm run sponsor:withdraw` | Withdraw earnings (payout key). |
| `npm run sponsor:relayers` | Manage relayer set. |
| `npm run listing:gen` | Preview metadata / `listPlan` args (no txs). |
| `npm run key:encrypt` / `key:check` | Encrypted keystore helpers. |

CLI-only secrets (never put in `.env` on the server): `SPONSOR_ADMIN_PRIVATE_KEY`, `SPONSOR_NEW_PAYOUT_PRIVATE_KEY`, …

---

## Runtime

| Command | What it does |
|---------|----------------|
| `npm run build` | Compile to `dist/`. |
| `npm run start` | Foreground `node dist/index.js` (prefer systemd / Compose in production). |
| `npm run dev` | `tsx watch` local server. |

---

## Status while waiting for the curator

```bash
npm run sponsor:status
# or
npm run sponsor:onboard          # prints status; keeps node running if still PENDING
```

| Status | Meaning |
|--------|---------|
| `PENDING` | Metadata committed; waiting on curator. Keep `/health` green. |
| `VERIFIED` | Run `npm run sponsor:go` to list plans. |
| `REVOKED` | Curator must reinstate. |

Changing published metadata, relayer, or payout returns you to **PENDING**.

---

## What belongs where

| Data | Where |
|------|--------|
| Relayer key, RPC, payout, dashboard token, IPFS/Fil keys, gas/policy knobs | `.env` |
| `PUBLIC_DOMAIN`, `PUBLIC_RELAYER_URL`, `PROXY_KIND`, `TLS_MODE`, `HOST` | `.env` (after HTTPS is real) |
| Sponsor **name**, **region**, description, website, support URL, plan prices/caveats | `sponsor.plans.json` via `plans:configure` |
| `SPONSOR_ID`, `SPONSOR_METADATA_URI` | `.env`, written by onboard / publish |

Do **not** put `SPONSOR_NAME` / `SPONSOR_REGION` / description fields in `.env` — they are ignored once `sponsor.plans.json` exists.

---

## Tests / advanced (maintainers)

`test:*`, `e2e*`, `canary`, `chaos`, `alerts:sink`, `check:framework`, `typecheck` — see `package.json`. Not part of normal sponsor go-live.
