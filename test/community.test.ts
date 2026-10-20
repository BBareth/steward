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

  test('verification and content filter are checked on the values the server will have', async () => {
    env = makeEnv(STRICT);
    const { verification_level: _v, explicit_content_filter: _f, ...settings } = fresh().settings;
    const blocked = async () => {
      const { body } = await env!.service.createPlan({
        guildId: env!.guildId,
        blueprint: { ...fresh(), settings },
        clientId: 'test',
      });
      return body.steps.find((s) => s.action === 'update_settings')!.blocked;
    };
    expect(await blocked()).toMatch(/Community needs verification level "low" or higher/);
    env.adapter.guild.verificationLevel = 2;
    expect(await blocked()).toMatch(/Community needs the content filter to scan all members/);
    env.adapter.guild.explicitContentFilter = 2;
    expect(await blocked()).toBeUndefined();
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
    ).toMatch(/forum channels launched/);
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

  test.each(['stage', 'media', 'announcement'])(
    '%s channels are unsupported without Community',
    async (type) => {
      env = makeEnv();
      const { body } = await env.service.createPlan({
        guildId: env.guildId,
        blueprint: noCommunity(type),
        clientId: 'test',
      });
      expect(body.unsupported.map((u) => u.code)).toEqual(['needs_community']);
    },
  );

  test('a server with the NEWS feature can have announcement channels', async () => {
    env = makeEnv(STRICT);
    env.adapter.guild.features = ['NEWS'];
    const { body, result } = await planAndApply(env, noCommunity('announcement'));
    expect(body.unsupported).toEqual([]);
    expect(result.status).toBe('applied');
  });
});

describe('found in review', () => {
  const forum = {
    version: 1,
    roles: [],
    categories: [{ key: 'talk', name: 'Talk', channels: [{ key: 'room', name: 'room', type: 'forum' }] }],
    messages: [],
  };

  test('a refusal on a server that already has Community is reported as Discord gave it', async () => {
    env = makeEnv();
    env.adapter.guild.features = ['COMMUNITY'];
    env.adapter.inject('createChannel', 'forbidden', {
      when: (args) => (args[1] as { type?: number }).type === 15,
    });
    const { result } = await planAndApply(env, forum);
    const step = result.steps.find((s) => s.summary.includes('#room'))!;
    expect(step.status).toBe('failed');
    expect(step.error).toMatch(/Missing Permissions/);
    expect(step.error).not.toMatch(/Community feature/);
    expect(step.opIds).toHaveLength(1);
  });

  test('when the features cannot be read, the original refusal stands', async () => {
    env = makeEnv(STRICT);
    const { record } = await env.service.createPlan({
      guildId: env.guildId,
      blueprint: forum,
      clientId: 'test',
    });
    // The apply's own freshness check reads the server first; fail only the read after the refusal.
    env.adapter.inject('fetchSnapshot', 'timeout_before', {
      when: () => env!.adapter.calls.some((c) => c.method === 'createChannel'),
    });
    const result = await env.service.apply({
      planId: record.id,
      guildId: env.guildId,
      clientId: 'test',
      canDestroy: false,
      continueOnError: false,
      acceptBlocked: false,
    });
    const step = result.steps.find((s) => s.summary.includes('#room'))!;
    expect(step.status).toBe('failed');
    expect(step.error).toMatch(/type requires Community/);
    expect(step.error).not.toMatch(/may or may not have been applied/);
    expect(step.opIds).toHaveLength(1);
  });

  test('a NEWS server turning Community on creates announcement channels without waiting', async () => {
    env = makeEnv(STRICT);
    env.adapter.guild.features = ['NEWS'];
    const bp = fresh({ system_channel: 'news' });
    const { body, result } = await planAndApply(env, bp);
    const settings = body.steps.find((s) => s.action === 'update_settings')!;
    expect(settings.blocked).toBeUndefined();
    const news = body.steps.find((s) => s.action === 'create_channel' && 'key' in s && s.key === 'news')!;
    expect(news.dependsOn).not.toContain(settings.id);
    expect(result.status).toBe('applied');
  });
});
