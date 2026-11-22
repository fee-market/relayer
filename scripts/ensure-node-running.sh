#!/usr/bin/env bash
# Ensure the sponsor node is running in the background so the curator can reach it.
#
#   bash scripts/ensure-node-running.sh
#   npm run sponsor:ensure-running
#
# - PROXY_KIND=caddy (or unset with docker): docker compose up -d --build
# - nginx / apache / bare: systemd unit feemarket-relayer (installs if missing)
# Falls back to nohup only when systemd cannot be installed without a password.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# shellcheck source=vps/lib.sh
. "$ROOT/scripts/vps/lib.sh"

PROXY=$(env_get "$ENV_FILE" PROXY_KIND)
PROXY=$(printf '%s' "${PROXY:-}" | tr '[:upper:]' '[:lower:]')
PORT=$(env_get "$ENV_FILE" PORT)
PORT=${PORT:-8787}
HOST=$(env_get "$ENV_FILE" HOST)
HOST=${HOST:-127.0.0.1}
DOMAIN=$(env_get "$ENV_FILE" PUBLIC_DOMAIN)

section "Ensure node is running (for curator / wallets)"

live_ok() {
  local code
  code=$(http_code "http://127.0.0.1:${PORT}/live")
  [ "$code" = 200 ]
}

wait_live() {
  local i=0
  printf ' Waiting for http://127.0.0.1:%s/live' "$PORT"
  while [ $i -lt 30 ]; do
    if live_ok; then
      printf '\n'
      ok "Node is up on ${HOST}:${PORT} (pid via systemd or docker)"
      return 0
    fi
    printf '.'
    sleep 1
    i=$((i + 1))
  done
  printf '\n'
  fail "Node did not answer /live on :$PORT" "journalctl -u feemarket-relayer -n 50   or   docker compose logs relayer"
  return 1
}

run_as_root() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  elif have sudo; then
    sudo "$@"
  else
    return 1
  fi
}

start_docker() {
  have docker || die "Docker required for Caddy mode"
  docker compose version >/dev/null 2>&1 || die "Docker Compose plugin required"
  note "Starting via Docker Compose (restart: unless-stopped)…"
  docker compose up -d --build
  wait_live
  if [ -n "$DOMAIN" ]; then
    note "Public checks: npm run sponsor:check-endpoint -- $DOMAIN"
  fi
}

install_and_start_systemd() {
  local owner
  owner=$(file_owner "$ROOT")
  owner=${owner:-$(id -un)}

  note "Building…"
  npm run build

  env_set "$ENV_FILE" HOST "$HOST"
  env_set "$ENV_FILE" PORT "$PORT"

  local unit_dir unit_user
  unit_dir=$(systemctl show -p WorkingDirectory --value feemarket-relayer.service 2>/dev/null || true)
  unit_user=$(systemctl show -p User --value feemarket-relayer.service 2>/dev/null || true)
  if systemctl list-unit-files feemarket-relayer.service 2>/dev/null | grep -q feemarket-relayer &&
    [ "$unit_dir" = "$ROOT" ] && [ "$unit_user" = "$owner" ]; then
    ok "systemd unit feemarket-relayer already installed"
  else
    if [ -n "$unit_dir" ] && [ "$unit_dir" != "$ROOT" ]; then
      warn "feemarket-relayer.service runs ${unit_user:-?} from $unit_dir" "Re-pointing it at $ROOT as $owner"
    fi
    note "Installing systemd unit (survives logout + reboot)…"
    if ! run_as_root bash "$ROOT/scripts/vps/install-relayer-service.sh" --user "$owner" --dir "$ROOT"; then
      return 1
    fi
  fi

  if ! run_as_root systemctl restart feemarket-relayer.service; then
    return 1
  fi
  run_as_root systemctl enable feemarket-relayer.service >/dev/null 2>&1 || true
  ok "feemarket-relayer.service active"
  wait_live
  if [ -n "$DOMAIN" ]; then
    note "Public checks: npm run sponsor:check-endpoint -- $DOMAIN"
  fi
  return 0
}

start_nohup_fallback() {
  warn "Could not install/start systemd — using nohup fallback (not reboot-safe)"
  note "Fix later: sudo bash scripts/vps/install-relayer-service.sh --start"
  npm run build
  mkdir -p data
  if [ -f data/relayer.pid ] && kill -0 "$(cat data/relayer.pid)" 2>/dev/null; then
    ok "Already running (pid $(cat data/relayer.pid))"
  else
    nohup env HOST="$HOST" PORT="$PORT" node dist/index.js >>data/relayer.out 2>&1 &
    echo $! >data/relayer.pid
    ok "Started pid $(cat data/relayer.pid) — logs: data/relayer.out"
  fi
  wait_live
}

# Decide mode
case "$PROXY" in
  nginx | apache | bare | tunnel)
    if install_and_start_systemd; then
      exit 0
    fi
    start_nohup_fallback
    exit 0
    ;;
  caddy | docker | "")
    if have docker && docker compose version >/dev/null 2>&1 && [ -f "$ROOT/docker-compose.yml" ]; then
      # Prefer docker when compose file exists and PROXY is caddy/empty
      if [ -z "$PROXY" ] || [ "$PROXY" = caddy ] || [ "$PROXY" = docker ]; then
        start_docker
        exit 0
      fi
    fi
    # No docker — host systemd
    if install_and_start_systemd; then
      exit 0
    fi
    start_nohup_fallback
    exit 0
    ;;
  *)
    warn "Unknown PROXY_KIND=$PROXY — trying systemd then docker"
    if install_and_start_systemd 2>/dev/null; then exit 0; fi
    if have docker; then start_docker; exit 0; fi
    start_nohup_fallback
    ;;
esac
