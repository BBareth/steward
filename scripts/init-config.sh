#!/bin/sh
# Create .env from .env.example with a fresh MCP token. Safe to re-run: it
# never overwrites an existing .env.
#
#   sh scripts/init-config.sh
#   sh scripts/init-config.sh --guilds 123456789012345678 --bind 192.168.1.20 --host steward.lan
#
# The Discord token is never passed on the command line (it would land in your
# shell history); paste it into .env afterwards, or set DISCORD_TOKEN in the
# environment when running this script.
set -eu

cd "$(dirname "$0")/.."

GUILDS=""
BIND=""
HOSTNAME_EXTRA=""
while [ $# -gt 0 ]; do
  case "$1" in
    --guilds) GUILDS="$2"; shift 2 ;;
    --bind) BIND="$2"; shift 2 ;;
    --host) HOSTNAME_EXTRA="$2"; shift 2 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

if [ -e .env ]; then
  echo ".env already exists; not touching it. Delete it first to start over." >&2
  exit 1
fi

if command -v openssl >/dev/null 2>&1; then
  TOKEN="stw_$(openssl rand -base64 36 | tr '+/' '-_' | tr -d '=\n')"
elif command -v node >/dev/null 2>&1; then
  TOKEN="$(node scripts/generate-token.mjs)"
else
  echo "need openssl or node to generate a token" >&2
  exit 1
fi

umask 077
cp .env.example .env

# Replace "KEY=..." lines in place without echoing secrets to the terminal.
set_var() {
  key="$1"
  value="$2"
  tmp=$(mktemp)
  awk -v k="$key" -v v="$value" 'BEGIN { done = 0 } $0 ~ "^"k"=" { print k"="v; done = 1; next } { print } END { if (!done) print k"="v }' .env > "$tmp"
  cat "$tmp" > .env
  rm -f "$tmp"
}

set_var MCP_AUTH_TOKEN "$TOKEN"
[ -n "${DISCORD_TOKEN:-}" ] && set_var DISCORD_TOKEN "$DISCORD_TOKEN"
[ -n "$GUILDS" ] && set_var DISCORD_GUILD_IDS "$GUILDS"
if [ -n "$BIND" ]; then
  set_var STEWARD_BIND_ADDRESS "$BIND"
  HOSTS="localhost,127.0.0.1,$BIND"
  [ -n "$HOSTNAME_EXTRA" ] && HOSTS="$HOSTS,$HOSTNAME_EXTRA"
  set_var MCP_ALLOWED_HOSTS "$HOSTS"
elif [ -n "$HOSTNAME_EXTRA" ]; then
  set_var MCP_ALLOWED_HOSTS "localhost,127.0.0.1,$HOSTNAME_EXTRA"
fi
chmod 600 .env

echo "Wrote .env (mode 600)."
echo
echo "MCP token for your client (also in .env as MCP_AUTH_TOKEN):"
echo "  $TOKEN"
echo
echo "Next:"
[ -z "${DISCORD_TOKEN:-}" ] && echo "  - put your bot token in .env (DISCORD_TOKEN=...)"
[ -z "$GUILDS" ] && echo "  - set DISCORD_GUILD_IDS in .env"
echo "  - docker compose up -d --build"
echo "  - curl -s http://127.0.0.1:8787/readyz"
