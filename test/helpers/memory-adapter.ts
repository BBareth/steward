import type {
  AdapterEvents,
  AuditLogEntry,
  ButtonPressEvent,
  DiscordAdapter,
} from '../../src/discord/adapter.js';
import {
  ALL_PERMISSIONS,
  botChannelPermissions,
  botStanding,
  canBotManageRole,
  compareRoles,
  has,
  P,
} from '../../src/discord/permissions.js';
import type {
  AutoModRuleInfo,
  AutoModWriteBody,
  ChannelInfo,
  ChannelWriteBody,
  ConnectionState,
  ConnectionStatus,
  GuildInfo,
  GuildSnapshot,
  GuildWriteBody,
  MemberInfo,
  MessageBody,
  MessageInfo,
  PositionUpdate,
  RoleInfo,
  RoleWriteBody,
} from '../../src/discord/types.js';
import { channelKindFromType } from '../../src/discord/types.js';
import { DiscordRequestError } from '../../src/util/errors.js';

/**
 * An in-memory Discord that enforces the rules steward has to cope with:
 * permission checks, role hierarchy, managed roles, position shuffling, nonce
 * de-duplication, and an audit log. Faults can be injected per method.
 */

const DISCORD_EPOCH = 1420070400000n;
let seq = 0n;
export function makeSnowflake(at = Date.now()): string {
  seq = (seq + 1n) & 0xfffn;
  return (((BigInt(at) - DISCORD_EPOCH) << 22n) | (1n << 17n) | seq).toString();
}

export type FaultMode =
  | 'timeout_before'
  | 'timeout_after'
  | 'server_error_after'
  | 'forbidden'
  | 'not_found'
  | 'hang_before'
  | 'hang_after'
  /** Report success but change nothing, as Discord sometimes does with positions. */
  | 'ignored';

interface Fault {
  method: string;
  mode: FaultMode;
  when?: (args: unknown[]) => boolean;
  remaining: number;
}

const clone = <T>(v: T): T => structuredClone(v);

export interface MemoryAdapterOptions {
  guildId?: string;
  guildName?: string;
  /** Permissions held by the bot's own (managed) role. */
  botPermissions?: bigint;
  /** Position of the bot's role; roles at or above it cannot be managed. */
  botRolePosition?: number;
  /**
   * How role positions behave. 'discord' (default) matches what live Discord
   * was seen doing: a new role lands on position 1 without renumbering anything,
   * so several roles can share a position, and updates are stored as sent.
   * 'normalised' renumbers every role 1..n after each change.
   */
  rolePositions?: 'discord' | 'normalised';
}

export class MemoryDiscordAdapter implements DiscordAdapter {
  readonly guildId: string;
  readonly botUserId = makeSnowflake();
  readonly ownerId = makeSnowflake();
  readonly botRoleId: string;
  guild: GuildInfo;
  roles = new Map<string, RoleInfo>();
  channels = new Map<string, ChannelInfo>();
  members = new Map<string, MemberInfo>();
  messages = new Map<string, MessageInfo & { body: MessageBody }>();
  automod = new Map<string, AutoModRuleInfo>();
  /**
   * Rules Discord keeps for itself: listed, but edits and deletes answer 404.
   * 'hidden' rules also answer 404 when read by id.
   */
  nativeAutomod = new Map<string, 'readable' | 'hidden'>();
  audit: AuditLogEntry[] = [];
  calls: Array<{ method: string; args: unknown[] }> = [];
  private nonces = new Map<string, string>();
  private faults: Fault[] = [];
  private events: AdapterEvents = {};
  private state: ConnectionState = 'ready';
  private detail: string | null = null;

