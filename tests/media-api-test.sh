#!/usr/bin/env bash
# BotsChat Media API End-to-End Test
# Tests the complete media upload/download/serving chain using dev-auth.
# Usage: ./tests/media-api-test.sh [BASE_URL]
set -euo pipefail

BASE_URL="${1:-http://localhost:8787}"
SECRET="REDACTED_DEV_SECRET"
PASS=0
FAIL=0
TMPDIR_TEST=$(mktemp -d)
trap "rm -rf $TMPDIR_TEST" EXIT

red()   { printf '\033[0;31m%s\033[0m\n' "$*"; }
green() { printf '\033[0;32m%s\033[0m\n' "$*"; }
cyan()  { printf '\033[0;36m%s\033[0m\n' "$*"; }

pass() { PASS=$((PASS+1)); green "  PASS: $1"; }
fail() { FAIL=$((FAIL+1)); red   "  FAIL: $1 — $2"; }

# ── Step 0: Create a test image ──────────────────────────────────────
cyan "Creating test image..."
# Minimal 1x1 PNG (67 bytes)
printf '\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x02\x00\x00\x00\x90wS\xde\x00\x00\x00\x0cIDATx\x9cc\xf8\x0f\x00\x00\x01\x01\x00\x05\x18\xd8N\x00\x00\x00\x00IEND\xaeB`\x82' > "$TMPDIR_TEST/test.png"

# ── Step 1: Dev-Auth Login ───────────────────────────────────────────
cyan "\n=== Step 1: Dev-Auth Login ==="

RESP=$(curl -s -w '\n%{http_code}' -X POST "$BASE_URL/api/dev-auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"secret\":\"$SECRET\"}")
HTTP_CODE=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')

if [[ "$HTTP_CODE" == "200" ]]; then
  TOKEN=$(echo "$BODY" | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])" 2>/dev/null || echo "")
  USER_ID=$(echo "$BODY" | python3 -c "import sys,json; print(json.load(sys.stdin)['userId'])" 2>/dev/null || echo "")
  if [[ -n "$TOKEN" ]]; then
    pass "dev-auth login (userId=$USER_ID)"
  else
    fail "dev-auth login" "token missing from response"
  fi
else
  fail "dev-auth login" "HTTP $HTTP_CODE: $BODY"
  echo "Cannot continue without auth token"
  exit 1
fi

# ── Step 1b: Dev-Auth with custom userId ─────────────────────────────
RESP=$(curl -s -w '\n%{http_code}' -X POST "$BASE_URL/api/dev-auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"secret\":\"$SECRET\",\"userId\":\"custom-test-user\"}")
HTTP_CODE=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')
CUSTOM_UID=$(echo "$BODY" | python3 -c "import sys,json; print(json.load(sys.stdin).get('userId',''))" 2>/dev/null || echo "")
if [[ "$HTTP_CODE" == "200" && "$CUSTOM_UID" == "custom-test-user" ]]; then
  pass "dev-auth login with custom userId"
else
  fail "dev-auth login with custom userId" "HTTP $HTTP_CODE, userId=$CUSTOM_UID"
fi

# ── Step 1c: Dev-Auth with wrong secret ──────────────────────────────
RESP=$(curl -s -w '\n%{http_code}' -X POST "$BASE_URL/api/dev-auth/login" \
  -H 'Content-Type: application/json' \
  -d '{"secret":"wrong-secret"}')
HTTP_CODE=$(echo "$RESP" | tail -1)
if [[ "$HTTP_CODE" == "403" ]]; then
  pass "dev-auth rejects wrong secret (403)"
else
  fail "dev-auth wrong secret" "expected 403, got $HTTP_CODE"
fi

# ── Step 2: Upload Image ────────────────────────────────────────────
cyan "\n=== Step 2: Upload Image ==="

