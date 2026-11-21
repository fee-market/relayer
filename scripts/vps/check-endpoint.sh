#!/usr/bin/env bash
# Validate that the public sponsor node URL responds (local + DNS + HTTPS).
#
#   bash scripts/vps/check-endpoint.sh
#   bash scripts/vps/check-endpoint.sh node.fee.market
#   bash scripts/vps/check-endpoint.sh --domain node.fee.market --print-settings
set -euo pipefail
# shellcheck source=lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

DOMAIN=""
PRINT=0
PORT=""

while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN=${2:-}; shift 2 || die "--domain needs a value" ;;
    --port) PORT=${2:-}; shift 2 || die "--port needs a value" ;;
    --print-settings) PRINT=1; shift ;;
    -h | --help)
      sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    -*) die "Unknown option: $1" ;;
    *) DOMAIN=$1; shift ;;
  esac
done

cd "$RELAYER_DIR"
if [ -z "$DOMAIN" ]; then
  DOMAIN=$(env_get "$ENV_FILE" PUBLIC_DOMAIN)
fi
[ -n "$DOMAIN" ] || die "Pass a domain or set PUBLIC_DOMAIN in .env"
is_domain "$DOMAIN" || die "Not a domain name: $DOMAIN"

if [ -z "$PORT" ]; then
  PORT=$(env_get "$ENV_FILE" PORT)
fi
PORT=${PORT:-8787}

TLS_MODE=$(env_get "$ENV_FILE" TLS_MODE)
PROXY_KIND=$(env_get "$ENV_FILE" PROXY_KIND)
TLS_MODE=${TLS_MODE:-certbot}
PROXY_KIND=${PROXY_KIND:-caddy}

printf '%sfee.market: endpoint check%s\n' "$B" "$N"
note "domain=$DOMAIN  port=$PORT  proxy=${PROXY_KIND}  tls=${TLS_MODE}"

if [ "$PRINT" -eq 1 ]; then
  print_copyable_settings "$DOMAIN" "$TLS_MODE" "$PROXY_KIND" "$PORT"
fi

if verify_public_endpoint "$DOMAIN" "$PORT"; then
  printf '\n%sPublic node URL is responding.%s\n' "$G" "$N"
  if [ "$PRINT" -eq 0 ]; then
    note "Copyable Cloudflare/.env values: bash scripts/vps/check-endpoint.sh $DOMAIN --print-settings"
  fi
  exit 0
fi

printf '\n%sEndpoint check failed — see above.%s\n' "$R" "$N"
print_copyable_settings "$DOMAIN" "$TLS_MODE" "$PROXY_KIND" "$PORT"
exit 1
