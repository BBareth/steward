# Setting up steward

From nothing to an agent managing your Discord server, for a human with a
browser and a Docker host. The same steps as a checklist for a coding agent are
in [AGENT.md](./AGENT.md).

Discord's developer portal is redesigned from time to time. If a label below
does not match exactly, look for the nearest equivalent; the concepts (a bot
token, privileged intents, an OAuth2 install link, role order) have been stable
for years.

---

## What you need

- A Discord account with **Manage Server** on the server steward will manage.
  Start with a throwaway test server if you can.
- A Docker host on your LAN (Docker 24+ with Compose v2). Anything that runs
  Linux containers: a NAS, a mini PC, a Raspberry Pi 4/5 (arm64 is supported).
- On the machine you run Claude Code or Codex from: network access to that host,
  directly or over a VPN.

## 1. Create the Discord application

1. Open <https://discord.com/developers/applications> and click
   **New Application**. Name it (`steward` is fine; members will see the bot's
   name), accept the terms, **Create**.
2. Go to **Bot**.
   - Click **Reset Token**, confirm, and copy the token. It is shown once. This
     is `DISCORD_TOKEN`. Treat it like a password: anyone who has it controls
     the bot.
   - Under **Privileged Gateway Intents**:
     - **Server Members Intent**: turn on only if you want welcome messages or
       join roles. You will also set `DISCORD_MEMBERS_INTENT=true`.
     - **Presence Intent** and **Message Content Intent**: leave off. steward
       never asks for them.
   - Optional but recommended: turn off **Public Bot**, so only you can add it
     to servers. If the portal refuses because of an install link, set
     **Installation → Install Link** to _None_ first.
3. Note the **Application ID** on **General Information**. You only need it if
   you build the invite link by hand.

## 2. Invite the bot to your server

steward needs to be in the server, with a role that can do the work.

**Easiest:** use Administrator. Go to **OAuth2 → URL Generator**, tick the
`bot` scope, tick **Administrator** under Bot Permissions, copy the generated
URL, open it, pick your server, **Authorize**.

**Narrower:** instead of Administrator, tick: View Channels, Send Messages,
Send Messages in Threads, Embed Links, Attach Files, Read Message History, Add
Reactions, View Audit Log, Manage Roles, Manage Channels, Manage Server, Manage
Messages, Manage Threads, Create Public Threads, Create Private Threads, Use
External Emojis, Connect, Speak, Video, Use Voice Activity, Mute Members, Move
Members, Timeout Members. That is steward's `recommended` preset. The long tail
matters: Discord only lets a bot put a permission into a channel overwrite or a
role if the bot holds that permission itself, so leave out anything you will
never want your blueprints to grant.

Once steward is running you can also ask the agent for
`generate_invite_link` — it builds the same URL with either preset.

steward does not register slash commands, so the `applications.commands` scope
is not needed.

## 3. Put the bot's role high enough

When the bot joins, Discord gives it a role named after it, usually near the
bottom of the list. **A bot can only edit, order or hand out roles below its
own highest role, even with Administrator.**

Open **Server Settings → Roles** and drag the bot's role above every role you
want steward to manage. Typically that is just below your own owner/admin role.
Roles you keep above it are visible to steward but untouchable; plans mark
those steps as blocked and say why.

## 4. Find your server ID

**User Settings → Advanced → Developer Mode**: on. Then right-click your
server's icon → **Copy Server ID**. That is a value for `DISCORD_GUILD_IDS`.
steward refuses to touch any server not listed there, even if the bot is a
member.

## 5. Deploy on the homelab

On the Docker host:

```bash
git clone https://github.com/BBareth/steward.git /opt/steward
cd /opt/steward
sh scripts/init-config.sh --guilds 123456789012345678 --bind 192.168.1.20 --host steward.lan
```

- `--guilds`: your server ID(s), comma-separated.
- `--bind`: the host's LAN (or VPN) address; the port is published there. Omit
  it to keep steward reachable from the host only.
- `--host`: an extra host name clients will use, if any.

The script writes `.env` (mode 600) from [`.env.example`](../.env.example),
generates an MCP token, and prints it. Keep that token handy for step 7.

Open `.env` and set:

```dotenv
DISCORD_TOKEN=<the bot token from step 1>
DISCORD_MEMBERS_INTENT=true      # only if you enabled Server Members Intent
```

Start it:

```bash
docker compose up -d --build
```

