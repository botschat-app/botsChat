#!/usr/bin/env bash
# BotsChat v2 Multi-Agent API Test Suite
# Usage: ./tests/v2-api-test.sh [base_url]
# Default: http://localhost:8788

set -euo pipefail

BASE_URL="${1:-http://localhost:8788}"
DEV_SECRET="botschat-local-dev-secret"
PASS=0
FAIL=0

RED='\033[0;31m'; GREEN='\033[0;32m'; CYAN='\033[0;36m'; DIM='\033[2m'; NC='\033[0m'

pass() { PASS=$((PASS + 1)); echo -e "  ${GREEN}PASS${NC} $1"; }
fail() { FAIL=$((FAIL + 1)); echo -e "  ${RED}FAIL${NC} $1: $2"; }
section() { echo -e "\n${CYAN}── $1 ──${NC}"; }

# Helper: HTTP request
api() {
  local method=$1 path=$2; shift 2
  curl -sf -X "$method" "$BASE_URL/api$path" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" "$@" 2>/dev/null
}

# ── Auth ──────────────────────────────────────────────────────────────
section "Authentication"

RESP=$(curl -sf -X POST "$BASE_URL/api/dev-auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"secret\":\"$DEV_SECRET\",\"userId\":\"u_v2test\"}" 2>/dev/null)
TOKEN=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])" 2>/dev/null)

if [ -n "$TOKEN" ]; then
  pass "dev-auth login"
else
  fail "dev-auth login" "no token returned"
  echo "Cannot continue without auth. Exiting."
  exit 1
fi

# ── Agents CRUD ───────────────────────────────────────────────────────
section "Agents CRUD (v2)"

# List agents (empty initially)
AGENTS=$(api GET /v2/agents)
COUNT=$(echo "$AGENTS" | python3 -c "import sys,json; print(len(json.load(sys.stdin)['agents']))" 2>/dev/null)
[ "$COUNT" = "0" ] && pass "list agents (empty)" || fail "list agents" "expected 0, got $COUNT"

# Create OpenClaw agent (PM role)
OC_RESP=$(api POST /v2/agents -d '{
  "name": "PM OpenClaw",
  "type": "openclaw",
  "role": "product_manager",
  "systemPrompt": "你是产品经理，擅长需求分析和任务拆解。",
  "skills": [{"name":"需求分析","description":"分析用户需求"},{"name":"任务拆解","description":"拆解大任务"}],
  "pairingToken": "bc_pat_v2test_openclaw_001"
}')
OC_ID=$(echo "$OC_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])" 2>/dev/null)
OC_TYPE=$(echo "$OC_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['type'])" 2>/dev/null)
OC_ROLE=$(echo "$OC_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['role'])" 2>/dev/null)
[ "$OC_TYPE" = "openclaw" ] && [ "$OC_ROLE" = "product_manager" ] && pass "create OpenClaw agent (PM)" || fail "create OpenClaw" "type=$OC_TYPE role=$OC_ROLE"

# Create Cursor agent (Developer role)
CU_RESP=$(api POST /v2/agents -d '{
  "name": "Cursor Dev",
  "type": "cursor_cli",
  "role": "developer",
  "systemPrompt": "你是高级程序员。",
  "skills": [{"name":"代码编写","description":"编写代码"},{"name":"重构","description":"重构代码"}],
  "pairingToken": "bc_pat_v2test_cursor_001"
}')
CU_ID=$(echo "$CU_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])" 2>/dev/null)
CU_TYPE=$(echo "$CU_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['type'])" 2>/dev/null)
[ "$CU_TYPE" = "cursor_cli" ] && pass "create Cursor agent (Dev)" || fail "create Cursor" "type=$CU_TYPE"

# Create Mock agent (QA role)
QA_RESP=$(api POST /v2/agents -d '{
  "name": "QA Claude",
  "type": "mock",
  "role": "qa",
  "systemPrompt": "你是QA工程师。",
  "skills": [{"name":"测试","description":"编写测试用例"}]
}')
QA_ID=$(echo "$QA_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])" 2>/dev/null)
[ -n "$QA_ID" ] && pass "create Mock agent (QA)" || fail "create Mock agent" "no id"

# List agents (should have 3)
COUNT=$(api GET /v2/agents | python3 -c "import sys,json; print(len(json.load(sys.stdin)['agents']))" 2>/dev/null)
[ "$COUNT" = "3" ] && pass "list agents (3 agents)" || fail "list agents" "expected 3, got $COUNT"

