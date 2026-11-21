#!/usr/bin/env bash
# Guided setup of a sponsor node on a prepared server. Run as the node user (not root), from the repository:
#
#   bash relayer/scripts/vps/setup.sh             # from nothing to "waiting for the curator"
#   bash relayer/scripts/vps/setup.sh --go-live   # after the curator verified you: list plans, publish the endpoint
#
# It asks for what only you know (domain, payout address, RPC URL, storage key), writes relayer/.env, shows the
# relayer address to fund, defines your plans, registers you on Polygon, starts the node and checks it answers.
# Secrets are typed hidden, go only into relayer/.env (mode 600) and are never printed. The one step that sends a
# transaction (the registration) shows a dry run first and waits for you to type "yes".
# Running it again is safe: it keeps an existing .env and picks up where things stand.
set -euo pipefail
# shellcheck source=lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

MODE=setup
for arg in "$@"; do
  case "$arg" in
    --go-live) MODE=golive ;;
    -h | --help)
      sed -n '2,11p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) die "Unknown option: $arg (see --help)" ;;
  esac
done

STEP=0
STEPS=8
step() {
  STEP=$((STEP + 1))
  section "Step $STEP of $STEPS: $1"
}
trap 'printf "\n%sStopped.%s Run the script again to continue; it keeps what is already done.\n" "$Y" "$N"; exit 130' INT

require_tty
cd "$RELAYER_DIR"

# npm run, without npm's own banner lines.
sponsor() { npm run --silent "$@"; }

set_env() { env_set "$ENV_FILE" "$1" "$2"; }
get_env() { env_get "$ENV_FILE" "$1"; }

# ---- Requirements (both modes) ----
check_requirements() {
  if [ "$(id -u)" -eq 0 ]; then die "Run this as the node user, not root: the .env file and the key in it should not belong to root."; fi
  local node
  node=$(node_major)
  if [ -z "$node" ] || [ "$node" -lt 22 ]; then die "Node.js 22 is needed (found: ${node:-none}). prepare.sh installs it."; fi
  have curl || die "curl is needed: sudo apt-get install -y curl"
  if ! have docker || ! docker compose version >/dev/null 2>&1; then die "Docker with the compose plugin is needed. prepare.sh installs it."; fi
  if ! docker info >/dev/null 2>&1; then die "This user cannot talk to Docker. Log out and in again after prepare.sh, or: sudo usermod -aG docker $(id -un)"; fi
  [ -f "$DEPLOY_FILE" ] || die "deployments/137.json is missing: run this from a full clone of the repository."
  ok "Node.js $(node -v), Docker $(docker --version | sed 's/^Docker version \([^,]*\).*/\1/'), compose $(docker compose version --short)"
}

install_packages() {
  if [ -d node_modules ] && [ node_modules -nt package-lock.json ]; then
    ok "Packages are installed"
  else
    note "Installing the node's packages (npm ci). This takes a minute."
    npm ci --no-audit --no-fund --loglevel=error
    ok "Packages installed"
  fi
}

# Brings the contract addresses in .env in line with deployments/137.json. Asks before changing a filled-in value.
sync_addresses() {
  local pair var want got changed=""
  for pair in $ADDRESS_MAP; do
    var=${pair%%:*}
    want=$(json_get "$DEPLOY_FILE" "${pair##*:}")
    got=$(get_env "$var")
    if [ -z "$want" ] || [ "$(lower "$got")" = "$(lower "$want")" ]; then continue; fi
    if [ -n "$got" ] && ! confirm "$var is $got, but deployments/137.json says $want. Correct it?"; then continue; fi
    set_env "$var" "$want"
    changed="$changed $var"
  done
  if [ "$(get_env CHAIN_ID)" != "$CHAIN_ID_DEC" ]; then
    set_env CHAIN_ID "$CHAIN_ID_DEC"
    changed="$changed CHAIN_ID"
  fi
  if [ -n "$changed" ]; then ok "Set from deployments/137.json:$changed"; else ok "Contract addresses match deployments/137.json"; fi
}

