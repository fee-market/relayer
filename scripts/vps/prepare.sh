#!/usr/bin/env bash
# Prepares a fresh Ubuntu VPS for a sponsor node. Run once, as root, from a clone of this repository:
#
#   sudo bash scripts/vps/prepare.sh
#   sudo bash scripts/vps/prepare.sh --dry-run   # asks the same questions, prints the commands, changes nothing
#
# It walks through nine steps and asks before each one: a normal user for the node, SSH with keys only, the
# firewall (SSH, 80 and 443), automatic security updates, clock sync, a swap file on small servers, Docker,
# Node.js LTS (security-patched), and handing the repository to the new user. Every step can be skipped, and running it again is safe:
# a step that is already done says so. It installs nothing related to keys and never sees a secret.
set -euo pipefail
# shellcheck source=lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

DRY=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=1 ;;
    -h | --help)
      sed -n '2,10p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) die "Unknown option: $arg (see --help)" ;;
  esac
done

# run CMD...: runs it, or only prints it in a dry run.
run() {
  if [ "$DRY" -eq 1 ]; then
    printf '   %s+ %s%s\n' "$D" "$*" "$N"
  else
    "$@"
  fi
}
# run_sh "pipeline": the same for a command that needs a shell.
run_sh() {
  if [ "$DRY" -eq 1 ]; then
    printf '   %s+ %s%s\n' "$D" "$1" "$N"
  else
    bash -c "$1"
  fi
}
# write_file PATH MODE <<EOF ... EOF
write_file() {
  local path=$1 mode=$2 content
  content=$(cat)
  if [ "$DRY" -eq 1 ]; then
    printf '   %s+ write %s (mode %s):%s\n' "$D" "$path" "$mode" "$N"
    printf '%s\n' "$content" | sed "s/^/       /"
  else
    printf '%s\n' "$content" >"$path"
    chmod "$mode" "$path"
  fi
}

STEP=0
STEPS=9
step() {
  STEP=$((STEP + 1))
  section "Step $STEP of $STEPS: $1"
}

trap 'printf "\n%sStopped.%s Run the script again to continue; finished steps are detected.\n" "$Y" "$N"; exit 130' INT

# ---- Before anything else ----
require_tty
printf '%sfee.market sponsor node: server preparation%s\n' "$B" "$N"
if [ "$DRY" -eq 1 ]; then
  note "Dry run: commands are printed, nothing is changed."
else
  if [ "$(id -u)" -ne 0 ]; then die "Run this with sudo: sudo bash scripts/vps/prepare.sh"; fi
  OS_ID=""
  if [ -r /etc/os-release ]; then OS_ID=$(. /etc/os-release && printf '%s' "${ID:-}"); fi
  if [ "$OS_ID" != ubuntu ]; then die "This script is for Ubuntu (found: ${OS_ID:-unknown}). Nothing was changed."; fi
fi
export DEBIAN_FRONTEND=noninteractive
NODE_USER=""
NODE_HOME=""
SSH_PORT=$(ssh_port)

# ---- 1. Packages ----
step "Base packages"
note "Updates the package list and installs: ca-certificates curl gnupg git ufw unattended-upgrades openssl"
if confirm "Install them now?"; then
  run apt-get update -y
  run apt-get install -y ca-certificates curl gnupg git ufw unattended-upgrades openssl
  ok "Base packages are installed"
else
  skip "Skipped"
fi

# ---- 2. A user for the node ----
step "A normal user for the node"
note "The node should not run as root. This user owns the code and the .env file, and logs in with an SSH key."
DEFAULT_USER=sponsor
if [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != root ]; then DEFAULT_USER=$SUDO_USER; fi
while true; do
  ask NODE_USER "User name" "$DEFAULT_USER"
  if [ "$NODE_USER" = root ]; then
    say "  Not root, please."
  elif is_username "$NODE_USER"; then
    break
  else
    say "  Use lower-case letters, digits, - and _ (start with a letter)."
  fi
done
if id "$NODE_USER" >/dev/null 2>&1; then
  ok "User $NODE_USER exists"
