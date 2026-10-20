import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, test } from 'vitest';
import YAML from 'yaml';
import { BlueprintService } from '../src/blueprint/service.js';
import { P } from '../src/discord/permissions.js';
import { silentLogger } from '../src/logger.js';
import { Store } from '../src/store.js';
import type { TestEnv } from './helpers/env.js';
import { makeEnv } from './helpers/env.js';
import { MemoryDiscordAdapter } from './helpers/memory-adapter.js';

const COMMUNITY = readFileSync('examples/community.yaml', 'utf8');

type Loose = {
  version: 1;
  roles: Array<Record<string, unknown> & { key: string; name: string }>;
  categories: Array<{
    key: string;
    name: string;
    access?: unknown;
    channels: Array<Record<string, unknown> & { key: string; name: string }>;
  }>;
  messages: Array<{ key: string; channel: string; content: string }>;
};

const SMALL: Loose = {
  version: 1,
  roles: [
    { key: 'mod', name: 'Moderator', permissions: ['ManageMessages'], staff: true },
    { key: 'member', name: 'Member' },
  ],
  categories: [
    {
      key: 'staff',
      name: 'Staff',
      access: { private: true, visible_to: ['mod'] },
      channels: [{ key: 'mod-chat', name: 'mod-chat' }],
    },
    {
      key: 'chat',
      name: 'Chat',
      channels: [
        { key: 'general', name: 'general', topic: 'Hello' },
        { key: 'media', name: 'media' },
        { key: 'lounge', name: 'Lounge', type: 'voice' },
      ],
    },
  ],
  messages: [{ key: 'hello', channel: 'general', content: 'Welcome!' }],
};

let env: TestEnv;
afterEach(() => env?.cleanup());

const mutations = (d: MemoryDiscordAdapter) =>
  d.calls.filter((c) => !c.method.startsWith('fetch')).map((c) => c.method);

async function planAndApply(
  e: TestEnv,
  blueprint: unknown,
  opts: { canDestroy?: boolean; continueOnError?: boolean; acceptBlocked?: boolean; options?: object } = {},
) {
  const { record, body } = await e.service.createPlan({
    guildId: e.guildId,
    blueprint,
    clientId: 'test',
    options: opts.options as never,
  });
  const result = await e.service.apply({
    planId: record.id,
    guildId: e.guildId,
    clientId: 'test',
    canDestroy: opts.canDestroy ?? false,
    continueOnError: opts.continueOnError ?? false,
    acceptBlocked: opts.acceptBlocked ?? false,
  });
  return { record, body, result };
}

