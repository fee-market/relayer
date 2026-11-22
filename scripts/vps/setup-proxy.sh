#!/usr/bin/env bash
# Install and configure nginx or Apache as the front for a bare Node relayer.
# Ubuntu packages (apt security updates) + optional TLS:
#
#   sudo bash scripts/vps/setup-proxy.sh nginx
#   sudo bash scripts/vps/setup-proxy.sh apache --domain node.fee.market
#   sudo bash scripts/vps/setup-proxy.sh nginx --tls certbot --email you@example.com
#   sudo bash scripts/vps/setup-proxy.sh nginx --tls cf-flexible
#   sudo bash scripts/vps/setup-proxy.sh nginx --tls selfsigned
#   sudo bash scripts/vps/setup-proxy.sh nginx --tls import --cert /path/fullchain.pem --key /path/privkey.pem
#
# TLS modes:
#   certbot       Let's Encrypt (use with Cloudflare "Full (strict)" or DNS-only)
#   import        Your own cert + key (files or paste PEM)
#   selfsigned    Generated openssl cert (Cloudflare "Full" — not Flexible)
#   cf-flexible   HTTP on origin only; Cloudflare terminates HTTPS (Flexible SSL)
#   none          HTTP only (dev / behind another TLS terminator)
#
# Node must listen on 127.0.0.1:8787 (HOST=127.0.0.1). Port 8787 stays closed in ufw.
set -euo pipefail
# shellcheck source=lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

KIND=""
DOMAIN=""
EMAIL=""
RELAYER_PORT=8787
TLS_MODE=""
CERT_FILE=""
KEY_FILE=""
CHAIN_FILE=""
ORIG_ARGS=("$@")

while [ $# -gt 0 ]; do
  case "$1" in
    nginx | apache) KIND=$1; shift ;;
    --domain) DOMAIN=${2:-}; shift 2 || die "--domain needs a value" ;;
    --email) EMAIL=${2:-}; shift 2 || die "--email needs a value" ;;
    --port) RELAYER_PORT=${2:-8787}; shift 2 || die "--port needs a value" ;;
    --tls) TLS_MODE=${2:-}; shift 2 || die "--tls needs certbot|import|selfsigned|cf-flexible|none" ;;
    --cert) CERT_FILE=${2:-}; shift 2 || die "--cert needs a path" ;;
    --key) KEY_FILE=${2:-}; shift 2 || die "--key needs a path" ;;
    --chain) CHAIN_FILE=${2:-}; shift 2 || die "--chain needs a path" ;;
    --skip-cert) TLS_MODE=none; shift ;;
    -h | --help)
      sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) die "Unknown argument: $1 (see --help)" ;;
  esac
done

[ "$(id -u)" -eq 0 ] || die "Run with sudo: sudo bash scripts/vps/setup-proxy.sh nginx|apache"
[ -n "$KIND" ] || die "Usage: sudo bash scripts/vps/setup-proxy.sh nginx|apache [options]"

require_tty

# Started from a root-owned clone (e.g. /root/relayer) while the node user has its own copy: configure that one.
if [ "$(file_owner "$RELAYER_DIR")" = root ] && [ -f /etc/feemarket/prepare.env ]; then
  T=$(env_get /etc/feemarket/prepare.env TARGET)
  if [ -n "$T" ] && [ "$T" != "$RELAYER_DIR" ] && [ -f "$T/scripts/vps/setup-proxy.sh" ]; then
    warn "This checkout ($RELAYER_DIR) belongs to root" "Switching to the node user's copy: $T"
    exec bash "$T/scripts/vps/setup-proxy.sh" "${ORIG_ARGS[@]}"
  fi
fi
cd "$RELAYER_DIR"

TLS_DIR=/etc/feemarket/tls
FULLCHAIN="$TLS_DIR/fullchain.pem"
PRIVKEY="$TLS_DIR/privkey.pem"

# ---- helpers ----

# Read PEM (or any text) until a line that is exactly END (case-sensitive).
read_pem_until_end() {
  local var=$1 label=$2 line buf=""
  note "$label"
  note "Paste the PEM (including BEGIN/END lines). When finished, type a line with only: END"
  while IFS= read -r line; do
    if [ "$line" = END ]; then break; fi
    buf+="$line"$'\n'
  done
  [ -n "$buf" ] || die "No PEM content received"
  printf -v "$var" '%s' "$buf"
}