else
  run adduser --disabled-password --gecos "" "$NODE_USER"
  ok "User $NODE_USER created"
fi
NODE_HOME=$(getent passwd "$NODE_USER" 2>/dev/null | cut -d: -f6 || true)
NODE_HOME=${NODE_HOME:-/home/$NODE_USER}
run usermod -aG sudo "$NODE_USER"

# sudo asks for the user's password; a user created without one could not use sudo at all.
PW_STATE=$(passwd -S "$NODE_USER" 2>/dev/null | awk '{ print $2 }' || true)
if sudo -n -l -U "$NODE_USER" 2>/dev/null | grep -q NOPASSWD; then
  ok "$NODE_USER can use sudo without a password (set up by the hosting image)"
elif [ "$PW_STATE" = P ]; then
  ok "$NODE_USER has a password for sudo"
else
  note "$NODE_USER needs a password for sudo. It is not used for SSH: logins stay key-only."
  if confirm "Set that password now?"; then
    run passwd "$NODE_USER"
  else
    warn "$NODE_USER cannot use sudo until a password is set" "sudo passwd $NODE_USER"
  fi
fi

AUTH="$NODE_HOME/.ssh/authorized_keys"
add_keys() { # text with one key per line
  run install -d -m 700 -o "$NODE_USER" -g "$NODE_USER" "$NODE_HOME/.ssh"
  if [ "$DRY" -eq 1 ]; then
    note "+ append $(printf '%s\n' "$1" | grep -c .) key(s) to $AUTH"
  else
    printf '%s\n' "$1" >>"$AUTH"
    chown "$NODE_USER:$NODE_USER" "$AUTH"
    chmod 600 "$AUTH"
  fi
}
USER_KEYS=$(count_keys "$AUTH")
if [ "$USER_KEYS" -gt 0 ]; then
  ok "$NODE_USER has $USER_KEYS SSH key(s)"
else
  SOURCE_AUTH=/root/.ssh/authorized_keys
  if [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != root ]; then
    SOURCE_AUTH="$(getent passwd "$SUDO_USER" | cut -d: -f6)/.ssh/authorized_keys"
  fi
  SOURCE_KEYS=$(count_keys "$SOURCE_AUTH")
  if [ "$SOURCE_KEYS" -gt 0 ] && confirm "Give $NODE_USER the $SOURCE_KEYS SSH key(s) you log in with now ($SOURCE_AUTH)?"; then
    add_keys "$(plain_keys "$SOURCE_AUTH")"
    USER_KEYS=$SOURCE_KEYS
  else
    note "Paste one public key (the single line from your id_ed25519.pub). A public key is not a secret."
    ask PUBKEY "Public key (empty to skip)"
    if [ -n "$PUBKEY" ]; then
      TMPKEY=$(mktemp)
      printf '%s\n' "$PUBKEY" >"$TMPKEY"
      if [ "$(count_keys "$TMPKEY")" -eq 1 ]; then
        add_keys "$PUBKEY"
        USER_KEYS=1
      else
        warn "That does not look like a public key; nothing was added"
      fi
      rm -f "$TMPKEY"
    fi
  fi
  if [ "$USER_KEYS" -gt 0 ]; then
    ok "$NODE_USER can log in with an SSH key"
  else
    warn "$NODE_USER has no SSH key" "The SSH step below is skipped until there is one"
  fi
fi

# ---- 3. SSH ----
step "SSH with keys only"
HARDEN_FILE=/etc/ssh/sshd_config.d/00-feemarket-hardening.conf
reload_ssh() { run_sh "systemctl reload ssh 2>/dev/null || systemctl restart ssh"; }
PW=$(sshd_setting passwordauthentication)
ROOTLOGIN=$(sshd_setting permitrootlogin)
note "Now: password login ${PW:-unknown}, root login ${ROOTLOGIN:-unknown}, port $SSH_PORT"
if [ "$PW" = no ] && [ "$ROOTLOGIN" = no ]; then
  ok "Password login and root login are already off"
elif [ "$USER_KEYS" -eq 0 ]; then
  warn "Skipped: $NODE_USER has no SSH key, so turning passwords off would lock you out"
