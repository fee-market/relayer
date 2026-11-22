#!/usr/bin/env bash
# Install a systemd unit so the sponsor node stays up across logout/reboot.
#
#   sudo bash scripts/vps/install-relayer-service.sh
#   sudo bash scripts/vps/install-relayer-service.sh --user sponsor --dir /home/sponsor/relayer
#   sudo bash scripts/vps/install-relayer-service.sh --start
#
# Unit name: feemarket-relayer.service
set -euo pipefail
# shellcheck source=lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

NODE_USER=""
RELAY_DIR=""
DO_START=0

while [ $# -gt 0 ]; do
  case "$1" in
    --user) NODE_USER=${2:-}; shift 2 || die "--user needs a value" ;;
    --dir) RELAY_DIR=${2:-}; shift 2 || die "--dir needs a value" ;;
    --start) DO_START=1; shift ;;
    -h | --help)
      sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) die "Unknown option: $1" ;;
  esac
done

[ "$(id -u)" -eq 0 ] || die "Run with sudo: sudo bash scripts/vps/install-relayer-service.sh"

if [ -z "$RELAY_DIR" ]; then
  RELAY_DIR=$RELAYER_DIR
fi
[ -d "$RELAY_DIR" ] || die "Relayer directory not found: $RELAY_DIR"
[ -f "$RELAY_DIR/package.json" ] || die "Not a relayer checkout: $RELAY_DIR"

if [ -z "$NODE_USER" ]; then
  NODE_USER=$(file_owner "$RELAY_DIR")
fi
[ -n "$NODE_USER" ] || die "Could not detect file owner; pass --user"
id "$NODE_USER" >/dev/null 2>&1 || die "User not found: $NODE_USER"

NODE_BIN=$(command -v node || true)
[ -n "$NODE_BIN" ] || die "node not on PATH for root — install Node.js LTS first (prepare.sh)"
# Prefer the same binary the node user would see
if [ -x "/usr/bin/node" ]; then NODE_BIN=/usr/bin/node; fi

PORT=$(env_get "$RELAY_DIR/.env" PORT)
PORT=${PORT:-8787}
HOST=$(env_get "$RELAY_DIR/.env" HOST)
HOST=${HOST:-127.0.0.1}

UNIT=/etc/systemd/system/feemarket-relayer.service
section "Install feemarket-relayer.service"
note "user=$NODE_USER  dir=$RELAY_DIR  exec=$NODE_BIN  bind=${HOST}:${PORT}"

cat >"$UNIT" <<EOF
# Managed by scripts/vps/install-relayer-service.sh — fee.market sponsor relayer
[Unit]
Description=fee.market sponsor relayer
Documentation=https://github.com/fee-market/relayer
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$NODE_USER
Group=$NODE_USER
WorkingDirectory=$RELAY_DIR
EnvironmentFile=-$RELAY_DIR/.env
Environment=HOST=$HOST
Environment=PORT=$PORT
# Build artifacts must exist (npm run build). Restart on crash.
ExecStartPre=/bin/bash -c 'test -f $RELAY_DIR/dist/index.js || { echo "missing dist/ — run: cd $RELAY_DIR && npm run build" >&2; exit 1; }'
ExecStart=$NODE_BIN dist/index.js
Restart=always
RestartSec=5
TimeoutStopSec=35
KillSignal=SIGTERM
# Hardening (node still needs outbound RPC / HTTPS)
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=read-only
ReadWritePaths=$RELAY_DIR/data $RELAY_DIR/secrets

[Install]
WantedBy=multi-user.target
EOF

# data/secrets must be writable by the service user
install -d -m 0750 -o "$NODE_USER" -g "$NODE_USER" "$RELAY_DIR/data" "$RELAY_DIR/secrets" 2>/dev/null || true
chown -R "$NODE_USER:$NODE_USER" "$RELAY_DIR/data" "$RELAY_DIR/secrets" 2>/dev/null || true

systemctl daemon-reload
systemctl enable feemarket-relayer.service
ok "Installed and enabled $UNIT"

if [ "$DO_START" -eq 1 ]; then
  systemctl restart feemarket-relayer.service
  ok "Started feemarket-relayer (systemctl status feemarket-relayer)"
else
  note "Start with: sudo systemctl start feemarket-relayer"
fi

note "Logs: journalctl -u feemarket-relayer -f"
note "Stop:  sudo systemctl stop feemarket-relayer"