write_tls_files() {
  local cert=$1 key=$2
  install -d -m 0755 "$TLS_DIR"
  printf '%s' "$cert" >"$FULLCHAIN"
  printf '%s' "$key" >"$PRIVKEY"
  chmod 644 "$FULLCHAIN"
  chmod 600 "$PRIVKEY"
  ok "Wrote $FULLCHAIN and $PRIVKEY"
}

generate_self_signed() {
  install -d -m 0755 "$TLS_DIR"
  openssl req -x509 -nodes -newkey rsa:2048 -days 825 \
    -keyout "$PRIVKEY" -out "$FULLCHAIN" \
    -subj "/CN=$DOMAIN" \
    -addext "subjectAltName=DNS:$DOMAIN" 2>/dev/null ||
    openssl req -x509 -nodes -newkey rsa:2048 -days 825 \
      -keyout "$PRIVKEY" -out "$FULLCHAIN" \
      -subj "/CN=$DOMAIN"
  chmod 644 "$FULLCHAIN"
  chmod 600 "$PRIVKEY"
  ok "Generated self-signed cert for $DOMAIN (825 days)"
}

# A cert + key already in place, valid for 30 more days and issued for this domain.
existing_cert_ok() {
  [ -s "$FULLCHAIN" ] && [ -s "$PRIVKEY" ] || return 1
  openssl x509 -in "$FULLCHAIN" -noout -checkend 2592000 >/dev/null 2>&1 || return 1
  openssl x509 -in "$FULLCHAIN" -noout -text 2>/dev/null | grep -qF "DNS:$DOMAIN"
}

choose_tls_mode() {
  # Pass "force" to re-prompt even when TLS_MODE is already set.
  if [ -n "$TLS_MODE" ] && [ "${1:-}" != force ]; then return 0; fi
  TLS_MODE=""
  section "TLS / certificate"
  note "1) Let's Encrypt (certbot) — real cert; use with Cloudflare Full (strict) or grey-cloud DNS"
  note "2) Import your own certificate — paste PEM or give file paths"
  note "3) Generate self-signed — ok for Cloudflare SSL mode Full (not Flexible)"
  note "4) Cloudflare Flexible — HTTP only on this server; Cloudflare handles HTTPS (weaker; CF→origin is HTTP)"
  note "5) None — HTTP only (dev, or TLS terminated elsewhere)"
  while true; do
    ask TLS_CHOICE "TLS mode" "1"
    case "$TLS_CHOICE" in
      1 | certbot | le | letsencrypt) TLS_MODE=certbot; break ;;
      2 | import) TLS_MODE=import; break ;;
      3 | selfsigned | self | generate) TLS_MODE=selfsigned; break ;;
      4 | cf-flexible | flexible | cloudflare) TLS_MODE=cf-flexible; break ;;
      5 | none | skip | http) TLS_MODE=none; break ;;
      *) say "  Enter 1–5." ;;
    esac
  done
}

# Print DNS A lookup vs this server's public IP (does not fail the script).
show_dns_status() {
  local ip a
  ip=$(public_ipv4)
  a=$(resolve_a "$DOMAIN" | tr '\n' ' ' | sed 's/ $//')
  if [ -z "$a" ]; then
    warn "DNS: $DOMAIN has no A record (NXDOMAIN / empty)" "Create an A record → ${ip:-this server}, wait for propagation, then retry"
    return 1
  fi
  if [ -n "$ip" ] && printf ' %s ' "$a" | grep -q " $ip "; then
    ok "DNS: $DOMAIN → $a (this server)"
    return 0
  fi
  warn "DNS: $DOMAIN → $a (this server is ${ip:-unknown})" "Grey-cloud should match the server IP; orange-cloud (Cloudflare) often shows CF anycast — that can still work for HTTP-01"
  return 0
}

ensure_tls_extra_packages() {
  case "$TLS_MODE" in
    selfsigned | import)
      apt-get install -y openssl >/dev/null
      ;;
    certbot)
      case "$KIND" in
        nginx) apt-get install -y certbot python3-certbot-nginx >/dev/null ;;
        apache) apt-get install -y certbot python3-certbot-apache >/dev/null ;;
      esac
      ;;
  esac
}