RESP=$(curl -s -w '\n%{http_code}' -X POST "$BASE_URL/api/upload" \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@$TMPDIR_TEST/test.png;type=image/png")
HTTP_CODE=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')

if [[ "$HTTP_CODE" == "200" ]]; then
  MEDIA_URL=$(echo "$BODY" | python3 -c "import sys,json; print(json.load(sys.stdin)['url'])" 2>/dev/null || echo "")
  MEDIA_KEY=$(echo "$BODY" | python3 -c "import sys,json; print(json.load(sys.stdin).get('key',''))" 2>/dev/null || echo "")
  if [[ -n "$MEDIA_URL" ]]; then
    pass "upload image (url=$MEDIA_URL)"
  else
    fail "upload image" "url missing from response: $BODY"
  fi
else
  fail "upload image" "HTTP $HTTP_CODE: $BODY"
fi

# ── Step 2b: Upload without auth ─────────────────────────────────────
RESP=$(curl -s -w '\n%{http_code}' -X POST "$BASE_URL/api/upload" \
  -F "file=@$TMPDIR_TEST/test.png;type=image/png")
HTTP_CODE=$(echo "$RESP" | tail -1)
if [[ "$HTTP_CODE" == "401" || "$HTTP_CODE" == "403" ]]; then
  pass "upload rejects unauthenticated (HTTP $HTTP_CODE)"
else
  fail "upload without auth" "expected 401/403, got $HTTP_CODE"
fi

# ── Step 2c: Upload allowed non-image file (JSON) ────────────────────
echo '{"test": true}' > "$TMPDIR_TEST/test.json"
RESP=$(curl -s -w '\n%{http_code}' -X POST "$BASE_URL/api/upload" \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@$TMPDIR_TEST/test.json;type=application/json")
HTTP_CODE=$(echo "$RESP" | tail -1)
if [[ "$HTTP_CODE" == "200" ]]; then
  pass "upload accepts JSON file attachment"
else
  fail "upload JSON file" "expected 200, got $HTTP_CODE"
fi

# ── Step 2d: Upload blocked file type (SVG) ──────────────────────────
echo '<svg xmlns="http://www.w3.org/2000/svg"></svg>' > "$TMPDIR_TEST/test.svg"
RESP=$(curl -s -w '\n%{http_code}' -X POST "$BASE_URL/api/upload" \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@$TMPDIR_TEST/test.svg;type=image/svg+xml")
HTTP_CODE=$(echo "$RESP" | tail -1)
if [[ "$HTTP_CODE" == "400" ]]; then
  pass "upload rejects SVG file (400)"
else
  fail "upload SVG" "expected 400, got $HTTP_CODE"
fi

# ── Step 2e: Upload blocked file type (executable) ───────────────────
echo '#!/bin/sh' > "$TMPDIR_TEST/test.sh"
RESP=$(curl -s -w '\n%{http_code}' -X POST "$BASE_URL/api/upload" \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@$TMPDIR_TEST/test.sh;type=application/x-sh")
HTTP_CODE=$(echo "$RESP" | tail -1)
if [[ "$HTTP_CODE" == "400" ]]; then
  pass "upload rejects unsupported file type (400)"
else
  fail "upload unsupported type" "expected 400, got $HTTP_CODE"
fi

# ── Step 3: Serve Media via Signed URL ───────────────────────────────
cyan "\n=== Step 3: Serve Media via Signed URL ==="

if [[ -n "${MEDIA_URL:-}" ]]; then
  RESP=$(curl -s -w '\n%{http_code}' "$BASE_URL$MEDIA_URL")
  HTTP_CODE=$(echo "$RESP" | tail -1)
  if [[ "$HTTP_CODE" == "200" ]]; then
    pass "serve media via signed URL"
  else
    fail "serve media via signed URL" "HTTP $HTTP_CODE for $MEDIA_URL"
  fi

  # ── Step 3b: Serve media with tampered signature ───────────────────
  TAMPERED_URL=$(echo "$MEDIA_URL" | sed 's/sig=[^&]*/sig=TAMPERED/')
  RESP=$(curl -s -w '\n%{http_code}' "$BASE_URL$TAMPERED_URL")
  HTTP_CODE=$(echo "$RESP" | tail -1)
  if [[ "$HTTP_CODE" == "403" ]]; then
    pass "serve rejects tampered signature (403)"
  else
    fail "serve tampered signature" "expected 403, got $HTTP_CODE"
  fi

  # ── Step 3c: Serve media via Bearer token ──────────────────────────
  # Strip query params to get the bare path
  BARE_PATH=$(echo "$MEDIA_URL" | cut -d'?' -f1)
  RESP=$(curl -s -w '\n%{http_code}' "$BASE_URL$BARE_PATH" \
    -H "Authorization: Bearer $TOKEN")
  HTTP_CODE=$(echo "$RESP" | tail -1)
  if [[ "$HTTP_CODE" == "200" ]]; then
    pass "serve media via Bearer token"
  else
    fail "serve media via Bearer token" "HTTP $HTTP_CODE for $BARE_PATH"
  fi

  # ── Step 3d: Serve media without auth ──────────────────────────────
  RESP=$(curl -s -w '\n%{http_code}' "$BASE_URL$BARE_PATH")
  HTTP_CODE=$(echo "$RESP" | tail -1)
  if [[ "$HTTP_CODE" == "401" || "$HTTP_CODE" == "403" ]]; then
    pass "serve rejects no-auth request (HTTP $HTTP_CODE)"
  else
    fail "serve media without auth" "expected 401/403, got $HTTP_CODE"
  fi

  # ── Step 3e: Serve non-existent media ──────────────────────────────
  RESP=$(curl -s -w '\n%{http_code}' "$BASE_URL/api/media/$USER_ID/nonexistent.png" \
    -H "Authorization: Bearer $TOKEN")
  HTTP_CODE=$(echo "$RESP" | tail -1)
  if [[ "$HTTP_CODE" == "404" ]]; then
    pass "serve returns 404 for non-existent media"
  else
    fail "serve non-existent media" "expected 404, got $HTTP_CODE"
  fi
else
  fail "media serving tests" "skipped — no MEDIA_URL from upload"
fi

# ── Step 4: Channel + Agent Setup ────────────────────────────────────
cyan "\n=== Step 4: Channel & Agent Setup ==="

# List channels (may be empty for new user)
RESP=$(curl -s -w '\n%{http_code}' "$BASE_URL/api/channels" \
  -H "Authorization: Bearer $TOKEN")
HTTP_CODE=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')
if [[ "$HTTP_CODE" == "200" ]]; then
  pass "list channels"
  CHANNEL_COUNT=$(echo "$BODY" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('channels',d) if isinstance(d,dict) else d))" 2>/dev/null || echo "0")
  cyan "  (found $CHANNEL_COUNT channels)"
else
  fail "list channels" "HTTP $HTTP_CODE: $BODY"
fi

# Create a test channel (unique name per run)
CHAN_NAME="Media Test $(date +%s)"
RESP=$(curl -s -w '\n%{http_code}' -X POST "$BASE_URL/api/channels" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"name\":\"$CHAN_NAME\",\"description\":\"For media testing\"}")
HTTP_CODE=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')
if [[ "$HTTP_CODE" == "200" || "$HTTP_CODE" == "201" ]]; then
  CHANNEL_ID=$(echo "$BODY" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('id',d.get('channel',{}).get('id','')))" 2>/dev/null || echo "")
  pass "create test channel (id=$CHANNEL_ID)"
else
  fail "create test channel" "HTTP $HTTP_CODE: $BODY"
fi

# ── Step 5: Absolute URL Construction Test ───────────────────────────
cyan "\n=== Step 5: URL Construction Tests ==="

# Simulate what the web frontend does: convert relative URL to absolute
if [[ -n "${MEDIA_URL:-}" ]]; then
  ABSOLUTE_URL="$BASE_URL$MEDIA_URL"
  # Test that the absolute URL also works
  RESP=$(curl -s -w '\n%{http_code}' "$ABSOLUTE_URL")
  HTTP_CODE=$(echo "$RESP" | tail -1)
  if [[ "$HTTP_CODE" == "200" ]]; then
    pass "absolute media URL works"
  else
    fail "absolute media URL" "HTTP $HTTP_CODE for $ABSOLUTE_URL"
  fi

  # Test fetch from another "host" simulation (like mini.local plugin would)
  # Just verify the signed URL contains all needed params
  if echo "$MEDIA_URL" | grep -q 'expires=' && echo "$MEDIA_URL" | grep -q 'sig='; then
    pass "signed URL has expires and sig params"
  else
    fail "signed URL params" "missing expires or sig in: $MEDIA_URL"
  fi
fi

# ── Summary ──────────────────────────────────────────────────────────
echo ""
cyan "════════════════════════════════════════"
echo "  Results: ${PASS} passed, ${FAIL} failed"
cyan "════════════════════════════════════════"

if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
