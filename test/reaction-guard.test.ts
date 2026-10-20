import { EventEmitter } from 'node:events';
import type { Client } from 'discord.js';
import { GatewayIntentBits } from 'discord.js';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { ReactionAddEvent } from '../src/discord/adapter.js';
import { DiscordJsAdapter, parseReactionAdd } from '../src/discord/discordjs-adapter.js';
import { P } from '../src/discord/permissions.js';
import type { MessageBody } from '../src/discord/types.js';
import { DiscordRequestError } from '../src/util/errors.js';
import { buildMessageBody } from '../src/features/messages.js';
import { decideReaction, ReactionGuard, reactionEmojiSegment } from '../src/features/reaction-guard.js';
import { handlePanelButton, panelCustomId } from '../src/features/role-panels.js';
import { silentLogger } from '../src/logger.js';
import type { TestEnv } from './helpers/env.js';
import { makeEnv } from './helpers/env.js';
import type { Running } from './helpers/server.js';
import { FULL_TOKEN, call, connect, startServer } from './helpers/server.js';

let env: TestEnv | undefined;
let running: Running | undefined;
afterEach(async () => {
  await running?.close();
  running = undefined;
  env?.cleanup();
  env = undefined;
});

const THUMBS = { id: null, name: '👍' };
const THUMBS_SEGMENT = '%F0%9F%91%8D';

// ---- policy ------------------------------------------------------------------

describe('which reactions go', () => {
  const event: ReactionAddEvent = {
    guildId: '100000000000000001',
    channelId: '100000000000000002',
    messageId: '100000000000000003',
    userId: '100000000000000004',
    messageAuthorId: '100000000000000009',
    member: { roleIds: [], isBot: false },
    emoji: THUMBS,
    burst: false,
    guildOwnerId: '100000000000000005',
    botUserId: '100000000000000009',
  };
  const facts = {
    active: true,
    allowedGuildIds: [event.guildId],
    authorId: event.botUserId,
    member: { roleIds: [] as string[], isBot: false },
    exemptRoleIds: new Set(['100000000000000006']),
  };

  test("an ordinary member's reaction on steward's own message is removed", () => {
    expect(decideReaction(event, facts)).toEqual({ remove: true, emoji: THUMBS_SEGMENT });
  });

  test.each([
    ['inactive', { ...facts, active: false }, event],
    ['other_guild', { ...facts, allowedGuildIds: ['100000000000000099'] }, event],
    ['bot_unknown', facts, { ...event, botUserId: null }],
    ['own_reaction', facts, { ...event, userId: event.botUserId! }],
    ['author_unknown', { ...facts, authorId: null }, event],
    ['not_steward_message', { ...facts, authorId: '100000000000000077' }, event],
    ['owner_unknown', facts, { ...event, guildOwnerId: null }],
    ['guild_owner', facts, { ...event, userId: event.guildOwnerId! }],
    ['member_unknown', { ...facts, member: null }, event],
    ['bot', { ...facts, member: { roleIds: [], isBot: true } }, event],
    ['exempt_role', { ...facts, member: { roleIds: ['100000000000000006'], isBot: false } }, event],
    ['emoji_unknown', facts, { ...event, emoji: { id: '100000000000000008', name: null } }],
  ] as const)('keeps it: %s', (reason, f, e) => {
    expect(decideReaction(e, f)).toEqual({ remove: false, reason });
  });
});

describe('emoji route segments', () => {
  test.each([
    ['plain unicode', { id: null, name: '👍' }, '%F0%9F%91%8D'],
    ['keycap, whose # would end the path', { id: null, name: '#️⃣' }, '%23%EF%B8%8F%E2%83%A3'],
    ['skin tone', { id: null, name: '👍🏽' }, '%F0%9F%91%8D%F0%9F%8F%BD'],
    ['ZWJ sequence', { id: null, name: '👩‍💻' }, '%F0%9F%91%A9%E2%80%8D%F0%9F%92%BB'],
    [
      'custom emoji as name:id',
      { id: '123456789012345678', name: 'party_blob' },
      'party_blob%3A123456789012345678',
    ],
  ])('%s', (_label, emoji, segment) => {
    expect(reactionEmojiSegment(emoji)).toBe(segment);
  });

  test('a custom emoji without a name is left alone rather than guessed', () => {
    expect(reactionEmojiSegment({ id: '123456789012345678', name: null })).toBeNull();
  });
});