The first build takes a minute or two. Later, `docker compose up -d` reuses
the image already on the host; see [Updating](#updating) for how to move to a
newer one.

### Check it

```bash
curl -s http://127.0.0.1:8787/healthz   # {"status":"ok",...}
curl -s http://127.0.0.1:8787/readyz    # {"status":"ready",...}
docker compose ps                        # STATUS: Up ... (healthy) after a minute
docker compose logs steward | tail -20
```

`readyz` is the useful one: it says `not_ready` with the reason while Discord is
unreachable or rejected the token. The startup log line `steward started` lists
the guilds, credentials (by name), allowed hosts and safety switches it is
running with. Read it once.

### LAN, VPN and firewalls

The port is published on `STEWARD_BIND_ADDRESS` (default `127.0.0.1`). Every
request must also carry a `Host` header listed in `MCP_ALLOWED_HOSTS`; a
mismatch gets `403`. So for a client that connects to
`http://steward.lan:8787/mcp`, `steward.lan` must be in the list.

- **LAN:** bind to the host's LAN IP. Keep port 8787 closed on your router.
- **Tailscale / WireGuard:** bind to the host's VPN address (Tailscale:
  `100.x.y.z`) and add its MagicDNS name to `MCP_ALLOWED_HOSTS`. Then only VPN
  peers can reach it.
- **Both:** Docker publishes one address per port mapping. Use `0.0.0.0` only if
  a host firewall restricts 8787 to trusted networks.

Never put steward on the open internet. It has no rate limiting beyond failed
logins, and a leaked write token can rebuild your server.

## 6. Turn on what you need

The defaults are conservative. In `.env`:

| Want | Set |
| --- | --- |
| The agent may delete channels/roles and prune with blueprints | `ALLOW_DESTRUCTIVE=true` |
| Inspection only, no changes at all | `READ_ONLY=true` |
| Welcome messages and join roles | `DISCORD_MEMBERS_INTENT=true` (and the portal toggle) |
| Keep members' reactions off steward's own messages | `DISCORD_BOT_REACTION_GUARD=true` (no portal toggle; the bot needs Manage Messages) |

`docker compose up -d` after editing `.env`: it recreates the container with
the new settings. `docker compose restart` does not; it restarts the old
container with the old settings.

## 7. Connect your agent

On the machine you code on. Replace the address with yours; the token is the
one `init-config.sh` printed (it is also `MCP_AUTH_TOKEN` in `.env`).

### Claude Code

```bash
export STEWARD_MCP_TOKEN=stw_...
claude mcp add --transport http steward http://steward.lan:8787/mcp \
  --header "Authorization: Bearer $STEWARD_MCP_TOKEN"
claude mcp list
```

`claude mcp list` should show `✔ Connected`. Inside Claude Code, `/mcp` shows
the server and its tools. Add `--scope user` to make it available in every
project.

To share the configuration in a repository instead, commit a `.mcp.json` like
[`examples/claude-code.mcp.json`](../examples/claude-code.mcp.json). It reads
`${STEWARD_MCP_TOKEN}` from the environment, so the token stays out of git.

### Codex

```bash
export STEWARD_MCP_TOKEN=stw_...   # put this in your shell profile
codex mcp add steward --url http://steward.lan:8787/mcp --bearer-token-env-var STEWARD_MCP_TOKEN
codex mcp list
```

Or add [`examples/codex-config.toml`](../examples/codex-config.toml) to
`~/.codex/config.toml`. In a Codex session, `/mcp` lists connected servers.

### First conversation

Try, in order:

1. "Call steward_status." — confirms the connection, the guilds, and your scopes.
2. "Give me an overview of my server with get_guild_overview." — read its
   warnings: they point out hierarchy problems and missing permissions.
3. "Export the server as a blueprint." — this also binds keys to your existing
   channels and roles, so later plans update them instead of creating copies.
4. "Change the blueprint to add a private staff category with a mod-chat
   channel, plan it, and show me the plan." — then approve the apply.

## Several clients

One token for everything is fine for one person. To give, say, a read-only
token to a second tool, use a tokens file instead of (or as well as)
`MCP_AUTH_TOKEN`:

```bash
node scripts/generate-token.mjs --name codex-readonly --scopes read --guilds 123456789012345678
```

It prints a token (give it to the client) and an entry with only its SHA-256.
Put entries in a file like [`examples/tokens.json.example`](../examples/tokens.json.example),
then mount it and point steward at it, e.g. in a `docker-compose.override.yml`:

```yaml
services:
  steward:
    environment:
      MCP_TOKENS_FILE: /run/secrets/steward-tokens.json
    volumes:
      - ./tokens.json:/run/secrets/steward-tokens.json:ro
```

The container runs as uid 1000, so the file must be readable by it
(`chmod 644 tokens.json` — it only holds hashes). Scopes are `read`, `write`,
`destructive`; `guilds` limits a credential to some of `DISCORD_GUILD_IDS`.

## Keeping secrets out of `.env`

`DISCORD_TOKEN_FILE` and `MCP_AUTH_TOKEN_FILE` read the value from a file,
which works with Compose secrets:

```yaml
services:
  steward:
    environment:
      DISCORD_TOKEN_FILE: /run/secrets/discord_token
    secrets: [discord_token]
secrets:
  discord_token:
    file: ./discord_token.txt
```

(Remove `DISCORD_TOKEN` from `.env` when you do this; setting both is an error.)

## Updating

Restarting is not updating. A container runs the image it was created from,
with the settings it was created with, until it is recreated:

| Command | New code? | New `.env` settings? |
| --- | --- | --- |
| `docker compose restart` | No | No |
| `docker compose up -d` | No: uses the image already on the host, pulling or building only when there is none | Yes, it recreates the container when its settings changed |
| `docker compose pull` then `docker compose up -d` | Yes, the newest image published under the tag | Yes |
| `docker compose up -d --build` | Yes, built from the files in this directory | Yes |

**Which image.** `STEWARD_IMAGE` (default `ghcr.io/bbareth/steward:latest`)
picks the tag. The publish workflow pushes `edge` on every push to `main`,
`X.Y.Z` and `X.Y` for release tags, and moves `latest` only for the newest
release, so `latest` does not exist until the first release. To follow `main`,
set `STEWARD_IMAGE=ghcr.io/bbareth/steward:edge`; to stay put, pin `X.Y.Z`.
A local `--build` is tagged with the same name, so it keeps being used until
you `docker compose pull`.

**From a published image:**

```bash
cd /opt/steward
docker compose pull
docker compose up -d
docker compose ps        # (healthy) after a minute
curl -s http://127.0.0.1:8787/readyz
```

**From source.** Put the new source files in place, keeping `.env`, any
secret files and the volume, then build. If `/opt/steward` is a git checkout,
`git pull` does the first step; if it is a plain copy (no `.git` directory),
copy the files over from a checkout or an archive instead, for example from
your workstation:

```bash
# src/ exactly, so files a release removed do not linger and break the build:
rsync -a --delete src/ host:/opt/steward/src/
# everything else, leaving the host's own files alone:
rsync -a --exclude .git --exclude node_modules --exclude dist --exclude src \
  --exclude .env --exclude discord_token.txt --exclude tokens.json \
  --exclude docker-compose.override.yml ./ host:/opt/steward/
```

then on the host:

```bash
cd /opt/steward
docker compose up -d --build
docker compose ps
curl -s http://127.0.0.1:8787/readyz
```

Compare `.env` with `.env.example` after an update; new settings default to
off. Database migrations run automatically at startup. Check `readyz`
afterwards.

## Backups

Everything steward knows lives in one SQLite file in the `steward_data` volume:
key-to-ID mappings, plans, the operation journal, welcome configuration, the
self-role allowlist, role panels and managed messages.

**The mappings matter.** Without them, steward no longer knows which Discord
resources a blueprint's keys refer to, and the next plan would create new ones
alongside the old. If you lose the database, run `export_blueprint` (which
re-binds keys to whatever exists) before applying anything.

An online backup, without stopping the service:

```bash
docker compose exec steward node -e \
  "require('better-sqlite3')('/data/steward.db',{readonly:true}).backup('/data/steward-backup.db').then(()=>console.log('ok'))"
docker compose cp steward:/data/steward-backup.db ./steward-$(date +%F).db
```

## Uninstalling

```bash
docker compose down        # stop; keeps the volume
docker compose down -v     # also delete the database
```

Remove the bot from your server (Server Settings → Integrations) and, if you
are done with it, delete the application in the developer portal. Roles and
channels steward created stay in your server; they are ordinary Discord
resources.

## Troubleshooting

**`steward: refusing to start.`** The message lists every configuration
problem. Typical: missing `DISCORD_TOKEN`, a guild ID that is not a number, an
`MCP_AUTH_TOKEN` shorter than 32 characters.

**`readyz` shows `TokenInvalid`.** The bot token is wrong or was reset. Reset it
again in the portal, update `.env`, `docker compose up -d`.

**`readyz` mentions intents.** You set `DISCORD_MEMBERS_INTENT=true` but Server
Members Intent is off in the portal (Bot page). Enable it or set the variable to
`false`.

**`readyz` says `getaddrinfo ENOTFOUND discord.com`.** The container has no DNS
or no internet access. steward keeps retrying with backoff.

**The client cannot connect.** From the client machine:
`curl -s http://steward.lan:8787/healthz`. No answer: networking (binding,
firewall, VPN). `403`: add the host name to `MCP_ALLOWED_HOSTS`. `401`: wrong
token. `429`: too many failed attempts from your address; wait five minutes.

**`guild_not_allowed`.** The server is not in `DISCORD_GUILD_IDS`, or the
credential's `guilds` list excludes it.

**"the bot is not a member of guild …".** Invite it (step 2).

**Plan steps are blocked.** Each blocked step says why. "At or above the bot's
highest role": move the bot's role up (step 3). "Cannot grant permissions it
does not hold": give the bot that permission, or remove it from the blueprint.
"Needs Manage …": the bot is missing that permission.

**`stale_plan`.** Someone changed the server between planning and applying.
Plan again.

**Welcome messages never post.** Check `get_bot_features`: `members_intent`
must be `true`. The welcome channel must be one the bot can post in.

**A role panel button says the role cannot be self-assigned.** The role gained
moderation power (directly or via a channel overwrite), was marked as staff, or
moved above the bot. steward re-checks on every click. The reason is in the
container logs (`refused self-assign`).
