<p align="center">
  <img src="./docs/logo.svg" width="96" height="96" alt="">
</p>

<h1 align="center">steward</h1>

<p align="center">
  A self-hosted Discord administration bot that coding agents drive over MCP —
  describe a whole server in one blueprint, review the plan, apply it.
</p>

<p align="center">
  <a href="https://github.com/BBareth/steward/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/BBareth/steward/actions/workflows/ci.yml/badge.svg"></a>
  <a href="./LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-green.svg"></a>
  <img alt="TypeScript" src="https://img.shields.io/badge/typescript-6-3178c6?logo=typescript&logoColor=white">
  <img alt="MCP over Streamable HTTP" src="https://img.shields.io/badge/MCP-Streamable%20HTTP-0f766e">
</p>

---

Connect Claude Code or Codex to steward and ask it to build or tidy a Discord
server: categories, channels, roles, permissions, rules posts, welcome
messages, self-role panels, AutoMod. steward does the work through Discord's
official bot API. It holds the bot token; your agent gets its own, separate
credential and never sees it. There is no model inside steward — it executes
structured operations and tells you exactly what happened.

- **A whole server in one call.** Write (or export) a YAML blueprint, get a
  dry-run plan with every create, update, reorder and deletion, then apply it.
  One plan replaces hundreds of individual tool calls. See
  [docs/BLUEPRINTS.md](./docs/BLUEPRINTS.md).
- **Same blueprint, same server, no duplicates.** Resources are identified by
  stable keys bound to Discord IDs in SQLite, not by name. Re-applying a
  blueprint changes nothing; things it does not mention are left alone unless
  you explicitly ask to prune.
- **Plans you can trust.** A plan is bound to one server, one blueprint and the
  state it was computed against. Applying it re-reads the server first and
  refuses if anything relevant changed. Hierarchy problems and missing
  permissions are found before any write, with the fix spelled out.
- **Honest about failure.** Discord has no transactions, so steward does not
  pretend to roll back. Every request is journaled before it is sent; a timed
  out create is looked up in the audit log before anything is retried; a crash
  mid-apply is reconciled on the next plan. The result says which steps took
  effect.
- **Safe self-roles.** Button panels for pronouns, pings and interests, from an
  explicit allowlist. Roles with moderation or admin power — including power
  granted through channel overwrites — are refused, at configuration time and
  again on every click.
- **Locked down by default.** Bearer-token auth with per-credential scopes and
  guild lists, Host and Origin validation, loopback-only publishing,
  destructive tools off, `@everyone` pings off, secrets redacted from logs and
  errors, and a read-only mode.

> [!IMPORTANT]
> steward is built for a **trusted LAN or VPN**. Anyone holding an MCP token
> with write scope can reshape your Discord server. Do not publish the port to
> the internet. See [SECURITY.md](./SECURITY.md) for the trust model.

## Quick start

On a Docker host (Docker 24+, Compose v2):

```bash
git clone https://github.com/BBareth/steward.git /opt/steward && cd /opt/steward
sh scripts/init-config.sh --guilds <your-server-id>   # writes .env (mode 600) with a fresh MCP token
$EDITOR .env                                          # paste DISCORD_TOKEN
docker compose up -d --build
curl -s http://127.0.0.1:8787/readyz                  # {"status":"ready",...} once Discord connects
```

