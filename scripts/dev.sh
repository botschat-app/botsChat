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
  exec npx wrangler dev --config wrangler.toml --ip 0.0.0.0 --var ENVIRONMENT:development --var DEV_AUTH_SECRET:REDACTED_DEV_SECRET
}

do_sync_plugin() {
  # ── IMPORTANT ──────────────────────────────────────────────────
  # Development repo and production plugin MUST be kept separate:
  #   Dev repo:    mini:~/Projects/botschat-app/botsChat/packages/plugin/
  #   Production:  mini:~/.openclaw/extensions/botschat/
  # NEVER edit files directly in ~/.openclaw/extensions/botschat/.
  # Always: edit dev repo → build → deploy artifacts to extensions.
  # ────────────────────────────────────────────────────────────────
  local REMOTE="mini.local"
  local DEV_DIR="~/Projects/botschat-app/botsChat/packages/plugin"
  local EXT_DIR="~/.openclaw/extensions/botschat"

  info "Syncing plugin source to mini.local dev repo…"
  rsync -avz --exclude node_modules --exclude .git --exclude dist --exclude .wrangler \
    packages/plugin/ "$REMOTE:$DEV_DIR/"
  ok "Plugin source synced → $DEV_DIR"

  info "Building plugin in dev repo, deploying to extensions, restarting gateway…"
  ssh "$REMOTE" "export PATH=\"/opt/homebrew/bin:\$PATH\"
cd $DEV_DIR
npm run build
echo '--- Deploying built artifacts to $EXT_DIR ---'
rsync -av --delete dist/ $EXT_DIR/dist/
rsync -av bin/ $EXT_DIR/bin/ 2>/dev/null || true
cp -f package.json openclaw.plugin.json $EXT_DIR/ 2>/dev/null || true
echo '--- Restarting gateway via launchctl ---'
launchctl kickstart -k gui/\$(id -u)/ai.openclaw.gateway
echo 'Gateway restarted'"
  ok "Plugin deployed to extensions, gateway restarted"

  sleep 4
  info "Checking connection…"
  ssh "$REMOTE" 'tail -10 ~/.openclaw/logs/gateway.log | grep -i "authenticated\|error\|Task scan\|botschat"'
}

do_logs() {
  info "Tailing gateway logs on mini.local…"
  ssh mini.local 'tail -f ~/.openclaw/logs/gateway.log'
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