  constructor(private readonly options: MemoryAdapterOptions = {}) {
    this.guildId = options.guildId ?? makeSnowflake();
    this.guild = {
      id: this.guildId,
      name: options.guildName ?? 'Test Server',
      ownerId: this.ownerId,
      description: null,
      verificationLevel: 0,
      defaultMessageNotifications: 0,
      explicitContentFilter: 0,
      mfaLevel: 0,
      nsfwLevel: 0,
      preferredLocale: 'en-US',
      afkChannelId: null,
      afkTimeout: 300,
      systemChannelId: null,
      systemChannelFlags: 0,
      rulesChannelId: null,
      publicUpdatesChannelId: null,
      safetyAlertsChannelId: null,
      premiumProgressBarEnabled: false,
      premiumTier: 0,
      features: [],
      approximateMemberCount: 2,
    };
    this.roles.set(this.guildId, {
      id: this.guildId,
      name: '@everyone',
      color: 0,
      hoist: false,
      mentionable: false,
      managed: false,
      position: 0,
      permissions:
        P.ViewChannel | P.SendMessages | P.ReadMessageHistory | P.Connect | P.Speak | P.AddReactions,
      tags: null,
    });
    this.botRoleId = makeSnowflake();
    this.roles.set(this.botRoleId, {
      id: this.botRoleId,
      name: 'Steward',
      color: 0,
      hoist: false,
      mentionable: false,
      managed: true,
      position: options.botRolePosition ?? 1,
      permissions: options.botPermissions ?? P.Administrator,
      tags: { botId: this.botUserId },
    });
    this.members.set(this.botUserId, {
      userId: this.botUserId,
      username: 'steward',
      isBot: true,
      roleIds: [this.botRoleId],
      communicationDisabledUntil: null,
    });
    this.members.set(this.ownerId, {
      userId: this.ownerId,
      username: 'owner',
      isBot: false,
      roleIds: [],
      communicationDisabledUntil: null,
    });
  }

  // ---- test controls --------------------------------------------------------

  inject(
    method: string,
    mode: FaultMode,
    options: { times?: number; when?: (args: unknown[]) => boolean } = {},
  ): void {
    this.faults.push({ method, mode, when: options.when, remaining: options.times ?? 1 });
  }

  clearFaults(): void {
    this.faults = [];
  }

  setConnection(state: ConnectionState, detail: string | null = null): void {
    this.state = state;
    this.detail = detail;
  }

  addRole(spec: Partial<RoleInfo> & { name: string }): RoleInfo {
    const role: RoleInfo = {
      id: makeSnowflake(),
      color: 0,
      hoist: false,
      mentionable: false,
      managed: false,
      permissions: 0n,
      tags: null,
      ...spec,
      position: spec.position ?? this.nextRolePosition(),
    };
    this.roles.set(role.id, role);
    return role;
  }

  addChannel(spec: Partial<ChannelInfo> & { name: string }): ChannelInfo {
    const type = spec.type ?? 0;
    const channel: ChannelInfo = {
      id: makeSnowflake(),
      kind: channelKindFromType(type),
      type,
      parentId: null,
      position: 0,
      topic: null,
      nsfw: false,
      rateLimitPerUser: 0,
      bitrate: type === 2 ? 64000 : null,
      userLimit: type === 2 ? 0 : null,
      overwrites: [],
      ...spec,
    };
    this.channels.set(channel.id, channel);
    return channel;
  }

  addMember(spec: Partial<MemberInfo> = {}): MemberInfo {
    const member: MemberInfo = {
      userId: makeSnowflake(),
      username: 'member',
      isBot: false,
      roleIds: [],
      communicationDisabledUntil: null,
      ...spec,
    };
    this.members.set(member.userId, member);
    return member;
  }

  addAutoModRule(
    spec: Partial<AutoModRuleInfo> & { name: string },
    native?: 'readable' | 'hidden',
  ): AutoModRuleInfo {
    const rule: AutoModRuleInfo = {
      id: makeSnowflake(),
      eventType: 1,
      triggerType: 1,
      triggerMetadata: {},
      actions: [{ type: 1 }],
      enabled: true,
      exemptRoles: [],
      exemptChannels: [],
      creatorId: this.ownerId,
      ...spec,
    };
    this.automod.set(rule.id, rule);
    if (native) this.nativeAutomod.set(rule.id, native);
    return rule;
  }

  setBotRolePosition(position: number): void {
    this.roles.get(this.botRoleId)!.position = position;
  }

  setBotPermissions(perms: bigint): void {
    this.roles.get(this.botRoleId)!.permissions = perms;
  }

  async emitMemberJoin(member: MemberInfo): Promise<void> {
    this.members.set(member.userId, member);
    await this.events.memberJoin?.({ guildId: this.guildId, member: clone(member) });
  }

