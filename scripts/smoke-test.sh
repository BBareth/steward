#!/bin/sh
# Boot an image with throwaway credentials and check the HTTP surface.
# Used by CI; handy locally too:  sh scripts/smoke-test.sh steward:test
# Discord is not reachable with a fake token, so readiness must say so.
set -eu

IMAGE="${1:-steward:ci}"
NAME="steward-smoke-$$"
PORT="${SMOKE_PORT:-18787}"
TOKEN="stw_smoke_$(date +%s)_0123456789abcdefghijklmnop"

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker run -d --name "$NAME" -p "127.0.0.1:$PORT:8787" \
  -e DISCORD_TOKEN=not-a-real-token \
  -e DISCORD_GUILD_IDS=123456789012345678 \
  -e MCP_AUTH_TOKEN="$TOKEN" \
  -e MCP_ALLOWED_HOSTS=localhost,127.0.0.1 \
  --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges:true \
  "$IMAGE" >/dev/null

fail() { echo "FAIL: $*"; docker logs "$NAME" 2>&1 | tail -30; exit 1; }
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

for i in $(seq 1 30); do
  [ "$(code "http://127.0.0.1:$PORT/healthz")" = "200" ] && break
  [ "$i" = "30" ] && fail "never became live"
  sleep 1
done
echo "live after ${i}s"

[ "$(docker exec "$NAME" id -u)" = "1000" ] || fail "not running as uid 1000"

ready=$(curl -s "http://127.0.0.1:$PORT/readyz")
echo "$ready" | grep -q '"status":"not_ready"' || fail "readyz should report not_ready with a fake token: $ready"
[ "$(code "http://127.0.0.1:$PORT/readyz")" = "503" ] || fail "readyz should be 503"

INIT='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}'
H='-H content-type:application/json -H accept:application/json,text/event-stream'

# shellcheck disable=SC2086
[ "$(code -X POST $H -d "$INIT" "http://127.0.0.1:$PORT/mcp")" = "401" ] || fail "unauthenticated /mcp must be 401"
# shellcheck disable=SC2086
[ "$(code -X POST $H -H "authorization: Bearer wrong-$TOKEN" -d "$INIT" "http://127.0.0.1:$PORT/mcp")" = "401" ] || fail "wrong token must be 401"
# shellcheck disable=SC2086
[ "$(code -X POST $H -H "authorization: Bearer $TOKEN" -H 'host: evil.example' -d "$INIT" "http://127.0.0.1:$PORT/mcp")" = "403" ] || fail "foreign Host must be 403"
# shellcheck disable=SC2086
[ "$(code -X POST $H -H "authorization: Bearer $TOKEN" -H 'origin: https://evil.example' -d "$INIT" "http://127.0.0.1:$PORT/mcp")" = "403" ] || fail "browser Origin must be 403"
# shellcheck disable=SC2086
body=$(curl -s -X POST $H -H "authorization: Bearer $TOKEN" -d "$INIT" "http://127.0.0.1:$PORT/mcp")
echo "$body" | grep -q '"name":"steward"' || fail "initialize did not answer: $body"

# The frontend must be packaged in the image and its authenticated API must
# work even while Discord is unavailable. Never print the session or token.
if ! docker exec -i "$NAME" node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const base = 'http://127.0.0.1:8787';
for (const path of ['/', '/assets/app.js', '/assets/style.css', '/favicon.svg']) {
  const response = await fetch(base + path);
  assert.equal(response.status, 200, path);
}
assert.equal((await fetch(base + '/api/tools')).status, 401);
const login = await fetch(base + '/api/session', {
  method: 'POST', headers: { authorization: `Bearer ${process.env.MCP_AUTH_TOKEN}` },
});
assert.equal(login.status, 200);
const { csrf } = await login.json();
const cookie = login.headers.get('set-cookie').split(';')[0];
const catalog = await fetch(base + '/api/tools', { headers: { cookie } });
assert.equal(catalog.status, 200);
assert((await catalog.json()).tools.some((t) => t.name === 'list_guilds'));
const status = await fetch(base + '/api/tools/steward_status', {
  method: 'POST', headers: { cookie, 'x-steward-csrf': csrf, 'content-type': 'application/json' }, body: '{}',
});
assert.equal(status.status, 200);
assert.equal((await status.json()).data.version, JSON.parse(readFileSync('package.json', 'utf8')).version);
const foreign = await fetch(base + '/api/health', { headers: { cookie, origin: 'https://evil.example' } });
assert.equal(foreign.status, 403);
JS
then
  fail "dashboard smoke test failed"
fi

docker logs "$NAME" 2>&1 | grep -q "$TOKEN" && fail "the MCP token appeared in the logs"
docker logs "$NAME" 2>&1 | grep -q 'not-a-real-token' && fail "the Discord token appeared in the logs"

docker stop -t 20 "$NAME" >/dev/null
docker logs "$NAME" 2>&1 | grep -q '"msg":"stopped"' || fail "did not shut down cleanly"
echo "smoke test passed"