describe('idempotency and preservation', () => {
  test('applying the same blueprint again sends no mutations', async () => {
    env = makeEnv();
    const first = await planAndApply(env, COMMUNITY);
    expect(first.result.status).toBe('applied');
    env.adapter.calls = [];
    const second = await planAndApply(env, COMMUNITY);
    expect(second.body.steps).toEqual([]);
    expect(second.result.status).toBe('applied');
    expect(mutations(env.adapter)).toEqual([]);
    // No duplicates anywhere.
    const names = [...env.adapter.channels.values()].map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    expect([...env.adapter.messages.values()]).toHaveLength(2 + 3); // two managed messages, three panels
  });

  test('resources outside the blueprint are preserved, including overwrites on managed channels', async () => {
    env = makeEnv();
    const keepRole = env.adapter.addRole({ name: 'Old Timers', position: 2, permissions: P.ViewChannel });
    const keepCat = env.adapter.addChannel({ name: 'Archive', type: 4, position: 9 });
    const keepChan = env.adapter.addChannel({ name: 'old-chat', parentId: keepCat.id });
    await planAndApply(env, SMALL);
    const modChat = env.adapter.channelByName('mod-chat')!;
    modChat.overwrites.push({ id: keepRole.id, type: 'role', allow: 0n, deny: P.SendMessages }); // a hand-made tweak
    const { body, result } = await planAndApply(env, SMALL);
    expect(result.status).toBe('applied');
    expect(body.steps.filter((s) => s.action.startsWith('delete'))).toEqual([]);
    expect(env.adapter.roles.has(keepRole.id)).toBe(true);
    expect(env.adapter.channels.has(keepCat.id)).toBe(true);
    expect(env.adapter.channels.get(keepChan.id)!.parentId).toBe(keepCat.id);
    expect(env.adapter.channelByName('mod-chat')!.overwrites.some((o) => o.id === keepRole.id)).toBe(true);
    expect(body.warnings.map((w) => w.code)).toContain('unmanaged_overwrites');
  });

  test('a same-named unmanaged resource is not adopted silently; adopt_by_name binds it', async () => {
    env = makeEnv();
    const existing = env.adapter.addChannel({ name: 'general' });
    const plain = await env.service.createPlan({
      guildId: env.guildId,
      blueprint: { version: 1, channels: [{ key: 'general', name: 'general' }] },
      clientId: 't',
    });
    expect(plain.body.steps.map((s) => s.action)).toEqual(['create_channel']);
    expect(plain.body.warnings[0]!.code).toBe('name_collision');
    const adopt = await env.service.createPlan({
      guildId: env.guildId,
      blueprint: { version: 1, channels: [{ key: 'general', name: 'general' }] },
      clientId: 't',
      options: { adopt_by_name: true },
    });
    expect(adopt.body.steps.map((s) => s.action)).toEqual(['adopt']);
    await env.service.apply({
      planId: adopt.record.id,
      guildId: env.guildId,
      clientId: 't',
      canDestroy: false,
      continueOnError: false,
      acceptBlocked: false,
    });
    expect(env.store.getMapping(env.guildId, 'channel', 'general')?.discordId).toBe(existing.id);
  });

  test('renaming in the blueprint renames, it does not recreate', async () => {
    env = makeEnv();
    await planAndApply(env, SMALL);
    const id = env.adapter.roleByName('Moderator')!.id;
    const renamed = structuredClone(SMALL);
    renamed.roles[0]!.name = 'Mods';
    const { body } = await planAndApply(env, renamed);
    expect(body.steps.map((s) => s.action)).toEqual(['update_role']);
    expect(env.adapter.roles.get(id)!.name).toBe('Mods');
  });

  test('ordering puts managed channels in blueprint order and leaves unmanaged ones in their slots', async () => {
    env = makeEnv();
    await planAndApply(env, SMALL);
    const chat = env.adapter.channelByName('Chat')!;
    const stray = env.adapter.addChannel({ name: 'stray', parentId: chat.id, position: 1 });
    const reversed = structuredClone(SMALL);
    reversed.categories[1]!.channels = [...reversed.categories[1]!.channels].reverse();
    await planAndApply(env, reversed);
    const text = [...env.adapter.channels.values()]
      .filter((c) => c.parentId === chat.id && c.kind === 'text')
      .sort((a, b) => a.position - b.position || (BigInt(a.id) < BigInt(b.id) ? -1 : 1))
      .map((c) => c.name);
    expect(text.indexOf('media')).toBeLessThan(text.indexOf('general'));
    expect(text).toContain(stray.name);
  });
});

