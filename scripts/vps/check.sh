#!/usr/bin/env bash
# Checks a sponsor node's server. Read-only: it changes nothing and sends no transactions.
#
#   bash scripts/vps/check.sh                              # everything it can see as this user
#   sudo bash scripts/vps/check.sh                         # also the firewall and the effective SSH settings
#   bash scripts/vps/check.sh --domain relay.example.com   # before .env exists
#
# Run it before the setup (what is missing?), after it (is it right?) and any time later (is it still right?).
# It ends with a count; the exit code is 1 when something blocks you, 0 otherwise. On-chain state (registered,
# verified, plans) is the job of `npm run sponsor:doctor`.
set -uo pipefail
# shellcheck source=lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

DOMAIN=""
while [ $# -gt 0 ]; do
  case "$1" in
    --domain)
      DOMAIN=${2:-}
      shift 2 || die "--domain needs a value"
      ;;
    -h | --help)
      sed -n '2,10p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) die "Unknown option: $1 (see --help)" ;;
  esac
done
if [ -z "$DOMAIN" ]; then DOMAIN=$(env_get "$ENV_FILE" PUBLIC_DOMAIN); fi
if [ -n "$DOMAIN" ] && ! is_domain "$DOMAIN"; then die "Not a domain name: $DOMAIN"; fi

IS_ROOT=0
if [ "$(id -u)" -eq 0 ]; then IS_ROOT=1; fi
CAN_ROOT=0
if as_root true 2>/dev/null; then CAN_ROOT=1; fi
SSH_PORT=$(ssh_port)

printf '%sfee.market sponsor node: server check%s\n' "$B" "$N"
note "$(date -u '+%Y-%m-%d %H:%M UTC')  host $(hostname)  user $(id -un)"
if [ "$CAN_ROOT" -eq 0 ]; then note "Not root: the firewall and SSH settings are skipped. Run with sudo to include them."; fi

# ---- 1. System ----
section "1. System"
if [ -r /etc/os-release ]; then
  OS_ID=$(. /etc/os-release && printf '%s' "${ID:-}")
  OS_VER=$(. /etc/os-release && printf '%s' "${VERSION_ID:-}")
  if [ "$OS_ID" = ubuntu ] && ! num_lt "${OS_VER:-0}" 22.04; then
    ok "Ubuntu $OS_VER ($(uname -m))"
  else
    warn "This is ${OS_ID:-unknown} ${OS_VER:-}; these scripts are written for Ubuntu 22.04 and 24.04"
  fi
else
  fail "Not a Linux server with /etc/os-release ($(uname -s))" "These scripts are for an Ubuntu VPS"
fi

if have nproc; then ok "$(nproc) vCPU"; fi

MEM=$(mem_total_mb)
SWAP=$(swap_total_mb)
if [ -n "$MEM" ]; then
  if [ "$MEM" -lt 900 ]; then
    fail "${MEM} MB of memory" "The node needs 1 GB"
  elif [ "$MEM" -lt 1900 ] && [ "${SWAP:-0}" -lt 500 ]; then
    warn "${MEM} MB of memory and no swap: building the image can run out of memory" "prepare.sh can add a 2 GB swap file"
  else
    ok "${MEM} MB of memory, ${SWAP:-0} MB swap"
  fi
fi

FREE=$(disk_free_gb /)
if [ -n "$FREE" ]; then
  if [ "$FREE" -lt 3 ]; then
    fail "${FREE} GB free on /" "Docker images and logs need room; free up or grow the disk"
  elif [ "$FREE" -lt 8 ]; then
    warn "${FREE} GB free on /: enough to start, tight over time"
  else
    ok "${FREE} GB free on /"
  fi
fi

if have timedatectl; then
  if [ "$(timedatectl show -p NTPSynchronized --value 2>/dev/null)" = yes ]; then
    ok "Clock is synchronised"
  else
    fail "Clock is not synchronised" "sudo timedatectl set-ntp true (delegations carry timestamps)"
  fi
fi
if [ -f /var/run/reboot-required ]; then warn "A reboot is pending (installed updates need it)" "sudo reboot, at a quiet moment"; fi

