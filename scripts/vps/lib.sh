#!/usr/bin/env bash
# Shared helpers for the VPS scripts (check.sh, prepare.sh, setup.sh). Sourced, never run.
# Written for bash on Ubuntu 22.04+; this repo is the standalone fee-market/relayer checkout.

VPS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Repo root = this package (scripts/vps → ../..)
RELAYER_DIR="$(cd "$VPS_DIR/../.." && pwd)"
REPO_DIR="$RELAYER_DIR"
ENV_FILE="$RELAYER_DIR/.env"
ENV_EXAMPLE="$RELAYER_DIR/.env.example"
DEPLOY_FILE="$RELAYER_DIR/deployments/137.json"
CHAIN_ID_DEC=137
CHAIN_ID_HEX=0x89

# .env variable : key in deployments/137.json
ADDRESS_MAP="FEE_MARKET_REGISTRY:feeMarketRegistry
SPONSOR_RELAYER_ENFORCER:sponsorRelayerEnforcer
REDEEMER_RESTRICTION_ENFORCER:redeemerRestrictionEnforcer
DELEGATION_MANAGER:delegationManager
DELEGATOR_IMPLEMENTATION:delegatorImplementation
LIMITED_CALLS_ENFORCER:limitedCallsEnforcer
EXACT_EXECUTION_BATCH_ENFORCER:exactExecutionBatchEnforcer
TIMESTAMP_ENFORCER:timestampEnforcer
UPGRADE_TIMELOCK:upgradeTimelock"

if [ -t 1 ]; then
  B=$'\033[1m'; D=$'\033[2m'; R=$'\033[31m'; G=$'\033[32m'; Y=$'\033[33m'; C=$'\033[36m'; N=$'\033[0m'
else
  B=""; D=""; R=""; G=""; Y=""; C=""; N=""
fi

# ---- Output ----

PASSES=0
WARNS=0
FAILS=0

section() { printf '\n%s%s%s\n' "$B" "$1" "$N"; }
note() { printf '   %s%s%s\n' "$D" "$1" "$N"; }
say() { printf '%s\n' "$1"; }
skip() { printf ' %s-%s %s\n' "$D" "$N" "$1"; }
ok() {
  PASSES=$((PASSES + 1))
  printf ' %s✓%s %s\n' "$G" "$N" "$1"
}
# warn and fail take an optional second argument: what to do about it.
warn() {
  WARNS=$((WARNS + 1))
  printf ' %s!%s %s\n' "$Y" "$N" "$1"
  if [ -n "${2:-}" ]; then note "→ $2"; fi
}
fail() {
  FAILS=$((FAILS + 1))
  printf ' %s✗%s %s\n' "$R" "$N" "$1"
  if [ -n "${2:-}" ]; then note "→ $2"; fi
}
die() {
  printf '%s✗ %s%s\n' "$R" "$1" "$N" >&2
  exit 1
}

have() { command -v "$1" >/dev/null 2>&1; }
lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }
trim() { printf '%s' "$1" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//'; }

# ---- Questions ----

require_tty() {
  if [ ! -t 0 ]; then die "This script asks questions. Run it in a terminal, not through a pipe."; fi
}

# ask VAR "Question" [default]
ask() {
  local __var=$1 __q=$2 __def=${3:-} __a
  if [ -n "$__def" ]; then
    printf '%s?%s %s %s[%s]%s: ' "$C" "$N" "$__q" "$D" "$__def" "$N"
  else
    printf '%s?%s %s: ' "$C" "$N" "$__q"
  fi
  IFS= read -r __a || die "Input closed."
  __a=$(trim "$__a")
  if [ -z "$__a" ]; then __a=$__def; fi
  printf -v "$__var" '%s' "$__a"
}

# ask_secret VAR "Question": the answer is not shown while typing and is never printed back.
ask_secret() {
  local __var=$1 __q=$2 __a
  printf '%s?%s %s %s(hidden)%s: ' "$C" "$N" "$__q" "$D" "$N"
  IFS= read -rs __a || die "Input closed."
  printf '\n'
  __a=$(trim "$__a")
  printf -v "$__var" '%s' "$__a"
}

# confirm "Question" [y|n]: returns 0 for yes. The default is used when the answer is empty.
confirm() {
  local q=$1 def=${2:-y} a hint="y/N"
  if [ "$def" = y ]; then hint="Y/n"; fi
  while true; do
    printf '%s?%s %s %s[%s]%s: ' "$C" "$N" "$q" "$D" "$hint" "$N"
    IFS= read -r a || die "Input closed."
    a=$(lower "$(trim "$a")")
    if [ -z "$a" ]; then a=$def; fi
    case "$a" in
      y | yes) return 0 ;;
      n | no) return 1 ;;
    esac
    say "  Please answer y or n."
  done
}