ask_domain() {
  local ip a
  while true; do
    ask DOMAIN "Domain for the node (its A record must point at this server), for example relay.example.com"
    if ! is_domain "$DOMAIN"; then
      say "  That is not a domain name (no https://, no path)."
      continue
    fi
    ip=$(public_ipv4)
    a=$(resolve_a "$DOMAIN" | tr '\n' ' ' | sed 's/ $//')
    if [ -n "$ip" ] && printf ' %s ' "$a" | grep -q " $ip "; then
      ok "$DOMAIN points at this server ($ip)"
      break
    fi
    warn "$DOMAIN points at ${a:-nothing}, this server is ${ip:-unknown}" "Without the right A record Caddy cannot get a certificate. On Cloudflare use DNS only (grey cloud)"
    if confirm "Use $DOMAIN anyway (you will fix DNS before starting)?" n; then break; fi
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
    ok "relayer/.env exists and is kept as it is (it holds your relayer key)"
    note "To start over, move it away yourself first, with a backup of the key: mv .env .env.old"
    chmod 600 "$ENV_FILE"
    sync_addresses
    DOMAIN=$(get_env PUBLIC_DOMAIN)
    if [ -z "$DOMAIN" ]; then
      ask_domain
      set_env PUBLIC_DOMAIN "$DOMAIN"
      set_env PUBLIC_RELAYER_URL "https://$DOMAIN"
    fi
    return
  fi

  say "A few questions. Nothing is sent anywhere; the answers go into relayer/.env on this server."
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
  note "Alerts: a Slack or Discord webhook that is told when the relayer runs low or a transaction is stuck."
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

  # --yes: no questions from the tool itself, and it makes a new relayer key. The secrets are added below so they
  # never appear in a command line.
  sponsor sponsor:init -- --yes --public-url "https://$DOMAIN" --payout "$PAYOUT" >/dev/null
  [ -f "$ENV_FILE" ] || die "sponsor:init did not write relayer/.env"
  chmod 600 "$ENV_FILE"
  set_env RPC_URL "$RPC"
  if [ -n "$RPC2" ]; then set_env RPC_URLS "$RPC2"; fi
  set_env PUBLIC_DOMAIN "$DOMAIN"
  if [ -n "$THIRDWEB" ]; then set_env THIRDWEB_SECRET_KEY "$THIRDWEB"; fi
  if [ -n "$WEBHOOK" ]; then set_env ALERT_WEBHOOK_URL "$WEBHOOK"; fi
  set_env CORS_ORIGINS "$CORS"
  set_env METRICS_TOKEN "$(random_hex 32)"
  set_env TRUST_PROXY 1 # Caddy is the one hop in front of the node
  unset RPC RPC2 THIRDWEB WEBHOOK
  ok "Wrote relayer/.env (mode 600) with a new relayer key, a dashboard token and a metrics token"
  sync_addresses

  say ""
  say "Spending limits, as shipped:"
  note "MAX_GAS_WEI=$(get_env MAX_GAS_WEI)  (most one sponsored send may cost; 100000000000000000 is 0.1 POL)"
  note "MAX_GAS_UNITS=$(get_env MAX_GAS_UNITS)  MAX_FEE_PER_GAS_GWEI=$(get_env MAX_FEE_PER_GAS_GWEI)"
  note "MIN_RELAYER_BALANCE_WEI=$(get_env MIN_RELAYER_BALANCE_WEI)  (the node pauses below this; 300000000000000000 is 0.3 POL)"
  note "Change them in relayer/.env once you know your plan prices (fee math in docs/sponsor-setup.md). 0 switches a limit off."
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
  note "Back up the relayer key now: it is the RELAYER_PRIVATE_KEY line in relayer/.env. Copy it offline, not into a chat."
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

configure_plans() {
  if [ -f sponsor.plans.json ]; then
    ok "Plans are defined (sponsor.plans.json)"
    if ! confirm "Change them now?" n; then return; fi
    warn "Changing plans changes your metadata" "After the curator verified you, that sends you back to Pending"
  else
    note "Next: your profile (name, region) and your plans (model, price, quota). Examples are in docs/sponsor-setup.md."
  fi
  sponsor sponsor:plans:configure || true
  if [ -f sponsor.plans.json ]; then ok "Plans saved"; else warn "No sponsor.plans.json was written" "Run it again: npm run sponsor:plans:configure"; fi
}

register() {
  if [ -z "$(get_env THIRDWEB_SECRET_KEY)" ] && [ -z "$(get_env THIRDWEB_CLIENT_ID)" ] && [ "$(get_env METADATA_STORAGE)" != filone ]; then
    note "Publishing your profile needs a storage key."
    ask_secret THIRDWEB "Thirdweb secret key (empty to stop here)"
    if [ -z "$THIRDWEB" ] || ! is_env_safe "$THIRDWEB"; then
      warn "No storage key: the registration is skipped" "Add THIRDWEB_SECRET_KEY to relayer/.env and run this script again"
      return 1
    fi
    set_env THIRDWEB_SECRET_KEY "$THIRDWEB"
    unset THIRDWEB
  fi
  say "What the registration would do (nothing is sent yet):"
  if ! sponsor sponsor:onboard -- --dry-run; then
    warn "The dry run reported a problem (see above)" "Fix it and run this script again"
    return 1
  fi
  say ""
  note "The real run sends transactions on Polygon mainnet from the relayer key: it registers you and commits your metadata."
  note "It costs a little POL in gas and cannot be undone, only changed later."
  local a
  ask a "Type yes to send it"
  if [ "$a" != yes ]; then
    skip "Not sent. Run this script again when you are ready"
    return 1
  fi
  # An explicit check: inside `register || …` the shell does not stop on a failing command by itself.
  if ! sponsor sponsor:onboard; then
    warn "The registration did not finish (see above)" "It is safe to run again: it continues where it stopped"
    return 1
  fi
  ok "Registered. Sponsor id: $(get_env SPONSOR_ID)"
}

start_node() {
  note "Builds the image and starts two containers: the node (internal) and Caddy (ports 80 and 443, with the certificate)."
  if ! confirm "Start the node now?"; then
    skip "Not started. Later: cd relayer && docker compose up -d --build"
    return 1
  fi
  if ! docker compose up -d --build; then
    fail "docker compose could not start the node (see above)"
    return 1
  fi
  local domain code="" i=0
  domain=$(get_env PUBLIC_DOMAIN)
  printf ' Waiting for https://%s/health (the first certificate can take a minute)' "$domain"
  while [ $i -lt 45 ]; do
    code=$(curl -s --max-time 6 -o /dev/null -w '%{http_code}' "https://$domain/health" 2>/dev/null || true)
    if [ "$code" = 200 ] || [ "$code" = 503 ]; then break; fi
    printf '.'
    sleep 4
    i=$((i + 1))
  done
  printf '\n'
  case "$code" in
    200) ok "The node answers on https://$domain and is ready" ;;
    503) warn "The node answers on https://$domain but reports it is not ready" "Usually a low relayer balance: curl https://$domain/health" ;;
    *)
      fail "https://$domain/health does not answer after three minutes" "docker compose logs --tail 50 caddy   (DNS or port 80 is the usual cause)"
      return 1
      ;;
  esac
}

