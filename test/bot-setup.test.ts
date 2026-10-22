import { afterEach, expect, test } from 'vitest';
import { P } from '../src/discord/permissions.js';
import { makeEnv } from './helpers/env.js';
import { makeSnowflake } from './helpers/memory-adapter.js';
import type { Running } from './helpers/server.js';
import { READ_TOKEN, call, connect, credential, startServer } from './helpers/server.js';

let running: Running | undefined;
afterEach(async () => {
  await running?.close();
  running = undefined;
});

interface Report {
  installed: boolean;
  requirements_met: boolean;
  missing_guild_permissions: string[];
  channels: Array<{ status: string; requirements_met: boolean; missing_permissions?: string[] }>;
  assignable_roles: Array<{ assignable: boolean; blockers: string[] }>;
  warnings: string[];
}

async function setup() {
  running = await startServer({ readOnly: true });
  const client = await connect(running.url, READ_TOKEN);
  return { client, d: running.env.adapter, guild_id: running.env.guildId };
}

test('a read-only credential checks another bot without Discord mutations', async () => {
  const { client, d, guild_id } = await setup();
  const botId = makeSnowflake();
  const botRole = d.addRole({
    name: 'Other Bot',
    position: 5,
    permissions: P.ManageRoles | P.EmbedLinks,
    managed: true,
    tags: { botId },
  });
  d.addMember({ userId: botId, isBot: true, roleIds: [botRole.id] });
  const reward = d.addRole({ name: 'Level 10', position: 2 });
  const log = d.addChannel({ name: 'bot-log' });
  d.calls = [];
  const r = await call<Report>(client, 'check_bot_setup', {
    guild_id,
    bot_user_id: botId,
    required_guild_permissions: ['MANAGE_ROLES'],
    channels: [{ channel_id: log.id, permissions: ['ViewChannel', 'SendMessages', 'EmbedLinks'] }],
    assignable_role_ids: [reward.id],
  });
  expect(r.isError).toBe(false);
  expect(r.data).toMatchObject({ installed: true, requirements_met: true });
  expect(d.calls.every((c) => c.method.startsWith('fetch'))).toBe(true);
  const tools = await client.listTools();
  expect(tools.tools.find((t) => t.name === 'check_bot_setup')?.annotations?.readOnlyHint).toBe(true);
  await client.close();
});

test('member overwrites and implicit message permissions are included', async () => {
  const { client, d, guild_id } = await setup();
  const bot = d.addMember({ isBot: true });
  const room = d.addChannel({
    name: 'locked',
    overwrites: [{ id: bot.userId, type: 'member', allow: P.EmbedLinks, deny: P.SendMessages }],
  });
  const r = await call<Report>(client, 'check_bot_setup', {
    guild_id,
    bot_user_id: bot.userId,
    required_guild_permissions: ['ManageGuild'],
    channels: [{ channel_id: room.id, permissions: ['ViewChannel', 'SendMessages', 'EmbedLinks'] }],
  });
  expect(r.data.requirements_met).toBe(false);
  expect(r.data.missing_guild_permissions).toEqual(['ManageGuild']);
  expect(r.data.channels[0]!.missing_permissions).toEqual(['SendMessages', 'EmbedLinks']);
  await client.close();
});

test('Administrator bypasses overwrites but not tied role order or managed roles', async () => {
  const { client, d, guild_id } = await setup();
  const tiedAbove = d.addRole({ name: 'Above on tie', position: 4 });
  const botRole = d.addRole({ name: 'Bot', position: 4, permissions: P.Administrator });
  const tiedBelow = d.addRole({ name: 'Below on tie', position: 4 });
  const managed = d.addRole({ name: 'Integration', position: 1, managed: true });
  const bot = d.addMember({ isBot: true, roleIds: [botRole.id] });
  const room = d.addChannel({
    name: 'private',
    overwrites: [{ id: bot.userId, type: 'member', allow: 0n, deny: P.ViewChannel }],
  });
  const r = await call<Report>(client, 'check_bot_setup', {
    guild_id,
    bot_user_id: bot.userId,
    channels: [{ channel_id: room.id }],
    assignable_role_ids: [tiedAbove.id, tiedBelow.id, managed.id, guild_id],
  });
  expect(r.data.channels[0]!.requirements_met).toBe(true);
  expect(r.data.assignable_roles.map((r) => r.assignable)).toEqual([false, true, false, false]);
  expect(r.data.warnings.join()).toContain('Administrator');
  await client.close();
});