# ---- 2. Access ----
section "2. Access"
LOGIN_USER=${SUDO_USER:-$(id -un)}
if [ "$LOGIN_USER" = root ]; then
  warn "You are working as root" "Create a normal user for the node (prepare.sh does it)"
else
  ok "Working as $LOGIN_USER, not root"
fi
LOGIN_HOME=$(getent passwd "$LOGIN_USER" 2>/dev/null | cut -d: -f6)
if [ -n "$LOGIN_HOME" ]; then
  KEYS=$(as_root cat "$LOGIN_HOME/.ssh/authorized_keys" 2>/dev/null | grep -cE '(ssh-(ed25519|rsa)|ecdsa-sha2-|sk-)' || true)
  if [ "${KEYS:-0}" -gt 0 ]; then
    ok "$LOGIN_USER has $KEYS SSH key(s)"
  else
    warn "$LOGIN_USER has no SSH key in ~/.ssh/authorized_keys" "Add one before password login is turned off"
  fi
fi
if [ "$CAN_ROOT" -eq 1 ] && have sshd; then
  PW=$(sshd_setting passwordauthentication)
  KBD=$(sshd_setting kbdinteractiveauthentication)
  ROOTLOGIN=$(sshd_setting permitrootlogin)
  if [ -z "$PW" ]; then
    skip "SSH settings could not be read (sshd -T gave nothing)"
  elif [ "$PW" = no ] && [ "${KBD:-no}" = no ]; then
    ok "SSH password login is off"
  else
    fail "SSH still accepts passwords" "prepare.sh turns it off after it has checked your key works"
  fi
  case "$ROOTLOGIN" in
    "") ;;
    no) ok "SSH root login is off" ;;
    without-password | prohibit-password) warn "root can still log in over SSH with a key" "PermitRootLogin no is safer once your own user works" ;;
    *) fail "SSH root login with a password is allowed (PermitRootLogin ${ROOTLOGIN:-?})" "prepare.sh turns it off" ;;
  esac
  note "SSH listens on port $SSH_PORT"
else
  skip "SSH settings (needs sudo)"
fi

# ---- 3. Firewall and open ports ----
section "3. Firewall and open ports"
if ! have ufw; then
  fail "ufw is not installed" "prepare.sh installs and configures it"
elif [ "$CAN_ROOT" -eq 1 ]; then
  UFW=$(as_root ufw status verbose 2>/dev/null)
  if printf '%s' "$UFW" | grep -q '^Status: active'; then
    ok "Firewall is on"
    if printf '%s' "$UFW" | grep -q 'deny (incoming)'; then
      ok "Incoming traffic is denied by default"
    else
      fail "Incoming traffic is not denied by default" "sudo ufw default deny incoming"
    fi
    for p in "$SSH_PORT" 80 443; do
      if printf '%s' "$UFW" | grep -Eq "^${p}(/tcp)?[[:space:]].*(ALLOW|LIMIT)" ||
        { [ "$p" = "$SSH_PORT" ] && printf '%s' "$UFW" | grep -Eq '^OpenSSH[[:space:]].*(ALLOW|LIMIT)'; }; then
        ok "Port $p is allowed"
      else
        fail "Port $p is not allowed in the firewall" "sudo ufw allow ${p}/tcp"
      fi
    done
  else
    fail "Firewall is off" "prepare.sh turns it on with only SSH, 80 and 443 open"
  fi
else
  skip "Firewall rules (needs sudo)"
fi

if have ss; then
  # Every TCP port that listens on all interfaces. Anything besides SSH, 80 and 443 deserves a look.
  WILD=$(ss -H -tln 2>/dev/null | awk '{ print $4 }' | grep -E '^(0\.0\.0\.0|\*|\[::\]):' | sed 's/.*://' | sort -un)
  EXTRA=""
  for p in $WILD; do
    case "$p" in
      "$SSH_PORT" | 80 | 443) ;;
      8787) fail "Port 8787 (the node) listens on every interface" "It must be reachable through Caddy only; start it with docker compose, which keeps it internal" ;;
      *) EXTRA="$EXTRA $p" ;;
    esac
  done
  if [ -n "$EXTRA" ]; then
    warn "Other ports listen on every interface:$EXTRA" "Fine if the firewall blocks them. Note that ports published by Docker go around ufw"
  else
    ok "Nothing listens publicly besides SSH, 80 and 443"
  fi
