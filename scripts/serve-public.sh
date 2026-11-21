#!/usr/bin/env bash
# Start (or rebuild) the public HTTPS endpoint: Caddy + relayer via Docker Compose.
# Uses PUBLIC_DOMAIN from .env for the Let's Encrypt certificate. No Apache/nginx.
#
#   bash scripts/serve-public.sh
#   npm run sponsor:serve
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

[ -f .env ] || die "No .env — run npm run sponsor:init or bash scripts/vps/setup.sh first"
command -v docker >/dev/null || die "Docker is required (prepare.sh installs it on Ubuntu)"
docker compose version >/dev/null 2>&1 || die "Docker Compose plugin is required"

# shellcheck source=vps/lib.sh
. "$ROOT/scripts/vps/lib.sh"
DOMAIN=$(env_get "$ENV_FILE" PUBLIC_DOMAIN)
URL=$(env_get "$ENV_FILE" PUBLIC_RELAYER_URL)
[ -n "$DOMAIN" ] || die "PUBLIC_DOMAIN is empty in .env (needed for the Caddy certificate)"

if ! url_matches_domain "${URL:-}" "$DOMAIN"; then
  want=$(public_relay_url "$DOMAIN")
  warn "PUBLIC_RELAYER_URL (${URL:-empty}) does not match PUBLIC_DOMAIN — setting $want"
  env_set "$ENV_FILE" PUBLIC_RELAYER_URL "$want"
  URL=$want
fi
env_set "$ENV_FILE" TRUST_PROXY 1

note "Domain: $DOMAIN"
note "Public URL: $URL  (wallets call $URL/relay, $URL/health, …)"
note "Building and starting Caddy (HTTPS) + relayer…"

docker compose up -d --build

printf ' Waiting for https://%s/health' "$DOMAIN"
code=""
i=0
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
    warn "https://$DOMAIN/health not up yet (DNS or first certificate can take a minute)"
    note "Check: docker compose logs --tail 50 caddy"
    ;;
esac
ok "Serving via Caddy (not Apache/nginx). Logs: docker compose logs -f"