  async pressButton(userId: string, customId: string, channelId = ''): Promise<string> {
    let replied = '';
    const member = this.members.get(userId)!;
    const event: ButtonPressEvent = {
      guildId: this.guildId,
      channelId,
      userId,
      memberRoleIds: [...member.roleIds],
      customId,
      reply: async (text) => {
        replied = text;
      },
    };
    await this.events.buttonPress?.(event);
    return replied;
  }

  channelByName(name: string): ChannelInfo | undefined {
    return [...this.channels.values()].find((c) => c.name === name);
  }

  roleByName(name: string): RoleInfo | undefined {
    return [...this.roles.values()].find((r) => r.name === name);
  }

  // ---- internals -----------------------------------------------------------

  private nextRolePosition(): number {
    return Math.max(0, ...[...this.roles.values()].map((r) => r.position)) + 1;
  }

  private snapshotNow(): GuildSnapshot {
    return {
      guild: clone(this.guild),
      roles: [...this.roles.values()].map(clone),
      channels: [...this.channels.values()].map(clone),
      botMember: clone(this.members.get(this.botUserId)!),
      fetchedAt: new Date().toISOString(),
    };
  }

  private async enter(method: string, args: unknown[]): Promise<FaultMode | null> {
    this.calls.push({ method, args: clone(args) });
    if (this.state !== 'ready' && this.state !== 'reconnecting') {
      throw new DiscordRequestError('network', `discord not connected (${this.state})`);
    }
    const fault = this.faults.find(
      (f) => f.method === method && f.remaining > 0 && (!f.when || f.when(args)),
    );
    if (!fault) return null;
    fault.remaining -= 1;
    switch (fault.mode) {
      case 'timeout_before':
        throw new DiscordRequestError(
          'timeout',
          'the request to Discord timed out; it may or may not have been applied',
        );
      case 'forbidden':
        throw new DiscordRequestError(
          'http',
          'Discord rejected the request: Missing Permissions',
          403,
          50013,
        );
      case 'not_found':
        throw new DiscordRequestError('http', 'Discord rejected the request: Unknown', 404, 10003);
      case 'hang_before':
        await new Promise(() => {});
        return null;
      default:
        return fault.mode;
    }
  }

  private async leave<T>(mode: FaultMode | null, value: T): Promise<T> {
    if (mode === 'timeout_after') {
      throw new DiscordRequestError(
        'timeout',
        'the request to Discord timed out; it may or may not have been applied',
      );
    }
    if (mode === 'server_error_after')
      throw new DiscordRequestError('server', 'Discord returned HTTP 502; the outcome is unknown', 502);
    if (mode === 'hang_after') await new Promise(() => {});
    return value;
  }

  /** Discord documents no JSON code for an unknown AutoMod rule, only the HTTP status. */
  private notFound(): DiscordRequestError {
    return new DiscordRequestError('http', 'Discord rejected the request: 404 Not Found', 404);
  }

  private forbid(why: string): never {
    throw new DiscordRequestError(
      'http',
      `Discord rejected the request: Missing Permissions (${why})`,
      403,
      50013,
    );
  }

  private requireGuildPerm(bit: bigint, why: string): void {
    if (!has(botStanding(this.snapshotNow()).permissions, bit)) this.forbid(why);
  }

  private requireChannel(id: string): ChannelInfo {
    const c = this.channels.get(id);
    if (!c)
      throw new DiscordRequestError('http', 'Discord rejected the request: Unknown Channel', 404, 10003);
    return c;
  }

  private requireRole(id: string): RoleInfo {
    const r = this.roles.get(id);
    if (!r) throw new DiscordRequestError('http', 'Discord rejected the request: Unknown Role', 404, 10011);
    return r;
  }

  private checkOverwriteBits(body: ChannelWriteBody, channel: ChannelInfo | null): void {
    if (!body.permission_overwrites) return;
    const snap = this.snapshotNow();
    const bot = botStanding(snap);
    if (!has(bot.permissions, P.ManageRoles)) this.forbid('overwrites need Manage Roles');
    if (bot.isAdmin) return;
    const held = channel ? botChannelPermissions(snap, channel) : bot.permissions;
    for (const o of body.permission_overwrites) {
      const bits = BigInt(o.allow) | BigInt(o.deny);
      if ((bits & ~held) !== 0n) this.forbid('cannot grant or deny permissions the bot does not hold');
    }
  }

