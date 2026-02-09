#!/usr/bin/env bash
# BotsChat local dev startup script
# Usage:
#   ./scripts/dev.sh          — build web + migrate + start server
#   ./scripts/dev.sh reset    — nuke local DB, re-migrate, then start
#   ./scripts/dev.sh migrate  — only run D1 migrations (no server)
#   ./scripts/dev.sh build    — only build web frontend (no server)
#   ./scripts/dev.sh sync     — sync plugin to mini.local + rebuild + restart gateway
#   ./scripts/dev.sh logs     — tail gateway logs on mini.local
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

# ── Colours ──────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()  { echo -e "${CYAN}▸${NC} $*"; }
ok()    { echo -e "${GREEN}✔${NC} $*"; }
warn()  { echo -e "${YELLOW}▲${NC} $*"; }
fail()  { echo -e "${RED}✖${NC} $*"; exit 1; }

# ── Helpers ──────────────────────────────────────────────────────────

kill_port() {
  local port=${1:-8787}
  local pids
  pids=$(lsof -ti:"$port" 2>/dev/null || true)
  if [[ -n "$pids" ]]; then
    warn "Killing process(es) on port $port: $pids"
    echo "$pids" | xargs kill -9 2>/dev/null || true
    sleep 1
  fi
}

do_migrate() {
  info "Applying D1 migrations (local)…"
  npx wrangler d1 migrations apply botschat-db --local
  ok "Migrations applied"
}

do_reset() {
  warn "Nuking local D1 database…"
  rm -rf "$ROOT/.wrangler/state"
  ok "Local DB wiped"
  do_migrate
}

do_build_web() {
  info "Building web frontend…"
  npm run build -w packages/web
  ok "Web build complete (packages/web/dist)"
}

do_start() {
  kill_port 8787
  info "Starting wrangler dev on 0.0.0.0:8787…"
  exec npx wrangler dev --config wrangler.toml --ip 0.0.0.0 --var ENVIRONMENT:development
}

do_sync_plugin() {
  local REMOTE="mini.local"
  local REMOTE_DIR="~/Projects/botsChat/packages/plugin"

  info "Syncing plugin to $REMOTE…"
  rsync -avz --exclude node_modules --exclude .git --exclude dist --exclude .wrangler \
    packages/plugin/ "$REMOTE:$REMOTE_DIR/"
  ok "Plugin files synced"

  info "Building plugin, deploying to extensions, restarting gateway on mini.local…"
  ssh "$REMOTE" 'export PATH="/opt/homebrew/bin:$PATH"
cd ~/Projects/botsChat/packages/plugin
npm run build
EXT_DIR=~/.openclaw/extensions/botschat
rsync -av --delete dist/ "$EXT_DIR/dist/"
rsync -av bin/ "$EXT_DIR/bin/" 2>/dev/null || true
cp -f package.json openclaw.plugin.json "$EXT_DIR/" 2>/dev/null || true
echo "--- Deployed to $EXT_DIR ---"
pkill -9 -f openclaw-gateway 2>/dev/null || true
sleep 3
nohup openclaw gateway run --bind loopback --port 18789 --force > /tmp/openclaw-gateway.log 2>&1 &
echo "Gateway restarted (PID=$!)"'
  ok "Plugin synced, deployed to extensions, gateway restarted"

  sleep 4
  info "Checking connection…"
  ssh "$REMOTE" 'tail -5 /tmp/openclaw-gateway.log | grep -i "authenticated\|error\|Task scan"'
}

do_logs() {
  info "Tailing gateway logs on mini.local…"
  ssh mini.local 'tail -f /tmp/openclaw-gateway.log'
}

# ── Main ─────────────────────────────────────────────────────────────

cmd="${1:-}"

case "$cmd" in
  reset)
    do_reset
    do_build_web
    do_start
    ;;
  migrate)
    do_migrate
    ;;
  build)
    do_build_web
    ;;
  sync)
    do_sync_plugin
    ;;
  logs)
    do_logs
    ;;
  *)
    # Default: build + migrate + start
    do_build_web
    do_migrate
    do_start
    ;;
esac
