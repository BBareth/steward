import { afterEach, describe, expect, test } from 'vitest';
import { P } from '../src/discord/permissions.js';
import type { TestEnv } from './helpers/env.js';
import { makeEnv } from './helpers/env.js';
import { MemoryDiscordAdapter } from './helpers/memory-adapter.js';

/**
 * From 2026-11-16 Discord's guild channel list leaves out channels the bot
 * cannot view, and reading one by id answers 403. The memory adapter does the
 * same. A managed channel missing from the list must not be taken for deleted.
 */

let env: TestEnv | undefined;
afterEach(() => {
  env?.cleanup();
  env = undefined;
});

const NOT_ADMIN = { botPermissions: MemoryDiscordAdapter.EVERYTHING_BUT_ADMIN };

const BP = {
  version: 1,
  roles: [{ key: 'mod', name: 'Moderator', staff: true }],
  categories: [
    {
      key: 'staff',
      name: 'Staff',
      access: { private: true, visible_to: ['mod'] },
      channels: [
        { key: 'staff-chat', name: 'staff-chat' },
        { key: 'mod-log', name: 'mod-log' },
      ],
    },
    { key: 'chat', name: 'Chat', channels: [{ key: 'general', name: 'general' }] },
  ],
  messages: [{ key: 'staff-note', channel: 'staff-chat', content: 'Read the handbook.' }],
};

const mutations = (e: TestEnv) =>
  e.adapter.calls.filter((c) => !c.method.startsWith('fetch')).map((c) => c.method);

const idOf = (e: TestEnv, key: string) => e.store.getMapping(e.guildId, 'channel', key)!.discordId;

async function plan(e: TestEnv, blueprint: unknown, options?: object) {
  return e.service.createPlan({ guildId: e.guildId, blueprint, clientId: 'test', options: options as never });
}

async function apply(
  e: TestEnv,
  planId: string,
  opts: { acceptBlocked?: boolean; canDestroy?: boolean } = {},
) {
  return e.service.apply({
    planId,
    guildId: e.guildId,
    clientId: 'test',
    canDestroy: opts.canDestroy ?? false,
    continueOnError: false,
    acceptBlocked: opts.acceptBlocked ?? false,
  });
}

async function setUp(blueprint: unknown = BP, options: object = NOT_ADMIN): Promise<TestEnv> {
  const e = makeEnv(options);
  const { record } = await plan(e, blueprint);
  expect((await apply(e, record.id)).status).toBe('applied');
  e.adapter.calls.length = 0;
  return e;
}

