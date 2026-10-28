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
credential and never sees it. Open the built-in dashboard at
`http://<host>:8787/` to inspect health, browse servers, and run the same
operations yourself; it has no sign-in, because the MCP token is only for the
AI. There is no model inside steward — it executes
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
- **Locked down by default.** Bearer-token auth for MCP with per-credential
  scopes and guild lists, Host and Origin validation, loopback-only publishing,
  destructive tools off, `@everyone` pings off, secrets redacted from logs and
  errors, and a read-only mode.

> [!IMPORTANT]
> steward is built to run **locally or on a trusted LAN or VPN**. Anyone who
> can open the dashboard, or holds an MCP token with write scope, can reshape
> your Discord server. Do not publish the port to the internet. See
> [SECURITY.md](./SECURITY.md) for the trust model.

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
`100.x.y.z` address and its MagicDNS name. The dashboard has no sign-in, so
every device that can reach that address can use it.

</details>

<details>
<summary><b>Prebuilt images</b></summary>

The [Publish image](./.github/workflows/publish.yml) workflow pushes
multi-arch images (`linux/amd64`, `linux/arm64`) to
`ghcr.io/bbareth/steward` once it has run: `edge` from every push to `main`,
`X.Y.Z` and `X.Y` from release tags, and `latest` for the newest release only.
You can also build from source as above. `docker compose up -d` uses the image already on
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

## Web dashboard

Open `http://<host>:8787/` in a browser on the machine running steward, or on
your LAN or VPN if you published the port there. No separate frontend service,
build tool, port or sign-in is needed: MCP tokens are only for AI clients on
`/mcp`. `READ_ONLY`, `ALLOW_DESTRUCTIVE` and `DISCORD_GUILD_IDS` apply to the
dashboard exactly as they do to MCP.

- Health: Discord gateway, SQLite, uptime, version, and available operations.
- Servers: every server the bot has joined, plus configured servers it has not
  joined. A server outside `DISCORD_GUILD_IDS` is listed but cannot be edited.
- Roles and channels: searchable, fully paginated inventories, permission and
  hierarchy details, creation and editing, member-role assignment, and access
  controls.
- Server setup: settings, onboarding, welcome screen, widget, security actions,
  expressions, events, invites, webhooks, templates, integrations and AutoMod,
  limited by what Discord exposes and the bot can access.
- All operations: schema-driven forms for every MCP tool the server mode allows, with a JSON
  editor for complex inputs. Every Discord write has a request review; deletion
  tools retain their existing confirmation and policy requirements.
- Blueprints: export, edit, validate, plan, review, apply and verify. Expired or
  stale plans are rejected by the same service used by MCP.
- Activity: the existing operation journal and tool-call history.

Anyone who can reach the port can use the dashboard with everything the bot is
allowed to do, so keep `STEWARD_BIND_ADDRESS` on `127.0.0.1` (the default)
unless you trust every device on the network you publish it to. The dashboard
requires the same Host allowlist as MCP and enforces same-origin API requests
and CSRF checks, so other websites cannot drive it through your browser. It
needs no `MCP_ALLOWED_ORIGINS` change. See [SECURITY.md](./SECURITY.md) for the
trust boundary.

### Can I send AI prompts from the dashboard?

The **AI request inbox** saves prompts in SQLite and displays agent replies.
MCP lets an AI call tools; connecting Steward does not automatically wake a
chat, send a message into an existing Codex conversation, or run a model.

