import { afterEach, describe, expect, test } from 'vitest';
import { validateBlueprint } from '../src/blueprint/validate.js';
import { P } from '../src/discord/permissions.js';
import type { TestEnv } from './helpers/env.js';
import { makeEnv } from './helpers/env.js';

/**
 * Channel types tied to the Community feature. The strict mock refuses
 * announcement, stage, forum and media channels until Community is on, which
 * is the most demanding behaviour Discord has had for them.
 */

let env: TestEnv | undefined;
afterEach(() => {
  env?.cleanup();
  env = undefined;
});

const STRICT = { communityChannelTypes: [5, 13, 15, 16] };

const fresh = (settings: Record<string, unknown> = {}) => ({
  version: 1,
  settings: {
    verification_level: 'low',
    explicit_content_filter: 'all_members',
    community: true,
    rules_channel: 'rules',
    public_updates_channel: 'mod-updates',
    ...settings,
  },
  roles: [],
  categories: [
    {
      key: 'info',
      name: 'Info',
      channels: [
        { key: 'rules', name: 'rules' },
        { key: 'mod-updates', name: 'mod-updates' },
        { key: 'news', name: 'news', type: 'announcement' },
      ],
    },
    {
      key: 'talk',
      name: 'Talk',
      channels: [
        { key: 'general', name: 'general' },
        { key: 'help', name: 'help', type: 'forum' },
        { key: 'clips', name: 'clips', type: 'media' },
        { key: 'stage', name: 'Town Hall', type: 'stage' },
      ],
    },
  ],
  messages: [],
});

async function planAndApply(e: TestEnv, blueprint: unknown) {
  const { record, body } = await e.service.createPlan({ guildId: e.guildId, blueprint, clientId: 'test' });
  const result = await e.service.apply({
    planId: record.id,
    guildId: e.guildId,
    clientId: 'test',
    canDestroy: false,
    continueOnError: false,
    acceptBlocked: false,
  });
  return { body, result };
}

describe('turning Community on in a fresh server', () => {
  test('every Community-tied channel is created after the settings step, and the plan converges', async () => {
    env = makeEnv(STRICT);
    const bp = fresh();
    const { body, result } = await planAndApply(env, bp);

    const settings = body.steps.find((s) => s.action === 'update_settings')!;
    const create = (key: string) =>
      body.steps.find((s) => s.action === 'create_channel' && 'key' in s && s.key === key)!;
    const index = (key: string) => body.steps.indexOf(create(key));
    for (const key of ['news', 'help', 'clips', 'stage']) {
      expect(create(key).dependsOn).toContain(settings.id);
      expect(index(key)).toBeGreaterThan(body.steps.indexOf(settings));
    }
    for (const key of ['rules', 'mod-updates', 'general']) {
      expect(create(key).dependsOn).not.toContain(settings.id);
      expect(index(key)).toBeLessThan(body.steps.indexOf(settings));
    }
    expect(settings.dependsOn).toEqual(
      expect.arrayContaining([create('rules').id, create('mod-updates').id]),
    );
    expect(body.unsupported).toEqual([]);
    expect(body.warnings.map((w) => w.code)).toContain('media_channel_beta');
    expect(body.warnings.map((w) => w.code)).not.toContain('community_may_be_needed');

    expect(result.status).toBe('applied');
    expect(env.adapter.guild.features).toContain('COMMUNITY');
    for (const name of ['news', 'help', 'clips', 'Town Hall'])
      expect(env.adapter.channelByName(name)).toBeDefined();
    expect((await env.service.verify(env.guildId, bp)).inSync).toBe(true);
  });

  test('a rules channel that could only exist after Community is blocked with the reason', async () => {
    env = makeEnv(STRICT);
    const bp = fresh({ rules_channel: 'news' });
    expect(
      validateBlueprint(bp)
        .warnings.map((w) => w.message)
        .join(),
    ).toMatch(/"news" is an announcement channel; when this blueprint turns Community on/);
    const { body } = await env.service.createPlan({ guildId: env.guildId, blueprint: bp, clientId: 'test' });
    expect(body.steps.find((s) => s.action === 'update_settings')!.blocked).toMatch(
      /settings.rules_channel is "news", a announcement channel that can only be created once Community is on/,
    );
  });

  test('turning Community on needs Administrator', async () => {
    env = makeEnv({
      ...STRICT,
      botPermissions: P.ManageGuild | P.ManageChannels | P.ManageRoles | P.ViewChannel,
    });
    const { body } = await env.service.createPlan({
      guildId: env.guildId,
      blueprint: fresh(),
      clientId: 'test',
    });
    expect(body.steps.find((s) => s.action === 'update_settings')!.blocked).toBe(
      'Discord requires Administrator to turn Community on or off',
    );
    // The channels that wait for Community are blocked with it.
    const forum = body.steps.find((s) => s.summary.includes('#help'))!;
    expect(forum.blocked).toMatch(/depends on blocked step/);
  });
});

describe('servers that stay without Community', () => {
  const noCommunity = (type: string) => ({
    version: 1,
    roles: [],
    categories: [{ key: 'talk', name: 'Talk', channels: [{ key: 'room', name: 'room', type }] }],
    messages: [],
  });

  test('a forum is planned with a warning, not refused', async () => {
    env = makeEnv();
    const bp = noCommunity('forum');
    expect(
      validateBlueprint(bp)
        .warnings.map((w) => w.message)
        .join(),
    ).toMatch(/forum and media channels launched/);
    const { body, result } = await planAndApply(env, bp);
    expect(body.unsupported).toEqual([]);
    expect(body.warnings.map((w) => w.code)).toContain('community_may_be_needed');
    expect(result.status).toBe('applied');
  });

  test('when Discord refuses a forum, the error says why it may have', async () => {
    env = makeEnv(STRICT);
    const { result } = await planAndApply(env, noCommunity('forum'));
    const step = result.steps.find((s) => s.action === 'create_channel' && s.summary.includes('#room'))!;
    expect(step.status).toBe('failed');
    expect(step.error).toMatch(
      /Discord may only allow forum channels on servers with the Community feature; this server has: no features/,
    );
    expect(step.opIds).toHaveLength(1);
  });

  test('stage channels are still unsupported without Community', async () => {
    env = makeEnv();
    const { body } = await env.service.createPlan({
      guildId: env.guildId,
      blueprint: noCommunity('stage'),
      clientId: 'test',
    });
    expect(body.unsupported.map((u) => u.code)).toEqual(['needs_community']);
  });

  test('a server with the NEWS feature can have announcement channels', async () => {
    env = makeEnv(STRICT);
    env.adapter.guild.features = ['NEWS'];
    const { body, result } = await planAndApply(env, noCommunity('announcement'));
    expect(body.unsupported).toEqual([]);
    expect(result.status).toBe('applied');
  });
});
