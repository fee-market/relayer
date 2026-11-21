#!/usr/bin/env bash
# One-script setup for a stable public endpoint via a named Cloudflare Tunnel — the alternative to
# the Caddy+VPS path (docker-compose.yml/Caddyfile) when you'd rather keep running the node on your
# own machine with no VPS, no open ports, and no domain-pointing-at-an-IP step. Unlike
# `cloudflared tunnel --url` (ephemeral: a new random URL every restart, and it can be invalidated
# server-side), a named tunnel keeps the same hostname across restarts and reboots.
#
# Needs: a domain already added to a Cloudflare account (free tier is fine), and `cloudflared`
# installed (`brew install cloudflared` / https://pkg.cloudflare.com).
#
# Usage:
#   bash scripts/setup-tunnel.sh <subdomain.yourdomain.com> [tunnel-name]
#
# Idempotent: re-running reuses an existing tunnel/DNS route/service instead of erroring.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

HOSTNAME="${1:-}"
TUNNEL_NAME="${2:-feemarket-relay}"
CLOUDFLARED_DIR="$HOME/.cloudflared"
CONFIG_PATH="$CLOUDFLARED_DIR/config-${TUNNEL_NAME}.yml"

if [[ -z "$HOSTNAME" ]]; then
  echo "Usage: bash scripts/setup-tunnel.sh <subdomain.yourdomain.com> [tunnel-name]" >&2
  exit 1
fi

if ! command -v cloudflared >/dev/null 2>&1; then
  echo "cloudflared is not installed." >&2
  if [[ "$(uname)" == "Darwin" ]] && command -v brew >/dev/null 2>&1; then
    echo "Installing it with Homebrew..." >&2
    brew install cloudflared
  else
    echo "Install it first: https://pkg.cloudflare.com/ (or \`brew install cloudflared\` on macOS)." >&2
    exit 1
  fi
fi

PORT="$(grep -E '^PORT=' .env 2>/dev/null | cut -d= -f2)"
PORT="${PORT:-8787}"

if [[ ! -f "$CLOUDFLARED_DIR/cert.pem" ]]; then
  echo "▶ Not logged in to Cloudflare yet — this opens a browser to authorize cloudflared against your account."
  cloudflared tunnel login
fi

if cloudflared tunnel list 2>/dev/null | awk '{print $2}' | grep -qx "$TUNNEL_NAME"; then
  echo "✓ tunnel \"$TUNNEL_NAME\" already exists, reusing it"
  TUNNEL_ID="$(cloudflared tunnel list 2>/dev/null | awk -v n="$TUNNEL_NAME" '$2==n{print $1}')"
else
  echo "▶ creating tunnel \"$TUNNEL_NAME\""
  cloudflared tunnel create "$TUNNEL_NAME"
  TUNNEL_ID="$(cloudflared tunnel list 2>/dev/null | awk -v n="$TUNNEL_NAME" '$2==n{print $1}')"
fi

echo "▶ routing $HOSTNAME -> tunnel $TUNNEL_NAME ($TUNNEL_ID)"
cloudflared tunnel route dns "$TUNNEL_NAME" "$HOSTNAME" 2>&1 | grep -v "already configured" || true

cat > "$CONFIG_PATH" <<EOF
tunnel: $TUNNEL_ID
credentials-file: $CLOUDFLARED_DIR/$TUNNEL_ID.json

ingress:
  - hostname: $HOSTNAME
    service: http://localhost:$PORT
  - service: http_status:404
EOF
echo "✓ wrote $CONFIG_PATH"

OS="$(uname)"
if [[ "$OS" == "Darwin" ]]; then
  PLIST="$HOME/Library/LaunchAgents/com.feemarket.${TUNNEL_NAME}.plist"
  CLOUDFLARED_BIN="$(command -v cloudflared)"
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.feemarket.${TUNNEL_NAME}</string>
  <key>ProgramArguments</key>
  <array>
    <string>$CLOUDFLARED_BIN</string>
    <string>tunnel</string>
    <string>--config</string>
    <string>$CONFIG_PATH</string>
    <string>run</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$CLOUDFLARED_DIR/${TUNNEL_NAME}.log</string>
  <key>StandardErrorPath</key>
  <string>$CLOUDFLARED_DIR/${TUNNEL_NAME}.log</string>
</dict>
</plist>
EOF
  launchctl unload "$PLIST" 2>/dev/null || true
  launchctl load "$PLIST"
  echo "✓ installed + started launchd service $PLIST (survives reboots; logs: $CLOUDFLARED_DIR/${TUNNEL_NAME}.log)"
elif [[ "$OS" == "Linux" ]]; then
  UNIT_DIR="$HOME/.config/systemd/user"
  mkdir -p "$UNIT_DIR"
  UNIT="$UNIT_DIR/${TUNNEL_NAME}.service"
  cat > "$UNIT" <<EOF
[Unit]
Description=Cloudflare Tunnel ($TUNNEL_NAME)
After=network.target

[Service]
ExecStart=$(command -v cloudflared) tunnel --config $CONFIG_PATH run
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable --now "${TUNNEL_NAME}.service"
  echo "✓ installed + started systemd user service ${TUNNEL_NAME}.service (enable linger with \`loginctl enable-linger \$USER\` so it survives logout)"
else
  echo "Unrecognized OS ($OS) — run it in the foreground instead: cloudflared tunnel --config $CONFIG_PATH run" >&2
fi

echo "▶ waiting for https://$HOSTNAME/health ..."
for _ in $(seq 1 15); do
  if curl -sS -o /dev/null -w '' --max-time 3 "https://$HOSTNAME/health" 2>/dev/null; then
    echo "✓ https://$HOSTNAME/health is reachable"
    break
  fi
  sleep 2
done

node -e "
const fs = require('fs');
const p = '.env';
let t = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
const set = (key, value) => {
  const re = new RegExp('^' + key + '=.*\$', 'm');
  t = re.test(t) ? t.replace(re, key + '=' + value) : t.trimEnd() + '\n' + key + '=' + value + '\n';
};
set('PUBLIC_RELAYER_URL', 'https://$HOSTNAME/relay');
set('PUBLIC_DOMAIN', '$HOSTNAME');
// Every request arrives from cloudflared, so without this all users share ONE per-IP rate-limit bucket.
set('CLIENT_IP_HEADER', 'cf-connecting-ip');
fs.writeFileSync(p, t, { mode: 0o600 });
console.log('✓ set PUBLIC_RELAYER_URL=https://$HOSTNAME/relay and CLIENT_IP_HEADER=cf-connecting-ip in .env');
"

echo ""
echo "Done. Next: \`npm run sponsor:onboard\` (publishes metadata with this URL), then ask your curator to verify you."