apply_site_config() {
  section "Reverse-proxy config → 127.0.0.1:$RELAYER_PORT (TLS_MODE=$TLS_MODE)"
  case "$KIND" in
    nginx)
      SITE=/etc/nginx/sites-available/feemarket-relayer
      case "$TLS_MODE" in
        import | selfsigned) write_nginx_https "$SITE" ;;
        *) write_nginx_http_only "$SITE" ;;
      esac
      ln -sfn "$SITE" /etc/nginx/sites-enabled/feemarket-relayer
      rm -f /etc/nginx/sites-enabled/default
      nginx -t
      systemctl enable --now nginx
      systemctl reload nginx
      ok "nginx site enabled for $DOMAIN"
      ;;
    apache)
      SITE=/etc/apache2/sites-available/feemarket-relayer.conf
      case "$TLS_MODE" in
        import | selfsigned) write_apache_https "$SITE" ;;
        *) write_apache_http_only "$SITE" ;;
      esac
      a2dissite 000-default >/dev/null 2>&1 || true
      a2ensite feemarket-relayer >/dev/null
      if [ "$TLS_MODE" = import ] || [ "$TLS_MODE" = selfsigned ]; then
        a2enmod ssl >/dev/null
      fi
      apache2ctl configtest
      systemctl enable --now apache2
      systemctl reload apache2
      ok "Apache site enabled for $DOMAIN"
      ;;
  esac
}

# Prepare cert material for the current TLS_MODE (not certbot — that runs later).
prepare_certificate_material() {
  section "Certificate ($TLS_MODE)"
  case "$TLS_MODE" in
    certbot)
      note "Will request a Let's Encrypt cert after the HTTP vhost is up. DNS must point here."
      note "Cloudflare: use SSL/TLS mode Full (strict), or temporarily grey-cloud for issuance."
      ;;
    import)
      if [ -z "$CERT_FILE" ] && existing_cert_ok && confirm "Keep the certificate already in $TLS_DIR?" y; then
        ok "Keeping $FULLCHAIN"
      else
        import_certificate
      fi
      ;;
    selfsigned)
      if existing_cert_ok; then ok "Keeping the self-signed certificate in $TLS_DIR"; else generate_self_signed; fi
      note "In Cloudflare set SSL/TLS to Full (not Flexible, not Full strict)."
      ;;
    cf-flexible)
      warn "Cloudflare Flexible: origin speaks HTTP only" "Anyone who bypasses Cloudflare can hit you on port 80 in cleartext. Prefer Full (strict) + certbot."
      note "In Cloudflare: SSL/TLS → Flexible. Orange-cloud the DNS record."
      ;;
    none)
      note "HTTP only — no certificate on this host."
      ;;
  esac
}

run_certbot_once() {
  case "$KIND" in
    nginx)
      certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$EMAIL" --redirect --keep-until-expiring
      ;;
    apache)
      certbot --apache -d "$DOMAIN" --non-interactive --agree-tos -m "$EMAIL" --redirect --keep-until-expiring
      ;;
  esac
}