# ---- Validation ----

RE_ADDRESS='^0x[a-fA-F0-9]{40}$'
RE_DOMAIN='^([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$'
# No spaces, quotes, $ or #: the value goes into an env file that both dotenv and docker compose read.
RE_HTTPS_URL='^https://[A-Za-z0-9._~:/?@!&=+,%-]+$'
RE_ENV_SAFE='^[A-Za-z0-9._~:/?@!&=+,%-]*$'
RE_IPV4='^([0-9]{1,3}\.){3}[0-9]{1,3}$'
RE_USER='^[a-z_][a-z0-9_-]{0,31}$'

is_address() { [[ $1 =~ $RE_ADDRESS ]]; }
is_domain() { [[ $1 =~ $RE_DOMAIN ]]; }
is_https_url() { [[ $1 =~ $RE_HTTPS_URL ]]; }
is_env_safe() { [[ $1 =~ $RE_ENV_SAFE ]]; }
is_ipv4() { [[ $1 =~ $RE_IPV4 ]]; }
is_username() { [[ $1 =~ $RE_USER ]]; }

# Canonical public base URL for a domain. Wallets append /relay, /subscribe, /health themselves —
# do NOT include /relay here or they hit /relay/relay.
public_relay_url() { printf 'https://%s' "$1"; }

# True when PUBLIC_RELAYER_URL matches PUBLIC_DOMAIN (strip a mistaken trailing /relay).
url_matches_domain() {
  local url=$1 domain=$2
  url=${url%/}
  url=${url%/relay}
  case "$url" in
    "https://$domain" | "http://$domain") return 0 ;;
  esac
  return 1
}

# ---- Env file ----

# env_get FILE KEY: the value of the first KEY= line, without surrounding quotes. Empty when missing.
env_get() {
  if [ ! -f "$1" ]; then return 0; fi
  awk -v k="$2" 'index($0, k "=") == 1 { v = substr($0, length(k) + 2); sub(/[[:space:]]+$/, "", v); print v; exit }' "$1" |
    sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/" || true
}

# env_set FILE KEY VALUE: replaces the first KEY= line or appends one. The value never appears in a command line.
env_set() {
  local file=$1 tmp
  tmp=$(mktemp "${file}.XXXXXX") || die "Cannot write next to $file"
  chmod 600 "$tmp"
  if KEY="$2" VALUE="$3" awk '
      BEGIN { k = ENVIRON["KEY"]; v = ENVIRON["VALUE"]; done = 0 }
      index($0, k "=") == 1 && !done { print k "=" v; done = 1; next }
      { print }
      END { if (!done) print k "=" v }' "$file" >"$tmp"; then
    mv "$tmp" "$file"
  else
    rm -f "$tmp"
    die "Could not update $2 in $file"
  fi
}

file_mode() { stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1" 2>/dev/null; }
file_owner() { stat -c '%U' "$1" 2>/dev/null || stat -f '%Su' "$1" 2>/dev/null; }

# json_get FILE KEY: a string value from a flat (or lightly nested) JSON file, without needing Node.
json_get() {
  sed -n 's/.*"'"$2"'"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$1" | head -n 1
}

# Address default: deployments/137.json, else .env.example.
deploy_addr() {
  local key=$1 env_key=$2 want
  want=$(json_get "$DEPLOY_FILE" "$key")
  if [ -z "$want" ] && [ -f "$ENV_EXAMPLE" ]; then
    want=$(env_get "$ENV_EXAMPLE" "$env_key")
  fi
  printf '%s' "$want"
}

random_hex() { # bytes
  if have openssl; then
    openssl rand -hex "$1"
  else
    od -An -N "$1" -tx1 /dev/urandom | tr -d ' \n'
  fi
}

# ---- System ----

# as_root CMD...: runs as root when that needs no password. Returns 99 when it cannot, so the caller can skip.
as_root() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  elif have sudo && sudo -n true 2>/dev/null; then
    sudo -n "$@"
  else
    return 99
  fi
}

node_major() {
  if have node; then node -p 'process.versions.node.split(".")[0]' 2>/dev/null; fi
}