  private audit_(actionType: number, targetId: string | null, reason: string): void {
    this.audit.unshift({ id: makeSnowflake(), actionType, targetId, userId: this.botUserId, reason });
  }

  private applyChannelBody(channel: ChannelInfo, body: ChannelWriteBody): void {
    if (body.name !== undefined) channel.name = body.name;
    if (body.type !== undefined) {
      channel.type = body.type;
      channel.kind = channelKindFromType(body.type);
    }
    if (body.topic !== undefined) channel.topic = body.topic;
    if (body.nsfw !== undefined) channel.nsfw = body.nsfw;
    if (body.rate_limit_per_user !== undefined) channel.rateLimitPerUser = body.rate_limit_per_user;
    if (body.bitrate !== undefined) channel.bitrate = body.bitrate;
    if (body.user_limit !== undefined) channel.userLimit = body.user_limit;
    if (body.parent_id !== undefined) {
      if (body.parent_id !== null && this.channels.get(body.parent_id)?.kind !== 'category') {
        throw new DiscordRequestError(
          'http',
          'Discord rejected the request: Invalid Form Body (parent_id)',
          400,
          50035,
        );
      }
      channel.parentId = body.parent_id;
    }
    if (body.position !== undefined) channel.position = body.position;
    if (body.permission_overwrites !== undefined) {
      channel.overwrites = body.permission_overwrites.map((o) => ({
        id: o.id,
        type: o.type === 1 ? 'member' : 'role',
        allow: BigInt(o.allow),
        deny: BigInt(o.deny),
      }));
    }
  }

  private normaliseRolePositions(): void {
    const others = [...this.roles.values()]
      .filter((r) => r.id !== this.guildId)
      .sort((a, b) => compareRoles(a, b));
    others.forEach((r, i) => (r.position = i + 1));
  }

  // ---- DiscordAdapter -------------------------------------------------------

  status(): ConnectionStatus {
    return {
      state: this.state,
      since: new Date(0).toISOString(),
      detail: this.detail,
      botUserId: this.botUserId,
      botTag: 'steward#0000',
      applicationId: this.botUserId,
      guildIds: [this.guildId],
    };
  }

  async start(events: AdapterEvents): Promise<void> {
    this.events = events;
  }

  async stop(): Promise<void> {
    this.state = 'disconnected';
  }

  async fetchSnapshot(guildId: string): Promise<GuildSnapshot> {
    await this.enter('fetchSnapshot', [guildId]);
    if (guildId !== this.guildId)
      throw new DiscordRequestError('http', 'Discord rejected the request: Unknown Guild', 404, 10004);
    return this.snapshotNow();
  }

  async fetchMember(_guildId: string, userId: string): Promise<MemberInfo | null> {
    await this.enter('fetchMember', [userId]);
    const m = this.members.get(userId);
    return m ? clone(m) : null;
  }

  async fetchAutoModRules(): Promise<AutoModRuleInfo[]> {
    await this.enter('fetchAutoModRules', []);
    this.requireGuildPerm(P.ManageGuild, 'automod needs Manage Server');
    return [...this.automod.values()].map(clone);
  }

  async fetchAutoModRule(guildId: string, ruleId: string): Promise<AutoModRuleInfo | null> {
    await this.enter('fetchAutoModRule', [guildId, ruleId]);
    this.requireGuildPerm(P.ManageGuild, 'automod needs Manage Server');
    const rule = this.automod.get(ruleId);
    if (!rule || this.nativeAutomod.get(ruleId) === 'hidden') return null;
    return clone(rule);
  }

  async fetchMessage(channelId: string, messageId: string): Promise<MessageInfo | null> {
    await this.enter('fetchMessage', [channelId, messageId]);
    const m = this.messages.get(messageId);
    if (!m || m.channelId !== channelId) return null;
    const { body: _b, ...info } = m;
    return clone(info);
  }

  async fetchRecentMessages(channelId: string, limit: number): Promise<MessageInfo[]> {
    await this.enter('fetchRecentMessages', [channelId, limit]);
    return [...this.messages.values()]
      .filter((m) => m.channelId === channelId)
      .reverse()
      .slice(0, limit)
      .map(({ body: _b, ...info }) => clone(info));
  }