describe('raw gateway packets', () => {
  const d = {
    guild_id: '100000000000000001',
    channel_id: '100000000000000002',
    message_id: '100000000000000003',
    user_id: '100000000000000004',
    message_author_id: '100000000000000009',
    member: { roles: ['100000000000000006'], user: { id: '100000000000000004', bot: false } },
    emoji: { id: null, name: '👍' },
    burst: false,
    type: 0,
  };

  test('a reaction add is read field by field', () => {
    expect(parseReactionAdd({ op: 0, t: 'MESSAGE_REACTION_ADD', s: 7, d })).toEqual({
      guildId: d.guild_id,
      channelId: d.channel_id,
      messageId: d.message_id,
      userId: d.user_id,
      messageAuthorId: d.message_author_id,
      member: { roleIds: ['100000000000000006'], isBot: false },
      emoji: { id: null, name: '👍' },
      burst: false,
    });
  });

  test('optional fields Discord leaves out come back as unknown, not as defaults', () => {
    const { message_author_id: _a, ...noAuthor } = d;
    const parsed = parseReactionAdd({
      op: 0,
      t: 'MESSAGE_REACTION_ADD',
      d: { ...noAuthor, member: { roles: [] } },
    });
    expect(parsed?.messageAuthorId).toBeNull();
    expect(parsed?.member).toEqual({ roleIds: [], isBot: null });
    const noMember = parseReactionAdd({ op: 0, t: 'MESSAGE_REACTION_ADD', d: { ...d, member: undefined } });
    expect(noMember?.member).toBeNull();
  });

  test.each([
    ['another event', { op: 0, t: 'MESSAGE_REACTION_REMOVE', d }],
    ['not a dispatch', { op: 11 }],
    ['a DM reaction', { op: 0, t: 'MESSAGE_REACTION_ADD', d: { ...d, guild_id: undefined } }],
    ['no emoji', { op: 0, t: 'MESSAGE_REACTION_ADD', d: { ...d, emoji: undefined } }],
    ['garbage', 'not a packet'],
  ])('ignores %s', (_label, packet) => {
    expect(parseReactionAdd(packet)).toBeNull();
  });
});

// ---- the guard against the in-memory Discord ---------------------------------

function guarded(options: { active?: boolean } = {}) {
  env = makeEnv();
  const guard = new ReactionGuard({
    store: env.store,
    adapter: env.adapter,
    logger: silentLogger,
    allowedGuildIds: [env.guildId],
    active: options.active ?? true,
    backoffMs: 0,
  });
  void env.adapter.start({ reactionAdd: (e) => guard.handle(e) });
  const channel = env.adapter.addChannel({ name: 'rules' });
  return { e: env, guard, channel };
}

async function stewardMessage(e: TestEnv, channelId: string) {
  return e.adapter.sendMessage(channelId, buildMessageBody({ content: 'Read the rules.' }));
}

function humanMessage(e: TestEnv, channelId: string, authorId: string) {
  const id = (BigInt(e.adapter.botRoleId) + 5000n).toString();
  e.adapter.messages.set(id, {
    id,
    channelId,
    authorId,
    content: 'hello',
    embeds: [],
    componentCount: 0,
    createdAt: new Date().toISOString(),
    editedAt: null,
    body: { content: 'hello', allowed_mentions: { parse: [] } } as MessageBody,
  });
  return id;
}

const removals = (e: TestEnv) => e.adapter.calls.filter((c) => c.method === 'removeUserReaction');

