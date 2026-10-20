# Contributing

Bug reports, fixes, and well-scoped features are welcome.

## Before a large change

Open an issue first. steward is deliberately small: one container, one
process, one SQLite file, no external services, no model calls. The most useful
thing a proposal can do is explain why it belongs inside that shape.

## Getting set up

Node 22.12+ (24 recommended) and, for the image, Docker.

```bash
npm ci
npm run check            # typecheck, lint, format check, tests
```

`.npmrc` sets `ignore-scripts=true`: no dependency needs an install script, and
better-sqlite3 ships prebuilt binaries for glibc and musl on amd64 and arm64.

Run it against a throwaway bot and a throwaway server:

```bash
cp .env.example .env     # DATABASE_PATH defaults to ./data/steward.db outside Docker
$EDITOR .env
npm run dev              # tsx, restarts on change, reads .env
# or: npm run build && node --env-file=.env dist/index.js
```

## Tests

`npm test` runs everything offline in a few seconds:

- an in-memory Discord (`test/helpers/memory-adapter.ts`) that enforces
  permissions, role hierarchy, managed roles, Community requirements, position
  shuffling and nonce de-duplication, and can inject timeouts (before or after
  the change is applied), 5xx errors, 403s, 404s and hangs;
- the real HTTP server and a real MCP client (`@modelcontextprotocol/client`)
  for authentication, Host/Origin checks, scopes, guild restrictions and the
  end-to-end blueprint workflow;
- blueprint validation, planning, apply, stale plans, partial failure,
  retries, reconciliation and interrupted runs; persistence across restarts;
  self-role and welcome safety; docs consistency (the examples in the docs are
  checked against the code).

### Live tests (optional)

`test/live/` runs the real discord.js adapter against a real server. Use a
dedicated test server with nothing you care about in it; the test creates
resources with a unique prefix and prunes them at the end.

```bash
STEWARD_LIVE_TOKEN=<bot token> STEWARD_LIVE_GUILD_ID=<test server id> npm run test:live
```

The bot needs Manage Roles, Manage Channels, View Channel, Send Messages,
Embed Links and View Audit Log there (Administrator is simplest), and its role
must sit above the roles it creates (it does by default: new roles are created
at the bottom). `STEWARD_LIVE_VERBOSE=1` prints its logs.

## Before opening a PR

```bash
npm run check
docker build -t steward:test .
sh scripts/smoke-test.sh steward:test
```

CI runs the same: the checks on Node 22 and 24, then builds the image and runs
the smoke test (liveness, readiness reporting the Discord failure, 401/403
paths, a real MCP initialize, no secrets in logs, clean shutdown).

## Style

Match what is there. A few things that are deliberate:

- **Comments explain why, not what.** Most comments exist because something
  non-obvious would bite otherwise — the disabled REST retries, the
  restrictive-first overwrite order, the bot-access overwrite on private
  channels. Keep that bar.
- **State describes reality.** A step is `recovered` only when the resource was
  actually found; `uncertain` when steward cannot tell. Do not add a status the
  code cannot prove.
- **Fail before writing.** Hierarchy, permission and safety problems belong in
  the plan (or the tool's pre-check), not in a Discord 403 halfway through.
- **No silent adoption, no silent deletion.** Anything that binds an existing
  resource or removes one must be explicit.
- **Compact by default.** Tool results are read by models with limited
  context; return summaries and let `detail: "full"` and pagination supply the
  rest.

## Releasing

1. Merge to `main` and let CI go green. The **Publish image** workflow pushes
   `edge` for `main`.
2. Move the `Unreleased` notes in `CHANGELOG.md` under a version heading and
   bump `version` in `package.json` and `src/version.ts` (a test checks they
   agree).
3. Tag and push: `git tag -a vX.Y.Z -m "steward X.Y.Z" && git push origin vX.Y.Z`.
4. Wait for **Publish image**; it pushes `X.Y.Z`, `X.Y` and, if this is the
   newest tag, `latest` for `linux/amd64` and `linux/arm64`.
5. Then create the GitHub release, and add the GHCR badge to the README once
   the package exists.