  async fetchAuditLog(_guildId: string, actionType: number, limit = 50): Promise<AuditLogEntry[]> {
    await this.enter('fetchAuditLog', [actionType]);
    this.requireGuildPerm(P.ViewAuditLog, 'audit log needs View Audit Log');
    return this.audit
      .filter((e) => e.actionType === actionType)
      .slice(0, limit)
      .map(clone);
  }

  async createChannel(guildId: string, body: ChannelWriteBody, reason: string): Promise<ChannelInfo> {
    const mode = await this.enter('createChannel', [guildId, body, reason]);
    this.requireGuildPerm(P.ManageChannels, 'creating channels needs Manage Channels');
    this.checkOverwriteBits(body, body.parent_id ? (this.channels.get(body.parent_id) ?? null) : null);
    const type = body.type ?? 0;
    if ((type === 5 || type === 13) && !this.guild.features.includes('COMMUNITY')) {
      throw new DiscordRequestError(
        'http',
        'Discord rejected the request: Invalid Form Body (type requires Community)',
        400,
        50035,
      );
    }
    const channel: ChannelInfo = this.addChannel({ name: body.name ?? 'channel', type });
    const siblings = [...this.channels.values()].filter(
      (c) => c.id !== channel.id && c.parentId === (body.parent_id ?? null),
    );
    this.applyChannelBody(channel, {
      ...body,
      position: body.position ?? Math.max(-1, ...siblings.map((c) => c.position)) + 1,
    });
    this.audit_(10, channel.id, reason);
    return this.leave(mode, clone(channel));
  }

  async editChannel(channelId: string, body: ChannelWriteBody, reason: string): Promise<ChannelInfo> {
    const mode = await this.enter('editChannel', [channelId, body, reason]);
    const channel = this.requireChannel(channelId);
    if (!has(botChannelPermissions(this.snapshotNow(), channel), P.ManageChannels))
      this.forbid('editing needs Manage Channels');
    if ((body.type === 5 || body.type === 13) && !this.guild.features.includes('COMMUNITY')) {
      throw new DiscordRequestError(
        'http',
        'Discord rejected the request: Invalid Form Body (type requires Community)',
        400,
        50035,
      );
    }
    this.checkOverwriteBits(body, channel);
    this.applyChannelBody(channel, body);
    this.audit_(11, channelId, reason);
    return this.leave(mode, clone(channel));
  }

  async deleteChannel(channelId: string, reason: string): Promise<void> {
    const mode = await this.enter('deleteChannel', [channelId, reason]);
    const channel = this.requireChannel(channelId);
    if (!has(botChannelPermissions(this.snapshotNow(), channel), P.ManageChannels))
      this.forbid('deleting needs Manage Channels');
    if (this.guild.rulesChannelId === channelId || this.guild.publicUpdatesChannelId === channelId) {
      throw new DiscordRequestError(
        'http',
        'Discord rejected the request: cannot delete a channel required for Community servers',
        400,
        50074,
      );
    }
    this.channels.delete(channelId);
    for (const c of this.channels.values()) if (c.parentId === channelId) c.parentId = null;
    this.audit_(12, channelId, reason);
    return this.leave(mode, undefined);
  }

  async setChannelPositions(guildId: string, updates: PositionUpdate[], reason: string): Promise<void> {
    const mode = await this.enter('setChannelPositions', [guildId, updates, reason]);
    this.requireGuildPerm(P.ManageChannels, 'reordering needs Manage Channels');
    if (mode !== 'ignored') for (const u of updates) this.requireChannel(u.id).position = u.position;
    return this.leave(mode, undefined);
  }

  async putOverwrite(
    channelId: string,
    overwrite: { id: string; type: 'role' | 'member'; allow: bigint; deny: bigint },
    reason: string,
  ): Promise<void> {
    const mode = await this.enter('putOverwrite', [channelId, overwrite, reason]);
    const channel = this.requireChannel(channelId);
    this.checkOverwriteBits(
      {
        permission_overwrites: [
          { id: overwrite.id, type: 0, allow: overwrite.allow.toString(), deny: overwrite.deny.toString() },
        ],
      },
      channel,
    );
    channel.overwrites = channel.overwrites.filter((o) => o.id !== overwrite.id).concat([{ ...overwrite }]);
    this.audit_(14, channelId, reason);
    return this.leave(mode, undefined);
  }