elif ! grep -Eq '^[[:space:]]*Include[[:space:]]+/etc/ssh/sshd_config\.d/' /etc/ssh/sshd_config 2>/dev/null && [ "$DRY" -eq 0 ]; then
  warn "Skipped: /etc/ssh/sshd_config does not include sshd_config.d" "Set PasswordAuthentication no and PermitRootLogin no there by hand"
elif confirm "Turn off password login and root login over SSH?"; then
  # The first value sshd reads wins, so the file name sorts before cloud-init's 50-cloud-init.conf.
  write_file "$HARDEN_FILE" 644 <<'EOF'
# Written by fee.market scripts/vps/prepare.sh. Delete this file and reload ssh to undo.
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
PubkeyAuthentication yes
EOF
  run mkdir -p /run/sshd # sshd -t wants it, and it is missing while no SSH session has started the service
  if ! run sshd -t; then
    run rm -f "$HARDEN_FILE"
    die "sshd rejected the new settings; they were removed again. Nothing changed."
  fi
  reload_ssh
  printf '\n %sDo not close this terminal yet.%s Open a second one and check the new login works:\n\n' "$B" "$N"
  printf '     ssh -p %s %s@%s\n\n' "$SSH_PORT" "$NODE_USER" "$(public_ipv4 || true)"
  if confirm "Did the login as $NODE_USER work in the second terminal?" n; then
    ok "SSH accepts keys only, and not root"
  else
    run rm -f "$HARDEN_FILE"
    reload_ssh
    warn "The SSH settings were put back as they were" "Fix the key for $NODE_USER, then run this script again"
  fi
else
  skip "Skipped"
fi

# ---- 4. Firewall ----
step "Firewall"
# How the node will be reached decides which ports stay open.
note "Denies all other incoming traffic. Outgoing stays open."
note "How will wallets reach this node?"
note "  1) Docker + Caddy (recommended): HTTPS on 80/443; node stays internal"
note "  2) nginx on the host: Ubuntu-packaged nginx + Certbot (apt security updates)"
note "  3) Apache on the host: Ubuntu-packaged apache2 + Certbot (apt security updates)"
note "  4) Bare Node: open the app port (no automatic HTTPS)"
note "  5) Cloudflare Tunnel only: SSH only (no public app ports)"
PUBLISH_MODE=docker
RELAYER_PORT=8787
if confirm "Set up the firewall?"; then
  while true; do
    ask PUBLISH_CHOICE "Publish mode: 1=Docker+Caddy, 2=nginx, 3=Apache, 4=bare Node, 5=tunnel" "1"
    case "$PUBLISH_CHOICE" in
      1 | docker | caddy) PUBLISH_MODE=docker; break ;;
      2 | nginx) PUBLISH_MODE=nginx; break ;;
      3 | apache | httpd) PUBLISH_MODE=apache; break ;;
      4 | bare | node) PUBLISH_MODE=bare; break ;;
      5 | tunnel) PUBLISH_MODE=tunnel; break ;;
      *) say "  Enter 1–5." ;;
    esac
  done
  if [ "$PUBLISH_MODE" = bare ]; then
    while true; do
      ask RELAYER_PORT "Node listen port to open in the firewall" "8787"
      if printf '%s' "$RELAYER_PORT" | grep -Eq '^[0-9]+$' && [ "$RELAYER_PORT" -ge 1 ] && [ "$RELAYER_PORT" -le 65535 ]; then break; fi
      say "  Enter a port number 1–65535."
    done
    warn "Bare Node has no TLS from this repo" "Prefer Docker+Caddy, nginx/Apache+Certbot, or a Cloudflare Tunnel"
  fi
  note "SSH can be limited to one address. Only do that if your address never changes, or you lock yourself out."
  if [ -n "${SSH_CONNECTION:-}" ]; then note "You are connected from ${SSH_CONNECTION%% *}."; fi
  while true; do
    ask SSH_FROM "Allow SSH only from this IPv4 address (empty = from anywhere, rate-limited)"
    if [ -z "$SSH_FROM" ] || is_ipv4 "$SSH_FROM"; then break; fi
    say "  That is not an IPv4 address."
  done
  run ufw default deny incoming
  run ufw default allow outgoing
  if [ -n "$SSH_FROM" ]; then
    run ufw allow from "$SSH_FROM" to any port "$SSH_PORT" proto tcp
  else
    run ufw limit "$SSH_PORT/tcp"
  fi
  case "$PUBLISH_MODE" in
    docker | nginx | apache)
      run ufw allow 80/tcp
      run ufw allow 443/tcp
      ok "Firewall is on (SSH + 80 + 443). Port 8787 stays closed — the proxy reaches the node on localhost."
      ;;
    bare)
      run ufw allow "$RELAYER_PORT/tcp"
      ok "Firewall is on (SSH + $RELAYER_PORT). No 80/443 — add TLS yourself or use a tunnel."
      note "Run the node with HOST=0.0.0.0 PORT=$RELAYER_PORT (see .env)."
      ;;
    tunnel)
      ok "Firewall is on (SSH only). App traffic goes through Cloudflare Tunnel."
      note "After setup: bash scripts/setup-tunnel.sh relay.yourdomain.com"
      ;;
  esac
  run ufw --force enable