mem_total_mb() { awk '/^MemTotal:/ { printf "%d", $2 / 1024 }' /proc/meminfo 2>/dev/null || true; }
swap_total_mb() { awk '/^SwapTotal:/ { printf "%d", $2 / 1024 }' /proc/meminfo 2>/dev/null || true; }
disk_free_gb() { df -Pk "${1:-/}" 2>/dev/null | awk 'NR == 2 { printf "%d", $4 / 1024 / 1024 }' || true; }

ssh_port() {
  local p
  p=$(as_root sshd -T 2>/dev/null | awk '$1 == "port" { print $2; exit }' || true)
  printf '%s' "${p:-22}"
}

# One sshd setting as sshd itself resolves it (needs root). Empty when it cannot be read.
sshd_setting() { as_root sshd -T 2>/dev/null | awk -v k="$1" '$1 == k { print $2; exit }' || true; }

# Lines of an authorized_keys file that are plain keys. Lines with options in front are left out on purpose: cloud
# images put a forced command on root's key ("Please login as the user ubuntu"), and copying that would lock the new user out.
plain_keys() {
  if [ -r "$1" ]; then grep -E '^(ssh-(ed25519|rsa)|ecdsa-sha2-[a-z0-9-]+|sk-(ssh-ed25519|ecdsa-sha2-nistp256)@openssh\.com) ' "$1" 2>/dev/null; fi
}
count_keys() { plain_keys "$1" | grep -c . || true; }

# ---- Network ----

# The address the internet sees for this server. Asks a public "what is my IP" service; only the address is revealed.
public_ipv4() {
  curl -4 -fsS --max-time 6 https://api.ipify.org 2>/dev/null ||
    curl -4 -fsS --max-time 6 https://ifconfig.me/ip 2>/dev/null || true
}
resolve_a() { getent ahostsv4 "$1" 2>/dev/null | awk '{ print $1 }' | sort -u || true; }
# getent answers with IPv4-mapped addresses when a name has no AAAA record; those are not real IPv6 records.
resolve_aaaa() { getent ahostsv6 "$1" 2>/dev/null | awk '{ print $1 }' | grep -v '^::ffff:' | sort -u || true; }

# rpc_call URL METHOD PARAMS_JSON: prints the "result" string. The URL goes to curl on stdin, so an API key in it
# does not show up in the process list.
rpc_call() {
  printf 'url = "%s"\n' "$1" |
    curl -fsS --max-time 12 -K - -H 'content-type: application/json' \
      --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$2\",\"params\":$3}" 2>/dev/null |
    sed -n 's/.*"result"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' || true
}
rpc_chain_id() { rpc_call "$1" eth_chainId '[]'; }

is_free_rpc() {
  case "$1" in
    *publicnode.com* | *polygon-rpc.com* | *llamarpc.com* | *1rpc.io* | *drpc.org* | *blastapi.io*) return 0 ;;
  esac
  return 1
}

# ---- Relayer ----

# The relayer address for the key in .env. Prints nothing when the key is not a raw key or the packages are not installed.
relayer_address() {
  if [ ! -f "$ENV_FILE" ] || [ ! -d "$RELAYER_DIR/node_modules/viem" ] || ! have node; then return 0; fi
  (cd "$RELAYER_DIR" && node --input-type=module -e '
    import { readFileSync } from "node:fs";
    import { privateKeyToAccount } from "viem/accounts";
    const m = /^RELAYER_PRIVATE_KEY=["\x27]?(0x[0-9a-fA-F]{64})["\x27]?\s*$/m.exec(readFileSync(".env", "utf8"));
    if (m) console.log(privateKeyToAccount(m[1]).address);
  ' 2>/dev/null) || true
}

# wei (hex or decimal) to POL with four decimals.
wei_to_pol() {
  awk -v w="$(printf '%d' "$1" 2>/dev/null || echo 0)" 'BEGIN { printf "%.4f", w / 1e18 }'
}

# relayer_balance_pol ADDRESS: balance in POL, or empty when the RPC does not answer.
relayer_balance_pol() {
  local rpc hex
  rpc=$(env_get "$ENV_FILE" RPC_URL)
  if [ -z "$rpc" ]; then return 0; fi
  hex=$(rpc_call "$rpc" eth_getBalance "[\"$1\",\"latest\"]")
  if [ -z "$hex" ]; then return 0; fi
  if have node; then
    node -e 'const w = BigInt(process.argv[1]); console.log((Number(w / 10n ** 12n) / 1e6).toFixed(4))' "$hex" 2>/dev/null
  else
    wei_to_pol "$hex"
  fi
}

# Compares two positive decimal numbers: returns 0 when $1 < $2.
num_lt() { awk -v a="$1" -v b="$2" 'BEGIN { exit !(a + 0 < b + 0) }'; }