  async deleteOverwrite(channelId: string, targetId: string, reason: string): Promise<void> {
    const mode = await this.enter('deleteOverwrite', [channelId, targetId, reason]);
    const channel = this.requireChannel(channelId);
    this.requireGuildPerm(P.ManageRoles, 'overwrites need Manage Roles');
    channel.overwrites = channel.overwrites.filter((o) => o.id !== targetId);
    this.audit_(15, channelId, reason);
    return this.leave(mode, undefined);
  }

  async createRole(guildId: string, body: RoleWriteBody, reason: string): Promise<RoleInfo> {
    const mode = await this.enter('createRole', [guildId, body, reason]);
    const snap = this.snapshotNow();
    const bot = botStanding(snap);
    if (!has(bot.permissions, P.ManageRoles)) this.forbid('creating roles needs Manage Roles');
    const perms = body.permissions !== undefined ? BigInt(body.permissions) : 0n;
    if (!bot.isAdmin && (perms & ~bot.permissions) !== 0n)
      this.forbid('cannot grant permissions the bot does not hold');
    if (this.options.rolePositions === 'normalised') {
      for (const r of this.roles.values()) if (r.id !== this.guildId && r.position >= 1) r.position += 1;
    }
    const role: RoleInfo = {
      id: makeSnowflake(),
      name: body.name ?? 'new role',
      color: body.color ?? 0,
      hoist: body.hoist ?? false,
      mentionable: body.mentionable ?? false,
      managed: false,
      position: 1,
      permissions: perms,
      tags: null,
    };
    this.roles.set(role.id, role);
    this.audit_(30, role.id, reason);
    return this.leave(mode, clone(role));
  }

  async editRole(guildId: string, roleId: string, body: RoleWriteBody, reason: string): Promise<RoleInfo> {
    const mode = await this.enter('editRole', [guildId, roleId, body, reason]);
    const role = this.requireRole(roleId);
    const snap = this.snapshotNow();
    const verdict = canBotManageRole(snap, role, 'edit');
    if (!verdict.ok) this.forbid(verdict.reason!);
    if (body.permissions !== undefined) {
      const bot = botStanding(snap);
      const perms = BigInt(body.permissions);
      if (!bot.isAdmin && (perms & ~bot.permissions) !== 0n)
        this.forbid('cannot grant permissions the bot does not hold');
      role.permissions = perms;
    }
    if (body.name !== undefined) role.name = body.name;
    if (body.color !== undefined) role.color = body.color;
    if (body.hoist !== undefined) role.hoist = body.hoist;
    if (body.mentionable !== undefined) role.mentionable = body.mentionable;
    this.audit_(31, roleId, reason);
    return this.leave(mode, clone(role));
  }

  async deleteRole(guildId: string, roleId: string, reason: string): Promise<void> {
    const mode = await this.enter('deleteRole', [guildId, roleId, reason]);
    const role = this.requireRole(roleId);
    const verdict = canBotManageRole(this.snapshotNow(), role, 'delete');
    if (!verdict.ok) this.forbid(verdict.reason!);
    this.roles.delete(roleId);
    for (const m of this.members.values()) m.roleIds = m.roleIds.filter((id) => id !== roleId);
    for (const c of this.channels.values()) c.overwrites = c.overwrites.filter((o) => o.id !== roleId);
    if (this.options.rolePositions === 'normalised') this.normaliseRolePositions();
    this.audit_(32, roleId, reason);
    return this.leave(mode, undefined);
  }

  async setRolePositions(guildId: string, updates: PositionUpdate[], reason: string): Promise<void> {
    const mode = await this.enter('setRolePositions', [guildId, updates, reason]);
    const snap = this.snapshotNow();
    const bot = botStanding(snap);
    for (const u of updates) {
      const role = this.requireRole(u.id);
      const verdict = canBotManageRole(snap, role, 'move');
      if (!verdict.ok) this.forbid(verdict.reason!);
      if (!bot.highestRole || u.position >= bot.highestRole.position) {
        this.forbid('cannot move a role to or above the bot');
      }
    }
    if (mode === 'ignored') return this.leave(mode, undefined);
    for (const u of updates) this.requireRole(u.id).position = u.position;
    if (this.options.rolePositions === 'normalised') this.normaliseRolePositions();
    return this.leave(mode, undefined);
  }

