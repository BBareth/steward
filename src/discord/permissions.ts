import { PermissionFlagsBits } from 'discord-api-types/v10';
import { StewardError } from '../util/errors.js';
import type { ChannelInfo, GuildSnapshot, RoleInfo } from './types.js';

/**
 * Permission names are the PascalCase keys Discord's own libraries use
 * (`ViewChannel`, `ManageRoles`). SCREAMING_SNAKE_CASE (`VIEW_CHANNEL`) and
 * lower case are accepted on input and normalised.
 */

const DEPRECATED_ALIASES = new Set(['ManageEmojisAndStickers']);

export const PERMISSION_BITS: ReadonlyMap<string, bigint> = new Map(
  Object.entries(PermissionFlagsBits).filter(([name]) => !DEPRECATED_ALIASES.has(name)),
);

const LOOKUP = new Map<string, string>();
for (const name of Object.keys(PermissionFlagsBits)) {
  const canonical = DEPRECATED_ALIASES.has(name) ? 'ManageGuildExpressions' : name;
  LOOKUP.set(name.toLowerCase(), canonical);
  LOOKUP.set(name.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase(), canonical);
}
// Discord's documentation uses a few names that differ from the library keys.
LOOKUP.set('read_messages', 'ViewChannel');
LOOKUP.set('manage_emojis', 'ManageGuildExpressions');
LOOKUP.set('use_slash_commands', 'UseApplicationCommands');

export const ALL_PERMISSIONS = [...PERMISSION_BITS.values()].reduce((a, b) => a | b, 0n);

export const P = PermissionFlagsBits;

export function canonicalPermissionName(name: string): string | undefined {
  return LOOKUP.get(name.trim().toLowerCase()) ?? LOOKUP.get(name.trim().replace(/-/g, '_').toLowerCase());
}

export function unknownPermissionNames(names: readonly string[]): string[] {
  return names.filter((n) => !canonicalPermissionName(n));
}

export function permissionsFromNames(names: readonly string[]): bigint {
  let bits = 0n;
  const unknown: string[] = [];
  for (const name of names) {
    const canonical = canonicalPermissionName(name);
    if (!canonical) unknown.push(name);
    else bits |= PERMISSION_BITS.get(canonical)!;
  }
  if (unknown.length > 0) {
    throw new StewardError('invalid_argument', `unknown permission name(s): ${unknown.join(', ')}`);
  }
  return bits;
}

export function permissionNames(bits: bigint): string[] {
  const names: string[] = [];
  for (const [name, bit] of PERMISSION_BITS) if ((bits & bit) === bit && bit !== 0n) names.push(name);
  return names;
}

/**
 * Permissions that let a member moderate, administer, or reach other people
 * at scale. A role that carries any of these, at guild level or through a
 * channel overwrite, is never handed out by a self-role panel or on join.
 */
export const ELEVATED_PERMISSIONS: bigint = [
  P.Administrator,
  P.ManageGuild,
  P.ManageRoles,
  P.ManageChannels,
  P.ManageWebhooks,
  P.ManageGuildExpressions,
  P.ManageEvents,
  P.ManageThreads,
  P.ManageMessages,
  P.ManageNicknames,
  P.KickMembers,
  P.BanMembers,
  P.ModerateMembers,
  P.MentionEveryone,
  P.ViewAuditLog,
  P.ViewGuildInsights,
  P.MuteMembers,
  P.DeafenMembers,
  P.MoveMembers,
  P.ViewCreatorMonetizationAnalytics,
  P.PinMessages,
  P.BypassSlowmode,
].reduce((a, b) => a | b, 0n);

const TEXT_LIKE = new Set(['text', 'announcement', 'forum', 'media']);

export function everyoneRole(snapshot: GuildSnapshot): RoleInfo | undefined {
  return snapshot.roles.find((r) => r.id === snapshot.guild.id);
}

export function roleById(snapshot: GuildSnapshot, id: string): RoleInfo | undefined {
  return snapshot.roles.find((r) => r.id === id);
}

/** Positive when `a` sits above `b` in the role list. Ties break on id, lower id ranking higher. */
export function compareRoles(a: RoleInfo, b: RoleInfo): number {
  if (a.position !== b.position) return a.position - b.position;
  return BigInt(a.id) < BigInt(b.id) ? 1 : BigInt(a.id) > BigInt(b.id) ? -1 : 0;
}

