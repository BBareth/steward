# Deploying steward — agent runbook

A checklist for a coding agent asked to deploy steward on a host it has shell
access to, connect an MCP client, and prove it works. Every step has a command
and a check; prefer the check over assuming success.

The human-facing version is [SETUP.md](./SETUP.md).

---

## What you cannot do without the operator

Stop and ask for these. None of them can be obtained from a shell.

| Needed | Where it comes from |
| --- | --- |
| `DISCORD_TOKEN` | The operator creates an application at discord.com/developers/applications, adds a bot, and copies the token (Bot → Reset Token). Shown once. |
| Which server(s) to manage | The operator gives you the server IDs for `DISCORD_GUILD_IDS`. Do not add servers they did not name. |
| Inviting the bot | Needs a browser and Manage Server on the target server. Give the operator the link (Step 6 or SETUP.md §2); they click Authorize. |
| Role placement | The operator drags the bot's role above the roles it should manage (Server Settings → Roles). You cannot do this through the API for the bot's own top role. |
| Server Members Intent | Portal toggle (Bot page). Only needed for welcome messages and join roles. |
| Which network clients use | LAN IP, VPN address or host name. Decides `STEWARD_BIND_ADDRESS` and `MCP_ALLOWED_HOSTS`. |
| Permission to delete things | `ALLOW_DESTRUCTIVE=true` is the operator's call. Leave it `false` unless told. |

Never paste the Discord token or the MCP token into chat, commit them, or put
them on a command line that lands in shell history.

## 1. Preflight

```bash
docker --version && docker compose version     # Docker 24+, Compose v2
git --version
```

Pick a directory (e.g. `/opt/steward`). The service keeps its state in a named
volume, `<project>_steward_data`.

## 2. Get the code

```bash
git clone https://github.com/BBareth/steward.git /opt/steward
cd /opt/steward
```

**Check:** `ls docker-compose.yml .env.example scripts/init-config.sh`.

## 3. Configuration

```bash
sh scripts/init-config.sh --guilds <ids from the operator> [--bind <LAN or VPN IP>] [--host <name clients use>]
```

It refuses to overwrite an existing `.env`. It prints the new MCP token once;
hand it to whoever configures the client (or keep it for step 7). Then have the
operator put the bot token into `.env` themselves, or write it without echoing:

```bash
read -rs DT && sed -i "s|^DISCORD_TOKEN=.*|DISCORD_TOKEN=$DT|" .env && unset DT
```

**Check** (prints names only, never values):

```bash
grep -E '^(DISCORD_GUILD_IDS|MCP_ALLOWED_HOSTS|STEWARD_BIND_ADDRESS|ALLOW_DESTRUCTIVE|READ_ONLY|DISCORD_MEMBERS_INTENT|DISCORD_BOT_REACTION_GUARD)=' .env
grep -cE '^DISCORD_TOKEN=.+' .env      # 1
grep -cE '^MCP_AUTH_TOKEN=.{32,}' .env  # 1
stat -c %a .env                         # 600
```

## 4. Start

```bash
docker compose up -d --build
```

**Check — live:**

```bash
for i in $(seq 1 60); do curl -fsS http://127.0.0.1:8787/healthz && break; sleep 1; done
```

**Check — ready (Discord connected):**

```bash
curl -s http://127.0.0.1:8787/readyz
```

`{"status":"ready",...}` means the gateway is connected. Otherwise
`discord.detail` says why — act on it:

| `detail` contains | Do |
| --- | --- |
| `TokenInvalid` | Ask the operator for a fresh token. |
| `intents` | Set `DISCORD_MEMBERS_INTENT=false`, or ask the operator to enable Server Members Intent. |
| `ENOTFOUND`, `ECONNREFUSED` | The host cannot reach discord.com. Fix DNS/egress; steward retries by itself. |

**Check — configuration it is running with:**

```bash
docker compose logs steward | grep '"msg":"steward started"'
```

Confirm `guilds`, `allowedHosts`, `readOnly`, `allowDestructive`,
`membersIntent` are what the operator asked for.