describe('pruning is explicit and gated', () => {
  test('only steward-managed resources are pruned, and only with the destructive scope', async () => {
    env = makeEnv();
    await planAndApply(env, SMALL);
    const unmanaged = env.adapter.addChannel({ name: 'keep-me' });
    const smaller = structuredClone(SMALL);
    smaller.categories[1]!.channels = smaller.categories[1]!.channels.filter((c) => c.key !== 'media');
    smaller.roles = smaller.roles.filter((r) => r.key !== 'member');

    const noPrune = await env.service.createPlan({ guildId: env.guildId, blueprint: smaller, clientId: 't' });
    expect(noPrune.body.steps).toEqual([]);

    const pruned = await env.service.createPlan({
      guildId: env.guildId,
      blueprint: smaller,
      clientId: 't',
      options: { prune: { channels: true, roles: true } },
    });
    expect(pruned.body.steps.map((s) => s.summary)).toEqual([
      'delete text channel #media',
      'delete role "Member"',
    ]);
    expect(pruned.body.steps.every((s) => s.destructive)).toBe(true);

    await expect(
      env.service.apply({
        planId: pruned.record.id,
        guildId: env.guildId,
        clientId: 't',
        canDestroy: false,
        continueOnError: false,
        acceptBlocked: false,
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    const result = await env.service.apply({
      planId: pruned.record.id,
      guildId: env.guildId,
      clientId: 't',
      canDestroy: true,
      continueOnError: false,
      acceptBlocked: false,
    });
    expect(result.status).toBe('applied');
    expect(env.adapter.channelByName('media')).toBeUndefined();
    expect(env.adapter.roleByName('Member')).toBeUndefined();
    expect(env.adapter.channels.has(unmanaged.id)).toBe(true);
    expect(env.store.getMapping(env.guildId, 'channel', 'media')).toBeUndefined();
  });

  test('ALLOW_DESTRUCTIVE=false refuses destructive plans even for privileged callers', async () => {
    env = makeEnv({ allowDestructive: false });
    await planAndApply(env, SMALL);
    const { record } = await env.service.createPlan({
      guildId: env.guildId,
      blueprint: { version: 1 },
      clientId: 't',
      options: { prune: { channels: true } },
    });
    await expect(
      env.service.apply({
        planId: record.id,
        guildId: env.guildId,
        clientId: 't',
        canDestroy: true,
        continueOnError: false,
        acceptBlocked: false,
      }),
    ).rejects.toMatchObject({ code: 'destructive_disabled' });
  });
});

describe('plans are bound, single-use and checked for staleness', () => {
  test('a relevant change after planning makes apply refuse, and says what changed', async () => {
    env = makeEnv();
    await planAndApply(env, SMALL);
    const changed = structuredClone(SMALL);
    changed.categories[1]!.channels[0]!.topic = 'New topic';
    const { record } = await env.service.createPlan({
      guildId: env.guildId,
      blueprint: changed,
      clientId: 't',
    });
    env.adapter.channelByName('general')!.name = 'general-2'; // someone edits it by hand
    const err = await env.service
      .apply({
        planId: record.id,
        guildId: env.guildId,
        clientId: 't',
        canDestroy: false,
        continueOnError: false,
        acceptBlocked: false,
      })
      .catch((e) => e);
    expect(err.code).toBe('stale_plan');
    expect(JSON.stringify(err.details)).toContain('channel #general-2 changed');
    expect(env.store.getPlan(record.id)!.status).toBe('rejected');
  });

  test('plans run once, belong to one guild, and expire', async () => {
    env = makeEnv();
    const { record } = await planAndApply(env, SMALL);
    const args = {
      planId: record.id,
      guildId: env.guildId,
      clientId: 't',
      canDestroy: false,
      continueOnError: false,
      acceptBlocked: false,
    };
    await expect(env.service.apply(args)).rejects.toMatchObject({ code: 'conflict' });
    const fresh = await env.service.createPlan({ guildId: env.guildId, blueprint: SMALL, clientId: 't' });
    await expect(
      env.service.apply({ ...args, planId: fresh.record.id, guildId: '999999999999999999' }),
    ).rejects.toMatchObject({ code: 'invalid_argument' });
    env.store.db
      .prepare("UPDATE plans SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?")
      .run(fresh.record.id);
    await expect(env.service.apply({ ...args, planId: fresh.record.id })).rejects.toMatchObject({
      code: 'stale_plan',
    });
  });
});

describe('failures, retries and interruptions', () => {
  test('a failed step stops the run and is reported exactly; re-planning continues without duplicates', async () => {
    env = makeEnv();
    env.adapter.inject('createChannel', 'forbidden', {
      when: (args) => (args[1] as { name: string }).name === 'media',
    });
    const { result } = await planAndApply(env, SMALL);
    expect(result.status).toBe('partial');
    const failed = result.steps.find((s) => s.status === 'failed')!;
    expect(failed.summary).toContain('#media');
    expect(failed.error).toMatch(/Missing Permissions/);
    expect(failed.opIds).toHaveLength(1);
    expect(result.steps.filter((s) => s.status === 'not_started').length).toBeGreaterThan(0);
    const op = env.store.getOperation(failed.opIds[0]!)!;
    expect(op).toMatchObject({ status: 'failed', action: 'create_channel' });
    expect(op.auditReason).toContain(op.id);

    const second = await planAndApply(env, SMALL);
    expect(second.result.status).toBe('applied');
    expect(second.body.steps.filter((s) => s.action === 'create_channel').map((s) => s.summary)).toEqual([
      'create text #media in "Chat"',
      'create voice #Lounge in "Chat"',
    ]);
    const names = [...env.adapter.channels.values()].map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test('continue_on_error runs independent steps and skips dependents', async () => {
    env = makeEnv();
    env.adapter.inject('createChannel', 'forbidden', {
      when: (args) => (args[1] as { name: string }).name === 'Chat',
    });
    const { result } = await planAndApply(env, SMALL, { continueOnError: true });
    expect(result.status).toBe('partial');
    const byName = (n: string) => result.steps.find((s) => s.summary.includes(n))!;
    expect(byName('"Chat"').status).toBe('failed');
    expect(byName('#general').status).toBe('skipped');
    expect(byName('#general').error).toMatch(/depends on step/);
    expect(byName('#mod-chat').status).toBe('succeeded');
  });

  test('a create that timed out after Discord applied it is recovered from the audit log, not repeated', async () => {
    env = makeEnv();
    env.adapter.inject('createChannel', 'timeout_after', {
      when: (args) => (args[1] as { name: string }).name === 'general',
    });
    const { result } = await planAndApply(env, SMALL);
    expect(result.status).toBe('applied');
    const step = result.steps.find((s) => s.summary.includes('#general'))!;
    expect(step.status).toBe('recovered');
    expect(
      env.adapter.calls.filter(
        (c) => c.method === 'createChannel' && (c.args[1] as { name: string }).name === 'general',
      ),
    ).toHaveLength(1);
    const op = env.store.getOperation(step.opIds[0]!)!;
    expect(op.status).toBe('recovered');
    expect(JSON.parse(op.resultJson!).via).toBe('audit_log');
    expect(env.store.getMapping(env.guildId, 'channel', 'general')?.discordId).toBe(
      env.adapter.channelByName('general')!.id,
    );
  });

  test('without View Audit Log, recovery falls back to name, type, parent and creation time', async () => {
    env = makeEnv({ botPermissions: MemoryDiscordAdapter.EVERYTHING_BUT_ADMIN & ~P.ViewAuditLog });
    env.adapter.inject('createRole', 'timeout_after', {
      when: (args) => (args[1] as { name: string }).name === 'Member',
    });
    const { result } = await planAndApply(env, SMALL);
    const step = result.steps.find((s) => s.summary.includes('"Member"'))!;
    expect(step.status).toBe('recovered');
    expect(JSON.parse(env.store.getOperation(step.opIds[0]!)!.resultJson!).via).toBe('heuristic');
    expect([...env.adapter.roles.values()].filter((r) => r.name === 'Member')).toHaveLength(1);
  });

  test('a create that timed out before reaching Discord is retried once and created once', async () => {
    env = makeEnv();
    env.adapter.inject('createRole', 'timeout_before');
    const { result } = await planAndApply(env, SMALL);
    expect(result.status).toBe('applied');
    expect(
      env.store.getOperation(result.steps.find((s) => s.action === 'create_role')!.opIds[0]!)!.attempts,
    ).toBe(2);
    expect([...env.adapter.roles.values()].filter((r) => r.name === 'Moderator')).toHaveLength(1);
  });

  test('an ambiguous outcome halts as uncertain instead of guessing', async () => {
    env = makeEnv();
    env.adapter.addChannel({ name: 'media' }); // created moments ago by someone else
    env.adapter.inject('createChannel', 'timeout_after', {
      when: (args) => (args[1] as { name: string; parent_id: string | null }).name === 'media',
    });
    env.adapter.setBotPermissions(MemoryDiscordAdapter.EVERYTHING_BUT_ADMIN & ~P.ViewAuditLog);
    const looseMatch = { ...SMALL, categories: SMALL.categories.map((c) => ({ ...c })) };
    // Put #media at top level so the stray one matches on parent too.
    looseMatch.categories[1] = {
      ...looseMatch.categories[1]!,
      channels: looseMatch.categories[1]!.channels.filter((c) => c.key !== 'media'),
    };
    (looseMatch as { channels?: unknown[] }).channels = [{ key: 'media', name: 'media' }];
    const { result } = await planAndApply(env, looseMatch);
    const step = result.steps.find((s) => s.summary.includes('#media'))!;
    expect(step.status).toBe('uncertain');
    expect(step.error).toMatch(/bind the right one with map_resource/);
    expect(result.status).toBe('partial');
  });

  test('idempotent requests are retried after a 5xx', async () => {
    env = makeEnv();
    await planAndApply(env, SMALL);
    env.adapter.inject('editChannel', 'server_error_after');
    const changed = structuredClone(SMALL);
    changed.categories[1]!.channels[0]!.topic = 'Changed';
    const { result } = await planAndApply(env, changed);
    expect(result.status).toBe('applied');
    expect(env.store.getOperation(result.steps[0]!.opIds[0]!)!.attempts).toBe(2);
  });

  test('an interrupted run is reconciled after restart and re-planning creates nothing twice', async () => {
    env = makeEnv();
    env.adapter.inject('createChannel', 'hang_after', {
      when: (args) => (args[1] as { name: string }).name === 'general',
    });
    const { record } = await env.service.createPlan({
      guildId: env.guildId,
      blueprint: SMALL,
      clientId: 't',
    });
    const running = await env.service.apply({
      planId: record.id,
      guildId: env.guildId,
      clientId: 't',
      canDestroy: false,
      continueOnError: false,
      acceptBlocked: false,
      waitSeconds: 0,
    });
    expect(running.status).toBe('running');
    await new Promise((r) => setTimeout(r, 50));
    expect(env.adapter.channelByName('general')).toBeDefined(); // Discord did it; we never heard back

    // "Restart": a new process opens the same database.
    const store2 = new Store(env.dbPath);
    expect(store2.markInterrupted()).toEqual({ plans: 1, operations: 1 });
    expect(store2.getPlan(record.id)!.status).toBe('interrupted');
    env.adapter.clearFaults();
    const service2 = new BlueprintService({
      store: store2,
      adapter: env.adapter,
      logger: silentLogger,
      locks: new (await import('../src/ops/locks.js')).GuildLocks(),
      backoffMs: 0,
      config: { planTtlMinutes: 30, applyWaitSeconds: 30, membersIntent: true, allowDestructive: true },
    });
    const replan = await service2.createPlan({ guildId: env.guildId, blueprint: SMALL, clientId: 't' });
    expect(replan.notes.join()).toMatch(/interrupted create of channel "general" had succeeded/);
    expect(replan.body.steps.some((s) => s.action === 'create_channel' && s.key === 'general')).toBe(false);
    const done = await service2.apply({
      planId: replan.record.id,
      guildId: env.guildId,
      clientId: 't',
      canDestroy: false,
      continueOnError: false,
      acceptBlocked: false,
    });
    expect(done.status).toBe('applied');
    expect([...env.adapter.channels.values()].filter((c) => c.name === 'general')).toHaveLength(1);
    await expect(
      service2.apply({
        planId: record.id,
        guildId: env.guildId,
        clientId: 't',
        canDestroy: false,
        continueOnError: false,
        acceptBlocked: false,
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
    store2.close();
  });
});

describe('hierarchy and permissions are checked before mutation', () => {
  test('roles above the bot are reported as blocked, with the fix', async () => {
    env = makeEnv({ botRolePosition: 3 });
    const high = env.adapter.addRole({ name: 'Moderator', position: 10 });
    env.store.setMapping(env.guildId, 'role', 'mod', high.id, 'manual');
    const { body } = await env.service.createPlan({ guildId: env.guildId, blueprint: SMALL, clientId: 't' });
    const blocked = body.steps.find((s) => s.action === 'update_role')!;
    expect(blocked.blocked).toMatch(/at or above the bot's highest role.*move the bot's role higher/);
    expect(body.warnings.map((w) => w.code)).toContain('role_not_movable');
  });

  test('a plan with blocked steps needs accept_blocked, then applies the rest', async () => {
    env = makeEnv({ botRolePosition: 3 });
    const high = env.adapter.addRole({ name: 'Moderator', position: 10 });
    env.store.setMapping(env.guildId, 'role', 'mod', high.id, 'manual');
    const { record } = await env.service.createPlan({
      guildId: env.guildId,
      blueprint: SMALL,
      clientId: 't',
    });
    const args = {
      planId: record.id,
      guildId: env.guildId,
      clientId: 't',
      canDestroy: false,
      continueOnError: false,
      acceptBlocked: false,
    };
    await expect(env.service.apply(args)).rejects.toMatchObject({ code: 'precondition_failed' });
    const result = await env.service.apply({ ...args, acceptBlocked: true });
    expect(result.status).toBe('partial');
    expect(result.counts.blocked).toBeGreaterThan(0);
    expect(env.adapter.channelByName('general')).toBeDefined();
  });

  test('a bot without Administrator cannot grant what it lacks; dependents are blocked too', async () => {
    env = makeEnv({
      botPermissions:
        P.ManageRoles |
        P.ManageChannels |
        P.ViewChannel |
        P.SendMessages |
        P.ViewAuditLog |
        P.ReadMessageHistory |
        P.EmbedLinks,
    });
    const { body } = await env.service.createPlan({ guildId: env.guildId, blueprint: SMALL, clientId: 't' });
    expect(body.steps.find((s) => s.action === 'create_role' && s.key === 'mod')!.blocked).toMatch(
      /cannot grant permissions it does not hold: ManageMessages/,
    );
    expect(body.steps.find((s) => s.action === 'create_channel' && s.key === 'staff')!.blocked).toMatch(
      /depends on blocked step/,
    );
  });

  test('a bot without Administrator keeps access to private channels it creates', async () => {
    env = makeEnv({
      botPermissions:
        P.ManageRoles |
        P.ManageChannels |
        P.ViewChannel |
        P.SendMessages |
        P.ViewAuditLog |
        P.ReadMessageHistory |
        P.EmbedLinks,
    });
    const bp = structuredClone(SMALL);
    bp.roles[0]!.permissions = [];
    const { result } = await planAndApply(env, bp);
    expect(result.status).toBe('applied');
    const staff = env.adapter.channelByName('Staff')!;
    const botOw = staff.overwrites.find((o) => o.id === env.adapter.botRoleId)!;
    expect(botOw.allow & (P.ViewChannel | P.ManageChannels)).toBe(P.ViewChannel | P.ManageChannels);
    // and it can still edit the channel afterwards
    bp.categories[0]!.name = 'Staff Room';
    expect((await planAndApply(env, bp)).result.status).toBe('applied');
  });
});

describe('community', () => {
  test('enabling Community and converting a channel to announcement happen in the right order', async () => {
    env = makeEnv();
    const news = env.adapter.addChannel({ name: 'news' });
    const bp = {
      version: 1,
      settings: {
        community: true,
        rules_channel: 'rules',
        public_updates_channel: 'mod-updates',
        verification_level: 'low',
        explicit_content_filter: 'all_members',
      },
      channels: [
        { key: 'rules', name: 'rules' },
        { key: 'mod-updates', name: 'mod-updates' },
        { key: 'news', name: 'news', type: 'announcement', id: news.id },
        { key: 'stage', name: 'Town Hall', type: 'stage' },
      ],
    };
    const { body, result } = await planAndApply(env, bp);
    const order = body.steps.map((s) => s.action);
    expect(order.indexOf('update_settings')).toBeLessThan(order.indexOf('update_channel'));
    const convert = body.steps.find((s) => s.action === 'update_channel')!;
    expect(convert.dependsOn).toContain(body.steps.find((s) => s.action === 'update_settings')!.id);
    expect(result.status).toBe('applied');
    expect(env.adapter.channels.get(news.id)!.kind).toBe('announcement');
    expect(env.adapter.guild.features).toContain('COMMUNITY');
    expect((await env.service.verify(env.guildId, bp)).inSync).toBe(true);
  });

  test('without Community, announcement channels are reported as unsupported, not attempted', async () => {
    env = makeEnv();
    const { body } = await env.service.createPlan({
      guildId: env.guildId,
      blueprint: {
        version: 1,
        channels: [
          { key: 'ann', name: 'ann', type: 'announcement' },
          { key: 'chat', name: 'chat' },
        ],
      },
      clientId: 't',
    });
    expect(body.unsupported.map((u) => u.code)).toEqual(['needs_community']);
    expect(body.steps.map((s) => s.summary)).toEqual(['create text #chat']);
  });
});

describe('managed messages', () => {
  test('edits in place when content changes, re-posts if deleted by hand', async () => {
    env = makeEnv();
    await planAndApply(env, SMALL);
    const before = env.store.getManagedMessage(env.guildId, 'hello')!;
    const changed = structuredClone(SMALL);
    changed.messages[0]!.content = 'Welcome, everyone!';
    const edit = await planAndApply(env, changed);
    expect(edit.body.steps.map((s) => s.action)).toEqual(['edit_message']);
    expect(env.adapter.messages.get(before.messageId)!.content).toBe('Welcome, everyone!');
    env.adapter.messages.delete(before.messageId);
    const repost = await planAndApply(env, changed);
    expect(repost.body.warnings.map((w) => w.code)).toContain('message_missing');
    expect(env.store.getManagedMessage(env.guildId, 'hello')!.messageId).not.toBe(before.messageId);
    // Blueprint posts never ping anyone.
    for (const m of env.adapter.messages.values()) expect(m.body.allowed_mentions.parse).toEqual([]);
  });

  test('exported blueprints re-plan to nothing on the same server', async () => {
    env = makeEnv();
    await planAndApply(env, COMMUNITY);
    const exported = await env.service.export({
      guildId: env.guildId,
      format: 'yaml',
      includeIds: false,
      recordMappings: true,
    });
    const parsed = YAML.parse(exported.text);
    expect(parsed.roles.map((r: { key: string }) => r.key)).toContain('moderator');
    const { body } = await env.service.createPlan({
      guildId: env.guildId,
      blueprint: exported.text,
      clientId: 't',
    });
    expect(body.steps).toEqual([]);
  });

  test('an export applies cleanly to an empty server as a template', async () => {
    env = makeEnv();
    await planAndApply(env, SMALL);
    const exported = await env.service.export({
      guildId: env.guildId,
      format: 'json',
      includeIds: false,
      recordMappings: false,
    });
    const other = makeEnv();
    try {
      const { result } = await planAndApply(other, exported.text);
      expect(result.status).toBe('applied');
      expect(other.adapter.channelByName('mod-chat')).toBeDefined();
    } finally {
      other.cleanup();
    }
  });
});