# Get single agent
SINGLE=$(api GET "/v2/agents/$OC_ID")
SINGLE_NAME=$(echo "$SINGLE" | python3 -c "import sys,json; print(json.load(sys.stdin)['name'])" 2>/dev/null)
[ "$SINGLE_NAME" = "PM OpenClaw" ] && pass "get single agent" || fail "get single" "name=$SINGLE_NAME"

# Update agent
api PATCH "/v2/agents/$QA_ID" -d '{"role":"devops","skills":[{"name":"部署","description":"自动化部署"}]}' > /dev/null
UPDATED_ROLE=$(api GET "/v2/agents/$QA_ID" | python3 -c "import sys,json; print(json.load(sys.stdin)['role'])" 2>/dev/null)
[ "$UPDATED_ROLE" = "devops" ] && pass "update agent role" || fail "update agent" "role=$UPDATED_ROLE"

# ── Gateway Auth (v2 agents table) ───────────────────────────────────
section "Gateway Auth (dual-auth)"

GW_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/api/gateway/default?token=bc_pat_v2test_openclaw_001" 2>/dev/null)
[ "$GW_STATUS" = "426" ] && pass "gateway with agent pairing token (426 = needs WS)" || fail "gateway agent token" "status=$GW_STATUS"

# Check agent status updated to connected
OC_STATUS=$(api GET "/v2/agents/$OC_ID" | python3 -c "import sys,json; print(json.load(sys.stdin)['status'])" 2>/dev/null)
[ "$OC_STATUS" = "connected" ] && pass "agent status updated to connected" || fail "agent status" "status=$OC_STATUS"

# ── v1 Backward Compatibility ────────────────────────────────────────
section "v1 Backward Compatibility"

V1_AGENTS=$(api GET /agents)
V1_COUNT=$(echo "$V1_AGENTS" | python3 -c "import sys,json; print(len(json.load(sys.stdin)['agents']))" 2>/dev/null)
V1_DEFAULT=$(echo "$V1_AGENTS" | python3 -c "import sys,json; a=json.load(sys.stdin)['agents']; print(a[0]['isDefault'])" 2>/dev/null)
[ "$V1_DEFAULT" = "True" ] && pass "v1 agents API (default agent)" || fail "v1 agents" "isDefault=$V1_DEFAULT"

# ── Channels ──────────────────────────────────────────────────────────
section "Channels"

CH_RESP=$(api POST /channels -d '{"name":"botschat-dev","description":"BotsChat 开发频道"}')
CH_ID=$(echo "$CH_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])" 2>/dev/null)
CH_PAI=$(echo "$CH_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('providerAgentId','MISSING'))" 2>/dev/null)
[ -n "$CH_ID" ] && [ "$CH_PAI" != "MISSING" ] && pass "create channel (providerAgentId present)" || fail "create channel" "id=$CH_ID pai=$CH_PAI"

# ── Data Migration ───────────────────────────────────────────────────
section "Data Migration"

MIG_RESP=$(api POST /v2/migrate)
MIG_OK=$(echo "$MIG_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['ok'])" 2>/dev/null)
[ "$MIG_OK" = "True" ] && pass "v2 migration (idempotent)" || fail "migration" "ok=$MIG_OK"

# Run again (idempotent)
MIG2_CREATED=$(api POST /v2/migrate | python3 -c "import sys,json; print(json.load(sys.stdin)['stats']['agentsCreated'])" 2>/dev/null)
[ "$MIG2_CREATED" = "0" ] && pass "migration idempotent (0 created)" || fail "migration idempotent" "created=$MIG2_CREATED"

# ── History Query API ─────────────────────────────────────────────────
section "History Query API"

# Query empty session
HIST=$(api GET "/v2/messages/query?sessionKey=test:empty:session")
HIST_COUNT=$(echo "$HIST" | python3 -c "import sys,json; print(len(json.load(sys.stdin)['messages']))" 2>/dev/null)
[ "$HIST_COUNT" = "0" ] && pass "query history (empty)" || fail "query history" "count=$HIST_COUNT"

