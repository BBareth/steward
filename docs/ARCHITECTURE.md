# Architecture

steward is one Node.js process in one container: a discord.js client and an
HTTP server, sharing a SQLite database. There is no queue, cache, broker or
second service, and no language model — it executes structured operations an
MCP client asks for.

```
               ┌──────────────────────────── steward (one process) ─────────────────────────────┐
 MCP client    │  node:http                                                                      │
 (Claude Code, │   /healthz  /readyz                                                             │
  Codex) ──────┼─> /mcp ─ Host check ─ Origin check ─ bearer auth ─┐                             │
               │                                                  v                             │
               │                         per-request McpServer (only the tools the scopes allow)│
               │                                                  │                             │
               │        ┌─────────────── tools ───────────────────┴─────────────┐               │
               │        │ inspect   direct writes   blueprint service   features │               │
               │        └────┬───────────┬─────────────────┬──────────────┬─────┘               │
               │             │           │ guild lock      │ plan / apply │ welcome, panels    │
               │             │           v                 v              │                    │
               │             │      operation journal (write-ahead, retries, reconciliation)    │
               │             │           │                                                     │
               │             v           v                                                     │
               │        DiscordAdapter ──── discord.js REST (rate limits) ──────────────────────┼──> Discord API
               │             ^              discord.js gateway (Guilds[, GuildMembers]) <───────┼─── events
               │             │                                                                 │
               │        SQLite (WAL): mappings · plans · operations · tool calls ·              │
               │                      welcome · self roles · protected roles · panels · messages│
               └─────────────────────────────────────────────────────────────────────────────────┘
```

## Source layout

| Path | Responsibility |
| --- | --- |
| `src/index.ts` | Startup, signal handling, graceful shutdown. |
| `src/config.ts` | Environment parsing; refuses to start on missing or weak credentials. |
| `src/logger.ts` | JSON-lines logger with key-based and value-based secret redaction. |
| `src/store.ts` | SQLite schema, migrations and all queries. |
| `src/http/` | HTTP server, health endpoints, bearer authentication, failure throttling. |
| `src/mcp/` | MCP server factory, tool registry (scope gating, guild checks, history), tool groups. |
| `src/discord/adapter.ts` | The interface everything above Discord depends on. |
| `src/discord/discordjs-adapter.ts` | The real implementation: gateway lifecycle, REST calls, error mapping. |
| `src/discord/permissions.ts` | Permission names, Discord's effective-permission algorithm, hierarchy and privilege checks. |
| `src/blueprint/` | Schema, validation, planning, execution, export, verification. |
| `src/ops/` | Operation journal, per-guild lock, ordering (slot fill). |
| `src/features/` | Messages and mention policy, access presets, welcome, role panels. |
| `test/helpers/memory-adapter.ts` | In-memory Discord used by the tests, with fault injection. |

## MCP transport

