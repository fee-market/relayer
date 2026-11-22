#!/usr/bin/env bash
# One command from a fresh server to a live sponsor node. Safe to re-run: every step detects what is done.
#
#   sudo bash scripts/vps/setup.sh     # fresh Ubuntu VPS: prepares the server as root, then continues as the node user
#   npm run sponsor:setup              # as the node user (server already prepared)
#   npm run sponsor:setup -- --go-live # jump to the status / go-live step
#
# Order: requirements → packages → .env → fund relayer → how wallets reach you (Caddy / nginx / Apache / tunnel)
# → public HTTPS + background node → plans → register on Polygon → status. When the curator has verified you,
# running it again lists your plans and goes live. Secrets are typed hidden and only written to .env (mode 600).
set -euo pipefail
# shellcheck source=lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

MODE=setup
ARGS=("$@")
for arg in "$@"; do
  case "$arg" in
    --go-live) MODE=golive ;;
    -h | --help)
      sed -n '2,10p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) die "Unknown option: $arg (see --help)" ;;
  esac
done

require_tty
trap 'printf "\n%sStopped.%s Run the same command again to continue; finished steps are detected.\n" "$Y" "$N"; exit 130' INT

PREPARE_STATE=/etc/feemarket/prepare.env

# ---- As root: prepare the server, then hand over to the node user ----
if [ "$(id -u)" -eq 0 ]; then
  printf '%sfee.market sponsor node: setup (server preparation as root)%s\n' "$B" "$N"
  if [ -f "$PREPARE_STATE" ] && ! confirm "This server was prepared before. Run the preparation steps again?" n; then
    ok "Using the earlier preparation ($PREPARE_STATE)"
  else
    FEEMARKET_SETUP=1 bash "$VPS_DIR/prepare.sh" || die "Server preparation stopped (see above). Run this command again to continue."
  fi
  [ -f "$PREPARE_STATE" ] || die "No $PREPARE_STATE: the preparation did not finish."
  NODE_USER=$(env_get "$PREPARE_STATE" NODE_USER)
  TARGET=$(env_get "$PREPARE_STATE" TARGET)
  PUBLISH_MODE=$(env_get "$PREPARE_STATE" PUBLISH_MODE)
  [ -n "$NODE_USER" ] && [ "$NODE_USER" != root ] || die "No node user recorded; run the preparation again."
  [ -d "$TARGET" ] || die "Repository copy $TARGET is missing; run the preparation again."
  if [ "$RELAYER_DIR" != "$TARGET" ]; then
    # Cloned as root: the node user's copy is the one that runs. Carry over what only exists here.
    for f in .env sponsor.plans.json; do
      if [ -f "$RELAYER_DIR/$f" ] && [ ! -f "$TARGET/$f" ]; then
        install -m 600 -o "$NODE_USER" -g "$NODE_USER" "$RELAYER_DIR/$f" "$TARGET/$f"
        ok "Moved $f to $TARGET (owned by $NODE_USER)"
      elif [ -f "$RELAYER_DIR/$f" ] && ! cmp -s "$RELAYER_DIR/$f" "$TARGET/$f"; then
        warn "$f differs between $RELAYER_DIR and $TARGET" "$TARGET/$f is the one used; the root copy is ignored"
      fi
    done
    if [ -d "$RELAYER_DIR/secrets" ] && [ ! -d "$TARGET/secrets" ]; then
      cp -a "$RELAYER_DIR/secrets" "$TARGET/secrets"
      chown -R "$NODE_USER:$NODE_USER" "$TARGET/secrets"
      ok "Moved secrets/ to $TARGET"
    fi
    note "From now on the node runs from $TARGET as $NODE_USER. $RELAYER_DIR is no longer used;"
    note "once the node is live you can delete it (after backing up any .env you still need): rm -rf $RELAYER_DIR"
  fi
  section "Continuing as $NODE_USER in $TARGET"
  note "A fresh login for $NODE_USER, so the docker group and PATH apply."
  exec runuser -l "$NODE_USER" -c "cd '$TARGET' && PUBLISH_MODE='$PUBLISH_MODE' bash scripts/vps/setup.sh ${ARGS[*]:-}"
fi

cd "$RELAYER_DIR"

