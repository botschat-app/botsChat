#!/usr/bin/env bash
# BotsChat local dev startup script
# Usage:
#   ./scripts/dev.sh          — full dev env: build + migrate + server + mock AI + open browser
#   ./scripts/dev.sh reset    — nuke local DB, re-migrate, then start full dev env
#   ./scripts/dev.sh server   — only start wrangler dev server (no mock, no browser)
#   ./scripts/dev.sh migrate  — only run D1 migrations (no server)
#   ./scripts/dev.sh build    — only build web frontend (no server)
#   ./scripts/dev.sh sync     — sync plugin to mini.local + rebuild + restart gateway
#   ./scripts/dev.sh logs     — tail gateway logs on mini.local
#   ./scripts/dev.sh mock     — start mock OpenClaw standalone (foreground)
#   ./scripts/dev.sh v2       — v2 env: build + migrate (v2 DB) + start on port 8788
#   ./scripts/dev.sh v2:reset — nuke v2 local DB, re-migrate, then start
#   ./scripts/dev.sh v2:deploy — deploy v2 to Cloudflare
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

# ── Auto-set DEV_AUTH_SECRET ──────────────────────────────────────────
# For local dev, any string works. Use a fixed default so new developers
# can run `./scripts/dev.sh` without setting env vars first.
if [[ -z "${DEV_AUTH_SECRET:-}" ]]; then
  DEV_AUTH_SECRET="botschat-local-dev-secret"
  export DEV_AUTH_SECRET
fi

# ── Colours ──────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'; CYAN='\033[0;36m'; DIM='\033[2m'; NC='\033[0m'
info()  { echo -e "${CYAN}▸${NC} $*"; }
ok()    { echo -e "${GREEN}✔${NC} $*"; }
warn()  { echo -e "${YELLOW}▲${NC} $*"; }
fail()  { echo -e "${RED}✖${NC} $*"; exit 1; }

# ── Process tracking ─────────────────────────────────────────────────
WRANGLER_PID=""
MOCK_PID=""

cleanup() {
  [[ -n "$MOCK_PID" ]] && kill "$MOCK_PID" 2>/dev/null || true
  [[ -n "$WRANGLER_PID" ]] && kill "$WRANGLER_PID" 2>/dev/null || true
  wait 2>/dev/null || true
}

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

wait_for_server() {
  info "Waiting for server…"
  local max=60 i=0
  while ! curl -sf --max-time 1 -o /dev/null http://localhost:8787/ 2>/dev/null; do
    sleep 1
    i=$((i + 1))
    if [[ $i -ge $max ]]; then
      fail "Server didn't start within ${max}s"
    fi
  done
}

get_mock_token() {
  local BASE_URL="http://localhost:8787"
  local TOKEN_JSON AUTH_TOKEN PAT_JSON PAT

  TOKEN_JSON=$(curl -sf -X POST "$BASE_URL/api/dev-auth/login" \
    -H 'Content-Type: application/json' \
    -d "{\"secret\":\"$DEV_AUTH_SECRET\",\"userId\":\"dev-test-user\"}" 2>&1) || {
    fail "Cannot reach $BASE_URL — is the server running?"
  }
  AUTH_TOKEN=$(echo "$TOKEN_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])" 2>/dev/null) || {
    fail "Failed to parse auth token: $TOKEN_JSON"
  }

  PAT_JSON=$(curl -sf -X POST "$BASE_URL/api/pairing-tokens" \
    -H "Authorization: Bearer $AUTH_TOKEN" \
    -H 'Content-Type: application/json' \
    -d '{"label":"mock-openclaw"}' 2>&1) || {
    fail "Failed to create pairing token"
  }
  PAT=$(echo "$PAT_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])" 2>/dev/null) || {
    fail "Failed to parse pairing token: $PAT_JSON"
  }

  echo "$PAT"
}

