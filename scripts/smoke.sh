#!/usr/bin/env bash
# Post-deploy smoke test. Process startup alone does not prove multiplayer correctness — follow
# with the two-browser checks in docs/DEPLOYMENT.md.
#   scripts/smoke.sh https://realtime.example.com https://game.example.com
set -euo pipefail
RT="${1:?usage: smoke.sh <realtime-origin> <game-origin>}"
GAME="${2:?usage: smoke.sh <realtime-origin> <game-origin>}"
pass() { printf '  ok  %s\n' "$1"; }
fail() { printf '  FAIL %s\n' "$1"; exit 1; }
curl -fsS "$RT/healthz" >/dev/null && pass "health" || fail "health"
curl -fsS "$RT/readyz" | grep -q '"ok":true' && pass "readiness (database)" || fail "readiness"
code=$(curl -s -o /dev/null -w '%{http_code}' -X OPTIONS -H "Origin: $GAME" -H 'Access-Control-Request-Method: POST' "$RT/matchmake/create/restaurant")
[ "$code" = "204" ] && pass "matchmaking CORS preflight" || fail "matchmaking preflight ($code)"
acao=$(curl -s -D - -o /dev/null -X OPTIONS -H "Origin: https://evil.example" -H 'Access-Control-Request-Method: POST' "$RT/matchmake/create/restaurant" | tr -d '\r' | awk -F': ' 'tolower($1)=="access-control-allow-origin"{print $2}')
[ "$acao" != "https://evil.example" ] && pass "foreign origin rejected" || fail "foreign origin allowed"
curl -fsS -o /dev/null "$GAME/" && pass "client index" || fail "client index"
code=$(curl -s -o /dev/null -w '%{http_code}' "$GAME/assets/does-not-exist.js")
[ "$code" = "404" ] && pass "missing asset returns 404" || fail "missing asset returned $code"
echo "Smoke test passed."
