#!/usr/bin/env bash
#
# Post-deploy smoke test for the ai-proxy Worker. Runs from Termux (needs curl).
# Nothing here runs wrangler or workerd, so it is safe on Termux/proot ARM64.
#
# Usage:
#   BASE_URL=https://ai-proxy.<sub>.workers.dev ALLOWED_ORIGIN=https://you.github.io ./scripts/smoke-test.sh
#   ./scripts/smoke-test.sh https://ai-proxy.<sub>.workers.dev https://you.github.io
#
# ALLOWED_ORIGIN must be one of the origins in the Worker's ALLOWED_ORIGINS var.
#
# Which cases need a real upstream key on the Worker (wrangler secret put UPSTREAM_API_KEY):
#   1-4  do NOT need a key — they are handled or rejected before the upstream is ever called.
#   5    NEEDS a real key to be meaningful — it is the only case that reaches the upstream.
set -u

BASE_URL="${BASE_URL:-${1:-}}"
ALLOWED_ORIGIN="${ALLOWED_ORIGIN:-${2:-}}"
if [ -z "$BASE_URL" ] || [ -z "$ALLOWED_ORIGIN" ]; then
  echo "usage: BASE_URL=<worker-url> ALLOWED_ORIGIN=<allowed-origin> $0"
  echo "   or: $0 <worker-url> <allowed-origin>"
  exit 2
fi
BASE_URL="${BASE_URL%/}"

BODY='{"model":"claude-opus-4-8","max_tokens":16,"messages":[{"role":"user","content":"ping"}]}'
STREAM_BODY='{"model":"claude-opus-4-8","max_tokens":16,"stream":true,"messages":[{"role":"user","content":"ping"}]}'

pass=0; fail=0
check() { # $1 label  $2 expected  $3 actual
  if [ "$2" = "$3" ]; then echo "PASS  $1 (got $3)"; pass=$((pass+1))
  else echo "FAIL  $1 (expected $2, got $3)"; fail=$((fail+1)); fi
}

echo "== 1. GET /health -> 200 ==   [no upstream key needed]"
code=$(curl -sS -o /dev/null -w '%{http_code}' "$BASE_URL/health")
check "/health returns 200" 200 "$code"

echo
echo "== 2. POST /v1/chat with NO Origin header -> 403 ==   [no upstream key needed]"
code=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE_URL/v1/chat" \
  -H 'Content-Type: application/json' --data "$BODY")
check "missing Origin returns 403" 403 "$code"

echo
echo "== 3. POST /v1/chat with a disallowed Origin -> 403 ==   [no upstream key needed]"
code=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE_URL/v1/chat" \
  -H 'Content-Type: application/json' -H 'Origin: https://evil.example.com' --data "$BODY")
check "disallowed Origin returns 403" 403 "$code"

echo
echo "== 4. OPTIONS /v1/chat preflight, allowed Origin -> echoes that origin, never * ==   [no upstream key needed]"
hdrs=$(curl -sS -i -X OPTIONS "$BASE_URL/v1/chat" \
  -H "Origin: $ALLOWED_ORIGIN" \
  -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: content-type')
printf '%s\n' "$hdrs" | grep -iE '^HTTP/|^access-control-|^vary:' | tr -d '\r' | sed 's/^/    /'
acao=$(printf '%s\n' "$hdrs" | grep -i '^access-control-allow-origin:' | tr -d '\r' | awk '{$1=""; sub(/^ /,""); print}')
if [ "$acao" = "$ALLOWED_ORIGIN" ]; then
  echo "PASS  preflight echoes the allowed origin, not a wildcard"; pass=$((pass+1))
elif [ "$acao" = "*" ]; then
  echo "FAIL  preflight returned '*' (must never be wildcard)"; fail=$((fail+1))
else
  echo "FAIL  Allow-Origin was '$acao' (expected $ALLOWED_ORIGIN)"; fail=$((fail+1))
fi

echo
echo "== 5. POST /v1/chat with stream:true -> incremental SSE pass-through ==   [NEEDS A REAL UPSTREAM KEY]"
echo "   With a REAL key: response headers should show 'content-type: text/event-stream' and no"
echo "   fixed content-length; SSE events below should appear progressively, not all at once."
echo "   With a PLACEHOLDER key: the upstream returns 401 and the Worker returns 502 {\"ok\":false},"
echo "   which proves key injection + upstream-error handling but does NOT exercise streaming."
echo "   -N keeps curl unbuffered so you can see chunks arrive live."
echo "   --- response headers, then body ---"
curl -sS -N -D - -X POST "$BASE_URL/v1/chat" \
  -H 'Content-Type: application/json' \
  -H "Origin: $ALLOWED_ORIGIN" \
  --data "$STREAM_BODY"
echo
echo "   --- end of stream ---"

echo
echo "======================================================================"
echo "auto-checked cases 1-4: $pass passed, $fail failed"
echo "case 5 is a manual judgement: only meaningful if UPSTREAM_API_KEY is a real key on the Worker."
[ "$fail" -eq 0 ]