describe('a managed channel the bot can no longer view', () => {
  test('is left out of the snapshot, and Discord says it still exists', async () => {
    env = await setUp();
    const id = idOf(env, 'staff-chat');
    env.adapter.hideFromBot(id);
    const snap = await env.adapter.fetchSnapshot(env.guildId);
    expect(snap.channels.map((c) => c.id)).not.toContain(id);
    // The category stays listed: another channel in it is still visible.
    expect(snap.channels.map((c) => c.id)).toContain(idOf(env, 'staff'));
    expect(await env.adapter.fetchChannel(id)).toEqual({ status: 'hidden' });
  });

  test('is not created again, keeps its mapping, and blocks with the fix', async () => {
    env = await setUp();
    const id = idOf(env, 'staff-chat');
    const restore = env.adapter.hideFromBot(id);

    const { record, body } = await plan(env, BP);
    expect(env.adapter.calls).toContainEqual({ method: 'fetchChannel', args: [id] });
    expect(body.steps.filter((s) => s.action === 'create_channel' || s.action === 'post_message')).toEqual(
      [],
    );
    expect(body.warnings.map((w) => w.code)).not.toContain('mapped_resource_missing');
    expect(body.warnings.map((w) => w.code)).not.toContain('message_missing');
    expect(body.resolution['channel:staff-chat']).toBe(id);
    const step = body.steps.find((s) => 'key' in s && s.key === 'staff-chat')!;
    expect(step).toMatchObject({ action: 'update_channel', channelId: id, destructive: false });
    expect(step.blocked).toMatch(/cannot see channel "staff-chat".*View Channel/);
    // The message in it cannot be read either, so it is not posted a second time.
    const note = body.steps.find((s) => 'key' in s && s.key === 'staff-note')!;
    expect(note).toMatchObject({ action: 'edit_message', summary: 'check message "staff-note"' });
    expect(note.blocked).toMatch(/cannot read its message "staff-note".*Read Message History/);
    expect(body.steps.every((s) => s.blocked)).toBe(true);

    const result = await apply(env, record.id, { acceptBlocked: true });
    expect(result.steps.map((s) => s.status)).toEqual(['blocked', 'blocked']);
    expect(mutations(env)).toEqual([]);
    expect(idOf(env, 'staff-chat')).toBe(id);
    expect([...env.adapter.channels.values()].filter((c) => c.name === 'staff-chat')).toHaveLength(1);
    expect([...env.adapter.messages.values()]).toHaveLength(1);

    // Verify cannot call a channel it cannot see "in sync".
    const v = await env.service.verify(env.guildId, BP);
    expect(v.inSync).toBe(false);
    expect(v.body.steps.map((s) => s.blocked)).toEqual([
      expect.stringMatching(/View Channel/),
      expect.stringMatching(/View Channel/),
    ]);

    restore();
    expect((await plan(env, BP)).body.steps).toEqual([]);
    expect((await env.service.verify(env.guildId, BP)).inSync).toBe(true);
  });

  test('a channel that was really deleted is still created again', async () => {
    env = await setUp();
    const id = idOf(env, 'general');
    env.adapter.channels.delete(id);
    const { record, body } = await plan(env, BP);
    expect(env.adapter.calls).toContainEqual({ method: 'fetchChannel', args: [id] });
    expect(body.warnings.map((w) => w.code)).toContain('mapped_resource_missing');
    expect(body.steps.filter((s) => s.action === 'create_channel').map((s) => s.summary)).toEqual([
      'create text #general in "Chat"',
    ]);
    expect((await apply(env, record.id)).status).toBe('applied');
    expect(idOf(env, 'general')).not.toBe(id);
  });

  test('a failed check stops the plan instead of guessing', async () => {
    env = await setUp();
    env.adapter.hideFromBot(idOf(env, 'staff-chat'));
    env.adapter.inject('fetchChannel', 'timeout_before');
    await expect(plan(env, BP)).rejects.toThrow(/timed out/);
  });

  test('channels to create inside a category the bot cannot see are blocked', async () => {
    env = await setUp();
    for (const key of ['staff', 'staff-chat', 'mod-log']) env.adapter.hideFromBot(idOf(env, key));
    const grown = structuredClone(BP);
    grown.categories[0]!.channels.push({ key: 'reports', name: 'reports' });
    const { record, body } = await plan(env, grown);
    const create = body.steps.filter((s) => s.action === 'create_channel');
    expect(create.map((s) => s.summary)).toEqual([expect.stringContaining('#reports')]);
    expect(create[0]!.blocked).toMatch(/cannot see channel "staff"/);
    expect(
      body.steps
        .filter((s) => s.action === 'update_channel')
        .map((s) => ('key' in s ? s.key : null))
        .sort(),
    ).toEqual(['mod-log', 'staff', 'staff-chat']);
    await apply(env, record.id, { acceptBlocked: true });
    expect(mutations(env)).toEqual([]);
  });

  test('a hidden Community rules channel does not block an unrelated settings change', async () => {
    const community = {
      version: 1,
      settings: {
        verification_level: 'low',
        explicit_content_filter: 'all_members',
        community: true,
        rules_channel: 'rules',
        public_updates_channel: 'updates',
      },
      channels: [
        { key: 'rules', name: 'rules' },
        { key: 'updates', name: 'updates' },
      ],
      messages: [{ key: 'rules-post', channel: 'rules', content: 'Be kind.' }],
    };
    // Turning Community on needs Administrator; the bot loses it afterwards.
    env = await setUp(community, {});
    env.adapter.setBotPermissions(MemoryDiscordAdapter.EVERYTHING_BUT_ADMIN);
    const rules = idOf(env, 'rules');
    env.adapter.hideFromBot(rules);
    const renamed = { ...community, settings: { ...community.settings, name: 'Renamed' } };
    const { record, body } = await plan(env, renamed);
    const settings = body.steps.find((s) => s.action === 'update_settings')!;
    expect(settings).toMatchObject({ fields: { name: 'Renamed' } });
    expect(settings.blocked).toBeUndefined();
    expect(body.steps.filter((s) => s.blocked).map((s) => s.summary)).toEqual([
      `manage channel "rules" (${rules}), which the bot cannot see`,
      'check message "rules-post"',
    ]);
    await apply(env, record.id, { acceptBlocked: true });
    expect(mutations(env)).toEqual(['editGuild']);
    expect(env.adapter.guild).toMatchObject({ name: 'Renamed', rulesChannelId: rules });
  });
});

