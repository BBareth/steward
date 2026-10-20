import { afterEach, describe, expect, test } from 'vitest';
import { P } from '../src/discord/permissions.js';
import { handlePanelButton, panelCustomId } from '../src/features/role-panels.js';
import { handleMemberJoin } from '../src/features/welcome.js';
import { silentLogger } from '../src/logger.js';
import type { TestEnv } from './helpers/env.js';
import { makeEnv } from './helpers/env.js';

let env: TestEnv;
afterEach(() => env?.cleanup());

const BP = {
  version: 1,
  roles: [
    { key: 'mod', name: 'Moderator', permissions: ['KickMembers'], staff: true },
    { key: 'red', name: 'Red' },
    { key: 'blue', name: 'Blue' },
    { key: 'gamer', name: 'Gamer' },
    { key: 'member', name: 'Member' },
  ],
  channels: [
    { key: 'roles', name: 'roles' },
    { key: 'general', name: 'general' },
  ],
  welcome: {
    enabled: true,
    channel: 'general',
    message: { content: 'Hi {user}, welcome to {server}! You are #{member_count}. @everyone' },
    join_roles: ['member'],
  },
  self_roles: {
    roles: ['red', 'blue', 'gamer'],
    panels: [
      {
        key: 'colours',
        channel: 'roles',
        title: 'Colour',
        mode: 'single',
        options: [
          { role: 'red', label: 'Red' },
          { role: 'blue', label: 'Blue' },
        ],
      },
      { key: 'games', channel: 'roles', title: 'Games', options: [{ role: 'gamer', label: 'Gamer' }] },
    ],
  },
};

async function setup() {
  env = makeEnv();
  const { record } = await env.service.createPlan({ guildId: env.guildId, blueprint: BP, clientId: 't' });
  const res = await env.service.apply({
    planId: record.id,
    guildId: env.guildId,
    clientId: 't',
    canDestroy: false,
    continueOnError: false,
    acceptBlocked: false,
  });
  expect(res.status).toBe('applied');
  const deps = { store: env.store, adapter: env.adapter, logger: silentLogger };
  const panel = (key: string) => env.store.getPanelByKey(env.guildId, key)!;
  const role = (name: string) => env.adapter.roleByName(name)!;
  env.adapter.start({
    buttonPress: (e) => handlePanelButton(deps, e),
    memberJoin: (e) => handleMemberJoin(deps, e).then(() => undefined),
  });
  return { deps, panel, role };
}