  async addMemberRole(guildId: string, userId: string, roleId: string, reason: string): Promise<void> {
    const mode = await this.enter('addMemberRole', [guildId, userId, roleId, reason]);
    const role = this.requireRole(roleId);
    const verdict = canBotManageRole(this.snapshotNow(), role, 'assign');
    if (!verdict.ok) this.forbid(verdict.reason!);
    const member = this.members.get(userId);
    if (!member)
      throw new DiscordRequestError('http', 'Discord rejected the request: Unknown Member', 404, 10007);
    if (!member.roleIds.includes(roleId)) member.roleIds.push(roleId);
    return this.leave(mode, undefined);
  }

  async removeMemberRole(guildId: string, userId: string, roleId: string, reason: string): Promise<void> {
    const mode = await this.enter('removeMemberRole', [guildId, userId, roleId, reason]);
    const role = this.requireRole(roleId);
    const verdict = canBotManageRole(this.snapshotNow(), role, 'assign');
    if (!verdict.ok) this.forbid(verdict.reason!);
    const member = this.members.get(userId);
    if (!member)
      throw new DiscordRequestError('http', 'Discord rejected the request: Unknown Member', 404, 10007);
    member.roleIds = member.roleIds.filter((id) => id !== roleId);
    return this.leave(mode, undefined);
  }

  async editGuild(guildId: string, body: GuildWriteBody, reason: string): Promise<GuildInfo> {
    const mode = await this.enter('editGuild', [guildId, body, reason]);
    this.requireGuildPerm(P.ManageGuild, 'editing the server needs Manage Server');
    const g = this.guild;
    if (body.name !== undefined) g.name = body.name;
    if (body.description !== undefined) g.description = body.description;
    if (body.verification_level !== undefined) g.verificationLevel = body.verification_level;
    if (body.default_message_notifications !== undefined)
      g.defaultMessageNotifications = body.default_message_notifications;
    if (body.explicit_content_filter !== undefined) g.explicitContentFilter = body.explicit_content_filter;
    if (body.afk_channel_id !== undefined) g.afkChannelId = body.afk_channel_id;
    if (body.afk_timeout !== undefined) g.afkTimeout = body.afk_timeout;
    if (body.system_channel_id !== undefined) g.systemChannelId = body.system_channel_id;
    if (body.system_channel_flags !== undefined) g.systemChannelFlags = body.system_channel_flags;
    if (body.rules_channel_id !== undefined) g.rulesChannelId = body.rules_channel_id;
    if (body.public_updates_channel_id !== undefined)
      g.publicUpdatesChannelId = body.public_updates_channel_id;
    if (body.safety_alerts_channel_id !== undefined) g.safetyAlertsChannelId = body.safety_alerts_channel_id;
    if (body.preferred_locale !== undefined) g.preferredLocale = body.preferred_locale;
    if (body.premium_progress_bar_enabled !== undefined)
      g.premiumProgressBarEnabled = body.premium_progress_bar_enabled;
    if (body.features !== undefined) {
      if (body.features.includes('COMMUNITY') && (!g.rulesChannelId || !g.publicUpdatesChannelId)) {
        throw new DiscordRequestError(
          'http',
          'Discord rejected the request: Community requires rules and updates channels',
          400,
          50035,
        );
      }
      g.features = [...body.features];
    }
    this.audit_(1, guildId, reason);
    return this.leave(mode, clone(g));
  }

  async sendMessage(channelId: string, body: MessageBody): Promise<MessageInfo> {
    const mode = await this.enter('sendMessage', [channelId, body]);
    const channel = this.requireChannel(channelId);
    const perms = botChannelPermissions(this.snapshotNow(), channel);
    if (!has(perms, P.ViewChannel | P.SendMessages))
      this.forbid('sending needs View Channel and Send Messages');
    if (body.embeds?.length && !has(perms, P.EmbedLinks)) this.forbid('embeds need Embed Links');
    if (body.nonce && body.enforce_nonce) {
      const existing = this.nonces.get(body.nonce);
      if (existing && this.messages.has(existing)) {
        const { body: _b, ...info } = this.messages.get(existing)!;
        return this.leave(mode, clone(info));
      }
    }
    const msg = {
      id: makeSnowflake(),
      channelId,
      authorId: this.botUserId,
      content: body.content ?? '',
      embeds: clone(body.embeds ?? []),
      componentCount: body.components?.length ?? 0,
      createdAt: new Date().toISOString(),
      editedAt: null,
      body: clone(body),
    };
    this.messages.set(msg.id, msg);
    if (body.nonce) this.nonces.set(body.nonce, msg.id);
    const { body: _b, ...info } = msg;
    return this.leave(mode, clone(info));
  }

