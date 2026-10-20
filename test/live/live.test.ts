/**
 * Optional live test against a real Discord server. It creates resources with
 * a unique prefix, re-applies to prove idempotency, then prunes them again.
 *
 * Use a dedicated test server. Never point this at a community you care about.
 *
 *   STEWARD_LIVE_TOKEN=<bot token> STEWARD_LIVE_GUILD_ID=<server id> npm run test:live
 *
 * The bot needs Manage Roles, Manage Channels, View Channel, Send Messages,
 * Embed Links and View Audit Log in that server (Administrator is simplest).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { BlueprintService } from '../../src/blueprint/service.js';
import { DiscordJsAdapter } from '../../src/discord/discordjs-adapter.js';
import { createLogger, silentLogger } from '../../src/logger.js';
import { GuildLocks } from '../../src/ops/locks.js';
import { Store } from '../../src/store.js';

const token = process.env.STEWARD_LIVE_TOKEN;
const guildId = process.env.STEWARD_LIVE_GUILD_ID;
const enabled = !!token && !!guildId;

describe.skipIf(!enabled)('live Discord round trip', () => {
  const prefix = `stw-live-${Date.now().toString(36)}`;
  const dir = mkdtempSync(join(tmpdir(), 'steward-live-'));
  let adapter: DiscordJsAdapter;
  let store: Store;
  let service: BlueprintService;

  const blueprint = {
    version: 1,
    name: prefix,
    roles: [
      { key: `${prefix}-staff`, name: `${prefix} staff`, staff: true, permissions: [] },
      { key: `${prefix}-ping`, name: `${prefix} ping` },
    ],
    categories: [
      {
        key: `${prefix}-cat`,
        name: `${prefix} category`,
        access: { private: true, visible_to: [`${prefix}-staff`] },
        channels: [
          { key: `${prefix}-text`, name: `${prefix}-text`, topic: 'steward live test' },
          { key: `${prefix}-voice`, name: `${prefix} voice`, type: 'voice' },
        ],
      },
    ],
    messages: [{ key: `${prefix}-msg`, channel: `${prefix}-text`, content: 'steward live test message' }],
    self_roles: {
      roles: [`${prefix}-ping`],
      panels: [
        {
          key: `${prefix}-panel`,
          channel: `${prefix}-text`,
          title: 'Live test panel',
          options: [{ role: `${prefix}-ping`, label: 'Ping' }],
        },
      ],
    },
  };

  beforeAll(async () => {
    store = new Store(join(dir, 'live.db'));
    adapter = new DiscordJsAdapter({
      token: token!,
      membersIntent: false,
      requestTimeoutMs: 15_000,
      allowedGuildIds: [guildId!],
      logger: process.env.STEWARD_LIVE_VERBOSE ? createLogger({ level: 'debug' }) : silentLogger,
    });
    await adapter.start({});
    for (let i = 0; i < 60 && adapter.status().state !== 'ready'; i++)
      await new Promise((r) => setTimeout(r, 1000));
    expect(adapter.status().state).toBe('ready');
    service = new BlueprintService({
      store,
      adapter,
      logger: silentLogger,
      locks: new GuildLocks(),
      config: { planTtlMinutes: 30, applyWaitSeconds: 300, membersIntent: false, allowDestructive: true },
    });
  });

  afterAll(async () => {
    // Best-effort cleanup even if a test failed half way.
    try {
      const { record } = await service.createPlan({
        guildId: guildId!,
        blueprint: { version: 1 },
        clientId: 'live',
        options: { prune: { roles: true, channels: true, messages: true, panels: true } },
      });
      await service.apply({
        planId: record.id,
        guildId: guildId!,
        clientId: 'live',
        canDestroy: true,
        continueOnError: true,
        acceptBlocked: true,
      });
    } finally {
      await adapter?.stop();
      store?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const apply = async (bp: unknown, prune = false) => {
    const { record, body } = await service.createPlan({
      guildId: guildId!,
      blueprint: bp,
      clientId: 'live',
      options: prune ? { prune: { roles: true, channels: true, messages: true, panels: true } } : undefined,
    });
    const result = await service.apply({
      planId: record.id,
      guildId: guildId!,
      clientId: 'live',
      canDestroy: prune,
      continueOnError: false,
      acceptBlocked: false,
    });
    return { body, result };
  };

  test('apply creates everything', async () => {
    const { body, result } = await apply(blueprint);
    expect(body.summary.blocked).toBe(0);
    expect(result.status).toBe('applied');
  });

  test('verify reports the server in sync', async () => {
    const v = await service.verify(guildId!, blueprint);
    expect(v.body.steps.map((s) => s.summary)).toEqual([]);
    expect(v.inSync).toBe(true);
  });

  test('re-applying changes nothing', async () => {
    const { body } = await apply(blueprint);
    expect(body.steps).toEqual([]);
  });

  test('pruning removes exactly what steward created', async () => {
    const { result } = await apply({ version: 1 }, true);
    expect(result.status).toBe('applied');
    const snap = await adapter.fetchSnapshot(guildId!);
    expect(snap.channels.filter((c) => c.name.startsWith(prefix))).toEqual([]);
    expect(snap.roles.filter((r) => r.name.startsWith(prefix))).toEqual([]);
  });
});
