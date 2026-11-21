#!/usr/bin/env bash
# Prepares a fresh Ubuntu VPS for a sponsor node. Run once, as root, from a clone of this repository:
#
#   sudo bash relayer/scripts/vps/prepare.sh
#   sudo bash relayer/scripts/vps/prepare.sh --dry-run   # asks the same questions, prints the commands, changes nothing
#
# It walks through nine steps and asks before each one: a normal user for the node, SSH with keys only, the
# firewall (SSH, 80 and 443), automatic security updates, clock sync, a swap file on small servers, Docker,
# Node 22, and handing the repository to the new user. Every step can be skipped, and running it again is safe:
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
  if [ "$(id -u)" -ne 0 ]; then die "Run this with sudo: sudo bash relayer/scripts/vps/prepare.sh"; fi
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
# Written by fee.market relayer/scripts/vps/prepare.sh. Delete this file and reload ssh to undo.
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
note "Denies all incoming traffic except SSH (port $SSH_PORT), 80 and 443. Outgoing traffic stays open."
note "Port 8787 (the node) stays closed: only Caddy talks to it, inside Docker."
if confirm "Set up the firewall?"; then
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
  run ufw allow 80/tcp
  run ufw allow 443/tcp
  run ufw --force enable
  ok "Firewall is on"
  note "Docker publishes container ports around ufw. The compose file only publishes 80 and 443, so that is fine here."
else
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
step "Docker and Node 22"
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

NODE=$(node_major)
if [ -n "$NODE" ] && [ "$NODE" -ge 22 ]; then
  ok "Node.js $(node -v) is installed"
elif confirm "Install Node.js 22 with NodeSource's setup script (their documented way; it adds their package repository)?"; then
  NODESOURCE_SCRIPT=$(mktemp)
  run curl -fsSL https://deb.nodesource.com/setup_22.x -o "$NODESOURCE_SCRIPT"
  run bash "$NODESOURCE_SCRIPT"
  run apt-get install -y nodejs
  rm -f "$NODESOURCE_SCRIPT"
  ok "Node.js is installed"
else
  skip "Node.js skipped (the sponsor commands need Node 22)"
fi

# ---- 9. Hand the code to the node user ----
step "The code, owned by $NODE_USER"
TARGET=$REPO_DIR
OWNER=$(file_owner "$REPO_DIR")
if [ "$OWNER" = "$NODE_USER" ]; then
  ok "$REPO_DIR already belongs to $NODE_USER"
else
  TARGET="$NODE_HOME/$(basename "$REPO_DIR")"
  if [ -e "$TARGET" ]; then
    ok "$TARGET exists; using that copy"
  elif confirm "Copy this repository to $TARGET for $NODE_USER?"; then
    run cp -a "$REPO_DIR" "$TARGET"
    run chown -R "$NODE_USER:$NODE_USER" "$TARGET"
    ok "Copied to $TARGET"
  else
    warn "The repository still belongs to ${OWNER:-another user}" "$NODE_USER needs its own copy to run the node"
  fi
fi

# ---- Done ----
section "Done"
if [ "$DRY" -eq 1 ]; then
  note "That was a dry run. Run it again without --dry-run to apply."
  exit 0
fi
say "Next, as $NODE_USER (a fresh login, so the docker group applies):"
printf '\n     ssh -p %s %s@%s\n' "$SSH_PORT" "$NODE_USER" "$(public_ipv4 || true)"
printf '     cd %s/relayer\n' "$TARGET"
printf '     bash scripts/vps/check.sh --domain relay.example.com   # what is still missing\n'
printf '     bash scripts/vps/setup.sh                              # the guided node setup\n\n'
note "Before setup.sh: point the A record of your domain at this server, and have your RPC URL and payout address ready."
