# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Changed
- The web dashboard no longer asks for an MCP token. It opens directly for
  whoever can reach the port; MCP tokens are only for AI clients on `/mcp`.
  `READ_ONLY`, `ALLOW_DESTRUCTIVE` and `DISCORD_GUILD_IDS` still apply, and
  same-origin, CSRF and Host checks remain.

### Removed
- Dashboard sign-in, sign-out, session cookies and login throttling.

## [0.2.0] - 2026-10-28

### Added
- Built-in responsive web dashboard at `/`, served by the existing container.
- Health overview, all bot memberships, searchable role/channel inventories,
  details, creation/editing, server-setup inspection, activity history, and
  schema-driven forms for every permitted MCP operation.
- Blueprint export/edit/validate/plan/apply/verify workflow with request review.
- Guild-scoped persistent AI request inbox with MCP submission, listing and
  replies. Requests require an agent to fetch them; no model runs automatically.
- `list_guilds` reports joined and configured servers, respecting restricted
  credentials and retaining the management allowlist.
- Eight-hour HttpOnly sessions, same-origin/CSRF protection, CSP, login
  throttling and explicit write review. Browser tokens are never persisted.
- Shared tool executor keeps MCP/dashboard validation, policy and auditing aligned.


## [0.1.0] - 2026-10-25

First release, published as `ghcr.io/bbareth/steward:0.1.0`.

### Added
- Server-setup tools covering what Discord's bot API can change in Server
  Settings:
  - Onboarding: `configure_onboarding` checks the Community requirement, the
    7-channel minimum, and that roles are safe to self-assign. It keeps
    question ids so members' answers survive edits.
  - `configure_welcome_screen`, `configure_widget`, and
    `set_security_actions` (pause invites or DMs).
  - `update_bot_profile` for the bot's nickname, avatar, banner and bio in
    this server.
  - Emoji, stickers and soundboard sounds.
  - Scheduled events, including repeating ones.
  - Invites, including invites that hand out roles.
  - Webhooks (tokens are never returned), the server template, and
    integrations such as Twitch or YouTube.
  - `get_server_setup` reads all of it back in one call.
- `update_guild_settings` now sets the server icon, banner, invite background
  and Discovery background, and can pause invites or turn raid alerts off.
- `update_role` now sets gradient and holographic colours and role icons.
- `update_channel` now sets voice region and video quality, the default thread
  slowmode and archive time, and forum tags, default reaction, sort order,
  layout and required tags. `get_channel` reports them.
- Images and sounds are checked by their actual bytes, type and size before
  upload. Boost unlocks are checked before the request goes out.
- `check_bot_setup`: read-only checks for another bot's membership, required
  server/channel permissions and assignable roles, with hierarchy blockers,
  explicit unverified channels and a documented agent setup workflow.
- One container running a discord.js bot and an MCP server over authenticated
  Streamable HTTP at `/mcp`, with `/healthz` and `/readyz`.
- 71 typed MCP tools to inspect servers, channels, roles, members, permission
  overwrites and AutoMod; to create, edit, order and delete channels,
  categories and roles; to assign roles; to set overwrites and private/read-only
  presets; to update server settings; to post and edit bot-owned messages; and
  to configure welcome messages, join roles, self-role panels and AutoMod.
- Blueprints: export a server to YAML/JSON, validate, plan (dry run bound to
  guild, blueprint and server state, with blocked/unsupported/warning
  reporting), apply, verify. Stable keys bound to Discord IDs; re-applying is a
  no-op; pruning is explicit.
- Effective-permission and role-hierarchy checks before every write, including
  "the bot cannot grant what it does not hold" and privileged-role detection
  through channel overwrites.
- Operation journal: write-ahead records with operation IDs in Discord's audit
  log, retries for idempotent requests, audit-log and heuristic reconciliation
  of uncertain creates, nonce-protected message posts, and reconciliation after
  interrupted runs.
- Self-assignable role panels (buttons) from an explicit allowlist; welcome
  messages with escaped placeholders and member-only pings; join roles.
- Bearer-token credentials stored as hashes, with per-credential scopes and
  guild lists; Host/Origin validation; failure throttling; read-only mode;
  destructive tools off by default; secret redaction in logs and errors.
- Invite-link generation for steward and for other bots, with the manual steps
  and limits spelled out.