STEP=0
STEPS=9
step() {
  STEP=$((STEP + 1))
  section "Step $STEP of $STEPS: $1"
}

# npm run, without npm's own banner lines.
sponsor() { npm run --silent "$@"; }
set_env() { env_set "$ENV_FILE" "$1" "$2"; }
get_env() { env_get "$ENV_FILE" "$1"; }
docker_ok() { have docker && docker compose version >/dev/null 2>&1 && docker info >/dev/null 2>&1; }

# ---- Requirements ----
check_requirements() {
  local node
  node=$(node_major)
  if [ -z "$node" ] || [ "$node" -lt 22 ]; then
    die "Node.js >= 22 is needed (found: ${node:-none}). On a fresh VPS run: sudo bash scripts/vps/setup.sh"
  fi
  have curl || die "curl is needed: sudo apt-get install -y curl"
  [ -f "$RELAYER_DIR/package.json" ] || die "package.json missing: run from the relayer checkout."
  [ -f "$DEPLOY_FILE" ] || [ -f "$ENV_EXAMPLE" ] || die "deployments/137.json and .env.example are both missing: incomplete clone."
  ok "Node.js $(node -v), npm $(npm -v)$(docker_ok && printf ', Docker %s' "$(docker --version | sed 's/^Docker version \([^,]*\).*/\1/')")"
}

install_packages() {
  if [ -d node_modules ] && [ -f package-lock.json ] && [ node_modules -nt package-lock.json ]; then
    ok "Packages are installed"
  else
    note "Installing packages (npm ci). This takes a minute."
    npm ci --no-audit --no-fund --loglevel=error
    ok "Packages installed"
  fi
  note "Building…"
  npm run --silent build >/dev/null
  ok "Built dist/"
}

# Brings the contract addresses in .env in line with deployments/137.json (falls back to .env.example).
sync_addresses() {
  local pair var want got changed=""
  for pair in $ADDRESS_MAP; do
    var=${pair%%:*}
    want=$(deploy_addr "${pair##*:}" "$var")
    got=$(get_env "$var")
    if [ -z "$want" ] || [ "$(lower "$got")" = "$(lower "$want")" ]; then continue; fi
    if [ -n "$got" ] && ! confirm "$var is $got, but the Polygon defaults say $want. Correct it?"; then continue; fi
    set_env "$var" "$want"
    changed="$changed $var"
  done
  if [ "$(get_env CHAIN_ID)" != "$CHAIN_ID_DEC" ]; then
    set_env CHAIN_ID "$CHAIN_ID_DEC"
    changed="$changed CHAIN_ID"
  fi
  if [ -n "$changed" ]; then ok "Set Polygon defaults:$changed"; else ok "Contract addresses match Polygon defaults"; fi
}

ask_domain() {
  local ip a
  while true; do
    ask DOMAIN "Domain for the node, for example node.example.com (no https://, no path)"
    if ! is_domain "$DOMAIN"; then
      say "  That is not a domain name."
      continue
    fi
    ip=$(public_ipv4)
    a=$(resolve_a "$DOMAIN" | tr '\n' ' ' | sed 's/ $//')
    if [ -n "$ip" ] && printf ' %s ' "$a" | grep -q " $ip "; then
      ok "$DOMAIN points at this server ($ip)"
    elif [ -z "$a" ]; then
      warn "$DOMAIN has no A record yet" "Create one → ${ip:-this server} now; the HTTPS step checks again and waits for you"
    else
      warn "$DOMAIN points at $a, this server is ${ip:-unknown}" "Fine behind Cloudflare's orange cloud or a tunnel; otherwise fix the A record"
    fi
    break
  done
}

ask_payout() {
  note "The payout wallet receives your earnings and controls the sponsor. Use a cold wallet, ideally a Safe."
  note "It must not be the relayer key, and its key never comes near this server."
  while true; do
    ask PAYOUT "Payout address (0x…)"
    if is_address "$PAYOUT"; then break; fi
    say "  That is not an address (0x and 40 hex characters)."
  done
}