fi

# ---- 4. Updates ----
section "4. Security updates"
if have dpkg && dpkg -s unattended-upgrades >/dev/null 2>&1; then
  if apt-config dump 2>/dev/null | grep -q 'APT::Periodic::Unattended-Upgrade "1"'; then
    ok "Automatic security updates are on"
  else
    warn "unattended-upgrades is installed but switched off" "prepare.sh switches it on"
  fi
else
  warn "Automatic security updates are not installed" "prepare.sh installs unattended-upgrades"
fi

# ---- 5. Software ----
section "5. Software"
for c in git curl; do
  if have "$c"; then ok "$c is installed"; else fail "$c is missing" "sudo apt-get install -y $c"; fi
done
DOCKER_OK=0
if have docker; then
  ok "Docker $(docker --version 2>/dev/null | sed 's/^Docker version \([^,]*\).*/\1/')"
  if docker compose version >/dev/null 2>&1; then
    ok "Docker compose plugin $(docker compose version --short 2>/dev/null)"
  else
    fail "The docker compose plugin is missing" "prepare.sh installs it"
  fi
  if docker info >/dev/null 2>&1; then
    ok "This user can talk to Docker"
    DOCKER_OK=1
  else
    fail "This user cannot talk to Docker" "Add the user to the docker group (prepare.sh), then log out and in again"
  fi
else
  fail "Docker is not installed" "prepare.sh installs it"
fi
NODE=$(node_major)
if [ -z "$NODE" ]; then
  fail "Node.js is not installed" "prepare.sh installs Node 22 (the sponsor commands need it)"
elif [ "$NODE" -lt 22 ]; then
  fail "Node.js $NODE is too old" "The sponsor commands need Node 22"
else
  ok "Node.js $(node -v 2>/dev/null)"
fi

# ---- 6. Network and domain ----
section "6. Network and domain"
PUBLIC_IP=$(public_ipv4)
if [ -n "$PUBLIC_IP" ]; then ok "Public address $PUBLIC_IP"; else warn "Could not find this server's public address (no outbound https?)"; fi
if curl -fsS --max-time 8 -o /dev/null https://acme-v02.api.letsencrypt.org/directory 2>/dev/null; then
  ok "Let's Encrypt is reachable (Caddy gets the certificate there)"
else
  warn "Let's Encrypt is not reachable from here" "The certificate cannot be issued without outbound https"
fi
if [ -z "$DOMAIN" ]; then
  skip "Domain checks: no domain yet (pass --domain relay.example.com, or set PUBLIC_DOMAIN in .env)"
else
  A=$(resolve_a "$DOMAIN" | tr '\n' ' ' | sed 's/ $//')
  if [ -z "$A" ]; then
    fail "$DOMAIN has no A record" "Point an A record at ${PUBLIC_IP:-this server} and wait for DNS"
  elif [ -n "$PUBLIC_IP" ] && printf ' %s ' "$A" | grep -q " $PUBLIC_IP "; then
    ok "$DOMAIN points at this server ($A)"
  else
    fail "$DOMAIN points at $A, not at ${PUBLIC_IP:-this server}" "Fix the A record. On Cloudflare, set it to DNS only (grey cloud) so Caddy can get the certificate"
  fi
  AAAA=$(resolve_aaaa "$DOMAIN" | tr '\n' ' ' | sed 's/ $//')
  if [ -n "$AAAA" ]; then
    warn "$DOMAIN also has an IPv6 record ($AAAA)" "It must reach this server too, or certificate checks over IPv6 fail. Remove it if unsure"
  fi
fi
if have ss; then
  for p in 80 443; do
    OWNER=$(as_root ss -H -tlnp "sport = :$p" 2>/dev/null | sed -n 's/.*users:(("\([^"]*\)".*/\1/p' | sort -u | tr '\n' ' ' | sed 's/ $//')
    if ! ss -H -tln "sport = :$p" 2>/dev/null | grep -q .; then
      ok "Port $p is free for Caddy"
    elif [ -z "$OWNER" ] || printf '%s' "$OWNER" | grep -Eq 'docker-proxy|caddy'; then
      ok "Port $p is served${OWNER:+ by $OWNER}"
    else
      fail "Port $p is taken by $OWNER" "Stop that service; Caddy needs ports 80 and 443"
    fi
  done