## 5. Check the MCP endpoint

Without a token, and with a foreign Host, it must refuse:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:8787/mcp          # 401
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:8787/mcp \
  -H "Authorization: Bearer $(grep ^MCP_AUTH_TOKEN= .env | cut -d= -f2-)" -H 'Host: evil.example'  # 403
```

With the token, list the tools and call one. The endpoint is stateless, so no
session is needed:

```bash
TOKEN=$(grep ^MCP_AUTH_TOKEN= .env | cut -d= -f2-)
mcp() {
  curl -s http://127.0.0.1:8787/mcp -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
    -H 'MCP-Protocol-Version: 2025-06-18' -d "$1"
}
mcp '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | grep -o '"name":"[a-z_]*"' | head
mcp '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"steward_status","arguments":{}}}'
```

Keep this shell for step 6, then `unset TOKEN`.

**Check:** `steward_status` reports `discord.state: "ready"`, and every guild in
`guilds` has `bot_present: true`. `bot_present: false` means the bot has not
been invited there yet — go to step 6. If the operator set
`DISCORD_BOT_REACTION_GUARD=true`, `reaction_guard.active` should be `true`;
otherwise `why_inactive` says why.

## 6. Invite and position the bot (operator)

```bash
mcp '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"generate_invite_link","arguments":{"guild_id":"<id>","preset":"administrator"}}}'
```

Give the operator the `url` and the `manual_steps`. Afterwards:

```bash
mcp '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"get_guild_overview","arguments":{"guild_id":"<id>"}}}'
```

**Check:** `bot.warnings` is empty or only mentions roles the operator wants
left alone. A warning listing roles "at or above the bot's highest role" means
step 3 of SETUP.md still needs doing.

## 7. Connect the operator's client

On the machine where the agent runs (not necessarily the Docker host). Use the
address and host name allowed in `MCP_ALLOWED_HOSTS`.

Claude Code:

```bash
claude mcp add --transport http steward http://<host>:8787/mcp --header "Authorization: Bearer $STEWARD_MCP_TOKEN"
claude mcp list        # expect ✔ Connected
```

Codex:

```bash
codex mcp add steward --url http://<host>:8787/mcp --bearer-token-env-var STEWARD_MCP_TOKEN
codex mcp list
```

(`STEWARD_MCP_TOKEN` must be exported in the environment the client starts
from.) Files to copy: [`examples/`](../examples).

**Check:** in the client, call `steward_status`; `you.scopes` matches what the
operator intended.

## 8. Prove the blueprint workflow (optional, needs a test server)

Only on a server the operator nominated for testing.

1. `validate_blueprint` with [`examples/community.yaml`](../examples/community.yaml) → `valid: true`.
2. `plan_blueprint` with it → read `summary`, `blocked`, `warnings`.
3. `apply_plan` with the `plan_id` → `status: "applied"` (or poll
   `get_apply_status` while `running`).
4. `verify_blueprint` → `in_sync: true`.
5. `plan_blueprint` again → `steps: []`. That is the idempotency guarantee.

To remove what it created: with `ALLOW_DESTRUCTIVE=true` and a destructive-scope
token, `plan_blueprint` with `{"version": 1}` and
`prune: {roles: true, channels: true, messages: true, panels: true, automod: true}`,
review, then `apply_plan`. Only resources steward created or was bound to are
pruned.

## Optional: live integration test from a checkout

Runs the real discord.js adapter against a dedicated test server: creates
uniquely named resources, verifies, re-applies, prunes them.

```bash
npm ci
STEWARD_LIVE_TOKEN=<bot token> STEWARD_LIVE_GUILD_ID=<test server id> npm run test:live
```

Without both variables the suite is skipped.

## Rollback

```bash
docker compose down                     # stop, keep data
git checkout <previous tag or commit> && docker compose up -d --build
```

Database migrations run forward only (there is one schema version so far).
Back up the database before upgrading if you may want to roll back
([SETUP.md](./SETUP.md#backups)). Changes already made in Discord are not undone
by rolling back steward.