# ask_rpc VAR "Question" required|optional
ask_rpc() {
  local __out=$1 __q=$2 __need=$3 __u __cid
  while true; do
    ask_secret __u "$__q"
    if [ -z "$__u" ] && [ "$__need" = optional ]; then break; fi
    if ! is_https_url "$__u"; then
      say "  An https:// URL without spaces, please."
      continue
    fi
    __cid=$(rpc_chain_id "$__u")
    if [ "$__cid" = "$CHAIN_ID_HEX" ]; then
      ok "That RPC answers for Polygon"
      break
    fi
    if [ -n "$__cid" ]; then warn "That RPC answers for chain $__cid, not Polygon"; else warn "That RPC does not answer"; fi
    if confirm "Use it anyway?" n; then break; fi
  done
  printf -v "$__out" '%s' "$__u"
}

configure_env() {
  if [ -f "$ENV_FILE" ]; then
    ok ".env exists and is kept (it holds your relayer key)"
    note "To start over, move it away with a backup of the key first: mv .env .env.old"
    chmod 600 "$ENV_FILE"
    sync_addresses
    DOMAIN=$(get_env PUBLIC_DOMAIN)
    if [ -z "$DOMAIN" ]; then
      ask_domain
      set_env PUBLIC_DOMAIN "$DOMAIN"
      set_env PUBLIC_RELAYER_URL "$(public_relay_url "$DOMAIN")"
    else
      ok "Domain: $DOMAIN"
    fi
    return
  fi

  say "A few questions. Nothing is sent anywhere; the answers go into .env on this server."
  ask_domain
  ask_payout
  note "The RPC is how the node talks to Polygon. Use a paid plan (Alchemy, QuickNode, …); the URL contains your key."
  ask_rpc RPC "Polygon RPC URL" required
  ask_rpc RPC2 "A second RPC URL from another provider, as a fallback (empty to skip)" optional
  note "A thirdweb secret key publishes your sponsor profile to IPFS. Free at thirdweb.com/dashboard."
  while true; do
    ask_secret THIRDWEB "Thirdweb secret key (empty to add it later)"
    if is_env_safe "$THIRDWEB"; then break; fi
    say "  That contains characters a key does not have. Paste the key only."
  done
  note "Alerts: a Slack or Discord webhook told when the relayer runs low or a transaction is stuck."
  while true; do
    ask_secret WEBHOOK "Alert webhook URL (empty to add it later)"
    if [ -z "$WEBHOOK" ] || is_https_url "$WEBHOOK"; then break; fi
    say "  An https:// URL, please."
  done
  note "Web origins allowed to call the node from a browser. The phone wallet does not need this."
  while true; do
    ask CORS "Allowed web origins, comma-separated" "https://app.fee.market"
    if is_env_safe "$CORS" && [ "$CORS" != "*" ]; then break; fi
    say "  List https:// origins; * is refused for a published node."
  done

  # --yes: no questions from the tool itself, and it makes a new relayer key. Secrets are added below so they
  # never appear in a command line.
  sponsor sponsor:init -- --yes --public-url "$(public_relay_url "$DOMAIN")" --payout "$PAYOUT" >/dev/null
  [ -f "$ENV_FILE" ] || die "sponsor:init did not write .env"
  chmod 600 "$ENV_FILE"
  set_env RPC_URL "$RPC"
  if [ -n "$RPC2" ]; then set_env RPC_URLS "$RPC2"; fi
  set_env PUBLIC_DOMAIN "$DOMAIN"
  set_env PUBLIC_RELAYER_URL "$(public_relay_url "$DOMAIN")"
  if [ -n "$THIRDWEB" ]; then set_env THIRDWEB_SECRET_KEY "$THIRDWEB"; fi
  if [ -n "$WEBHOOK" ]; then set_env ALERT_WEBHOOK_URL "$WEBHOOK"; fi
  set_env CORS_ORIGINS "$CORS"
  set_env METRICS_TOKEN "$(random_hex 32)"
  unset RPC RPC2 THIRDWEB WEBHOOK
  ok "Wrote .env (mode 600) with a new relayer key, a dashboard token and a metrics token"
  sync_addresses
  note "Spending limits (edit in .env later): MAX_GAS_WEI=$(get_env MAX_GAS_WEI)  MIN_RELAYER_BALANCE_WEI=$(get_env MIN_RELAYER_BALANCE_WEI)"
}