# Keep the CLI open after certbot failures until the user succeeds or picks another TLS path.
obtain_certbot_or_recover() {
  local choice
  section "Let's Encrypt (certbot)"
  note "DNS for $DOMAIN must resolve (A or AAAA) before Let's Encrypt will issue."
  show_dns_status || true
  print_copyable_settings "$DOMAIN" certbot "$KIND" "$RELAYER_PORT"

  while true; do
    if ! show_dns_status; then
      note "Certbot will fail until an A/AAAA record exists. You can still try, or pick another option below."
    fi

    if confirm "Run certbot for $DOMAIN now?" y; then
      if [ -z "$EMAIL" ]; then
        ask EMAIL "Email for Let's Encrypt expiry notices"
      fi
      ensure_tls_extra_packages
      if run_certbot_once; then
        ok "HTTPS certificate installed for $DOMAIN"
        note "Cloudflare: set SSL/TLS to Full (strict)."
        TLS_MODE=certbot
        return 0
      fi
      warn "Certbot failed" "Usually missing/wrong DNS (NXDOMAIN), firewall blocking 80, or Cloudflare SSL mode blocking HTTP-01"
    else
      note "Skipped this attempt."
    fi

    section "Certbot did not finish — what next?"
    note "Proxy HTTP config is already in place; the script will not exit until you choose."
    note "1) I fixed DNS / firewall — retry Let's Encrypt"
    note "2) Switch to Cloudflare Flexible (HTTPS at Cloudflare, HTTP on this server)"
    note "3) Generate a self-signed cert (Cloudflare SSL mode: Full)"
    note "4) Import my own certificate / key"
    note "5) Continue with HTTP only for now (TLS_MODE=none)"
    note "6) Change domain and retry Let's Encrypt"
    note "7) Pick a different TLS mode from the full menu"
    note "8) Abort setup-proxy (proxy stays as HTTP; re-run later)"
    while true; do
      ask choice "Choose 1–8" "1"
      case "$choice" in
        1 | retry | certbot)
          apply_site_config
          break
          ;;
        2 | flexible | cf-flexible)
          TLS_MODE=cf-flexible
          ensure_tls_extra_packages
          prepare_certificate_material
          apply_site_config
          return 0
          ;;
        3 | selfsigned | self)
          TLS_MODE=selfsigned
          ensure_tls_extra_packages
          prepare_certificate_material
          apply_site_config
          return 0
          ;;
        4 | import)
          TLS_MODE=import
          CERT_FILE=""
          KEY_FILE=""
          CHAIN_FILE=""
          ensure_tls_extra_packages
          prepare_certificate_material
          apply_site_config
          return 0
          ;;
        5 | none | http)
          TLS_MODE=none
          prepare_certificate_material
          apply_site_config
          return 0
          ;;
        6 | domain)
          ask DOMAIN "New domain (must have an A record pointing here)"
          is_domain "$DOMAIN" || {
            say "  Not a domain name."
            continue
          }
          apply_site_config
          print_copyable_settings "$DOMAIN" certbot "$KIND" "$RELAYER_PORT"
          break
          ;;
        7 | menu)
          choose_tls_mode force
          if [ "$TLS_MODE" = certbot ]; then
            if [ -z "$EMAIL" ]; then ask EMAIL "Email for Let's Encrypt expiry notices"; fi
            apply_site_config
            break
          fi
          ensure_tls_extra_packages
          prepare_certificate_material
          apply_site_config
          return 0
          ;;
        8 | abort | quit | exit)
          TLS_MODE=none
          warn "Leaving proxy on HTTP without a finished cert" "Re-run: sudo bash scripts/vps/setup-proxy.sh $KIND --domain $DOMAIN"
          apply_site_config
          return 0
          ;;
        *) say "  Enter 1–8." ;;
      esac
    done
  done
}

import_certificate() {
  local cert_pem="" key_pem="" chain_pem=""
  if [ -n "$CERT_FILE" ] && [ -n "$KEY_FILE" ]; then
    [ -f "$CERT_FILE" ] || die "Cert file not found: $CERT_FILE"
    [ -f "$KEY_FILE" ] || die "Key file not found: $KEY_FILE"
    cert_pem=$(cat "$CERT_FILE")
    key_pem=$(cat "$KEY_FILE")
    if [ -n "$CHAIN_FILE" ]; then
      [ -f "$CHAIN_FILE" ] || die "Chain file not found: $CHAIN_FILE"
      chain_pem=$(cat "$CHAIN_FILE")
      cert_pem="${cert_pem}"$'\n'"${chain_pem}"
    fi
  else
    note "Provide certificate material. Prefer file paths if the PEMs are already on disk."
    if confirm "Load cert/key from file paths?" y; then
      ask CERT_FILE "Full chain / certificate file path"
      ask KEY_FILE "Private key file path"
      ask CHAIN_FILE "Optional CA chain file (empty to skip)"
      [ -f "$CERT_FILE" ] || die "Cert file not found: $CERT_FILE"
      [ -f "$KEY_FILE" ] || die "Key file not found: $KEY_FILE"
      cert_pem=$(cat "$CERT_FILE")
      key_pem=$(cat "$KEY_FILE")
      if [ -n "$CHAIN_FILE" ]; then
        [ -f "$CHAIN_FILE" ] || die "Chain file not found: $CHAIN_FILE"
        cert_pem="${cert_pem}"$'\n'"$(cat "$CHAIN_FILE")"
      fi
    else
      read_pem_until_end cert_pem "Certificate (leaf, or leaf+chain)"
      if confirm "Paste a separate CA chain to append?" n; then
        read_pem_until_end chain_pem "CA chain"
        cert_pem="${cert_pem}"$'\n'"${chain_pem}"
      fi
      read_pem_until_end key_pem "Private key"
    fi
  fi
  printf '%s' "$cert_pem" | grep -q "BEGIN CERTIFICATE" || die "Certificate PEM missing BEGIN CERTIFICATE"
  printf '%s' "$key_pem" | grep -q "BEGIN .*PRIVATE KEY" || die "Key PEM missing BEGIN PRIVATE KEY"
  write_tls_files "$cert_pem" "$key_pem"
}