- Dockerfile (non-root, health check on readiness, graceful shutdown),
  Compose file (loopback by default, read-only root, persistent volume),
  `.env.example`, `scripts/init-config.sh`, `scripts/generate-token.mjs`,
  `scripts/smoke-test.sh`.
- CI (lint, typecheck, format, tests on Node 22 and 24, image build and smoke
  test) and a GHCR publishing workflow for `linux/amd64` and `linux/arm64`.
- Tests against an in-memory Discord with fault injection and a real MCP
  client; an optional live test against a dedicated Discord server.
- Opt-in reaction guard (`DISCORD_BOT_REACTION_GUARD`, default off, inactive
  in read-only mode): removes ordinary members' reactions from messages
  steward posted, including uncached ones, using only the non-privileged Guild
  Message Reactions intent. Bots, the server owner and roles bound to `owner`,
  `admin`, `moderator` and `bot` are exempt, and a reaction stays whenever
  steward cannot tell who wrote the message, who reacted or who owns the
  server; `steward_status` reports whether it is active.

- Ready for Discord's channel visibility change of 16 November 2026, after
  which the guild channel list omits channels the bot cannot view. A mapped
  channel missing from the list is read by ID: a 403 means it still exists,
  so it is never re-created or pruned, its mapping is kept, and every step
  that needs it is blocked with the fix (allow View Channel for the bot's
  role there). Messages Discord refuses to show block their steps instead of
  failing the plan. Recovering a timed-out create finds a new channel the bot
  cannot view through the audit log instead of creating it again. Plans warn
  when the bot lacks View Channel server-wide; export notes managed channels
  it could not see.

### Fixed
- `update_channel` failed when one call set new forum tags and turned on
  `require_tag`, because Discord checks the flag against the tags the channel
  had before the edit. The tags and the flag now go out as two requests in the
  right order, and `require_tag` is refused up front when no tag is one members
  can pick.
- `delete_integration` claimed to kick bots, but Discord answers Missing
  Access when a bot removes another app's bot. The description now says so,
  and that refusal comes back with how to remove the bot by hand.
- CI dependency installation no longer waits for the optional npm audit
  endpoint; it uses the same install flags as the Docker build.
- Role ordering with tied positions. Discord lets roles share a position and
  breaks ties by id; the planner saw a difference that the executor could not
  express, so apply reported "already in order" while verify still differed.
  Plan, apply, verify and the role tools now share one calculation in
  Discord's real order, renumber only roles below the bot, read the order back
  after a change, and report a concrete blocker when there is no room.
- Hierarchy warnings in `get_guild_overview` and `create_role` compared raw
  positions while checks and writes used the id tie-breaker, so a role sharing
  the bot's position could be reported as both manageable and not.
  `get_member` also lists roles in Discord's order now.
- AutoMod: export no longer invents a mention limit or drops actions it cannot
  describe, so an exported server re-plans to nothing. Updates send only the
  fields that differ and keep actions steward does not model. A 404 on a rule
  Discord lists (rules Discord keeps for itself) fails just that step with a
  diagnosis, never deletes or recreates the rule, and lets independent steps
  run (deletions wait unless `continue_on_error`); deletes are read back. Prune only takes rules steward created unless
  `prune_unmanaged` is set.
- Community: announcement, stage, forum and media channels are created after
  the settings step that turns Community on. Media channels count as needing
  Community; forums are planned with a warning instead. Turning Community on
  needs Administrator, and its prerequisites are checked on the values the
  server will have.
- Publishing: `latest` now moves only for the newest release tag. Before,
  the metadata action also tagged every other release (so re-running or
  backporting an older tag moved `latest` back) and the newest-tag check
  counted pre-releases. `edge` is tagged for pushes to `main` itself rather
  than to the repository's default branch, which can be another branch.
- Audit-log reasons are cut to Discord's 512-character limit as measured after
  URL encoding, where a space costs 3 characters and an emoji 12, instead of
  to 500 raw characters. The cut keeps whole code points and the leading
  operation ID that reconciliation searches for.

### Documentation
- Updating versus restarting: what `restart`, `up -d`, `pull` and `--build`
  each change, which image tags exist (`edge`, `X.Y.Z`, `X.Y`, `latest` for
  the newest release only), and how to update a deployment that is a plain
  copy of the source.

[Unreleased]: https://github.com/BBareth/steward/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/BBareth/steward/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/BBareth/steward/releases/tag/v0.1.0