fund_relayer() {
  RELAYER=$(relayer_address)
  if [ -z "$RELAYER" ]; then
    skip "The relayer key is not a raw key in .env; check its balance with: npm run sponsor:doctor"
    return
  fi
  say "Relayer address (this one pays the gas):"
  printf '\n     %s%s%s\n\n' "$B" "$RELAYER" "$N"
  note "Send it POL on Polygon: a few days of gas, not more. 2 POL is a reasonable start; the node pauses below 0.3."
  note "Back up the relayer key: the RELAYER_PRIVATE_KEY line in .env. Copy it offline, not into a chat."
  local bal a
  while true; do
    bal=$(relayer_balance_pol "$RELAYER")
    if [ -z "$bal" ]; then
      warn "The RPC did not answer; the balance is unknown"
    elif num_lt "$bal" 0.5; then
      say "  Balance: $bal POL (registration needs gas, and the doctor wants at least 0.5)"
    else
      ok "Balance: $bal POL"
      return
    fi
    ask a "Press Enter to check again, or type skip to go on"
    if [ "$a" = skip ]; then return; fi
  done
}

# ---- How wallets reach this node ----
# Switching from one way of publishing to another: stop the old one so both don't fight over :80/:443.
retire_publish_mode() {
  warn "Switching from $1 to $KIND" "Stopping the $1 setup first"
  case "$1" in
    caddy) docker compose down || true ;;
    nginx)
      sudo rm -f /etc/nginx/sites-enabled/feemarket-relayer && sudo systemctl reload nginx 2>/dev/null || true
      if [ "$KIND" = caddy ]; then note "If nginx serves nothing else: sudo systemctl disable --now nginx (Caddy needs :80/:443)"; fi
      ;;
    apache)
      sudo a2dissite feemarket-relayer >/dev/null 2>&1 && sudo systemctl reload apache2 2>/dev/null || true
      if [ "$KIND" = caddy ]; then note "If Apache serves nothing else: sudo systemctl disable --now apache2 (Caddy needs :80/:443)"; fi
      ;;
    tunnel) note "Stop the old tunnel if you no longer use it: sudo systemctl disable --now cloudflared" ;;
  esac
  if [ "$KIND" = caddy ] && systemctl list-unit-files feemarket-relayer.service 2>/dev/null | grep -q feemarket-relayer; then
    sudo systemctl disable --now feemarket-relayer.service || true
    ok "Stopped the host service feemarket-relayer (the node now runs in Docker)"
  fi
  # A new proxy means a new TLS choice.
  set_env TLS_MODE ""
}

choose_publish_mode() {
  local c
  KIND=$(lower "$(get_env PROXY_KIND)")
  OLD_KIND=$KIND
  if [ -z "$KIND" ]; then
    case "${PUBLISH_MODE:-}" in
      docker) KIND=caddy ;;
      nginx | apache | tunnel) KIND=$PUBLISH_MODE ;;
    esac
  fi
  if [ -n "$KIND" ] && ! confirm "Publish the node with $KIND?" y; then KIND=""; fi
  while [ -z "$KIND" ]; do
    note "1) Caddy in Docker — automatic HTTPS (recommended)"
    note "2) nginx on the host — Let's Encrypt, your own cert, self-signed, or Cloudflare Flexible"
    note "3) Apache on the host — same certificate options"
    note "4) Cloudflare Tunnel — no open ports (needs cloudflared and the domain on Cloudflare)"
    ask c "How should wallets reach this node" "1"
    case "$c" in
      1 | caddy | docker) KIND=caddy ;;
      2 | nginx) KIND=nginx ;;
      3 | apache) KIND=apache ;;
      4 | tunnel) KIND=tunnel ;;
      *) say "  Enter 1–4." ;;
    esac
    if [ "$KIND" = caddy ] && ! docker_ok; then
      warn "Docker is not usable by $(id -un)" "Install it with: sudo bash scripts/vps/prepare.sh (then log in again), or pick nginx/Apache"
      KIND=""
    elif [ "$KIND" = tunnel ] && ! have cloudflared; then
      warn "cloudflared is not installed" "https://pkg.cloudflare.com — or pick another option"
      KIND=""
    fi
  done
  if [ -n "$OLD_KIND" ] && [ "$OLD_KIND" != "$KIND" ]; then retire_publish_mode "$OLD_KIND"; fi
  set_env PROXY_KIND "$KIND"
  set_env TRUST_PROXY 1
  case "$KIND" in
    caddy) set_env HOST 0.0.0.0 ;; # inside the container; only Caddy publishes ports
    *) set_env HOST 127.0.0.1 ;;
  esac
  if [ "$KIND" = tunnel ]; then set_env CLIENT_IP_HEADER cf-connecting-ip; fi
  ok "Publishing via $KIND (PROXY_KIND in .env)"
}