# X-Forwarded-Proto: for CF Flexible, browsers use HTTPS but origin sees HTTP — force https for the app.
xfp_nginx() {
  if [ "$TLS_MODE" = cf-flexible ]; then
    printf '        proxy_set_header X-Forwarded-Proto https;\n'
  else
    printf '        proxy_set_header X-Forwarded-Proto $scheme;\n'
  fi
}
xfp_apache() {
  if [ "$TLS_MODE" = cf-flexible ]; then
    printf '    RequestHeader set X-Forwarded-Proto "https"\n'
  else
    printf '    RequestHeader set X-Forwarded-Proto "http"\n'
  fi
}

write_nginx_http_only() {
  local site=$1
  cat >"$site" <<EOF
# fee.market sponsor relayer — managed by scripts/vps/setup-proxy.sh (TLS_MODE=$TLS_MODE)
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;
    client_max_body_size 512k;
    location / {
        proxy_pass http://127.0.0.1:$RELAYER_PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
$(xfp_nginx)
        proxy_set_header CF-Connecting-IP \$http_cf_connecting_ip;
        proxy_read_timeout 120s;
    }
}
EOF
}

write_nginx_https() {
  local site=$1
  cat >"$site" <<EOF
# fee.market sponsor relayer — managed by scripts/vps/setup-proxy.sh (TLS_MODE=$TLS_MODE)
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;
    return 301 https://\$host\$request_uri;
}
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name $DOMAIN;
    ssl_certificate     $FULLCHAIN;
    ssl_certificate_key $PRIVKEY;
    ssl_protocols TLSv1.2 TLSv1.3;
    client_max_body_size 512k;
    location / {
        proxy_pass http://127.0.0.1:$RELAYER_PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header CF-Connecting-IP \$http_cf_connecting_ip;
        proxy_read_timeout 120s;
    }
}
EOF
}

write_apache_http_only() {
  local site=$1
  cat >"$site" <<EOF
# fee.market sponsor relayer — managed by scripts/vps/setup-proxy.sh (TLS_MODE=$TLS_MODE)
<VirtualHost *:80>
    ServerName $DOMAIN
    ProxyPreserveHost On
$(xfp_apache)
    ProxyPass / http://127.0.0.1:$RELAYER_PORT/
    ProxyPassReverse / http://127.0.0.1:$RELAYER_PORT/
    ErrorLog \${APACHE_LOG_DIR}/feemarket-relayer-error.log
    CustomLog \${APACHE_LOG_DIR}/feemarket-relayer-access.log combined
</VirtualHost>
EOF
}

write_apache_https() {
  local site=$1
  cat >"$site" <<EOF
# fee.market sponsor relayer — managed by scripts/vps/setup-proxy.sh (TLS_MODE=$TLS_MODE)
<VirtualHost *:80>
    ServerName $DOMAIN
    RewriteEngine On
    RewriteRule ^ https://%{SERVER_NAME}%{REQUEST_URI} [END,NE,R=permanent]
</VirtualHost>
<VirtualHost *:443>
    ServerName $DOMAIN
    SSLEngine on
    SSLCertificateFile $FULLCHAIN
    SSLCertificateKeyFile $PRIVKEY
    ProxyPreserveHost On
    RequestHeader set X-Forwarded-Proto "https"
    ProxyPass / http://127.0.0.1:$RELAYER_PORT/
    ProxyPassReverse / http://127.0.0.1:$RELAYER_PORT/
    ErrorLog \${APACHE_LOG_DIR}/feemarket-relayer-error.log
    CustomLog \${APACHE_LOG_DIR}/feemarket-relayer-access.log combined
</VirtualHost>
EOF
}

# ---- main ----

if [ -z "$DOMAIN" ]; then
  DOMAIN=$(env_get "$ENV_FILE" PUBLIC_DOMAIN)
fi
if [ -z "$DOMAIN" ]; then
  ask DOMAIN "Domain (A record / Cloudflare orange-cloud must reach this server)"
fi
is_domain "$DOMAIN" || die "Not a domain name: $DOMAIN"

choose_tls_mode

if [ "$TLS_MODE" = certbot ] && [ -z "$EMAIL" ]; then
  ask EMAIL "Email for Let's Encrypt expiry notices"
fi