Then connect a client — [Claude Code](#claude-code) or [Codex](#codex) — and
ask it to call `steward_status`.

You need a Discord application with a bot, invited to your server.
[docs/SETUP.md](./docs/SETUP.md) walks through every click.

<details>
<summary><b>Reach it from your LAN or VPN</b></summary>

By default the port is published on `127.0.0.1` only. To use it from another
machine, publish it on the host's LAN or VPN address and tell steward which
host name clients will use (requests with any other `Host` header are refused):

```dotenv
STEWARD_BIND_ADDRESS=192.168.1.20
MCP_ALLOWED_HOSTS=localhost,127.0.0.1,192.168.1.20,steward.lan
```

`docker compose up -d` again to apply. For Tailscale, use the host's
`100.x.y.z` address and its MagicDNS name.

</details>

<details>
<summary><b>Prebuilt images</b></summary>

The [Publish image](./.github/workflows/publish.yml) workflow pushes
multi-arch images (`linux/amd64`, `linux/arm64`) to
`ghcr.io/bbareth/steward` once it has run: `edge` from every push to `main`,
`X.Y.Z` and `X.Y` from release tags, and `latest` for the newest release only
(there is none until the first release tag). Until then — or if you prefer —
build from source as above. `docker compose up -d` uses the image already on
the host and only pulls (or builds) when there is none; to move to a newer
published image run `docker compose pull` first. Restarting the container
never fetches anything. [Updating](./docs/SETUP.md#updating) has the details.

</details>

<details>
<summary><b>Build it yourself without Compose</b></summary>

```bash
docker build -t steward .
docker volume create steward_data
docker run -d --name steward --init --restart unless-stopped \
  -p 127.0.0.1:8787:8787 -v steward_data:/data --env-file .env \
  --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges:true \
  steward
```

</details>

## Connect an MCP client

steward speaks MCP over Streamable HTTP at `http://<host>:8787/mcp` and expects
`Authorization: Bearer <MCP_AUTH_TOKEN>`. Ready-made files are in
[`examples/`](./examples).

### Claude Code

```bash
claude mcp add --transport http steward http://192.168.1.20:8787/mcp \
  --header "Authorization: Bearer $STEWARD_MCP_TOKEN"
claude mcp list          # steward: ... ✔ Connected
```

That stores the server for you in the current project (`--scope user` for all
projects). For a shared project file, use [`.mcp.json`](./examples/claude-code.mcp.json)
with `"Authorization": "Bearer ${STEWARD_MCP_TOKEN}"` and export the variable;
Claude Code asks for approval the first time.

### Codex

```bash
export STEWARD_MCP_TOKEN=stw_...        # e.g. in your shell profile
codex mcp add steward --url http://192.168.1.20:8787/mcp --bearer-token-env-var STEWARD_MCP_TOKEN
codex mcp list
```

or in `~/.codex/config.toml` ([example](./examples/codex-config.toml)):

```toml
[mcp_servers.steward]
url = "http://192.168.1.20:8787/mcp"
bearer_token_env_var = "STEWARD_MCP_TOKEN"
```

## Blueprints

```yaml
version: 1
roles:
  - { key: moderator, name: Moderator, permissions: [KickMembers, ManageMessages], staff: true }
  - { key: gamer, name: Gamer }
categories:
  - key: staff
    name: Staff
    access: { private: true, visible_to: [moderator] }
    channels:
      - { key: mod-chat, name: mod-chat }
  - key: info
    name: Information
    access: { read_only: true, writers: [moderator] }
    channels:
      - { key: rules, name: rules }
messages:
  - { key: rules-post, channel: rules, embeds: [{ title: Rules, description: Be kind. }] }
self_roles:
  roles: [gamer]
  panels:
    - { key: games, channel: rules, title: Interests, options: [{ role: gamer, label: Gaming }] }
```

The agent's loop is `validate_blueprint` → `plan_blueprint` → read the plan →
`apply_plan` → `verify_blueprint`. Starting from an existing server,
`export_blueprint` gives you its current shape with keys already bound.
[docs/BLUEPRINTS.md](./docs/BLUEPRINTS.md) has the full format and a complete
community server ([`examples/community.yaml`](./examples/community.yaml)).

## Tools

45 typed tools; each credential only sees the ones its scopes allow.

| Group | Tools | Scope |
| --- | --- | --- |
| Status | `steward_status`, `blueprint_reference`, `generate_invite_link` | read |
| Inspect | `get_guild_overview`, `list_channels`, `get_channel`, `list_roles`, `get_role`, `get_member`, `check_permissions`, `check_role_hierarchy`, `list_automod_rules`, `get_message`, `get_bot_features`, `list_mappings`, `list_history` | read |
| Blueprints | `validate_blueprint`, `export_blueprint`, `plan_blueprint`, `get_plan`, `get_apply_status`, `verify_blueprint` | read |
| | `apply_plan`, `map_resource` | write |
| Channels | `create_channel`, `update_channel`, `reorder_channels`, `set_channel_permissions`, `configure_channel_access` | write |
| Roles | `create_role`, `update_role`, `reorder_roles`, `assign_roles` | write |
| Server & content | `update_guild_settings`, `post_message`, `edit_message`, `configure_welcome`, `manage_self_roles`, `upsert_role_panel`, `upsert_automod_rule` | write |
| Deletion | `delete_channel`, `delete_role`, `delete_message`, `delete_role_panel`, `delete_automod_rule` | destructive |

Lists are paginated and filterable; plans and results come back as compact
one-line-per-step summaries unless you ask for `detail: "full"`. Text read from
Discord (topics, message content, descriptions) is returned wrapped as
`untrusted_text`, and the server instructions tell the agent not to follow it.

## Configuration

Everything is environment variables; [`.env.example`](./.env.example) explains
each one.

| Variable | Default | What it does |
| --- | --- | --- |
| `DISCORD_TOKEN` | — | **Required.** Bot token. Or `DISCORD_TOKEN_FILE`. |
| `DISCORD_GUILD_IDS` | — | **Required.** Comma-separated servers steward may touch. Everything else is refused. |
| `MCP_AUTH_TOKEN` | — | **Required** unless `MCP_TOKENS_FILE` is set. Bearer token for clients, 32+ characters. Or `MCP_AUTH_TOKEN_FILE`. |
| `MCP_AUTH_TOKEN_SCOPES` | `read,write,destructive` | Scopes for that token. |
| `MCP_TOKENS_FILE` | — | JSON list of hashed credentials, each with its own scopes and guilds. |
| `MCP_ALLOWED_HOSTS` | `localhost,127.0.0.1,[::1]` | Host names clients use. Anything else gets 403 (DNS-rebinding protection). |
| `MCP_ALLOWED_ORIGINS` | — | Browser origins allowed. Empty refuses all browsers. |
| `DISCORD_MEMBERS_INTENT` | `false` | Request the privileged Server Members intent (welcome messages, join roles). |
| `DISCORD_BOT_REACTION_GUARD` | `false` | Remove ordinary members' reactions from messages steward posted. Requests the non-privileged Guild Message Reactions intent; off in read-only mode. See below. |
| `READ_ONLY` | `false` | Inspection only; no tool that changes Discord is offered. |
| `ALLOW_DESTRUCTIVE` | `false` | Allow delete tools and plans that prune. |
| `STEWARD_BIND_ADDRESS` | `127.0.0.1` | Compose only: host address the port is published on. |
| `STEWARD_PORT` | `8787` | Compose only: host port. |
| `PLAN_TTL_MINUTES` | `30` | How long a plan can be applied. |
| `APPLY_WAIT_SECONDS` | `40` | `apply_plan` returns `running` after this; poll `get_apply_status`. |
| `DISCORD_REQUEST_TIMEOUT_MS` | `15000` | Per-request timeout. |
| `DATABASE_PATH` | `/data/steward.db` in the image | SQLite file. Keep it on a volume. |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`. |

steward refuses to start, listing every problem, when a required value is
missing or malformed.

## Discord permissions and intents

**Gateway intents.** `Guilds` only, by default. `GuildMembers` (privileged)
is requested only with `DISCORD_MEMBERS_INTENT=true`, and only welcome
messages and join roles need it. `GuildMessageReactions` (not privileged) is
requested only while the reaction guard is active. Message Content is never
requested.

**Reaction guard.** With `DISCORD_BOT_REACTION_GUARD=true` (and not
`READ_ONLY`), steward removes reactions that ordinary members add to messages
steward itself posted, in the configured servers only, including old messages
the bot never cached. It keeps reactions from bots, the server owner, and
members holding a role bound to the blueprint key `owner`, `admin`,
`moderator` or `bot`. Reactions on anyone else's messages, other bots'
messages and webhook posts are never touched, and role-panel buttons keep
working (they are buttons, not reactions). When it cannot tell who wrote a
message or who reacted, it leaves the reaction. It needs Manage Messages in
those channels; where Discord refuses, it pauses that channel for ten minutes.
Removals are in `list_history` under the tool `reaction_guard` (Discord's own
audit log does not record them), and `steward_status` shows whether the guard
is configured, actually active, and what it has done.

**Where the bot's role goes.** Discord lets a bot manage only roles _below_ its
own highest role — Administrator does not change that. Drag the bot's role
above every role you want steward to create, edit, order or hand out.
`check_role_hierarchy` lists what it can and cannot manage, and plans block
those steps with the reason.

**What each feature needs.** Administrator is simplest. Without it:

| Feature | Permissions |
| --- | --- |
| Inspect, plan, verify | View Channel (Manage Server to read AutoMod) |
| Channels and categories | Manage Channels |
| Roles, overwrites, role panels, join roles | Manage Roles, plus every permission it should be able to grant: Discord only lets a bot allow or deny permissions it holds |
| Server settings, AutoMod | Manage Server |
| Posting rules, welcome and panel messages | View Channel, Send Messages, Embed Links in that channel |
| Recovering cleanly from timeouts | View Audit Log (falls back to a weaker name/time match without it) |
| Reaction guard | Manage Messages and Read Message History in the channels steward posts in |

`generate_invite_link` builds an install URL with these (`recommended`) or
Administrator.

## What steward cannot do

- **Install other bots.** Discord requires a person with Manage Server to
  authorise every bot. `generate_invite_link` builds the link for any
  application ID and lists the manual steps.
- **Configure other bots' dashboards or settings.** Administrator in your
  server grants nothing on another bot's website or API. Integrate one only
  through its own documented API.
- **Run other bots' slash commands.** Discord does not let bots invoke them.
- **Roll back.** There are no cross-request transactions on Discord. steward
  reports what happened step by step; a fresh plan continues from the real
  state.
- **Read other people's message text** without the Message Content intent,
  which steward does not request. Its own messages are always readable.

## How it works

```
Claude Code / Codex ──HTTP──> /mcp ── Host/Origin check ── bearer auth ── scoped tools
                                                                              │
   blueprint ─> validate ─> plan (diff vs live state, permission checks) ─> apply
                                                                              │
             SQLite: key↔ID mappings · plans · operation journal ·       journaled,
             welcome · self-role allowlist · panels · messages        rate-limited REST
                                                                              │
                     discord.js gateway (events, panels, joins) <───────> Discord
```

One container, one Node process, one SQLite file. Details, including the
failure model: [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md).

## Setting it up

- **[docs/SETUP.md](./docs/SETUP.md)** — step by step, for a human: Discord
  application, invite, role placement, homelab deployment, clients.
- **[docs/AGENT.md](./docs/AGENT.md)** — the same deployment as a checklist for
  a coding agent, with the command and the check for each step.
- **[docs/BLUEPRINTS.md](./docs/BLUEPRINTS.md)** — the blueprint format.
- **[SECURITY.md](./SECURITY.md)** — trust model, secrets, scopes.

## Development

Node 22.12+ (24 recommended).

```bash
npm ci
npm run check          # typecheck, lint, format check, tests
npm run build && node dist/index.js
```

The test suite runs a real MCP client against the real HTTP server with an
in-memory Discord that enforces permissions and hierarchy and can inject
timeouts, 5xx errors and hangs. An optional live run against a throwaway
Discord server is described in [CONTRIBUTING.md](./CONTRIBUTING.md).

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `readyz` says `TokenInvalid` | Wrong or reset bot token. Copy a fresh one into `DISCORD_TOKEN`. |
| `readyz` says it refused the gateway intents | `DISCORD_MEMBERS_INTENT=true` but Server Members Intent is off in the developer portal. Turn it on, or set the variable to `false`. |
| Client gets `403` | The `Host` it uses is not in `MCP_ALLOWED_HOSTS`, or it sent a browser `Origin`. |
| Client gets `401` | Token mismatch. The client sends `MCP_AUTH_TOKEN`, not the Discord token. |
| Client gets `429` | Too many failed logins from that address; wait five minutes. |
| `guild_not_allowed` | Add the server ID to `DISCORD_GUILD_IDS` (and to the credential's `guilds`, if it has one). |
| Steps blocked "at or above the bot's highest role" | Move the bot's role higher in Server Settings → Roles, then plan again. |
| `stale_plan` | Someone changed the server after planning. Plan again; it is cheap. |
| Welcome messages never appear | Needs `DISCORD_MEMBERS_INTENT=true` and the portal toggle. `get_bot_features` shows whether it is active. |

More in [docs/SETUP.md](./docs/SETUP.md#troubleshooting).

## Licence

MIT — see [LICENSE](./LICENSE).