describe('the reaction guard', () => {
  test("removes an ordinary member's reaction from steward's message and journals it", async () => {
    const { e, guard, channel } = guarded();
    const msg = await stewardMessage(e, channel.id);
    const member = e.adapter.addMember();
    await e.adapter.emitReactionAdd(msg.id, member.userId, THUMBS);
    expect(removals(e).map((c) => c.args)).toEqual([[channel.id, msg.id, THUMBS_SEGMENT, member.userId]]);
    expect(e.adapter.reactions.get(msg.id)!.size).toBe(0);
    expect(guard.stats.removed).toBe(1);
    const ops = e.store.listOperations({ guildId: e.guildId, tool: 'reaction_guard', limit: 10, offset: 0 });
    expect(ops.items.map((o) => [o.action, o.status, o.targetId])).toEqual([
      ['remove_reaction', 'succeeded', msg.id],
    ]);
  });

  test('keeps reactions on human messages, from bots, the owner and staff roles', async () => {
    const { e, channel } = guarded();
    const msg = await stewardMessage(e, channel.id);
    const human = e.adapter.addMember();
    await e.adapter.emitReactionAdd(
      humanMessage(e, channel.id, human.userId),
      e.adapter.addMember().userId,
      THUMBS,
    );

    const otherBot = e.adapter.addMember({ isBot: true });
    await e.adapter.emitReactionAdd(msg.id, otherBot.userId, THUMBS);

    await e.adapter.emitReactionAdd(msg.id, e.adapter.ownerId, THUMBS);

    for (const key of ['owner', 'admin', 'moderator', 'bot']) {
      const role = e.adapter.addRole({ name: key, position: 2 });
      e.store.setMapping(e.guildId, 'role', key, role.id, 'manual');
      const staff = e.adapter.addMember({ roleIds: [role.id] });
      await e.adapter.emitReactionAdd(msg.id, staff.userId, THUMBS);
    }
    // A role under some other key is not an exemption.
    const fan = e.adapter.addRole({ name: 'fan', position: 2 });
    e.store.setMapping(e.guildId, 'role', 'fan', fan.id, 'manual');
    const member = e.adapter.addMember({ roleIds: [fan.id] });
    await e.adapter.emitReactionAdd(msg.id, member.userId, THUMBS);

    expect(removals(e).map((c) => c.args[3])).toEqual([member.userId]);
  });

  test('looks up an author or member the event left out, once per message', async () => {
    const { e } = guarded();
    const channel = e.adapter.channelByName('rules')!;
    const msg = await stewardMessage(e, channel.id);
    const a = e.adapter.addMember();
    const b = e.adapter.addMember();
    await e.adapter.emitReactionAdd(msg.id, a.userId, THUMBS, { messageAuthorId: null, member: null });
    await e.adapter.emitReactionAdd(msg.id, b.userId, THUMBS, { messageAuthorId: null });
    expect(e.adapter.calls.filter((c) => c.method === 'fetchMessage')).toHaveLength(1);
    expect(e.adapter.calls.filter((c) => c.method === 'fetchMember')).toHaveLength(1);
    expect(removals(e).map((c) => c.args[3])).toEqual([a.userId, b.userId]);
  });

  test('a message whose author cannot be read keeps its reactions', async () => {
    const { e, guard, channel } = guarded();
    const msg = await stewardMessage(e, channel.id);
    e.adapter.inject('fetchMessage', 'forbidden');
    await e.adapter.emitReactionAdd(msg.id, e.adapter.addMember().userId, THUMBS, { messageAuthorId: null });
    expect(guard.stats.kept).toBe(1);
    expect(removals(e)).toEqual([]);
  });

  test('inactive (read-only) never removes anything', async () => {
    const { e, guard, channel } = guarded({ active: false });
    const msg = await stewardMessage(e, channel.id);
    await e.adapter.emitReactionAdd(msg.id, e.adapter.addMember().userId, THUMBS);
    expect(removals(e)).toEqual([]);
    expect(guard.stats.kept).toBe(1);
  });

  test('an active guard leaves guilds outside DISCORD_GUILD_IDS alone', async () => {
    const { e, guard, channel } = guarded();
    const msg = await stewardMessage(e, channel.id);
    await guard.handle({
      guildId: '100000000000000077',
      channelId: channel.id,
      messageId: msg.id,
      userId: e.adapter.addMember().userId,
      messageAuthorId: e.adapter.botUserId,
      member: { roleIds: [], isBot: false },
      emoji: THUMBS,
      burst: false,
      guildOwnerId: null,
      botUserId: e.adapter.botUserId,
    });
    expect(removals(e)).toEqual([]);
    expect(guard.stats.kept).toBe(1);
  });

  test('a two-factor refusal pauses the whole server, not just one channel', async () => {
    const { e, guard, channel } = guarded();
    const other = e.adapter.addChannel({ name: 'news' });
    const first = await stewardMessage(e, channel.id);
    const second = await stewardMessage(e, other.id);
    const remove = vi
      .spyOn(e.adapter, 'removeUserReaction')
      .mockRejectedValue(
        new DiscordRequestError('http', 'Discord rejected the request: Two factor is required', 403, 60003),
      );
    await e.adapter.emitReactionAdd(first.id, e.adapter.addMember().userId, THUMBS);
    await e.adapter.emitReactionAdd(second.id, e.adapter.addMember().userId, THUMBS);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(guard.report(null)).toMatchObject({ failed: 1, paused_guilds: [e.guildId], paused_channels: [] });
  });

  test('a passing failure to read the author is tried again on the next reaction', async () => {
    const { e, guard, channel } = guarded();
    const msg = await stewardMessage(e, channel.id);
    e.adapter.inject('fetchMessage', 'timeout_before');
    await e.adapter.emitReactionAdd(msg.id, e.adapter.addMember().userId, THUMBS, { messageAuthorId: null });
    const member = e.adapter.addMember();
    await e.adapter.emitReactionAdd(msg.id, member.userId, THUMBS, { messageAuthorId: null });
    expect(e.adapter.calls.filter((c) => c.method === 'fetchMessage')).toHaveLength(2);
    expect(removals(e).map((c) => c.args[3])).toEqual([member.userId]);
    expect(guard.stats).toMatchObject({ kept: 1, removed: 1 });
  });

  test('status figures are limited to the guilds a credential may see', async () => {
    const { e, guard, channel } = guarded();
    const msg = await stewardMessage(e, channel.id);
    e.adapter.setBotPermissions(P.ViewChannel | P.SendMessages | P.ReadMessageHistory);
    await e.adapter.emitReactionAdd(msg.id, e.adapter.addMember().userId, THUMBS);
    expect(guard.report([e.guildId])).toMatchObject({ failed: 1, paused_channels: [channel.id] });
    expect(guard.report(['100000000000000077'])).toMatchObject({
      removed: 0,
      kept: 0,
      failed: 0,
      last_error: null,
      paused_channels: [],
      paused_guilds: [],
    });
  });

  test('a channel where Discord refuses removals is left alone for a while', async () => {
    const { e, guard, channel } = guarded();
    const msg = await stewardMessage(e, channel.id);
    // Take Manage Messages away from the bot.
    e.adapter.setBotPermissions(P.ViewChannel | P.SendMessages | P.ManageRoles | P.ReadMessageHistory);
    await e.adapter.emitReactionAdd(msg.id, e.adapter.addMember().userId, THUMBS);
    await e.adapter.emitReactionAdd(msg.id, e.adapter.addMember().userId, THUMBS);
    expect(removals(e)).toHaveLength(1);
    expect(guard.stats.failed).toBe(1);
    expect(guard.pausedChannels()).toEqual([channel.id]);
    expect(guard.stats.last_error).toMatch(/Manage Messages/);
  });

  test('role buttons on a panel keep working, and reactions on the panel message go', async () => {
    const { e, guard } = guarded();
    const bp = {
      version: 1,
      roles: [{ key: 'gamer', name: 'Gamer' }],
      channels: [{ key: 'roles', name: 'roles' }],
      self_roles: {
        roles: ['gamer'],
        panels: [
          { key: 'games', channel: 'roles', title: 'Games', options: [{ role: 'gamer', label: 'Gamer' }] },
        ],
      },
    };
    const { record } = await e.service.createPlan({ guildId: e.guildId, blueprint: bp, clientId: 't' });
    await e.service.apply({
      planId: record.id,
      guildId: e.guildId,
      clientId: 't',
      canDestroy: false,
      continueOnError: false,
      acceptBlocked: false,
    });
    const deps = { store: e.store, adapter: e.adapter, logger: silentLogger };
    void e.adapter.start({
      buttonPress: (ev) => handlePanelButton(deps, ev),
      reactionAdd: (ev) => guard.handle(ev),
    });
    const panel = e.store.getPanelByKey(e.guildId, 'games')!;
    const gamer = e.adapter.roleByName('Gamer')!;
    const m = e.adapter.addMember();
    await e.adapter.emitReactionAdd(panel.messageId!, m.userId, THUMBS);
    expect(removals(e).map((c) => c.args[1])).toEqual([panel.messageId]);
    expect(await e.adapter.pressButton(m.userId, panelCustomId(panel.id, gamer.id))).toBe('Added **Gamer**.');
  });
});

