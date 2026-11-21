#!/usr/bin/env bash
# Start (or rebuild) the public HTTPS endpoint for this sponsor node.
#
#   npm run sponsor:serve
#   bash scripts/serve-public.sh              # uses PROXY_KIND from .env (caddy|nginx|apache)
#   bash scripts/serve-public.sh --proxy nginx
#
# - caddy (default): Docker Compose (Caddy + relayer)
# - nginx | apache: host reverse proxy (setup via scripts/vps/setup-proxy.sh) + local Node on 127.0.0.1
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [ -t 1 ]; then
  G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; D=$'\033[2m'; N=$'\033[0m'
else
  G=""; Y=""; R=""; D=""; N=""
fi
ok() { printf ' %s✓%s %s\n' "$G" "$N" "$1"; }
warn() { printf ' %s!%s %s\n' "$Y" "$N" "$1"; }
die() { printf '%s✗ %s%s\n' "$R" "$1" "$N" >&2; exit 1; }
note() { printf '   %s%s%s\n' "$D" "$1" "$N"; }

PROXY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --proxy) PROXY=${2:-}; shift 2 || die "--proxy needs caddy|nginx|apache" ;;
    -h | --help)
      sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) die "Unknown option: $1" ;;
  esac
done

[ -f .env ] || die "No .env — run npm run sponsor:init or bash scripts/vps/setup.sh first"

# shellcheck source=vps/lib.sh
. "$ROOT/scripts/vps/lib.sh"

DOMAIN=$(env_get "$ENV_FILE" PUBLIC_DOMAIN)
URL=$(env_get "$ENV_FILE" PUBLIC_RELAYER_URL)
[ -n "$DOMAIN" ] || die "PUBLIC_DOMAIN is empty in .env"

if [ -z "$PROXY" ]; then
  PROXY=$(env_get "$ENV_FILE" PROXY_KIND)
fi
PROXY=$(printf '%s' "${PROXY:-caddy}" | tr '[:upper:]' '[:lower:]')
case "$PROXY" in
  caddy | docker | "") PROXY=caddy ;;
  nginx | apache) ;;
  *) die "Unknown PROXY_KIND=$PROXY (use caddy, nginx, or apache)" ;;
esac

if ! url_matches_domain "${URL:-}" "$DOMAIN"; then
  want=$(public_relay_url "$DOMAIN")
  warn "PUBLIC_RELAYER_URL (${URL:-empty}) does not match PUBLIC_DOMAIN — setting $want"
  env_set "$ENV_FILE" PUBLIC_RELAYER_URL "$want"
  URL=$want
fi
env_set "$ENV_FILE" TRUST_PROXY 1
env_set "$ENV_FILE" PROXY_KIND "$PROXY"

wait_health() {
  local code="" i=0
  printf ' Waiting for https://%s/health' "$DOMAIN"
  while [ $i -lt 45 ]; do
    code=$(curl -s --max-time 6 -o /dev/null -w '%{http_code}' "https://$DOMAIN/health" 2>/dev/null || true)
    if [ "$code" = 200 ] || [ "$code" = 503 ]; then break; fi
    printf '.'
    sleep 4
    i=$((i + 1))
  done
  printf '\n'
  case "$code" in
    200) ok "https://$DOMAIN/health answers — node is ready" ;;
    503) warn "https://$DOMAIN/health answers but reports not ready (often low relayer balance)" ;;
    *)
      warn "https://$DOMAIN/health not up yet (DNS or certificate)"
      ;;
  esac
}

print_and_verify() {
  local tls proxy port
  tls=$(env_get "$ENV_FILE" TLS_MODE)
  proxy=$(env_get "$ENV_FILE" PROXY_KIND)
  port=$(env_get "$ENV_FILE" PORT)
  tls=${tls:-certbot}
  proxy=${proxy:-caddy}
  port=${port:-8787}
  print_copyable_settings "$DOMAIN" "$tls" "$proxy" "$port"
  note "Running endpoint validation…"
  verify_public_endpoint "$DOMAIN" "$port" || warn "Validation reported problems" "Fix using the copyable block, then: bash scripts/vps/check-endpoint.sh $DOMAIN"
}

note "Domain: $DOMAIN"
note "Public URL: $URL  (wallets call $URL/relay, $URL/health, …)"
note "Proxy: $PROXY"

if [ "$PROXY" = caddy ]; then
  command -v docker >/dev/null || die "Docker is required for Caddy mode (or: npm run sponsor:serve -- --proxy nginx)"
  docker compose version >/dev/null 2>&1 || die "Docker Compose plugin is required"
  note "Building and starting Caddy (HTTPS) + relayer…"
  docker compose up -d --build
  wait_health
  ok "Serving via Caddy. Logs: docker compose logs -f"
  print_and_verify
  exit 0
fi

# nginx / apache — node on localhost, proxy already (or still to be) installed
env_set "$ENV_FILE" HOST "127.0.0.1"
PORT=$(env_get "$ENV_FILE" PORT)
PORT=${PORT:-8787}
env_set "$ENV_FILE" PORT "$PORT"
env_set "$ENV_FILE" CLIENT_IP_HEADER "x-forwarded-for"

if ! command -v "$PROXY" >/dev/null 2>&1 && { [ "$PROXY" != apache ] || ! command -v apache2 >/dev/null 2>&1; }; then
  die "$PROXY is not installed. Run: sudo bash scripts/vps/setup-proxy.sh $PROXY --domain $DOMAIN"
fi

note "Building the node…"
npm run build

# Reload proxy in case vhost was just written
if [ "$PROXY" = nginx ]; then
  nginx -t 2>/dev/null && systemctl reload nginx 2>/dev/null || true
else
  apache2ctl configtest 2>/dev/null && systemctl reload apache2 2>/dev/null || true
fi

if command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet feemarket-relayer 2>/dev/null; then
  systemctl restart feemarket-relayer
  ok "Restarted feemarket-relayer.service"
else
  note "Start the node in the background (or under systemd/tmux):"
  note "  HOST=127.0.0.1 PORT=$PORT npm start"
  # Try a short-lived background start for health check if nothing listens yet
  if ! curl -sf --max-time 2 "http://127.0.0.1:$PORT/live" >/dev/null 2>&1; then
    note "No process on :$PORT yet — starting node in background for this check…"
    mkdir -p data
    nohup env HOST=127.0.0.1 PORT="$PORT" node dist/index.js >>data/relayer.out 2>&1 &
    echo $! >data/relayer.pid
    sleep 2
  fi
fi

wait_health
ok "Serving via $PROXY (Ubuntu packages stay security-patched via apt). Node on 127.0.0.1:$PORT"
print_and_verify