describe('self-assigned role panels', () => {
  test('toggle a role on and off', async () => {
    const { panel, role } = await setup();
    const m = env.adapter.addMember();
    const id = panelCustomId(panel('games').id, role('Gamer').id);
    expect(await env.adapter.pressButton(m.userId, id)).toBe('Added **Gamer**.');
    expect(env.adapter.members.get(m.userId)!.roleIds).toContain(role('Gamer').id);
    expect(await env.adapter.pressButton(m.userId, id)).toBe('Removed **Gamer**.');
    expect(env.adapter.members.get(m.userId)!.roleIds).not.toContain(role('Gamer').id);
  });

  test('single mode swaps instead of stacking', async () => {
    const { panel, role } = await setup();
    const m = env.adapter.addMember();
    await env.adapter.pressButton(m.userId, panelCustomId(panel('colours').id, role('Red').id));
    await env.adapter.pressButton(m.userId, panelCustomId(panel('colours').id, role('Blue').id));
    const roles = env.adapter.members.get(m.userId)!.roleIds;
    expect(roles).toContain(role('Blue').id);
    expect(roles).not.toContain(role('Red').id);
  });

  test('a forged button for a role that is not on the panel grants nothing', async () => {
    const { panel, role } = await setup();
    const m = env.adapter.addMember();
    const reply = await env.adapter.pressButton(
      m.userId,
      panelCustomId(panel('games').id, role('Moderator').id),
    );
    expect(reply).toMatch(/no longer on this panel/);
    expect(env.adapter.members.get(m.userId)!.roleIds).toEqual([]);
  });

  test('a role removed from the allowlist stops working on old panels', async () => {
    const { panel, role } = await setup();
    env.store.removeSelfRole(env.guildId, role('Gamer').id);
    const m = env.adapter.addMember();
    expect(
      await env.adapter.pressButton(m.userId, panelCustomId(panel('games').id, role('Gamer').id)),
    ).toMatch(/no longer self-assignable/);
    expect(env.adapter.members.get(m.userId)!.roleIds).toEqual([]);
  });

  test('a panel role that later gains power is refused at click time', async () => {
    const { panel, role } = await setup();
    env.adapter.roles.get(role('Gamer').id)!.permissions = P.ManageMessages;
    const m = env.adapter.addMember();
    expect(
      await env.adapter.pressButton(m.userId, panelCustomId(panel('games').id, role('Gamer').id)),
    ).toMatch(/can't be self-assigned/);
    expect(env.adapter.members.get(m.userId)!.roleIds).toEqual([]);
  });

  test('the allowlist refuses privileged roles in plans', async () => {
    env = makeEnv();
    const admin = env.adapter.addRole({ name: 'Admins', permissions: P.Administrator, position: 5 });
    const { body } = await env.service.createPlan({
      guildId: env.guildId,
      blueprint: { version: 1, self_roles: { roles: [admin.id] } },
      clientId: 't',
    });
    expect(body.steps[0]!.blocked).toMatch(/privileged.*Administrator/);
  });

  test('panel clicks are journaled with the member as the actor', async () => {
    const { panel, role } = await setup();
    const m = env.adapter.addMember();
    await env.adapter.pressButton(m.userId, panelCustomId(panel('games').id, role('Gamer').id));
    const ops = env.store.listOperations({ guildId: env.guildId, tool: 'role_panel', limit: 10, offset: 0 });
    expect(ops.items[0]).toMatchObject({
      clientId: `discord:${m.userId}`,
      status: 'succeeded',
      action: 'add_member_role',
    });
  });
});

describe('welcome and join roles', () => {
  test('a new member gets the join role and a welcome that pings only them', async () => {
    const { role } = await setup();
    const m = {
      userId: '222222222222222222',
      username: '*bold* @here',
      isBot: false,
      roleIds: [],
      communicationDisabledUntil: null,
    };
    await env.adapter.emitMemberJoin(m);
    expect(env.adapter.members.get(m.userId)!.roleIds).toEqual([role('Member').id]);
    const msg = [...env.adapter.messages.values()].find((x) =>
      x.content.includes('Hi <@222222222222222222>'),
    )!;
    expect(msg.body.allowed_mentions).toEqual({ parse: [], users: ['222222222222222222'] });
    expect(msg.content).toContain('welcome to Test Server');
  });

  test('bots are ignored, and a join role that became privileged is skipped', async () => {
    const { deps, role } = await setup();
    const out1 = await handleMemberJoin(deps, {
      guildId: env.guildId,
      member: {
        userId: '333333333333333333',
        username: 'bot',
        isBot: true,
        roleIds: [],
        communicationDisabledUntil: null,
      },
    });
    expect(out1).toEqual({ rolesAdded: [], rolesSkipped: [], posted: false });
    env.adapter.roles.get(role('Member').id)!.permissions = P.BanMembers;
    env.adapter.addMember({ userId: '444444444444444444' });
    const out2 = await handleMemberJoin(deps, {
      guildId: env.guildId,
      member: {
        userId: '444444444444444444',
        username: 'x',
        isBot: false,
        roleIds: [],
        communicationDisabledUntil: null,
      },
    });
    expect(out2.rolesSkipped).toEqual([role('Member').id]);
    expect(out2.posted).toBe(true);
  });
});
