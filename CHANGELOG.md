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