else
  PUBLISH_MODE=docker
  skip "Skipped"
fi

# ---- 5. Security updates ----
step "Automatic security updates"
if apt-config dump 2>/dev/null | grep -q 'APT::Periodic::Unattended-Upgrade "1"'; then
  ok "Already on"
elif confirm "Install security updates automatically?"; then
  write_file /etc/apt/apt.conf.d/20auto-upgrades 644 <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
  run systemctl enable --now unattended-upgrades
  ok "Security updates install on their own"
  note "Some updates need a reboot. check.sh tells you when one is pending."
else
  skip "Skipped"
fi

# ---- 6. Clock ----
step "Clock"
if [ "$(timedatectl show -p NTPSynchronized --value 2>/dev/null || true)" = yes ]; then
  ok "The clock is synchronised"
else
  run timedatectl set-ntp true
  ok "Time synchronisation is switched on (it can take a minute to settle)"
fi

# ---- 7. Swap ----
step "Swap on a small server"
MEM=$(mem_total_mb)
SWAP=$(swap_total_mb)
if [ "${SWAP:-0}" -ge 500 ]; then
  ok "Swap is already there (${SWAP} MB)"
elif [ "${MEM:-4096}" -ge 1900 ]; then
  ok "${MEM:-?} MB of memory: no swap needed"
elif [ -e /swapfile ]; then
  warn "/swapfile exists but is not in use" "sudo swapon /swapfile"
elif [ "$(disk_free_gb /)" -lt 6 ]; then
  warn "Not enough free disk for a 2 GB swap file"
else
  note "${MEM} MB of memory. Building the Docker image can run out of memory without swap."
  if confirm "Add a 2 GB swap file?"; then
    run fallocate -l 2G /swapfile
    run chmod 600 /swapfile
    run mkswap /swapfile
    run swapon /swapfile
    run_sh "grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab"
    ok "2 GB of swap added"
  else
    skip "Skipped"
  fi
fi

# ---- 8. Docker and Node ----
step "Docker and Node.js LTS"
if have docker && docker compose version >/dev/null 2>&1; then
  ok "Docker and the compose plugin are installed"
elif confirm "Install Docker from Docker's own package repository?"; then
  run install -m 0755 -d /etc/apt/keyrings
  run curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  run chmod a+r /etc/apt/keyrings/docker.asc
  # The deb822 source file, as in Docker's install guide for Ubuntu.
  write_file /etc/apt/sources.list.d/docker.sources 644 <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: $(. /etc/os-release 2>/dev/null && echo "${UBUNTU_CODENAME:-${VERSION_CODENAME:-}}")
Components: stable
Architectures: $(dpkg --print-architecture 2>/dev/null || true)
Signed-By: /etc/apt/keyrings/docker.asc
EOF
  run apt-get update -y
  run apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  ok "Docker is installed"