section "Install $KIND (Ubuntu packages — security-patched via apt)"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
case "$KIND" in
  nginx)
    if [ "$TLS_MODE" = certbot ]; then
      apt-get install -y nginx certbot python3-certbot-nginx
    else
      apt-get install -y nginx
    fi
    if [ "$TLS_MODE" = selfsigned ] || [ "$TLS_MODE" = import ]; then
      apt-get install -y openssl
    fi
    ok "nginx $(nginx -v 2>&1 | sed 's/nginx version: //')"
    ;;
  apache)
    if [ "$TLS_MODE" = certbot ]; then
      apt-get install -y apache2 certbot python3-certbot-apache
    else
      apt-get install -y apache2
    fi
    a2enmod proxy proxy_http headers rewrite ssl >/dev/null
    if [ "$TLS_MODE" = selfsigned ] || [ "$TLS_MODE" = import ]; then
      apt-get install -y openssl
    fi
    ok "Apache $(apache2 -v 2>/dev/null | head -n1 | sed 's/Server version: //')"
    ;;
esac

prepare_certificate_material
apply_site_config

if [ "$TLS_MODE" = certbot ]; then
  # On failure, stays interactive until the user retries or switches TLS mode.
  obtain_certbot_or_recover
fi

section "Relayer .env"
if [ -f "$ENV_FILE" ]; then
  env_set "$ENV_FILE" PUBLIC_DOMAIN "$DOMAIN"
  env_set "$ENV_FILE" PUBLIC_RELAYER_URL "$(public_relay_url "$DOMAIN")"
  env_set "$ENV_FILE" HOST "127.0.0.1"
  env_set "$ENV_FILE" PORT "$RELAYER_PORT"
  env_set "$ENV_FILE" TRUST_PROXY "1"
  env_set "$ENV_FILE" PROXY_KIND "$KIND"
  env_set "$ENV_FILE" TLS_MODE "$TLS_MODE"
  # Prefer Cloudflare's real client IP when orange-clouded; else X-Forwarded-For from the proxy.
  if [ "$TLS_MODE" = cf-flexible ]; then
    env_set "$ENV_FILE" CLIENT_IP_HEADER "cf-connecting-ip"
  else
    env_set "$ENV_FILE" CLIENT_IP_HEADER "x-forwarded-for"
  fi
  chmod 600 "$ENV_FILE" 2>/dev/null || true
  OWNER=$(file_owner "$RELAYER_DIR")
  if [ -n "$OWNER" ] && [ "$OWNER" != root ]; then
    chown "$OWNER:$OWNER" "$ENV_FILE" 2>/dev/null || true
  fi
  ok "Updated .env (PROXY_KIND=$KIND, TLS_MODE=$TLS_MODE, HOST=127.0.0.1)"
else
  warn "No .env yet" "After sponsor:init set HOST=127.0.0.1 PROXY_KIND=$KIND TLS_MODE=$TLS_MODE PUBLIC_DOMAIN=$DOMAIN"
fi

print_copyable_settings "$DOMAIN" "$TLS_MODE" "$KIND" "$RELAYER_PORT"

section "Start the node (background service)"
note "Build + systemd unit so the process survives logout (curator needs /health)."
OWNER=$(file_owner "$RELAYER_DIR")
OWNER=${OWNER:-${SUDO_USER:-}}

# dist/ must exist before the unit starts
if [ -n "$OWNER" ] && [ "$OWNER" != root ] && id "$OWNER" >/dev/null 2>&1; then
  note "Building as $OWNER…"
  if have runuser; then
    runuser -u "$OWNER" -- bash -lc "cd '$RELAYER_DIR' && npm run build"
  else
    su - "$OWNER" -c "cd '$RELAYER_DIR' && npm run build"
  fi
else
  (cd "$RELAYER_DIR" && npm run build)
fi

if [ -n "$OWNER" ] && [ "$OWNER" != root ] && id "$OWNER" >/dev/null 2>&1; then
  bash "$VPS_DIR/install-relayer-service.sh" --user "$OWNER" --dir "$RELAYER_DIR" --start
else
  bash "$VPS_DIR/install-relayer-service.sh" --dir "$RELAYER_DIR" --start
fi

if verify_public_endpoint "$DOMAIN" "$RELAYER_PORT"; then
  ok "Public URL looks good — leave the service running for the curator"
else
  warn "Endpoint not fully green yet" "Keep feemarket-relayer running; fix DNS/TLS, then: bash scripts/vps/check-endpoint.sh $DOMAIN"
fi

case "$TLS_MODE" in
  certbot) note "Cert renews via certbot's systemd timer." ;;
  import | selfsigned) note "Cert files: $FULLCHAIN + $PRIVKEY. Replace and reload $KIND to rotate." ;;
  cf-flexible) note "Prefer upgrading to Full (strict) + certbot when you can." ;;
esac
note "Node service: systemctl status feemarket-relayer · logs: journalctl -u feemarket-relayer -f"