# ---- Public HTTPS + background node ----
start_endpoint() {
  local port
  port=$(get_env PORT)
  port=${port:-8787}
  case "$KIND" in
    caddy)
      note "Building and starting the node + Caddy (restart: unless-stopped)…"
      docker compose up -d --build
      ;;
    nginx | apache)
      note "Configuring $KIND (needs sudo): TLS choice, vhost, and the feemarket-relayer service."
      sudo bash "$VPS_DIR/setup-proxy.sh" "$KIND" --domain "$DOMAIN" --port "$port"
      ;;
    tunnel)
      bash "$RELAYER_DIR/scripts/ensure-node-running.sh"
      bash "$RELAYER_DIR/scripts/setup-tunnel.sh" "$DOMAIN"
      ;;
  esac
}

wait_public() {
  local i=0 code=""
  printf ' Waiting for https://%s/live' "$DOMAIN"
  while [ $i -lt "${1:-20}" ]; do
    code=$(http_code "https://$DOMAIN/live")
    if [ "$code" = 200 ]; then break; fi
    printf '.'
    sleep 3
    i=$((i + 1))
  done
  printf '\n'
}

public_endpoint() {
  local c port
  DOMAIN=$(get_env PUBLIC_DOMAIN)
  port=$(get_env PORT)
  port=${port:-8787}
  if [ "$(http_code "https://$DOMAIN/live")" = 200 ] && confirm "https://$DOMAIN already answers. Keep it as it is?" y; then
    bash "$RELAYER_DIR/scripts/ensure-node-running.sh" >/dev/null 2>&1 || true
  else
    start_endpoint || warn "The endpoint setup reported a problem (see above)"
    wait_public 20
  fi
  while true; do
    if verify_public_endpoint "$DOMAIN" "$port"; then
      ok "https://$DOMAIN answers; the node keeps running in the background"
      ENDPOINT_OK=1
      return 0
    fi
    print_copyable_settings "$DOMAIN" "$(get_env TLS_MODE)" "$KIND" "$port"
    section "The public URL does not answer yet"
    note "1) Check again (after fixing DNS / Cloudflare / firewall)"
    note "2) Run the endpoint setup again"
    note "3) Continue anyway (the curator cannot reach you until this is fixed)"
    note "4) Stop here — run the same command later; it resumes"
    ask c "Choose 1–4" "1"
    case "$c" in
      1) wait_public 10 ;;
      2) start_endpoint || true; wait_public 20 ;;
      3) ENDPOINT_OK=0; return 0 ;;
      4) note "Stopped. Re-run: npm run sponsor:setup"; exit 0 ;;
      *) say "  Enter 1–4." ;;
    esac
  done
}

# ---- Plans ----
configure_plans() {
  if [ -f sponsor.plans.json ]; then
    ok "Plans are defined (sponsor.plans.json)"
    if ! confirm "Change your profile or plans now?" n; then check_plan_url; return; fi
    warn "Changing plans changes your metadata" "After the curator verified you, that sends you back to Pending"
  else
    note "Your profile (name, region, optional description) and plans (model, price, quota)."
  fi
  note "Press Enter at the URL question to keep $(get_env PUBLIC_RELAYER_URL)."
  sponsor sponsor:plans:configure -- --no-endpoint || true
  if [ ! -f sponsor.plans.json ]; then
    warn "No sponsor.plans.json was written" "Run the same command again"
    return
  fi
  ok "Plans saved"
  check_plan_url
}

check_plan_url() {
  local plan_url env_url
  plan_url=$(json_get sponsor.plans.json relayerEndpoint)
  env_url=$(get_env PUBLIC_RELAYER_URL)
  if [ -n "$plan_url" ] && [ "${plan_url%/}" != "${env_url%/}" ]; then
    warn "The plan file publishes $plan_url, but this node is $env_url" "Answer yes to 'Change your profile or plans' and fix the URL"
  fi
}

