#!/usr/bin/env bash
# Pull the latest relayer release and restart the node without fighting local noise.
#
#   bash scripts/update.sh
#
# Safe for sponsors: keeps .env, sponsor.plans.json, data/, secrets/. Discards regenerable
# tracked files that often block `git pull` (especially package-lock.json after `npm install`).
# Aborts if you have other local edits to tracked source — those need a deliberate choice.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [ -t 1 ]; then
  G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; D=$'\033[2m'; N=$'\033[0m'
else
  G=""; Y=""; R=""; D=""; N=""
fi
ok() { printf ' %s✓%s %s\n' "$G" "$N" "$1"; }
warn() { printf ' %s!%s %s\n' "$Y" "$N" "$1"; }
die() { printf '%s✗ %s%s\n' "$R" "$1" "$N" >&2; exit 1; }
note() { printf '   %s%s%s\n' "$D" "$1" "$N"; }

FORCE=0
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    -h | --help)
      sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'
      printf '\nOptions:\n  --force   discard ALL local changes to tracked files (never touches untracked .env / plans / data)\n'
      exit 0
      ;;
    *) die "Unknown option: $arg (see --help)" ;;
  esac
done

command -v git >/dev/null || die "git is required"
[ -d .git ] || die "Not a git checkout. Clone https://github.com/fee-market/relayer and run from there."
[ -f .env ] || warn "No .env yet — copy .env.example or run: npm run sponsor:init"

# Files npm / builds often dirty on the server. Always safe to reset to upstream.
REGENERABLE='^(package-lock\.json|package\.json|dist/)'

dirty_tracked() {
  git status --porcelain --untracked-files=no | awk '{print substr($0,4)}'
}

UNEXPECTED=""
while IFS= read -r f; do
  [ -z "$f" ] && continue
  if printf '%s' "$f" | grep -Eq "$REGENERABLE"; then
    continue
  fi
  UNEXPECTED="${UNEXPECTED}${f}"$'\n'
done < <(dirty_tracked)

if [ -n "$UNEXPECTED" ] && [ "$FORCE" -ne 1 ]; then
  printf '%s✗ Local edits to tracked files would be lost:%s\n' "$R" "$N"
  printf '%s' "$UNEXPECTED" | sed '/^$/d' | sed 's/^/   /'
  note "Commit them elsewhere, or re-run with --force to discard them and pull."
  note ".env, sponsor.plans.json, data/ and secrets/ are untracked and stay put either way."
  exit 1
fi

if [ "$FORCE" -eq 1 ]; then
  note "Discarding all local changes to tracked files (--force)"
  git checkout -- .
  git clean -fd -e .env -e .env.* -e sponsor.plans.json -e data -e secrets -e node_modules >/dev/null
else
  # Reset only regenerable dirt so pull can fast-forward.
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    if printf '%s' "$f" | grep -Eq "$REGENERABLE"; then
      git restore --source=HEAD --worktree -- "$f" 2>/dev/null || git checkout -- "$f"
      note "Reset $f to match the last commit (will refresh from origin)"
    fi
  done < <(dirty_tracked)
fi

ok "Working tree ready for pull"

BEFORE=$(git rev-parse --short HEAD)
git fetch --quiet origin
BRANCH=$(git rev-parse --abbrev-ref HEAD)
REMOTE=$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || echo "origin/$BRANCH")

if ! git merge-base --is-ancestor HEAD "$REMOTE" 2>/dev/null; then
  die "Local branch has commits not on $REMOTE. Push, rebase, or reset manually before updating."
fi

if [ "$(git rev-parse HEAD)" = "$(git rev-parse "$REMOTE")" ]; then
  ok "Already up to date ($BEFORE)"
else
  git pull --ff-only
  AFTER=$(git rev-parse --short HEAD)
  ok "Updated $BEFORE → $AFTER"
fi

if [ -f package-lock.json ]; then
  note "Installing packages (npm ci)…"
  npm ci --no-audit --no-fund --loglevel=error
else
  note "No lockfile — installing with npm install…"
  npm install --no-audit --no-fund --loglevel=error
fi
ok "Dependencies installed"

# How the node runs on this server (Docker Compose, the feemarket-relayer service, or a bare process) is decided in
# ONE place, ensure-node-running.sh, from PROXY_KIND in .env. Docker being installed is not a reason to use it: a
# container started next to a host service would be a second node with the same relayer key.
if [ ! -f .env ]; then
  warn "No .env, so there is no node to restart. Set one up with: npm run sponsor:setup"
  exit 0
fi
note "Rebuilding and restarting the node…"
if bash "$ROOT/scripts/ensure-node-running.sh" --restart; then
  ok "The node runs the new version"
else
  die "The node did not restart (see above). It may still be running the old version: npm run sponsor:ensure-running"
fi