  async editMessage(channelId: string, messageId: string, body: MessageBody): Promise<MessageInfo> {
    const mode = await this.enter('editMessage', [channelId, messageId, body]);
    const msg = this.messages.get(messageId);
    if (!msg || msg.channelId !== channelId) {
      throw new DiscordRequestError('http', 'Discord rejected the request: Unknown Message', 404, 10008);
    }
    if (msg.authorId !== this.botUserId) this.forbid('cannot edit a message authored by someone else');
    msg.content = body.content ?? '';
    msg.embeds = clone(body.embeds ?? []);
    msg.componentCount = body.components?.length ?? 0;
    msg.editedAt = new Date().toISOString();
    msg.body = clone(body);
    const { body: _b, ...info } = msg;
    return this.leave(mode, clone(info));
  }

  async deleteMessage(channelId: string, messageId: string, reason: string): Promise<void> {
    const mode = await this.enter('deleteMessage', [channelId, messageId, reason]);
    const msg = this.messages.get(messageId);
    if (!msg || msg.channelId !== channelId) {
      throw new DiscordRequestError('http', 'Discord rejected the request: Unknown Message', 404, 10008);
    }
    this.messages.delete(messageId);
    return this.leave(mode, undefined);
  }

  async createAutoModRule(guildId: string, body: AutoModWriteBody, reason: string): Promise<AutoModRuleInfo> {
    const mode = await this.enter('createAutoModRule', [guildId, body, reason]);
    this.requireGuildPerm(P.ManageGuild, 'automod needs Manage Server');
    const rule: AutoModRuleInfo = {
      id: makeSnowflake(),
      name: body.name ?? 'rule',
      eventType: body.event_type ?? 1,
      triggerType: body.trigger_type ?? 1,
      triggerMetadata: clone(body.trigger_metadata ?? {}),
      actions: clone(body.actions ?? []),
      enabled: body.enabled ?? false,
      exemptRoles: [...(body.exempt_roles ?? [])],
      exemptChannels: [...(body.exempt_channels ?? [])],
      creatorId: this.botUserId,
    };
    this.automod.set(rule.id, rule);
    this.audit_(140, rule.id, reason);
    return this.leave(mode, clone(rule));
  }

  async editAutoModRule(
    guildId: string,
    ruleId: string,
    body: AutoModWriteBody,
    reason: string,
  ): Promise<AutoModRuleInfo> {
    const mode = await this.enter('editAutoModRule', [guildId, ruleId, body, reason]);
    this.requireGuildPerm(P.ManageGuild, 'automod needs Manage Server');
    const rule = this.automod.get(ruleId);
    if (!rule || this.nativeAutomod.has(ruleId)) throw this.notFound();
    if (body.name !== undefined) rule.name = body.name;
    if (body.event_type !== undefined) rule.eventType = body.event_type;
    if (body.trigger_metadata !== undefined) rule.triggerMetadata = clone(body.trigger_metadata);
    if (body.actions !== undefined) rule.actions = clone(body.actions);
    if (body.enabled !== undefined) rule.enabled = body.enabled;
    if (body.exempt_roles !== undefined) rule.exemptRoles = [...body.exempt_roles];
    if (body.exempt_channels !== undefined) rule.exemptChannels = [...body.exempt_channels];
    return this.leave(mode, clone(rule));
  }

  async deleteAutoModRule(guildId: string, ruleId: string, reason: string): Promise<void> {
    const mode = await this.enter('deleteAutoModRule', [guildId, ruleId, reason]);
    this.requireGuildPerm(P.ManageGuild, 'automod needs Manage Server');
    if (this.nativeAutomod.has(ruleId) || !this.automod.delete(ruleId)) throw this.notFound();
    return this.leave(mode, undefined);
  }

  /** Every bit, for tests that want an all-powerful bot without Administrator. */
  static readonly EVERYTHING_BUT_ADMIN = ALL_PERMISSIONS & ~P.Administrator;
}
