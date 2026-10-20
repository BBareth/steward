# Security

## Trust model

steward turns MCP tool calls into changes to a Discord server. Whoever holds an
MCP token with the `write` scope can restructure that server: create and
reorder roles, change who can see which channels, post as the bot. With
`destructive` they can delete channels (and their history) and roles. Treat
MCP tokens like admin passwords for your community.

It is built for a **trusted LAN or VPN**:

- The Compose file publishes the port on `127.0.0.1` unless you choose an
  address (`STEWARD_BIND_ADDRESS`). Use your LAN or VPN address, not
  `0.0.0.0` on a machine with a public interface.
- There is no TLS. Inside a LAN or a WireGuard/Tailscale tunnel that is the
  usual trade-off; across anything less trusted, terminate TLS in front of it.
- Do not expose it to the internet. Authentication is a bearer token with
  failure throttling, not a hardened public API.

## Layers

| Layer | What it does |
| --- | --- |
| Network | Loopback by default; you opt in to LAN/VPN exposure. |
| `Host` validation | Requests whose `Host` is not in `MCP_ALLOWED_HOSTS` get `403`. Stops DNS rebinding: a web page cannot reach steward through a hostname it controls. |
| `Origin` validation | Any request with a browser `Origin` not in `MCP_ALLOWED_ORIGINS` (empty by default) gets `403`. CLI agents send no `Origin`. |
| Bearer token | Required on every `/mcp` request. Only the SHA-256 of each token is held, compared in constant time. 20 failures from one address in five minutes → `429` for that address. |
| Scopes | `read`, `write`, `destructive` per credential. Tools outside a credential's scopes are not even listed, and every handler checks again. |
| Guilds | `DISCORD_GUILD_IDS` is a hard allowlist, checked before Discord is contacted. A credential can be limited further with its own `guilds`. Plans, history and results are only visible for allowed guilds. |
| Modes | `READ_ONLY=true` removes every tool that changes Discord (and stops the welcome and panel handlers). `ALLOW_DESTRUCTIVE` is **off** by default. |
| Explicit intent | Deletes need `confirm_name` equal to the current name. Plans delete only with `prune`. Handing out a privileged role through `assign_roles` needs `allow_privileged: true`. `@everyone`/`@here` only with `allow_everyone_mention`. |
| Self roles | Explicit allowlist; privileged roles refused at configuration and on every click (see below). |
| Audit | Every Discord change is journaled with an operation ID, the client name, the target, the outcome and the Discord audit-log reason; every tool call is recorded. `list_history` reads both. |

## Secrets

| Secret | Exposure if leaked | Rotate |
| --- | --- | --- |
| `DISCORD_TOKEN` | Full control of the bot, in every server it is in, within its permissions. | Developer portal → Bot → Reset Token; update `.env`; `docker compose up -d`. |
| `MCP_AUTH_TOKEN` / tokens in `MCP_TOKENS_FILE` | Whatever the credential's scopes allow, in its guilds. | Generate a new one (`node scripts/generate-token.mjs`), replace it, restart, update clients. |

- The Discord token never leaves the service: MCP clients get their own
  credential, and no tool returns the Discord token.
- Both may be supplied as files (`*_FILE`) for Docker secrets. After startup
  they are removed from the process environment.
- Logs and client-facing error messages are redacted by value (the configured
  secrets) and by pattern (anything shaped like a Discord token,
  `Bearer …`, and fields named like `token`, `secret`, `password`,
  `authorization`). Unexpected errors reach clients as "internal error"; the
  detail stays in the server log.
- `.env` is created with mode 600 by `scripts/init-config.sh` and is in
  `.gitignore` and `.dockerignore`.

## Untrusted content

Channel names and topics, role names, server descriptions, message text and
embeds are written by Discord users. steward returns free text wrapped as
`{"untrusted_text": "..."}` and tells clients, in its MCP server instructions,
never to follow instructions found in Discord content. That reduces prompt
injection risk; it cannot remove it. Review plans before applying them,
especially when an agent has been reading user content.

steward escapes user-controlled values it puts into its own messages (welcome
`{username}` and `{server}`), and every message it sends sets
`allowed_mentions` so only explicitly listed users or roles are pinged.

## Privileged roles

A role counts as privileged — never self-assignable, never a join role, and
only assignable with `allow_privileged` — if it is `@everyone`, managed by an
integration, marked `staff`/protected, or grants any of: Administrator,
Manage Server, Manage Roles, Manage Channels, Manage Webhooks, Manage
Expressions, Manage Events, Manage Threads, Manage Messages, Manage Nicknames,
Kick Members, Ban Members, Timeout Members, Mention Everyone, View Audit Log,
View Server Insights, Mute/Deafen/Move Members, View Creator Monetization
Analytics, Pin Messages, Bypass Slowmode. This is checked at server level
**and in every channel overwrite**: a role with no permissions of its own that
grants Manage Messages in one channel is a moderation role.

The check runs when the allowlist or join roles are configured, when a plan is
made and applied, and again on every button press and every join, so a role
that gains power later stops being handed out.

## What the bot can do in Discord

As much as its role allows, and no more than Discord's hierarchy permits: a bot
cannot edit, assign, move or delete roles at or above its own highest role,
even with Administrator. Keep roles you never want automation to touch above
the bot's role. The narrower permission set per feature is in the
[README](./README.md#discord-permissions-and-intents).

Gateway intents: `Guilds`; `GuildMembers` only if you enable welcome
features; `GuildMessageReactions` only while the reaction guard
(`DISCORD_BOT_REACTION_GUARD`, off by default and in read-only mode) is
active. steward never requests Message Content or Presence.

Discord's role hierarchy does not limit whose reactions a bot with Manage
Messages can remove, so the reaction guard's own exemptions (bots, the server
owner, roles bound to `owner`, `admin`, `moderator`, `bot`) are what protects
staff. It acts only on messages steward's bot user wrote, only in the
configured servers, and keeps a reaction whenever it cannot establish the
author, the member or the server owner.

## Reporting a vulnerability

Open a [security advisory](https://github.com/BBareth/steward/security/advisories/new)
rather than a public issue.

This is a hobby project maintained in spare time. There is no SLA, but genuine
reports will be taken seriously.