fi

# ---- 7. Node configuration ----
section "7. Node configuration (relayer/.env)"
RELAYER=""
if [ ! -f "$ENV_FILE" ]; then
  skip "No relayer/.env yet: setup.sh writes it"
elif [ ! -r "$ENV_FILE" ]; then
  skip "relayer/.env is not readable by $(id -un)"
else
  MODE=$(file_mode "$ENV_FILE")
  if [ "$MODE" = 600 ] || [ "$MODE" = 400 ]; then
    ok ".env is private (mode $MODE, owner $(file_owner "$ENV_FILE"))"
  else
    fail ".env has mode $MODE: other users on the server can read the relayer key" "chmod 600 relayer/.env"
  fi
  if have git && git -C "$REPO_DIR" ls-files --error-unmatch relayer/.env >/dev/null 2>&1; then
    fail ".env is tracked by git" "git rm --cached relayer/.env, and treat the key in it as leaked"
  fi

  if [ "$(env_get "$ENV_FILE" CHAIN_ID)" = "$CHAIN_ID_DEC" ]; then ok "CHAIN_ID is $CHAIN_ID_DEC (Polygon)"; else fail "CHAIN_ID is not $CHAIN_ID_DEC"; fi

  if [ -f "$DEPLOY_FILE" ]; then
    WRONG=""
    for pair in $ADDRESS_MAP; do
      var=${pair%%:*}
      want=$(json_get "$DEPLOY_FILE" "${pair##*:}")
      got=$(env_get "$ENV_FILE" "$var")
      if [ -n "$want" ] && [ "$(lower "$got")" != "$(lower "$want")" ]; then
        # the timelock is only watched for alerts; empty is allowed
        if [ "$var" = UPGRADE_TIMELOCK ] && [ -z "$got" ]; then continue; fi
        WRONG="$WRONG $var"
      fi
    done
    if [ -z "$WRONG" ]; then
      ok "Contract addresses match deployments/137.json"
    else
      fail "These addresses differ from deployments/137.json:$WRONG" "setup.sh offers to correct them"
    fi
  else
    warn "deployments/137.json not found; contract addresses were not compared"
  fi

  RPC=$(env_get "$ENV_FILE" RPC_URL)
  if [ -z "$RPC" ]; then
    fail "RPC_URL is empty"
  else
    CID=$(rpc_chain_id "$RPC")
    if [ "$CID" = "$CHAIN_ID_HEX" ]; then
      ok "The RPC answers for Polygon"
    elif [ -n "$CID" ]; then
      fail "The RPC answers for chain $CID, not Polygon ($CHAIN_ID_HEX)"
    else
      fail "The RPC does not answer" "Check RPC_URL and the provider's key"
    fi
    if is_free_rpc "$RPC"; then warn "RPC_URL is a free public endpoint" "Use a paid plan before you publish the node; the doctor refuses a published node without one"; fi
    if [ -z "$(env_get "$ENV_FILE" RPC_URLS)" ]; then warn "No fallback RPC (RPC_URLS is empty)" "One provider outage stops the node"; fi
  fi

  URL=$(env_get "$ENV_FILE" PUBLIC_RELAYER_URL)
  ENV_DOMAIN=$(env_get "$ENV_FILE" PUBLIC_DOMAIN)
  if [ -z "$ENV_DOMAIN" ]; then
    fail "PUBLIC_DOMAIN is empty" "docker compose needs it for the certificate"
  elif [ "$URL" = "https://$ENV_DOMAIN" ] || [ "$URL" = "https://$ENV_DOMAIN/" ]; then
    ok "Public URL is https://$ENV_DOMAIN"
  else
    fail "PUBLIC_RELAYER_URL and PUBLIC_DOMAIN disagree" "PUBLIC_RELAYER_URL must be https://$ENV_DOMAIN"
  fi

  SOURCE=$(env_get "$ENV_FILE" RELAYER_KEY_SOURCE)
  PAYOUT=$(env_get "$ENV_FILE" SPONSOR_PAYOUT_ADDRESS)
  if [ "${SOURCE:-env}" = env ]; then
    if [ -z "$(env_get "$ENV_FILE" RELAYER_PRIVATE_KEY)" ]; then
      fail "RELAYER_PRIVATE_KEY is empty"
    else
      RELAYER=$(relayer_address)
      warn "The relayer key is a raw key in .env${RELAYER:+ (address $RELAYER)}" "Fine to start with a small balance. Move to RELAYER_KEY_SOURCE=keystore later (docs/sponsor-setup.md)"
    fi
  else
    ok "The relayer key is not a raw key in .env ($SOURCE)"
  fi
  if ! is_address "${PAYOUT:-}"; then
    fail "SPONSOR_PAYOUT_ADDRESS is not an address"
  elif [ -n "$RELAYER" ] && [ "$(lower "$RELAYER")" = "$(lower "$PAYOUT")" ]; then
    fail "The payout address is the relayer address" "Use a separate cold wallet (ideally a Safe) for payouts"
  else
    ok "Payout address $PAYOUT"
  fi

  DASH=$(env_get "$ENV_FILE" DASHBOARD_TOKEN)
  if [ -z "$DASH" ]; then
    warn "DASHBOARD_TOKEN is empty: the /admin dashboard is off"
  elif [ ${#DASH} -lt 32 ]; then
    fail "DASHBOARD_TOKEN is short (${#DASH} characters)" "Use openssl rand -hex 24"
  else
    ok "Dashboard token is set"
  fi
  if [ -z "$(env_get "$ENV_FILE" METRICS_TOKEN)" ]; then warn "METRICS_TOKEN is empty: /metrics is off"; fi
  if [ -z "$(env_get "$ENV_FILE" ALERT_WEBHOOK_URL)" ]; then warn "ALERT_WEBHOOK_URL is empty" "Nobody is told when the relayer runs low or a transaction is stuck"; fi
  if [ "$(env_get "$ENV_FILE" CORS_ORIGINS)" = "*" ]; then warn "CORS_ORIGINS is *" "List your web origins; the doctor refuses a published node with *"; fi
  for cap in MAX_GAS_WEI MAX_GAS_UNITS MAX_FEE_PER_GAS_GWEI MIN_RELAYER_BALANCE_WEI; do
    v=$(env_get "$ENV_FILE" "$cap")
    if [ -z "$v" ] || [ "$v" = 0 ]; then warn "$cap is off" "Set it from the fee math in docs/sponsor-setup.md"; fi
  done
  if [ -z "$(env_get "$ENV_FILE" THIRDWEB_SECRET_KEY)" ] && [ -z "$(env_get "$ENV_FILE" THIRDWEB_CLIENT_ID)" ] && [ "$(env_get "$ENV_FILE" METADATA_STORAGE)" != filone ]; then
    warn "No metadata storage key (THIRDWEB_SECRET_KEY)" "sponsor:onboard cannot publish your metadata without one"
  fi

  if [ -n "$RELAYER" ]; then
    BAL=$(relayer_balance_pol "$RELAYER")
    if [ -z "$BAL" ]; then
      skip "Relayer balance: the RPC did not answer"
    elif num_lt "$BAL" 0.0001; then
      fail "The relayer holds no POL" "Send gas money to $RELAYER"
    elif num_lt "$BAL" 0.5; then
      warn "The relayer holds $BAL POL" "Top it up; the node pauses when it runs low"
    else
      ok "The relayer holds $BAL POL"
    fi
  fi
  if [ -f "$RELAYER_DIR/sponsor.plans.json" ]; then
    ok "Plans are defined (sponsor.plans.json)"
    # The URL in the plan file is the one that gets published in the metadata; it must be this node's address.
    PLAN_URL=$(json_get "$RELAYER_DIR/sponsor.plans.json" relayerEndpoint)
    if [ -n "$PLAN_URL" ] && [ "${PLAN_URL%/}" != "${URL%/}" ]; then
      fail "sponsor.plans.json publishes $PLAN_URL, but PUBLIC_RELAYER_URL is ${URL:-empty}" "npm run sponsor:plans:configure, and give it this node's URL"
    fi
  else
    warn "No sponsor.plans.json yet" "npm run sponsor:plans:configure"
  fi
fi

# ---- 8. The running node ----
section "8. The running node"
if [ "$DOCKER_OK" -eq 0 ]; then
  skip "Docker is not usable by this user; containers were not checked"
else
  for svc in relayer caddy; do
    ID=$(cd "$RELAYER_DIR" && docker compose ps -q "$svc" 2>/dev/null | head -n 1)
    if [ -z "$ID" ]; then
      skip "$svc is not started"
      continue
    fi
    STATE=$(docker inspect -f '{{.State.Status}}{{if .State.Health}} {{.State.Health.Status}}{{end}}' "$ID" 2>/dev/null)
    case "$STATE" in
      "running healthy" | running) ok "$svc is $STATE" ;;
      "running starting") warn "$svc is still starting" ;;
      *) fail "$svc is ${STATE:-not running}" "cd relayer && docker compose logs --tail 50 $svc" ;;
    esac
    if [ "$(docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' "$ID" 2>/dev/null)" != unless-stopped ]; then
      warn "$svc does not restart on its own after a reboot"
    fi
    PORTS=$(docker inspect -f '{{range $p, $c := .NetworkSettings.Ports}}{{if $c}}{{$p}} {{end}}{{end}}' "$ID" 2>/dev/null)
    if [ "$svc" = relayer ] && [ -n "$PORTS" ]; then
      fail "The node publishes ports to the internet: $PORTS" "Only Caddy may publish ports (and Docker goes around ufw)"
    fi
  done