test('assignment needs Manage Roles, but the assigned role may hold permissions the bot lacks', async () => {
  const { client, d, guild_id } = await setup();
  const top = d.addRole({ name: 'Bot', position: 10 });
  const powerful = d.addRole({ name: 'Moderator', position: 2, permissions: P.BanMembers });
  const bot = d.addMember({ isBot: true, roleIds: [top.id] });
  const r = await call<Report>(client, 'check_bot_setup', {
    guild_id,
    bot_user_id: bot.userId,
    assignable_role_ids: [powerful.id, makeSnowflake()],
  });
  expect(r.data.requirements_met).toBe(false);
  expect(r.data.assignable_roles[0]!.blockers).toEqual(['the bot lacks Manage Roles']);
  expect(r.data.assignable_roles[1]!.blockers.join()).toContain('not found');
  d.roles.get(top.id)!.permissions = P.ManageRoles;
  const fixed = await call<Report>(client, 'check_bot_setup', {
    guild_id,
    bot_user_id: bot.userId,
    assignable_role_ids: [powerful.id],
  });
  expect(fixed.data.requirements_met).toBe(true);
  await client.close();
});

test('an uninstalled bot is reported, and a human ID is rejected', async () => {
  const { client, d, guild_id } = await setup();
  const absent = await call<Report>(client, 'check_bot_setup', {
    guild_id,
    bot_user_id: makeSnowflake(),
  });
  expect(absent.data).toMatchObject({ installed: false, requirements_met: false });
  const human = d.addMember();
  const r = await call(client, 'check_bot_setup', { guild_id, bot_user_id: human.userId });
  expect(r.isError).toBe(true);
  const invalidPermission = await call(client, 'check_bot_setup', {
    guild_id,
    bot_user_id: makeSnowflake(),
    required_guild_permissions: ['MadeUpPermission'],
  });
  expect(invalidPermission.isError).toBe(true);
  await client.close();
});

test('steward hidden and missing channels stay unverified, even for an Administrator target', async () => {
  const { client, d, guild_id } = await setup();
  const admin = d.addRole({ name: 'Other bot', permissions: P.Administrator, position: 2 });
  const bot = d.addMember({ isBot: true, roleIds: [admin.id] });
  d.setBotPermissions(P.ViewChannel);
  const hidden = d.addChannel({
    name: 'hidden from steward',
    overwrites: [{ id: guild_id, type: 'role', allow: 0n, deny: P.ViewChannel }],
  });
  const r = await call<Report>(client, 'check_bot_setup', {
    guild_id,
    bot_user_id: bot.userId,
    channels: [{ channel_id: hidden.id }, { channel_id: makeSnowflake() }],
  });
  expect(r.data.requirements_met).toBe(false);
  expect(r.data.channels.map((c) => c.status)).toEqual(['unverified', 'unverified']);
  await client.close();
});

test('voice requires Connect for Speak, and threads are never certified from overwrites alone', async () => {
  const { client, d, guild_id } = await setup();
  const bot = d.addMember({ isBot: true });
  const voice = d.addChannel({
    name: 'voice',
    type: 2,
    overwrites: [{ id: bot.userId, type: 'member', allow: P.Speak, deny: P.Connect }],
  });
  const thread = d.addChannel({ name: 'private thread', type: 12, kind: 'other' });
  const r = await call<Report>(client, 'check_bot_setup', {
    guild_id,
    bot_user_id: bot.userId,
    channels: [{ channel_id: voice.id, permissions: ['Speak'] }, { channel_id: thread.id }],
  });
  expect(r.data.requirements_met).toBe(false);
  expect(r.data.channels[0]!.missing_permissions).toEqual(['Speak']);
  expect(r.data.channels[1]!.status).toBe('unverified');
  await client.close();
});

test('foreign guilds are refused before reads and foreign channels never leak their data', async () => {
  const env = makeEnv();
  running = await startServer({ credentials: [credential('restricted', READ_TOKEN, ['read'], [])] }, env);
  let client = await connect(running.url, READ_TOKEN);
  env.adapter.calls = [];
  const denied = await call(client, 'check_bot_setup', {
    guild_id: env.guildId,
    bot_user_id: env.adapter.botUserId,
  });
  expect(denied.isError).toBe(true);
  expect(env.adapter.calls).toHaveLength(0);
  await client.close();
  await running.close();
  running = undefined;

  const setupResult = await setup();
  client = setupResult.client;
  const { d, guild_id } = setupResult;
  const foreign = d.addChannel({ name: 'secret foreign channel' });
  d.fetchChannel = async () => ({ status: 'visible', channel: foreign, guildId: makeSnowflake() });
  const fetchSnapshot = d.fetchSnapshot.bind(d);
  d.fetchSnapshot = async (id) => ({ ...(await fetchSnapshot(id)), channels: [] });
  const result = await call(client, 'check_bot_setup', {
    guild_id,
    bot_user_id: d.botUserId,
    channels: [{ channel_id: foreign.id }],
  });
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result.data)).not.toContain(foreign.name);
  await client.close();
});