// ---- gateway to REST through the real adapter ---------------------------------

const BOT = '200000000000000001';
const GUILD = '200000000000000002';
const OWNER = '200000000000000003';
const CHANNEL = '200000000000000004';
const MESSAGE = '200000000000000005';
const MEMBER = '200000000000000006';

/** Stands in for the discord.js client: same events, a REST object that records routes. */
class FakeClient extends EventEmitter {
  user = { id: BOT, tag: 'steward#0001' };
  application = { id: BOT };
  guilds = { cache: new Map([[GUILD, { id: GUILD, ownerId: OWNER }]]) };
  routes: string[] = [];
  rest = {
    delete: async (route: string) => {
      this.routes.push(`DELETE ${route}`);
    },
    get: async (route: string) => {
      this.routes.push(`GET ${route}`);
      if (route === `/channels/${CHANNEL}/messages/${MESSAGE}`) {
        return {
          id: MESSAGE,
          channel_id: CHANNEL,
          author: { id: BOT, username: 'steward' },
          content: '',
          embeds: [],
          components: [],
          timestamp: new Date().toISOString(),
          edited_timestamp: null,
        };
      }
      throw new Error(`unexpected GET ${route}`);
    },
  };
  constructor(readonly options: { intents: number[] }) {
    super();
  }
  async login() {
    if (!fakeHoldReady) this.emit('clientReady', this);
    return 'ok';
  }
  async destroy() {}
}

