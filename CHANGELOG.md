# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

First version. Not yet released or published as an image.

### Added
- One container running a discord.js bot and an MCP server over authenticated
  Streamable HTTP at `/mcp`, with `/healthz` and `/readyz`.
- 45 typed MCP tools to inspect servers, channels, roles, members, permission
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

### Documentation
- Updating versus restarting: what `restart`, `up -d`, `pull` and `--build`
  each change, which image tags exist (`edge`, `X.Y.Z`, `X.Y`, `latest` for
  the newest release only), and how to update a deployment that is a plain
  copy of the source.