/** Roles sorted top to bottom, as Discord displays them. */
export function rolesTopDown(snapshot: GuildSnapshot): RoleInfo[] {
  return [...snapshot.roles].sort((a, b) => compareRoles(b, a));
}

export interface Subject {
  userId: string | null;
  roleIds: readonly string[];
  timedOut?: boolean;
}

export function basePermissions(snapshot: GuildSnapshot, subject: Subject): bigint {
  if (subject.userId && subject.userId === snapshot.guild.ownerId) return ALL_PERMISSIONS;
  let perms = everyoneRole(snapshot)?.permissions ?? 0n;
  for (const id of subject.roleIds) perms |= roleById(snapshot, id)?.permissions ?? 0n;
  if ((perms & P.Administrator) === P.Administrator) return ALL_PERMISSIONS;
  return perms;
}

export function channelPermissions(snapshot: GuildSnapshot, channel: ChannelInfo, subject: Subject): bigint {
  const base = basePermissions(snapshot, subject);
  if (base === ALL_PERMISSIONS) return ALL_PERMISSIONS;
  let perms = base;
  const everyoneOverwrite = channel.overwrites.find((o) => o.id === snapshot.guild.id);
  if (everyoneOverwrite) {
    perms &= ~everyoneOverwrite.deny;
    perms |= everyoneOverwrite.allow;
  }
  let allow = 0n;
  let deny = 0n;
  for (const o of channel.overwrites) {
    if (o.type === 'role' && o.id !== snapshot.guild.id && subject.roleIds.includes(o.id)) {
      allow |= o.allow;
      deny |= o.deny;
    }
  }
  perms &= ~deny;
  perms |= allow;
  if (subject.userId) {
    const member = channel.overwrites.find((o) => o.type === 'member' && o.id === subject.userId);
    if (member) {
      perms &= ~member.deny;
      perms |= member.allow;
    }
  }
  if (subject.timedOut) perms &= P.ViewChannel | P.ReadMessageHistory;
  if ((perms & P.ViewChannel) === 0n) return 0n;
  if (TEXT_LIKE.has(channel.kind) && (perms & P.SendMessages) === 0n) {
    perms &= ~(P.MentionEveryone | P.SendTTSMessages | P.AttachFiles | P.EmbedLinks);
  }
  return perms;
}

export function has(perms: bigint, bit: bigint): boolean {
  return (perms & bit) === bit;
}

export interface BotStanding {
  userId: string;
  /**
   * The bot's top role in Discord's order. Compare roles against it with
   * `compareRoles` / `ranksBelowBot`, never by raw `position`: Discord lets
   * several roles share a position and breaks the tie by id.
   */
  highestRole: RoleInfo | undefined;
  permissions: bigint;
  isAdmin: boolean;
}

export function botStanding(snapshot: GuildSnapshot): BotStanding {
  const roles = snapshot.botMember.roleIds
    .map((id) => roleById(snapshot, id))
    .filter((r): r is RoleInfo => !!r)
    .sort((a, b) => compareRoles(b, a));
  const permissions = basePermissions(snapshot, {
    userId: snapshot.botMember.userId,
    roleIds: snapshot.botMember.roleIds,
  });
  return {
    userId: snapshot.botMember.userId,
    highestRole: roles[0],
    permissions,
    isAdmin: permissions === ALL_PERMISSIONS,
  };
}

/**
 * Whether `role` sits strictly below the bot's highest role. This is the one
 * hierarchy test every summary, plan and mutation uses.
 */
export function ranksBelowBot(snapshot: GuildSnapshot, role: RoleInfo): boolean {
  const top = botStanding(snapshot).highestRole;
  return !!top && compareRoles(role, top) < 0;
}

/** Roles (other than @everyone and the bot's own top role) the bot cannot manage because of hierarchy. */
export function rolesOutOfBotReach(snapshot: GuildSnapshot): RoleInfo[] {
  const top = botStanding(snapshot).highestRole;
  return rolesTopDown(snapshot).filter(
    (r) => r.id !== snapshot.guild.id && r.id !== top?.id && !ranksBelowBot(snapshot, r),
  );
}