else
  skip "Docker skipped"
  if [ "${PUBLISH_MODE:-docker}" = docker ]; then
    warn "Firewall was set for Docker+Caddy, but Docker was skipped" "Either install Docker and use compose, or open the node port: sudo ufw allow 8787/tcp"
    if have ufw && [ "$DRY" -eq 0 ] && confirm "Open port 8787 now for a bare Node process?"; then
      run ufw allow 8787/tcp
      ok "Port 8787 allowed. No automatic HTTPS — use a tunnel or put TLS in front."
    fi
  fi
fi
if have docker || [ "$DRY" -eq 1 ]; then
  if [ ! -e /etc/docker/daemon.json ]; then
    # Without a limit, container logs grow until the disk is full.
    run install -m 0755 -d /etc/docker
    write_file /etc/docker/daemon.json 644 <<'EOF'
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "5" }
}
EOF
    run systemctl restart docker
    ok "Container logs are capped at 5 files of 10 MB"
  fi
  if id -nG "$NODE_USER" 2>/dev/null | tr ' ' '\n' | grep -qx docker; then
    ok "$NODE_USER may use Docker"
  else
    note "Members of the docker group can become root on this server. That is normal for the user who runs the node."
    if confirm "Let $NODE_USER use Docker without sudo?"; then
      run usermod -aG docker "$NODE_USER"
      ok "$NODE_USER added to the docker group (takes effect at the next login)"
    else
      skip "Skipped: $NODE_USER will need sudo for docker"
    fi
  fi
fi

# Current Active LTS from NodeSource (receives security patches). Minimum supported major is 22.
# Host Node is required for sponsor CLI always; for nginx/apache/bare/tunnel the Node *process*
# also runs on the host (Docker image is only enough when PUBLISH_MODE=docker).
NODE_MIN_MAJOR=22
install_node_lts() {
  local script
  script=$(mktemp)
  # setup_lts.x tracks the current Active LTS line — not a frozen major like setup_22.x.
  run curl -fsSL https://deb.nodesource.com/setup_lts.x -o "$script"
  run bash "$script"
  run apt-get install -y nodejs
  rm -f "$script"
  hash -r 2>/dev/null || true
  if have node && have npm; then
    ok "Node.js $(node -v) / npm $(npm -v) installed system-wide (all users: /usr/bin)"
  else
    warn "NodeSource finished but node/npm still not on PATH" "which node; ls /usr/bin/node"
  fi
}

NODE=$(node_major)
if [ -n "$NODE" ] && [ "$NODE" -ge "$NODE_MIN_MAJOR" ]; then
  ok "Node.js $(node -v) is installed (meets >=$NODE_MIN_MAJOR)"
  note "apt will keep applying NodeSource security updates for this major."
elif confirm "Install Node.js LTS from NodeSource (current Active LTS, security-patched via apt)?"; then
  install_node_lts
else
  skip "Node.js skipped"
fi

NODE=$(node_major)
needs_host_node=1
[ "${PUBLISH_MODE:-docker}" = docker ] && needs_host_node=0
if { [ -z "$NODE" ] || [ "$NODE" -lt "$NODE_MIN_MAJOR" ]; } && [ "$needs_host_node" -eq 1 ]; then
  warn "Node.js >= $NODE_MIN_MAJOR is required on the host for $PUBLISH_MODE" \
    "sponsor CLI + the relayer process run as $NODE_USER — Docker alone is not enough"
  if confirm "Install Node.js LTS now? (recommended)" y; then
    install_node_lts
  fi
elif { [ -z "$NODE" ] || [ "$NODE" -lt "$NODE_MIN_MAJOR" ]; } && [ "$needs_host_node" -eq 0 ]; then
  note "Docker image has Node; you still need host Node for sponsor:init / plans / doctor. Install later if you skip."
  if confirm "Install host Node.js LTS anyway (for CLI tools)?" y; then
    install_node_lts
  fi
fi

# Optional host reverse proxy (nginx / Apache) — Ubuntu packages + Certbot.
# Under the unified `setup.sh`, the proxy is configured later from the node user's copy of the repo.
if [ "${FEEMARKET_SETUP:-0}" = 1 ]; then
  :