fi
if [ -n "$DOMAIN" ]; then
  BODY=$(mktemp)
  CODE=$(curl -sS --max-time 12 -o "$BODY" -w '%{http_code}' "https://$DOMAIN/health" 2>/dev/null || true)
  REPORTED=$(sed -n 's/.*"relayer"[[:space:]]*:[[:space:]]*"\(0x[0-9a-fA-F]*\)".*/\1/p' "$BODY" | head -n 1)
  case "$CODE" in
    200) ok "https://$DOMAIN/health answers and the node is ready" ;;
    503) warn "https://$DOMAIN/health answers, but the node is not ready" "$(sed -n 's/.*"problems"[[:space:]]*:[[:space:]]*\[\([^]]*\)\].*/\1/p' "$BODY" | cut -c1-200)" ;;
    000 | "") skip "https://$DOMAIN/health does not answer (not started, DNS, or no certificate yet)" ;;
    *) fail "https://$DOMAIN/health answers with HTTP $CODE" "cd relayer && docker compose logs --tail 50" ;;
  esac
  if [ -n "$REPORTED" ] && [ -n "$RELAYER" ]; then
    if [ "$(lower "$REPORTED")" = "$(lower "$RELAYER")" ]; then
      ok "The node reports the relayer address from .env"
    else
      fail "The node reports relayer $REPORTED, but .env holds $RELAYER" "Another node answers on this domain, or the container runs an old .env: docker compose up -d"
    fi
  fi
  rm -f "$BODY"
  if [ "$CODE" = 200 ] || [ "$CODE" = 503 ]; then
    REDIRECT=$(curl -s --max-time 8 -o /dev/null -w '%{http_code}' "http://$DOMAIN/health" 2>/dev/null || true)
    case "$REDIRECT" in
      301 | 302 | 307 | 308) ok "Plain http is redirected to https" ;;
      *) warn "Plain http answers with HTTP ${REDIRECT:-nothing} instead of a redirect" ;;
    esac
  fi
else
  skip "Public endpoint: no domain yet"
fi

# ---- Summary ----
printf '\n%s%d passed, %d to look at, %d blocking%s\n' "$B" "$PASSES" "$WARNS" "$FAILS" "$N"
if [ -f "$ENV_FILE" ] && [ -d "$RELAYER_DIR/node_modules" ]; then
  note "For the on-chain side (registered, verified, plans): cd relayer && npm run sponsor:doctor"
fi
if [ "$FAILS" -gt 0 ]; then exit 1; fi
exit 0