# ---- Register ----
register() {
  local out a
  if [ -z "$(get_env THIRDWEB_SECRET_KEY)" ] && [ -z "$(get_env THIRDWEB_CLIENT_ID)" ] && [ "$(get_env METADATA_STORAGE)" != filone ]; then
    note "Publishing your profile needs a storage key."
    ask_secret THIRDWEB "Thirdweb secret key (empty to stop here)"
    if [ -z "$THIRDWEB" ] || ! is_env_safe "$THIRDWEB"; then
      warn "No storage key: registration skipped" "Add THIRDWEB_SECRET_KEY to .env and run the same command again"
      return 1
    fi
    set_env THIRDWEB_SECRET_KEY "$THIRDWEB"
    unset THIRDWEB
  fi
  say "What the registration would do (nothing is sent yet):"
  if ! out=$(sponsor sponsor:onboard -- --dry-run 2>&1); then
    printf '%s\n' "$out"
    warn "The dry run reported a problem (see above)" "Fix it and run the same command again"
    return 1
  fi
  printf '%s\n' "$out"
  if ! printf '%s\n' "$out" | grep -q '^Steps:'; then
    ok "Registration and metadata are already up to date"
    return 0
  fi
  if ! printf '%s\n' "$out" | grep '^ • ' | grep -vq 'publish-endpoint'; then
    ok "Registration and metadata are already up to date"
    publish_endpoint_hint
    return 0
  fi
  say ""
  note "The real run sends transactions on Polygon mainnet from the relayer key: it registers you and commits your metadata."
  note "It costs a little POL in gas and cannot be undone, only changed later."
  ask a "Type yes to send it"
  if [ "$a" != yes ]; then
    skip "Not sent. Run the same command again when you are ready"
    return 1
  fi
  # onboard restarts the background node afterwards, so it picks up the new SPONSOR_ID.
  if ! sponsor sponsor:onboard; then
    warn "The registration did not finish (see above)" "It is safe to run again: it continues where it stopped"
    return 1
  fi
  ok "Registered. Sponsor id: $(get_env SPONSOR_ID)"
}

# ---- Status / go live ----
sponsor_status() { sponsor sponsor:status -- --short 2>/dev/null | tail -n 1 || true; }

handoff() {
  local sid payout
  sid=$(get_env SPONSOR_ID)
  payout=$(get_env SPONSOR_PAYOUT_ADDRESS)
  section "Send this to the curator"
  printf '\n     Sponsor id:   %s\n     Relayer:      %s\n     Payout:       %s\n     Endpoint:     https://%s\n\n' \
    "$sid" "${RELAYER:-$(relayer_address)}" "$payout" "$DOMAIN"
  note "Not secret. Until you are verified, do not change plans, profile, relayer key or payout wallet (each resets you to Pending)."
  note "The node keeps running in the background so the curator can open https://$DOMAIN/health."
}

ENDPOINT_HINT_SHOWN=0
publish_endpoint_hint() {
  if [ "$ENDPOINT_HINT_SHOWN" -eq 1 ]; then return; fi
  ENDPOINT_HINT_SHOWN=1
  if ! sponsor sponsor:onboard -- --dry-run 2>/dev/null | grep -q 'publish-endpoint'; then
    ok "The endpoint stored on chain matches https://$DOMAIN"
    return
  fi
  note "Wallets find your node through the URL stored in the registry. Only the payout wallet can set it."
  if confirm "Is the payout wallet a Safe?" y; then
    sponsor sponsor:endpoint -- --safe-batch endpoint.json
    ok "Wrote endpoint.json — import it in the Safe Transaction Builder and execute it"
  else
    say "  Set it from the payout wallet in the web app: https://app.fee.market/sponsor/service"
    say "  URL to enter: $(public_relay_url "$DOMAIN")"
  fi
}