handoff() {
  local domain sid payout
  domain=$(get_env PUBLIC_DOMAIN)
  sid=$(get_env SPONSOR_ID)
  payout=$(get_env SPONSOR_PAYOUT_ADDRESS)
  section "Send this to the curator"
  printf '\n     Sponsor id:   %s\n     Relayer:      %s\n     Payout:       %s\n     Endpoint:     https://%s\n\n' "$sid" "${RELAYER:-$(relayer_address)}" "$payout" "$domain"
  note "None of this is secret. Until the curator has verified you, do not change your plans or profile, the relayer key"
  note "or the payout wallet: each of those sends you back to Pending."
  say ""
  say "When you are verified:"
  printf '\n     bash scripts/vps/setup.sh --go-live\n\n'
  say "Any time:"
  printf '\n     bash scripts/vps/check.sh        # the server and the node\n     npm run sponsor:doctor           # the on-chain side\n     docker compose logs -f relayer   # what the node is doing\n\n'
  note "The dashboard is at https://$domain/admin/ ; its token is DASHBOARD_TOKEN in relayer/.env."
  note "Then read docs/sponsor-vps-checklist.md section 7 (backups, uptime check, runbooks)."
}

# ---- After verification ----
go_live() {
  STEPS=3
  printf '%sfee.market sponsor node: go live%s\n' "$B" "$N"
  step "Requirements"
  check_requirements
  [ -f "$ENV_FILE" ] || die "No relayer/.env: run setup.sh without --go-live first."

  step "List your plans and (re)start the node"
  note "Lists the plans from sponsor.plans.json on Polygon (transactions from the relayer key), then starts the node."
  note "It stops by itself if the curator has not verified you yet."
  sponsor sponsor:go -- --dry-run || die "Not ready yet (see above)."
  local a
  ask a "Type yes to list the plans and start"
  if [ "$a" != yes ]; then die "Nothing was sent."; fi
  sponsor sponsor:go

  step "Publish the endpoint on chain"
  local domain
  domain=$(get_env PUBLIC_DOMAIN)
  note "Wallets find your node through the URL stored in the registry. Only the payout wallet can set it,"
  note "and its key should not be on this server."
  if confirm "Is the payout wallet a Safe?" y; then
    sponsor sponsor:endpoint -- --safe-batch endpoint.json
    ok "Wrote relayer/endpoint.json"
    note "Import it in the Safe's Transaction Builder and execute it with the owners."
  else
    say "  Set it from the payout wallet in the web app: https://app.fee.market/sponsor/service"
    say "  URL to enter: https://$domain"
  fi
  say ""
  note "Check the result: npm run sponsor:doctor compares the on-chain URL with the one the node publishes."
  note "Then make one small sponsored send from a wallet you control, and look at https://$domain/admin/"
}

# ---- Main ----
if [ "$MODE" = golive ]; then
  go_live
  exit 0
fi

printf '%sfee.market sponsor node: guided setup%s\n' "$B" "$N"
note "Polygon mainnet (chain $CHAIN_ID_DEC), closed test. Stop any time with Ctrl-C and run it again to continue."
RELAYER=""

step "Requirements"
check_requirements

step "Packages"
install_packages

step "Configuration"
configure_env

step "Fund the relayer"
fund_relayer

step "Plans"
configure_plans

step "Register on Polygon"
REGISTERED=1
register || REGISTERED=0

step "Start the node"
STARTED=1
start_node || STARTED=0

step "Checks"
bash "$VPS_DIR/check.sh" || true
say ""
say "On-chain state (a sponsor that is Pending is expected at this point):"
sponsor sponsor:doctor || true

if [ "$REGISTERED" -eq 1 ] && [ "$STARTED" -eq 1 ]; then
  handoff
else
  section "Not finished yet"
  if [ "$REGISTERED" -eq 0 ]; then note "The registration is not done."; fi
  if [ "$STARTED" -eq 0 ]; then note "The node is not started, or does not answer on its public address."; fi
  note "Fix what is listed above and run this script again: bash scripts/vps/setup.sh"
fi