# Missing sessionKey
HIST_ERR=$(curl -s "$BASE_URL/api/v2/messages/query" -H "Authorization: Bearer $TOKEN" 2>/dev/null)
HIST_ERR_MSG=$(echo "$HIST_ERR" | python3 -c "import sys,json; print(json.load(sys.stdin).get('error',''))" 2>/dev/null)
[ "$HIST_ERR_MSG" = "sessionKey required" ] && pass "query history (missing key = 400)" || fail "query history 400" "err=$HIST_ERR_MSG"

# Traces endpoint (non-existent)
TRACE_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/api/v2/messages/traces/nonexistent" -H "Authorization: Bearer $TOKEN" 2>/dev/null)
[ "$TRACE_STATUS" = "404" ] && pass "traces endpoint (404 for missing)" || fail "traces" "status=$TRACE_STATUS"

# ── Cursor Bridge Connection ──────────────────────────────────────────
section "Cursor Bridge Connection"

cd "$(dirname "$0")/.."
BRIDGE_LOG=$(mktemp)
BOTSCHAT_URL="$BASE_URL" \
BOTSCHAT_TOKEN="bc_pat_v2test_cursor_001" \
BOTSCHAT_AGENT_ID="$CU_ID" \
CURSOR_WORKSPACE="/tmp" \
timeout 6 node packages/cursor-bridge/dist/index.js > "$BRIDGE_LOG" 2>&1 || true

if grep -q "Authenticated as agent" "$BRIDGE_LOG"; then
  pass "Cursor Bridge connects and authenticates"
else
  fail "Cursor Bridge" "$(cat "$BRIDGE_LOG")"
fi

# Check cursor agent now shows as connected
CU_STATUS=$(api GET "/v2/agents/$CU_ID" | python3 -c "import sys,json; print(json.load(sys.stdin)['status'])" 2>/dev/null)
[ "$CU_STATUS" = "connected" ] && pass "Cursor agent status = connected" || fail "Cursor status" "status=$CU_STATUS"
rm -f "$BRIDGE_LOG"

# ── MCP Server ────────────────────────────────────────────────────────
section "MCP Server"

MCP_OUT=$(echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}
{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"botschat_list_agents","arguments":{}}}' | \
BOTSCHAT_URL="$BASE_URL" BOTSCHAT_TOKEN="$TOKEN" timeout 5 node packages/mcp-server/dist/index.js 2>/dev/null || true)

TOOL_COUNT=$(echo "$MCP_OUT" | python3 -c "
import sys,json
for line in sys.stdin:
    line = line.strip()
    if not line: continue
    try:
        obj = json.loads(line)
        if obj.get('id') == 2 and 'result' in obj:
            print(len(obj['result']['tools']))
    except: pass
" 2>/dev/null)
[ "$TOOL_COUNT" = "5" ] && pass "MCP Server lists 5 tools" || fail "MCP tools" "count=$TOOL_COUNT"

MCP_AGENTS=$(echo "$MCP_OUT" | python3 -c "
import sys,json
for line in sys.stdin:
    line = line.strip()
    if not line: continue
    try:
        obj = json.loads(line)
        if obj.get('id') == 3 and 'result' in obj:
            content = obj['result']['content'][0]['text']
            agents = json.loads(content)
            print(len(agents))
    except: pass
" 2>/dev/null)
[ "$MCP_AGENTS" = "3" ] && pass "MCP botschat_list_agents returns 3 agents" || fail "MCP agents" "count=$MCP_AGENTS"

# ── Delete Agent ──────────────────────────────────────────────────────
section "Cleanup"

DEL_RESP=$(api DELETE "/v2/agents/$QA_ID")
DEL_OK=$(echo "$DEL_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('ok',''))" 2>/dev/null)
[ "$DEL_OK" = "True" ] && pass "delete agent" || fail "delete" "ok=$DEL_OK"

FINAL_COUNT=$(api GET /v2/agents | python3 -c "import sys,json; print(len(json.load(sys.stdin)['agents']))" 2>/dev/null)
[ "$FINAL_COUNT" = "2" ] && pass "agent count after delete = 2" || fail "final count" "count=$FINAL_COUNT"

# ── Summary ───────────────────────────────────────────────────────────
echo ""
echo -e "${CYAN}════════════════════════════════════════${NC}"
echo -e "  ${GREEN}PASS: $PASS${NC}  ${RED}FAIL: $FAIL${NC}"
echo -e "${CYAN}════════════════════════════════════════${NC}"

[ "$FAIL" -eq 0 ] && exit 0 || exit 1