let fakeHoldReady = false;

async function realAdapter(reactionIntent: boolean) {
  env = makeEnv();
  let client: FakeClient | undefined;
  const adapter = new DiscordJsAdapter({
    token: 'not-a-real-token',
    membersIntent: false,
    reactionIntent,
    requestTimeoutMs: 1000,
    allowedGuildIds: [GUILD],
    logger: silentLogger,
    clientFactory: (options) => (client = new FakeClient(options as never)) as unknown as Client,
  });
  const guard = new ReactionGuard({
    store: env.store,
    adapter,
    logger: silentLogger,
    allowedGuildIds: [GUILD],
    active: true,
    backoffMs: 0,
  });
  await adapter.start({ reactionAdd: (e) => guard.handle(e) });
  if (fakeHoldReady) await vi.waitFor(() => expect(client).toBeDefined());
  else await vi.waitFor(() => expect(adapter.status().state).toBe('ready'));
  return { adapter, guard, client: client! };
}

const packet = (d: Record<string, unknown> = {}) => ({
  op: 0,
  t: 'MESSAGE_REACTION_ADD',
  s: 42,
  d: {
    guild_id: GUILD,
    channel_id: CHANNEL,
    message_id: MESSAGE,
    user_id: MEMBER,
    message_author_id: BOT,
    member: { roles: [], user: { id: MEMBER, bot: false } },
    emoji: { id: null, name: '#️⃣' },
    burst: false,
    type: 0,
    ...d,
  },
});