describe('pruning', () => {
  test('never deletes a channel the bot cannot see, and says why', async () => {
    env = await setUp();
    const hidden = idOf(env, 'staff-chat');
    const general = idOf(env, 'general');
    env.adapter.hideFromBot(hidden);
    const trimmed = structuredClone(BP) as Partial<typeof BP> & typeof BP;
    trimmed.categories[0]!.channels = trimmed.categories[0]!.channels.filter((c) => c.key !== 'staff-chat');
    trimmed.categories[1]!.channels = [];
    trimmed.messages = [];

    const { record, body } = await plan(env, trimmed, { prune: { channels: true, messages: true } });
    const deletes = body.steps.filter((s) => s.action === 'delete_channel' || s.action === 'delete_message');
    expect(deletes.map((s) => [s.summary, !!s.blocked, s.destructive])).toEqual([
      ['delete message "staff-note"', true, true],
      ['delete text channel #general', false, true],
      [`delete channel "staff-chat" (${hidden}), which the bot cannot see`, true, true],
    ]);
    expect(deletes.find((s) => s.action === 'delete_channel' && s.blocked)!.blocked).toMatch(/View Channel/);

    const result = await apply(env, record.id, { acceptBlocked: true, canDestroy: true });
    expect(result.status).toBe('partial');
    const deleted = env.adapter.calls.filter((c) => c.method === 'deleteChannel').map((c) => c.args[0]);
    expect(deleted).toEqual([general]);
    expect(mutations(env)).not.toContain('deleteMessage');
    expect(env.adapter.channels.has(hidden)).toBe(true);
    expect(idOf(env, 'staff-chat')).toBe(hidden);
  });
});

describe('around the edges', () => {
  test('an uncertain create of a channel the bot cannot see is recovered, not repeated', async () => {
    env = makeEnv(NOT_ADMIN);
    const bp = {
      version: 1,
      channels: [
        {
          key: 'secret',
          name: 'secret',
          permissions: [{ role: env.adapter.botRoleId, allow: [], deny: ['ViewChannel'] }],
        },
      ],
    };
    env.adapter.inject('createChannel', 'timeout_after');
    const { record } = await plan(env, bp);
    const result = await apply(env, record.id);
    expect(result.steps[0]!.status).toBe('recovered');
    const made = [...env.adapter.channels.values()].filter((c) => c.name === 'secret');
    expect(made).toHaveLength(1);
    expect(idOf(env, 'secret')).toBe(made[0]!.id);
    const again = await plan(env, bp);
    expect(again.body.steps.map((s) => [s.action, !!s.blocked])).toEqual([['update_channel', true]]);
  });

  test('an explicit id the bot cannot see is refused with the reason', async () => {
    env = makeEnv(NOT_ADMIN);
    const ch = env.adapter.addChannel({ name: 'vault' });
    env.adapter.hideFromBot(ch.id);
    await expect(
      plan(env, { version: 1, channels: [{ key: 'vault', name: 'vault', id: ch.id }] }),
    ).rejects.toThrow(/cannot see it \(it needs View Channel there\)/);
  });

  test('a bot without View Channel server-wide is warned that it may not see every channel', async () => {
    env = makeEnv({ botPermissions: MemoryDiscordAdapter.EVERYTHING_BUT_ADMIN & ~P.ViewChannel });
    env.adapter.roles.get(env.guildId)!.permissions &= ~P.ViewChannel;
    const { body } = await plan(env, { version: 1, channels: [{ key: 'general', name: 'general' }] });
    expect(body.warnings.map((w) => w.code)).toContain('bot_cannot_view_channels');
  });

  test('export says which managed channels it could not see', async () => {
    env = await setUp();
    env.adapter.hideFromBot(idOf(env, 'staff-chat'));
    const out = await env.service.export({
      guildId: env.guildId,
      format: 'json',
      includeIds: false,
      recordMappings: false,
    });
    expect(out.text).not.toContain('"staff-chat"');
    expect(out.notes.join('\n')).toMatch(/not exported because the bot cannot view them.*: "staff-chat"/);
    expect(out.notes.join('\n')).toMatch(/cannot read were left out: staff-note/);
  });
});