Queue a request, then use **Copy agent handoff** and paste it into your connected
AI chat. The agent can call `list_dashboard_prompts`, inspect the server, perform
authorized work through the normal tools, then record the verified result with
`reply_dashboard_prompt`. Requests are guild-scoped, and returned prompt and reply
text is marked as untrusted data. Pending requests survive container restarts.
Automatic prompt execution needs a separately configured agent runtime, such as
[Codex app-server](https://learn.chatgpt.com/docs/app-server), with its own
account, authorization and approval handling. No model credentials or model
calls are added to Steward.

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

75 typed tools; each credential only sees the ones its scopes allow.

| Group | Tools | Scope |
| --- | --- | --- |
| Status | `list_guilds`, `steward_status`, `blueprint_reference`, `generate_invite_link` | read |
| AI request inbox | `list_dashboard_prompts` | read |
| | `submit_dashboard_prompt`, `reply_dashboard_prompt` | write |
| Inspect | `get_guild_overview`, `list_channels`, `get_channel`, `list_roles`, `get_role`, `get_member`, `check_permissions`, `check_role_hierarchy`, `check_bot_setup`, `list_automod_rules`, `get_message`, `get_bot_features`, `list_mappings`, `list_history` | read |
| Blueprints | `validate_blueprint`, `export_blueprint`, `plan_blueprint`, `get_plan`, `get_apply_status`, `verify_blueprint` | read |
| | `apply_plan`, `map_resource` | write |
| Channels | `create_channel`, `update_channel`, `reorder_channels`, `set_channel_permissions`, `configure_channel_access` | write |
| Roles | `create_role`, `update_role`, `reorder_roles`, `assign_roles` | write |
| Server & content | `update_guild_settings`, `post_message`, `edit_message`, `configure_welcome`, `manage_self_roles`, `upsert_role_panel`, `upsert_automod_rule` | write |
| Server setup | `get_server_setup`, `list_expressions`, `list_scheduled_events`, `list_invites`, `list_webhooks`, `list_templates`, `list_integrations` | read |
| | `configure_onboarding`, `configure_welcome_screen`, `configure_widget`, `set_security_actions`, `update_bot_profile`, `upsert_emoji`, `upsert_sticker`, `upsert_soundboard_sound`, `upsert_scheduled_event`, `create_invite`, `upsert_webhook`, `upsert_template` | write |
| Deletion | `delete_channel`, `delete_role`, `delete_message`, `delete_role_panel`, `delete_automod_rule`, `delete_expression`, `delete_scheduled_event`, `delete_invite`, `delete_webhook`, `delete_template`, `delete_integration` | destructive |

Lists are paginated and filterable; plans and results come back as compact
one-line-per-step summaries unless you ask for `detail: "full"`. Text read from
Discord (topics, message content, descriptions) is returned wrapped as
`untrusted_text`, and the server instructions tell the agent not to follow it.

**What the server-setup tools cover.** Everything in Server Settings that
Discord's bot API can change:
- Server images: icon, banner, invite background and Discovery background.
  Each needs its boost unlock, and `get_server_setup` lists which are unlocked.
- Onboarding questions and default channels, the welcome screen, and the
  server widget.
- Pausing invites and DMs for up to 24 hours, and turning raid alerts off.
- Emoji, stickers and soundboard sounds.
- Scheduled events, including repeating ones.
- Invites, including invites that hand out roles.
- Webhooks, the server template, and removing integrations such as Twitch or
  YouTube. Discord does not let a bot remove another app's bot; do that in
  Server Settings > Integrations.
- The bot's own nickname, avatar, banner and bio in this server.
- Role gradients, holographic colours and role icons.
- Voice region and video quality.
- Forum and media tags, the default reaction, sort order, layout and
  required tags.

Images and sounds are passed as an `https` URL or a `data:` URI. steward
checks their actual type and size before uploading.

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
| `MCP_ALLOWED_ORIGINS` | — | Origins allowed for `/mcp`. The dashboard uses same-origin sessions. |
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
message, who reacted or who owns the server, it leaves the reaction. It needs
Manage Messages in those channels; where Discord refuses, it pauses that
channel for ten minutes
(the whole server when Discord wants two-factor authentication on the bot
owner's account).
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
| Inspect, plan, verify | View Channel, in every channel steward manages (Manage Server to read AutoMod) |
| Channels and categories | Manage Channels |
| Roles, overwrites, role panels, join roles | Manage Roles, plus every permission it should be able to grant: Discord only lets a bot allow or deny permissions it holds |
| Server settings, AutoMod | Manage Server |
| Onboarding | Manage Server and Manage Roles, with Community on |
| Welcome screen, widget, security actions, templates, integrations, listing and revoking invites | Manage Server |
| Emoji, stickers, soundboard sounds | Manage Expressions (Create Expressions covers the ones steward made) |
| Scheduled events | Manage Events (Create Events covers the ones steward made), plus Connect in a voice channel or Manage Channels, Mute Members and Move Members in a stage |
| Creating invites | Create Invite in that channel; Manage Roles to attach roles |
| Webhooks | Manage Webhooks |
| The bot's nickname in the server | Change Nickname |
| Turning Community on or off (`settings.community`, `update_guild_settings`) | Administrator: Discord requires it for that one change |
| Posting rules, welcome and panel messages | View Channel, Send Messages, Embed Links in that channel |
| Recovering cleanly from timeouts | View Audit Log (falls back to a weaker name/time match without it) |
| Reaction guard | Manage Messages and Read Message History in the channels steward posts in |

`generate_invite_link` builds an install URL with these (`recommended`) or
Administrator.

**Channels the bot cannot see.** From 16 November 2026 Discord leaves every
channel the bot lacks View Channel on out of the channel list it gives the bot
(`GET /guilds/{id}/channels`). Administrator sees every channel; without it, a
private channel the bot is not let into is invisible to it. steward never takes
a managed channel that is missing from the list for deleted: it asks Discord for
that channel by ID, and a 403 means it still exists. The plan then blocks every
step that needs the channel (the channel itself, messages and panels in it, new
channels inside it, settings and AutoMod rules that change to point at it, and
pruning it) and says why, and it never creates a replacement. Only a 404 counts
as deleted. `verify_blueprint` reports such a channel as not in sync. The fix is
to allow View Channel for the bot's role in that channel (and Read Message
History where steward has posted). Private channels steward creates already
keep that access for the bot, so this happens when someone takes the access
away. A channel steward has never managed and cannot see is invisible to it
entirely: it is not exported, cannot be adopted by name, does not trigger the
name-collision warning and is never pruned. Plans warn when the bot lacks View
Channel server-wide.

## Setting up another bot

`check_bot_setup` checks an installed bot against the permissions, channels and
assignable roles you specify. It reports missing permissions, channel overrides,
hierarchy blockers (including tied positions), managed roles that cannot be
assigned, and whether steward can reposition the bot role. It works with a
read-only credential and changes nothing in Discord.

Use `generate_invite_link` for the install, existing role/channel tools for the
server setup, then check again. Vendor settings still need the bot's own API,
dashboard or commands. [docs/BOTS.md](./docs/BOTS.md) has the agent workflow.

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
- **Change the settings Discord keeps from bots.** Someone has to do these in
  the Discord client:
  - the vanity URL
  - the server's two-factor requirement for moderators
  - Discovery
  - the Server Guide
  - member applications (rules screening)
  - server subscriptions
  - the server tag
  - ownership transfer
  - other apps' slash-command permissions

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