- Streamable HTTP at `/mcp`, served by the official TypeScript SDK (v2,
  `createMcpHandler` + `toNodeHandler`). Every request gets a fresh
  `McpServer` built for the caller, so there is no session state to lose or
  leak. Clients on the 2025 protocol revisions (today's Claude Code and Codex)
  are served statelessly; 2026-07-28 clients negotiate the modern revision.
  `GET` and `DELETE` on `/mcp` answer `405` (no server-initiated streams).
- Before the SDK sees a request: the `Host` header must be in
  `MCP_ALLOWED_HOSTS` and any `Origin` must be in `MCP_ALLOWED_ORIGINS` (empty
  by default, which refuses browsers) — the MCP transport's DNS-rebinding
  requirement; then a bearer token is checked. Failures are `403`/`401`, and an
  address with 20 failed logins in five minutes gets `429`.
- Tools are registered per request according to the credential's scopes and
  the server's modes, and each handler checks scope and guild again. A tool
  missing from `tools/list` is unknown to the session; a listed tool still
  cannot run outside its guild allowlist.
- Bodies are capped at 2 MiB (blueprints are capped at 1 MB of text).

## Discord connection

- Gateway intents: `Guilds`, plus `GuildMembers` only when
  `DISCORD_MEMBERS_INTENT=true`, and `GuildMessageReactions` only while the
  reaction guard is active. Interactions (role-panel buttons) need no intent.
- The reaction guard listens to the raw `MESSAGE_REACTION_ADD` dispatch, not
  discord.js's cached reaction events, so it sees reactions on messages
  discord.js never cached (steward posts over REST, so that is all of them).
  The event carries the message author and the reacting member's roles; when
  Discord leaves either out, steward reads the message or the member over REST
  (neither needs a privileged intent) and otherwise keeps the reaction.
  Removals go through the operation journal as tool `reaction_guard`.
- Reads go to REST, not the gateway cache, so a plan sees what Discord has now,
  including changes steward itself made a moment ago. A snapshot is three
  requests: the guild (with roles and approximate counts), its channels, and
  the bot's own member record.
- Writes go through discord.js's REST client, which queues per rate-limit
  bucket and waits out `429`s. **Its automatic retries are disabled**
  (`retries: 0`): it would otherwise replay a timed-out `POST`, and a replayed
  create is a duplicate channel or role. steward decides what to retry (below).
- Login failures that cannot fix themselves (invalid token, disallowed
  intents) set the state to `failed` with the reason and stop retrying; network
  failures retry with backoff from 5 s to 5 min. `/readyz` reports the state
  and reason; the container health check uses it.

## Identity: keys and mappings

Names are not identities — two roles can share one, and people rename things.
Every blueprint resource has a `key`; `resource_mappings` binds
`(guild, kind, key)` to a Discord ID. A mapping is created when steward creates
a resource, when a blueprint names an `id:`, when `export_blueprint` assigns
keys to existing resources, when `adopt_by_name` is used, when `map_resource`
is called, or when reconciliation recovers a create. One Discord ID never
carries two keys.

## Plans

`plan_blueprint` is a pure function of the blueprint, the live snapshot, the
mappings and steward's local state. It:

1. Resolves every key to an existing ID or "to be created". A same-named
   unmanaged resource is never adopted silently; the plan warns and, with
   `adopt_by_name`, binds it explicitly.
2. Diffs only the fields the blueprint sets. A role without `permissions`
   keeps its permissions; a channel without `permissions`/`access` (and no
   category to sync from) keeps its overwrites.
3. Expands access presets into overwrites. If a bot without Administrator would
   hide a channel from `@everyone`, the plan adds an overwrite that keeps the
   bot's own access, or it could never manage that channel again.
4. Orders the work: adoptions, roles, role order, categories, channels,
   settings, community-only channels, channel order, AutoMod, messages,
   welcome, self roles, panels, and deletions last.
5. Checks every step before anything is sent: Manage Roles/Channels/Server,
   role hierarchy (a bot can never touch a role at or above its own, even as
   Administrator), permissions the bot cannot grant, posting rights, Community
   prerequisites, AutoMod limits, privileged roles in self-role and join-role
   lists. A failed check marks the step **blocked** with the reason; steps
   that depend on it are blocked too.
6. Records fingerprints of every role, channel, the guild's settings, the bot's
   roles, the mappings, AutoMod rules it read, and the local configuration.

The plan is stored with a TTL (30 minutes by default) and status `planned`.

## Apply

`apply_plan` refuses a plan that is expired, already used, for another guild,
contains destructive steps without `ALLOW_DESTRUCTIVE` and the destructive
scope, or contains blocked steps without `accept_blocked`. It then takes the
guild's lock, re-reads the server, recomputes the fingerprints and refuses
(`stale_plan`, listing what changed) if anything differs. Only then does it run
the steps, sequentially, in a background task; the tool returns after
`APPLY_WAIT_SECONDS` with the current progress if it has not finished.

Steps refer to resources by key and resolve them through the mapping table at
the moment they run, so a channel created by step 12 has its ID available to
step 13. New channels are created with their permission overwrites in the same
request, so a private channel is never briefly public; overwrite changes on
existing channels apply restrictive ones first. Reordering uses **slot fill**:
the positions currently held by managed resources are reassigned in blueprint
order, so an unmanaged channel between two managed ones stays where it is.

Result statuses: `applied` (every step done), `partial`, `failed`,
`interrupted`. There is no rollback, because Discord has no transactions; the
per-step result says exactly what took effect, and a fresh plan from the same
blueprint continues from the real state without repeating finished work.

## The operation journal and uncertain outcomes

Every Discord mutation — from a plan, a direct tool, a panel click or a join —
goes through `runOperation`:

1. A row is written to `operations` (`in_progress`) **before** the request,
   with an operation ID, the target, the tool and client, and the audit-log
   reason (`steward <op id> <plan id>: <summary>`).
2. The request is sent. Success: `succeeded`, with the resulting ID.
3. A definite failure (4xx): `failed`, with Discord's message. The run stops
   unless `continue_on_error`, which still skips dependent steps.
4. An **uncertain** failure (timeout, connection reset, 5xx) — the request may
   or may not have happened:
   - **Idempotent requests** (PATCH, PUT, DELETE) are retried up to three
     times with backoff. A `404` on a delete counts as done.
   - **Message posts** carry a nonce with `enforce_nonce`, so Discord returns
     the original message instead of posting twice; they are retried like
     idempotent requests.
   - **Creates** (channels, roles, AutoMod rules) have no idempotency key on
     Discord. steward waits briefly and looks for the result: first in the
     audit log for its operation ID, then (without View Audit Log) for a
     resource with the same name, type and parent created after the request
     started and not bound to any key. Found once: adopted, `recovered`. Not
     found: sent once more. Found several times: `uncertain`, and the run stops
     — steward will not guess. `map_resource` resolves it.
5. If the process dies mid-request, startup marks `in_progress` rows
   `uncertain` and running plans `interrupted`. The next `plan_blueprint` for
   that guild reconciles them the same way (including interrupted message and
   panel posts, matched by author, time and content) before computing anything.

## Feature runtime

- **Welcome / join roles** (`guildMemberAdd`, needs `GuildMembers`): skips
  bots; re-checks each join role against the hierarchy and privilege rules at
  join time and skips (and logs) any that became unsafe; posts the message with
  `allowed_mentions` limited to the new member.
- **Role panels**: buttons carry `stw:rp:<panel id>:<role id>`. A press is
  deferred (Discord's three-second limit), then checked: the panel exists in
  this guild, the role is on that panel, still on the allowlist, not
  privileged (permissions or channel overwrites), not protected, and
  assignable by the bot. `single` mode removes the panel's other roles. Every
  change is journaled with `discord:<user id>` as the client.
- **Privilege**: a role is privileged if it is `@everyone`, integration
  managed, marked staff/protected, or grants any of Administrator, Manage
  Server/Roles/Channels/Webhooks/Expressions/Events/Threads/Messages/Nicknames,
  Kick, Ban, Timeout, Mention Everyone, View Audit Log, View Server Insights,
  Mute/Deafen/Move Members, Pin Messages, Bypass Slowmode — at server level or
  through any channel overwrite.

## Persistence

SQLite in WAL mode (`better-sqlite3`, synchronous), one file under `/data`.
Writes are durable before the request they describe is sent. Tables:
`resource_mappings`, `plans`, `operations`, `tool_calls` (pruned after 90
days), `welcome_configs`, `self_role_allowlist`, `protected_roles`,
`role_panels`, `managed_messages`, `schema_migrations`.

## Security layers

1. Network: published on loopback by default; LAN/VPN by explicit choice.
2. Host/Origin validation (DNS rebinding).
3. Bearer tokens, stored only as SHA-256, compared in constant time; failure
   throttling.
4. Scopes per credential (`read`, `write`, `destructive`) and guild lists per
   credential, enforced at registration and in every handler.
5. Server modes: `READ_ONLY`, `ALLOW_DESTRUCTIVE` (off by default).
6. Guild allowlist (`DISCORD_GUILD_IDS`) checked before Discord is contacted.
7. Explicit intent for dangerous actions: `confirm_name` on deletes, `prune`
   on plans, `allow_privileged` to hand out powerful roles, opt-in
   `@everyone` mentions.
8. Secrets never leave the process: the Discord token stays server-side,
   secrets are removed from the environment after startup, and logs and
   client-facing errors are redacted by value and by pattern.
9. Text from Discord is returned as `untrusted_text`, and the server
   instructions tell agents not to follow it.

## Choices and trade-offs

- **REST reads over the gateway cache.** A few more requests per plan, in
  exchange for plans that never act on stale cache.
- **Sequential apply.** Simple to reason about and naturally inside rate
  limits; Discord's per-route limits (channel creation in particular) set the
  pace of a large plan, which is why `apply_plan` can return while still
  running.
- **Strict staleness.** Any change to any role or channel invalidates a plan.
  On a busy server that means re-planning occasionally; it never means
  applying a plan computed against a server that no longer exists.
- **No rollback, honest reporting.** A rollback that can itself fail half way
  would be a second, worse version of the same problem.
