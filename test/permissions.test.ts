import { describe, expect, test } from 'vitest';
import {
  ALL_PERMISSIONS,
  assessRolePrivilege,
  basePermissions,
  canBotManageRole,
  canonicalPermissionName,
  channelPermissions,
  P,
  permissionNames,
  permissionsFromNames,
} from '../src/discord/permissions.js';
import { MemoryDiscordAdapter } from './helpers/memory-adapter.js';

describe('permission names', () => {
  test('accept PascalCase, SCREAMING_SNAKE_CASE and lower case', () => {
    expect(canonicalPermissionName('VIEW_CHANNEL')).toBe('ViewChannel');
    expect(canonicalPermissionName('viewchannel')).toBe('ViewChannel');
    expect(canonicalPermissionName('ManageEmojisAndStickers')).toBe('ManageGuildExpressions');
    expect(permissionsFromNames(['ViewChannel', 'SEND_MESSAGES'])).toBe(P.ViewChannel | P.SendMessages);
    expect(() => permissionsFromNames(['ViewChanel'])).toThrow(/unknown permission/);
    expect(permissionNames(P.KickMembers | P.BanMembers)).toEqual(['KickMembers', 'BanMembers']);
  });
});

describe('effective permissions', () => {
  const setup = async () => {
    const d = new MemoryDiscordAdapter();
    d.setBotRolePosition(50);
    const mod = d.addRole({ name: 'Mod', permissions: P.ManageMessages, position: 10 });
    const muted = d.addRole({ name: 'Muted', permissions: 0n, position: 5 });
    const ch = d.addChannel({
      name: 'staff',
      overwrites: [
        { id: d.guildId, type: 'role', allow: 0n, deny: P.ViewChannel },
        { id: mod.id, type: 'role', allow: P.ViewChannel, deny: 0n },
        { id: muted.id, type: 'role', allow: 0n, deny: P.SendMessages },
      ],
    });
    return { d, mod, muted, ch, s: await d.fetchSnapshot(d.guildId) };
  };

  test('@everyone overwrite, then role overwrites, then member overwrite', async () => {
    const { d, mod, muted, ch, s } = await setup();
    expect(channelPermissions(s, ch, { userId: null, roleIds: [] })).toBe(0n);
    const modPerms = channelPermissions(s, ch, { userId: null, roleIds: [mod.id] });
    expect(modPerms & P.ViewChannel).toBe(P.ViewChannel);
    expect(modPerms & P.SendMessages).toBe(P.SendMessages);
    // Role denies and allows combine before applying: allow wins across roles.
    const both = channelPermissions(s, ch, { userId: null, roleIds: [mod.id, muted.id] });
    expect(both & P.SendMessages).toBe(0n);
    // A member overwrite beats role overwrites.
    const user = '111111111111111111';
    ch.overwrites.push({ id: user, type: 'member', allow: P.SendMessages, deny: 0n });
    const withMember = channelPermissions(await d.fetchSnapshot(d.guildId), d.channels.get(ch.id)!, {
      userId: user,
      roleIds: [mod.id, muted.id],
    });
    expect(withMember & P.SendMessages).toBe(P.SendMessages);
  });

  test('no View Channel means no permissions; no Send Messages removes embed/attach/mention-everyone', async () => {
    const { muted, ch, s, mod } = await setup();
    const p = channelPermissions(s, ch, { userId: null, roleIds: [mod.id, muted.id] });
    expect(p & (P.EmbedLinks | P.AttachFiles | P.MentionEveryone)).toBe(0n);
  });

  test('Administrator and owner bypass overwrites; timeouts strip to view + history', async () => {
    const { d, ch, s } = await setup();
    const admin = d.addRole({ name: 'Admin', permissions: P.Administrator, position: 20 });
    const s2 = await d.fetchSnapshot(d.guildId);
    expect(channelPermissions(s2, ch, { userId: null, roleIds: [admin.id] })).toBe(ALL_PERMISSIONS);
    expect(basePermissions(s, { userId: d.ownerId, roleIds: [] })).toBe(ALL_PERMISSIONS);
    const general = d.addChannel({ name: 'general' });
    const timed = channelPermissions(await d.fetchSnapshot(d.guildId), general, {
      userId: null,
      roleIds: [],
      timedOut: true,
    });
    expect(timed).toBe(P.ViewChannel | P.ReadMessageHistory);
  });
});