elif [ "${PUBLISH_MODE:-}" = nginx ] || [ "${PUBLISH_MODE:-}" = apache ]; then
  section "HTTPS proxy: $PUBLISH_MODE"
  note "Installs the Ubuntu $PUBLISH_MODE package (security updates via apt) and Certbot for Let's Encrypt."
  note "The Node process will listen on 127.0.0.1 only; $PUBLISH_MODE terminates HTTPS on 80/443."
  if [ "$DRY" -eq 1 ]; then
    note "+ would run: bash scripts/vps/setup-proxy.sh $PUBLISH_MODE"
  elif confirm "Install and configure $PUBLISH_MODE + Certbot now?"; then
    PROXY_ARGS=("$PUBLISH_MODE")
    if [ -f "$ENV_FILE" ]; then
      d=$(env_get "$ENV_FILE" PUBLIC_DOMAIN)
      [ -n "$d" ] && PROXY_ARGS+=(--domain "$d")
    fi
    bash "$VPS_DIR/setup-proxy.sh" "${PROXY_ARGS[@]}"
  else
    skip "Skipped. Later: sudo bash scripts/vps/setup-proxy.sh $PUBLISH_MODE"
  fi
fi

# ---- 9. Hand the code to the node user ----
step "The code, owned by $NODE_USER"
TARGET=$REPO_DIR
OWNER=$(file_owner "$REPO_DIR")
if [ "$OWNER" = "$NODE_USER" ]; then
  ok "$REPO_DIR already belongs to $NODE_USER"
else
  # Prefer ~/relayer under the node user (matches the public clone path).
  TARGET="$NODE_HOME/relayer"
  if [ -e "$TARGET" ]; then
    ok "$TARGET exists; using that copy"
  elif confirm "Copy this repository to $TARGET for $NODE_USER?"; then
    run cp -a "$REPO_DIR" "$TARGET"
    run chown -R "$NODE_USER:$NODE_USER" "$TARGET"
    ok "Copied to $TARGET"
  else
    warn "The repository still belongs to ${OWNER:-another user}" "$NODE_USER needs its own copy to run the node"
    TARGET=$REPO_DIR
  fi
fi

# ---- Done ----
section "Done"
if [ "$DRY" -eq 1 ]; then
  note "That was a dry run. Run it again without --dry-run to apply."
  exit 0
fi

# Handoff for scripts/vps/setup.sh, which continues as $NODE_USER from $TARGET.
install -d -m 0755 /etc/feemarket
cat >/etc/feemarket/prepare.env <<EOF
NODE_USER=$NODE_USER
TARGET=$TARGET
PUBLISH_MODE=${PUBLISH_MODE:-docker}
SSH_PORT=$SSH_PORT
EOF
chmod 644 /etc/feemarket/prepare.env
if [ "${FEEMARKET_SETUP:-0}" = 1 ]; then
  ok "Server is prepared; continuing the setup as $NODE_USER"
  exit 0
fi

NODE=$(node_major)
if [ -z "$NODE" ] || [ "$NODE" -lt "$NODE_MIN_MAJOR" ]; then
  warn "Node.js is still missing on this server" "Install as root before switching to $NODE_USER:"
  printf '\n     curl -fsSL https://deb.nodesource.com/setup_lts.x | bash -\n'
  printf '     apt-get install -y nodejs\n'
  printf '     node -v && npm -v          # should work for every user\n\n'
  note "Or re-run: sudo bash scripts/vps/prepare.sh  and accept the Node.js step."
else
  ok "Host Node $(node -v) is ready for $NODE_USER"
fi

say "Next, as $NODE_USER (fresh login so docker group / PATH apply):"
printf '\n     ssh -p %s %s@%s\n' "$SSH_PORT" "$NODE_USER" "$(public_ipv4 || true)"
printf '     # or from root: su - %s\n' "$NODE_USER"
printf '     cd %s\n' "$TARGET"
printf '     npm run sponsor:setup        # everything else: .env, HTTPS, plans, registration, status\n\n'
note "Next time, run the whole thing as one command from root: sudo bash scripts/vps/setup.sh"
note "Have ready: a domain (A record → this server), a Polygon RPC URL, a payout address, a thirdweb key."