open_browser() {
  local url="http://localhost:8787/?dev_token=${DEV_AUTH_SECRET}"
  if command -v open &>/dev/null; then
    open "$url"
  elif command -v xdg-open &>/dev/null; then
    xdg-open "$url"
  else
    warn "Open in browser: $url"
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

# ── Server-only start (foreground, no mock/browser) ──────────────────

do_start() {
  kill_port 8787
  info "Starting wrangler dev on 0.0.0.0:8787…"
  exec npx wrangler dev --config wrangler.toml --ip 0.0.0.0 --var ENVIRONMENT:development --var DEV_AUTH_SECRET:"$DEV_AUTH_SECRET"
}

# ── Full dev environment (server + mock + browser) ───────────────────

do_start_full() {
  kill_port 8787
  trap cleanup EXIT INT TERM

  info "Starting wrangler dev on 0.0.0.0:8787…"
  npx wrangler dev --config wrangler.toml --ip 0.0.0.0 \
    --var ENVIRONMENT:development \
    --var DEV_AUTH_SECRET:"$DEV_AUTH_SECRET" &
  WRANGLER_PID=$!

  wait_for_server
  ok "Server ready on http://localhost:8787"

  info "Starting Mock OpenClaw…"
  local PAT
  PAT=$(get_mock_token)
  mkdir -p "$ROOT/.wrangler"
  node "$ROOT/scripts/mock-openclaw.mjs" --token "$PAT" > "$ROOT/.wrangler/mock-openclaw.log" 2>&1 &
  MOCK_PID=$!
  ok "Mock OpenClaw connected (pid=$MOCK_PID)"

  open_browser

  echo ""
  echo -e "${CYAN}╭──────────────────────────────────────────────────╮${NC}"
  echo -e "${CYAN}│${NC}  ${GREEN}BotsChat Dev Environment Ready${NC}                  ${CYAN}│${NC}"
  echo -e "${CYAN}│${NC}                                                  ${CYAN}│${NC}"
  echo -e "${CYAN}│${NC}  Server:   http://localhost:8787                 ${CYAN}│${NC}"
  echo -e "${CYAN}│${NC}  Mock AI:  running ${DIM}(log: .wrangler/mock-openclaw.log)${NC}"
  echo -e "${CYAN}│${NC}  Auth:     auto-login enabled                   ${CYAN}│${NC}"
  echo -e "${CYAN}│${NC}                                                  ${CYAN}│${NC}"
  echo -e "${CYAN}│${NC}  Press ${YELLOW}Ctrl+C${NC} to stop all services              ${CYAN}│${NC}"
  echo -e "${CYAN}╰──────────────────────────────────────────────────╯${NC}"
  echo ""

  wait $WRANGLER_PID 2>/dev/null || true
}

# ── Standalone mock (foreground) ─────────────────────────────────────

do_mock() {
  info "Getting auth token via dev-auth…"
  local PAT
  PAT=$(get_mock_token)
  ok "Pairing token: ${PAT:0:16}***"
  info "Starting Mock OpenClaw…"
  exec node "$ROOT/scripts/mock-openclaw.mjs" --token "$PAT" "$@"
}

# ── Sync plugin to mini.local ────────────────────────────────────────

do_sync_plugin() {
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

# ── v2 environment ──────────────────────────────────────────────────

V2_CONFIG="wrangler-v2.toml"
V2_DB="botschat-v2-db"
V2_PORT=8788

do_v2_migrate() {
  info "Applying D1 migrations (v2 local)…"
  npx wrangler d1 migrations apply "$V2_DB" --local --config "$V2_CONFIG"
  ok "v2 migrations applied"
}

do_v2_reset() {
  warn "Nuking v2 local state (DB + DO)…"
  rm -rf "$ROOT/.wrangler/state"
  ok "v2 local state wiped"
  do_v2_migrate
}

do_v2_start() {
  kill_port "$V2_PORT"
  info "Starting wrangler dev (v2) on 0.0.0.0:${V2_PORT}…"
  exec npx wrangler dev --config "$V2_CONFIG" --ip 0.0.0.0 --port "$V2_PORT" \
    --var ENVIRONMENT:development --var DEV_AUTH_SECRET:"$DEV_AUTH_SECRET"
}

do_v2_deploy() {
  info "Building web frontend…"
  npm run build -w packages/web
  info "Deploying v2 to Cloudflare…"
  npx wrangler deploy --config "$V2_CONFIG"
  ok "v2 deployed"
}

# ── Main ─────────────────────────────────────────────────────────────

cmd="${1:-}"

case "$cmd" in
  reset)
    do_reset
    do_build_web
    do_start_full
    ;;
  server)
    do_build_web
    do_migrate
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
  mock)
    shift
    do_mock "$@"
    ;;
  v2)
    do_build_web
    do_v2_migrate
    do_v2_start
    ;;
  v2:reset)
    do_v2_reset
    do_build_web
    do_v2_start
    ;;
  v2:migrate)
    do_v2_migrate
    ;;
  v2:deploy)
    do_v2_deploy
    ;;
  *)
    # Default: full dev experience — build + migrate + server + mock + browser
    do_build_web
    do_migrate
    do_start_full
    ;;
esac