describe('role hierarchy', () => {
  test('roles at or above the bot, managed roles and @everyone are refused with reasons', async () => {
    const d = new MemoryDiscordAdapter({ botRolePosition: 5 });
    const below = d.addRole({ name: 'Below', position: 2 });
    const above = d.addRole({ name: 'Above', position: 9 });
    const booster = d.addRole({
      name: 'Booster',
      position: 1,
      managed: true,
      tags: { premiumSubscriber: true },
    });
    const s = await d.fetchSnapshot(d.guildId);
    const role = (id: string) => s.roles.find((r) => r.id === id)!;
    expect(canBotManageRole(s, role(below.id), 'assign').ok).toBe(true);
    expect(canBotManageRole(s, role(above.id), 'assign').reason).toMatch(
      /at or above the bot's highest role/,
    );
    expect(canBotManageRole(s, role(booster.id), 'assign').reason).toMatch(/managed by an integration/);
    expect(canBotManageRole(s, role(booster.id), 'move').ok).toBe(true);
    expect(canBotManageRole(s, role(d.guildId), 'assign').ok).toBe(false);
    expect(canBotManageRole(s, role(d.guildId), 'edit').ok).toBe(true);
  });

  test('even with Administrator, the bot cannot manage roles above it', async () => {
    const d = new MemoryDiscordAdapter({ botRolePosition: 3, botPermissions: P.Administrator });
    const above = d.addRole({ name: 'Owner crew', position: 10 });
    const s = await d.fetchSnapshot(d.guildId);
    expect(
      canBotManageRole(
        s,
        s.roles.find((r) => r.id === above.id)!,
        'edit',
      ).ok,
    ).toBe(false);
  });

  test('without Manage Roles nothing is manageable', async () => {
    const d = new MemoryDiscordAdapter({ botRolePosition: 10, botPermissions: P.ViewChannel });
    const r = d.addRole({ name: 'x', position: 1 });
    const s = await d.fetchSnapshot(d.guildId);
    expect(
      canBotManageRole(
        s,
        s.roles.find((x) => x.id === r.id)!,
        'assign',
      ).reason,
    ).toMatch(/Manage Roles/);
  });
});

describe('privileged roles', () => {
  test('elevated guild permissions, elevated overwrites, protection and management all count', async () => {
    const d = new MemoryDiscordAdapter({ botRolePosition: 50 });
    const plain = d.addRole({ name: 'Gamer', position: 1 });
    const kicker = d.addRole({ name: 'Kicker', permissions: P.KickMembers, position: 2 });
    const sneaky = d.addRole({ name: 'Helper', permissions: 0n, position: 3 });
    const staff = d.addRole({ name: 'Staff', permissions: 0n, position: 4 });
    d.addChannel({
      name: 'support',
      overwrites: [{ id: sneaky.id, type: 'role', allow: P.ManageMessages, deny: 0n }],
    });
    d.addChannel({
      name: 'gaming',
      overwrites: [
        { id: d.guildId, type: 'role', allow: 0n, deny: P.ViewChannel },
        { id: plain.id, type: 'role', allow: P.ViewChannel, deny: 0n },
      ],
    });
    const s = await d.fetchSnapshot(d.guildId);
    const r = (id: string) => s.roles.find((x) => x.id === id)!;
    const gamer = assessRolePrivilege(s, r(plain.id));
    expect(gamer.privileged).toBe(false);
    expect(gamer.unlocksHiddenChannels).toEqual(['gaming']);
    expect(assessRolePrivilege(s, r(kicker.id)).reasons.join()).toMatch(/KickMembers/);
    expect(assessRolePrivilege(s, r(sneaky.id)).reasons.join()).toMatch(/ManageMessages in #support/);
    expect(assessRolePrivilege(s, r(staff.id), new Set([staff.id])).reasons.join()).toMatch(
      /protected staff role/,
    );
  });
});