go_live() {
  local a check
  check=$(sponsor sponsor:list -- --check 2>/dev/null || true)
  if printf '%s\n' "$check" | grep -q '^TO_LIST=0$'; then
    ok "VERIFIED and all your plans are listed: nothing to send"
    bash "$RELAYER_DIR/scripts/ensure-node-running.sh" || true
    publish_endpoint_hint
    ok "Live: wallets can subscribe to your plans at https://$DOMAIN"
    return 0
  fi
  printf '%s\n' "$check" | grep '^· not listed yet' || true
  say "You are VERIFIED. Going live lists your plans on Polygon (transactions from the relayer key)."
  if ! sponsor sponsor:go -- --no-start --dry-run; then
    warn "Not ready yet (see above)"
    return 1
  fi
  ask a "Type yes to list your plans"
  if [ "$a" != yes ]; then
    skip "Not listed. Run the same command again when ready"
    return 1
  fi
  sponsor sponsor:go -- --no-start || { warn "Listing did not finish (see above)" "Safe to re-run"; return 1; }
  bash "$RELAYER_DIR/scripts/ensure-node-running.sh" || true
  publish_endpoint_hint
  ok "Live: wallets can subscribe to your plans at https://$DOMAIN"
}

status_step() {
  local s a
  s=$(sponsor_status)
  say "On-chain status: ${B}${s:-unknown}${N}"
  case "$s" in
    VERIFIED)
      go_live
      ;;
    PENDING | UNVERIFIED)
      handoff
      if confirm "Wait here and check every 2 minutes until you are verified?" n; then
        while [ "$s" != VERIFIED ]; do
          sleep 120
          s=$(sponsor_status)
          printf ' %s  status: %s\n' "$(date '+%H:%M')" "${s:-unknown}"
          if [ "$s" = REVOKED ]; then warn "The sponsor was revoked"; return 1; fi
        done
        go_live
      else
        note "Check later with: npm run sponsor:status — or run this command again; it goes live once you are verified."
      fi
      ;;
    REVOKED)
      warn "This sponsor is REVOKED" "Contact the curator"
      ;;
    NOT_REGISTERED | "")
      warn "Not registered on chain yet" "Run the same command again and confirm the registration step"
      ;;
  esac
}

summary() {
  section "Summary"
  printf '\n     Node URL:     https://%s\n     Status:       %s\n     Published by: %s\n\n' "$DOMAIN" "$(sponsor_status)" "$KIND"
  say "Any time:"
  printf '\n     npm run sponsor:setup            # re-run: resumes, and goes live once verified\n'
  printf '     npm run sponsor:status           # PENDING / VERIFIED\n'
  printf '     npm run sponsor:check-endpoint   # is the public URL healthy?\n'
  printf '     npm run sponsor:doctor           # on-chain readiness\n'
  printf '     npm run update                   # upgrade (not bare git pull)\n'
  case "$KIND" in
    caddy) printf '     docker compose logs -f relayer   # node logs\n\n' ;;
    *) printf '     journalctl -u feemarket-relayer -f   # node logs\n\n' ;;
  esac
  note "Dashboard: https://$DOMAIN/admin/ (token: DASHBOARD_TOKEN in .env)"
}

# ---- Main ----
if [ "$(id -u)" -eq 0 ]; then die "Run as the node user, not root."; fi

printf '%sfee.market sponsor node: setup%s\n' "$B" "$N"
note "Polygon mainnet (chain $CHAIN_ID_DEC). Stop any time with Ctrl-C and run the same command again to continue."
RELAYER=""
KIND=""
ENDPOINT_OK=1

if [ "$MODE" = golive ]; then
  STEPS=2
  step "Requirements"
  check_requirements
  [ -f "$ENV_FILE" ] || die "No .env yet: run npm run sponsor:setup without --go-live first."
  DOMAIN=$(get_env PUBLIC_DOMAIN)
  KIND=$(get_env PROXY_KIND)
  step "Status"
  status_step
  summary
  exit 0
fi

step "Requirements"
check_requirements

step "Packages"
install_packages

step "Configuration (.env)"
configure_env

step "Fund the relayer"
fund_relayer

step "How wallets reach this node"
choose_publish_mode

step "Public HTTPS + background node"
public_endpoint

step "Profile and plans"
configure_plans

step "Register on Polygon"
REGISTERED=1
register || REGISTERED=0

step "Status"
if [ "$REGISTERED" -eq 1 ]; then
  status_step
else
  note "Not registered yet; the status step runs after registration."
fi
if [ "$ENDPOINT_OK" -eq 0 ]; then
  warn "The public URL was not answering" "Fix it, then: npm run sponsor:check-endpoint"
fi
summary