export function botChannelPermissions(snapshot: GuildSnapshot, channel: ChannelInfo): bigint {
  return channelPermissions(snapshot, channel, {
    userId: snapshot.botMember.userId,
    roleIds: snapshot.botMember.roleIds,
  });
}

export type RoleOperation = 'assign' | 'edit' | 'delete' | 'move';

export interface Verdict {
  ok: boolean;
  reason?: string;
}

/** Whether the bot may perform `operation` on `role`, following Discord's hierarchy rules. */
export function canBotManageRole(snapshot: GuildSnapshot, role: RoleInfo, operation: RoleOperation): Verdict {
  const bot = botStanding(snapshot);
  if (!has(bot.permissions, P.ManageRoles)) {
    return { ok: false, reason: 'the bot lacks the Manage Roles permission' };
  }
  const isEveryone = role.id === snapshot.guild.id;
  if (isEveryone && operation !== 'edit') {
    return { ok: false, reason: '@everyone cannot be assigned, moved or deleted' };
  }
  if (role.managed && (operation === 'assign' || operation === 'delete')) {
    return {
      ok: false,
      reason:
        'the role is managed by an integration (a bot, booster or linked role); Discord does not allow assigning or deleting it',
    };
  }
  if (!isEveryone && !ranksBelowBot(snapshot, role)) {
    return {
      ok: false,
      reason: `the role is at or above the bot's highest role (${bot.highestRole?.name ?? 'none'}); move the bot's role higher in Server Settings → Roles`,
    };
  }
  return { ok: true };
}

/** Bits the bot is not allowed to grant: anything it does not hold itself, unless it is an administrator. */
export function ungrantablePermissions(snapshot: GuildSnapshot, requested: bigint): bigint {
  const bot = botStanding(snapshot);
  if (bot.isAdmin) return 0n;
  return requested & ~bot.permissions;
}

export function ungrantableInChannel(
  snapshot: GuildSnapshot,
  channel: ChannelInfo | null,
  bits: bigint,
): bigint {
  const bot = botStanding(snapshot);
  if (bot.isAdmin) return 0n;
  const held = channel ? botChannelPermissions(snapshot, channel) : bot.permissions;
  // A Manage Roles overwrite in the channel lets the bot set anything it holds there.
  return bits & ~held;
}

export interface PrivilegeReport {
  privileged: boolean;
  reasons: string[];
  /** Not a privilege, but worth knowing: channels this role reveals that @everyone cannot see. */
  unlocksHiddenChannels: string[];
}

/**
 * Decide whether a role is too powerful to hand out automatically. Overwrites
 * matter as much as guild permissions: a role with no permissions of its own
 * can still be a staff role because of what channels grant it.
 */
export function assessRolePrivilege(
  snapshot: GuildSnapshot,
  role: RoleInfo,
  protectedRoleIds: ReadonlySet<string> = new Set(),
): PrivilegeReport {
  const reasons: string[] = [];
  if (role.id === snapshot.guild.id) reasons.push('it is @everyone');
  if (role.managed) reasons.push('it is managed by an integration');
  if (protectedRoleIds.has(role.id)) reasons.push('it is marked as a protected staff role');
  const elevated = role.permissions & ELEVATED_PERMISSIONS;
  if (elevated !== 0n) reasons.push(`it grants ${permissionNames(elevated).join(', ')}`);
  const unlocks: string[] = [];
  for (const channel of snapshot.channels) {
    const ow = channel.overwrites.find((o) => o.type === 'role' && o.id === role.id);
    if (!ow) continue;
    const elevatedHere = ow.allow & ELEVATED_PERMISSIONS;
    if (elevatedHere !== 0n) {
      reasons.push(`it grants ${permissionNames(elevatedHere).join(', ')} in #${channel.name}`);
    }
    if ((ow.allow & P.ViewChannel) !== 0n) {
      const everyoneCanSee =
        (channelPermissions(snapshot, channel, { userId: null, roleIds: [] }) & P.ViewChannel) !== 0n;
      if (!everyoneCanSee) unlocks.push(channel.name);
    }
  }
  return { privileged: reasons.length > 0, reasons, unlocksHiddenChannels: unlocks };
}

export function bitsToString(bits: bigint): string {
  return bits.toString();
}