describe('gateway to REST', () => {
  test('asks for the reaction intent only, with no privileged intents', async () => {
    const on = await realAdapter(true);
    expect(on.client.options.intents).toEqual([
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessageReactions,
    ]);
    for (const privileged of [
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildPresences,
    ])
      expect(on.client.options.intents).not.toContain(privileged);
    env!.cleanup();
    env = undefined;
    const off = await realAdapter(false);
    expect(off.client.options.intents).toEqual([GatewayIntentBits.Guilds]);
  });

  test('a raw reaction on an uncached steward message becomes one encoded DELETE', async () => {
    const { client, guard } = await realAdapter(true);
    client.emit('raw', packet(), 0);
    await vi.waitFor(() => expect(guard.stats.removed).toBe(1));
    expect(client.routes).toEqual([
      `DELETE /channels/${CHANNEL}/messages/${MESSAGE}/reactions/%23%EF%B8%8F%E2%83%A3/${MEMBER}`,
    ]);
  });

  test('without message_author_id, the author is read over REST first', async () => {
    const { client, guard } = await realAdapter(true);
    client.emit('raw', packet({ message_author_id: undefined }), 0);
    await vi.waitFor(() => expect(guard.stats.removed).toBe(1));
    expect(client.routes).toEqual([
      `GET /channels/${CHANNEL}/messages/${MESSAGE}`,
      `DELETE /channels/${CHANNEL}/messages/${MESSAGE}/reactions/%23%EF%B8%8F%E2%83%A3/${MEMBER}`,
    ]);
  });

  test('other guilds, human messages and the owner cause no request', async () => {
    const { client, guard } = await realAdapter(true);
    client.emit('raw', packet({ guild_id: '200000000000000099' }), 0);
    client.emit('raw', packet({ message_author_id: MEMBER }), 0);
    client.emit('raw', packet({ user_id: OWNER, member: { roles: [], user: { id: OWNER } } }), 0);
    await vi.waitFor(() => expect(guard.stats.kept).toBe(2));
    expect(client.routes).toEqual([]);
  });

  test('a server missing from the session cache keeps its reactions, since its owner is unknown', async () => {
    const { client, guard } = await realAdapter(true);
    client.guilds.cache.delete(GUILD);
    client.emit('raw', packet(), 0);
    await vi.waitFor(() => expect(guard.stats.kept).toBe(1));
    expect(client.routes).toEqual([]);
  });

  test('reactions before the session is ready are kept, with no request or journal row', async () => {
    fakeHoldReady = true;
    try {
      const { client, guard } = await realAdapter(true);
      client.emit('raw', packet(), 0);
      await vi.waitFor(() => expect(guard.stats.kept).toBe(1));
      expect(client.routes).toEqual([]);
      expect(env!.store.listOperations({ tool: 'reaction_guard', limit: 10, offset: 0 }).total).toBe(0);
    } finally {
      fakeHoldReady = false;
    }
  });

  test('without the intent, raw reactions are not listened to', async () => {
    const { client, guard } = await realAdapter(false);
    client.emit('raw', packet(), 0);
    await new Promise((r) => setTimeout(r, 20));
    expect(guard.stats).toMatchObject({ removed: 0, kept: 0 });
    expect(client.routes).toEqual([]);
  });
});

// ---- status -------------------------------------------------------------------

describe('steward_status', () => {
  type Status = {
    discord: { gateway_intents: string[] };
    modes: { reaction_guard: boolean };
    reaction_guard: { configured: boolean; active: boolean; why_inactive: string | null; removed?: number };
  };

  async function status(overrides: { reactionGuard: boolean; readOnly: boolean }) {
    running = await startServer(overrides);
    if (overrides.reactionGuard) {
      running.app.reactionGuard = new ReactionGuard({
        store: running.env.store,
        adapter: running.env.adapter,
        logger: silentLogger,
        allowedGuildIds: [running.env.guildId],
        active: !overrides.readOnly,
      });
    }
    const client = await connect(running.url, FULL_TOKEN);
    const r = await call<Status>(client, 'steward_status', {});
    await running.close();
    running = undefined;
    return r.data;
  }

  test('reports whether the guard is configured and actually active', async () => {
    const off = await status({ reactionGuard: false, readOnly: false });
    expect(off.reaction_guard).toMatchObject({
      configured: false,
      active: false,
      why_inactive: 'DISCORD_BOT_REACTION_GUARD is not set',
    });
    expect(off.discord.gateway_intents).not.toContain('GuildMessageReactions');

    const readOnly = await status({ reactionGuard: true, readOnly: true });
    expect(readOnly.reaction_guard).toMatchObject({
      configured: true,
      active: false,
      why_inactive: 'READ_ONLY is on',
    });
    expect(readOnly.modes.reaction_guard).toBe(false);

    const on = await status({ reactionGuard: true, readOnly: false });
    expect(on.reaction_guard).toMatchObject({
      configured: true,
      active: true,
      why_inactive: null,
      removed: 0,
    });
    expect(on.discord.gateway_intents).toContain('GuildMessageReactions');
  });
});
