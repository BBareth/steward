import type {
  AdapterEvents,
  AuditLogEntry,
  ButtonPressEvent,
  DiscordAdapter,
  ReactionAddEvent,
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
  BotProfileInfo,
  BotProfileWriteBody,
  ChannelExtras,
  ChannelInfo,
  ChannelLookup,
  ChannelWriteBody,
  ConnectionState,
  ConnectionStatus,
  EmojiInfo,
  EmojiWriteBody,
  GuildInfo,
  GuildSnapshot,
  GuildWriteBody,
  IncidentsInfo,
  IntegrationInfo,
  InviteInfo,
  InviteWriteBody,
  MemberInfo,
  MessageBody,
  MessageInfo,
  OnboardingInfo,
  OnboardingWriteBody,
  PositionUpdate,
  RoleInfo,
  RoleWriteBody,
  ScheduledEventInfo,
  ScheduledEventWriteBody,
  SoundInfo,
  SoundWriteBody,
  StickerFile,
  StickerInfo,
  StickerWriteBody,
  TemplateInfo,
  TemplateWriteBody,
  WebhookInfo,
  WebhookWriteBody,
  WelcomeScreenInfo,
  WelcomeScreenWriteBody,
  WidgetInfo,
} from '../../src/discord/types.js';
import { channelKindFromType } from '../../src/discord/types.js';
import { DiscordRequestError } from '../../src/util/errors.js';

/**
 * An in-memory Discord that enforces the rules steward has to cope with:
 * permission checks, role hierarchy, managed roles, position shuffling, nonce
 * de-duplication, channels hidden from a bot that cannot view them, and an
 * audit log. Faults can be injected per method.
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
  /**
   * Channel types refused without the Community feature (announcement is also
   * allowed with NEWS). Defaults to announcement and stage.
   */
  communityChannelTypes?: number[];
  /**
   * The guild channel list leaves out channels the bot cannot view, as Discord
   * does from 2026-11-16. true lists every channel, as Discord did before.
   * Reading a hidden channel by id answers 403 either way.
   */
  listHiddenChannels?: boolean;
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
   * 'hidden' rules also answer 404 when read by id; 'returns' rules accept
   * the delete and stay listed.
   */
  nativeAutomod = new Map<string, 'readable' | 'hidden' | 'returns'>();
  onboarding: OnboardingInfo = { enabled: false, mode: 0, defaultChannelIds: [], prompts: [] };
  /** null until someone sets one up, as Discord answers 404 before then. */
  welcomeScreen: (WelcomeScreenInfo & { enabled: boolean }) | null = null;
  widget: WidgetInfo = { enabled: false, channelId: null };
  botProfile: BotProfileInfo & { bio: string | null } = { nick: null, avatar: null, banner: null, bio: null };
  emojis = new Map<string, EmojiInfo>();
  stickers = new Map<string, StickerInfo & { file: StickerFile }>();
  sounds = new Map<string, SoundInfo>();
  scheduledEvents = new Map<string, ScheduledEventInfo>();
  invites = new Map<string, InviteInfo>();
  webhooks = new Map<string, WebhookInfo>();
  templates = new Map<string, TemplateInfo>();
  integrations = new Map<string, IntegrationInfo>();
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
      icon: null,
      banner: null,
      splash: null,
      discoverySplash: null,
      vanityUrlCode: null,
      incidents: null,
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
    native?: 'readable' | 'hidden' | 'returns',
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

  /**
   * Deny the bot's role View Channel on a channel, as someone editing its
   * permissions might. Returns a function that puts the old overwrites back.
   */
  hideFromBot(channelId: string): () => void {
    const channel = this.channels.get(channelId)!;
    const before = clone(channel.overwrites);
    channel.overwrites = channel.overwrites
      .filter((o) => o.id !== this.botRoleId)
      .concat([{ id: this.botRoleId, type: 'role', allow: 0n, deny: P.ViewChannel }]);
    return () => {
      this.channels.get(channelId)!.overwrites = before;
    };
  }

  addIntegration(spec: Partial<IntegrationInfo> & { name: string }): IntegrationInfo {
    const integration: IntegrationInfo = {
      id: makeSnowflake(),
      type: 'discord',
      enabled: true,
      applicationId: null,
      accountName: spec.name,
      ...spec,
    };
    this.integrations.set(integration.id, integration);
    return integration;
  }

  addEmoji(spec: Partial<EmojiInfo> & { name: string }): EmojiInfo {
    const emoji: EmojiInfo = {
      id: makeSnowflake(),
      animated: false,
      roleIds: [],
      managed: false,
      available: true,
      creatorId: this.ownerId,
      ...spec,
    };
    this.emojis.set(emoji.id, emoji);
    return emoji;
  }

  setBotRolePosition(position: number): void {
    this.roles.get(this.botRoleId)!.position = position;
  }

  setBotPermissions(perms: bigint): void {
    this.roles.get(this.botRoleId)!.permissions = perms;
  }

  /** Reactions per message, as `${encoded emoji}|${userId}`. */
  reactions = new Map<string, Set<string>>();

  /** Deliver a reaction the way the gateway would; `overrides` can drop fields Discord marks optional. */
  async emitReactionAdd(
    messageId: string,
    userId: string,
    emoji: { id: string | null; name: string | null },
    overrides: Partial<ReactionAddEvent> = {},
  ): Promise<void> {
    const msg = this.messages.get(messageId)!;
    const member = this.members.get(userId);
    const segment = encodeURIComponent(emoji.id ? `${emoji.name}:${emoji.id}` : (emoji.name ?? ''));
    if (!this.reactions.has(messageId)) this.reactions.set(messageId, new Set());
    this.reactions.get(messageId)!.add(`${segment}|${userId}`);
    await this.events.reactionAdd?.({
      guildId: this.guildId,
      channelId: msg.channelId,
      messageId,
      userId,
      messageAuthorId: msg.authorId,
      member: member ? { roleIds: [...member.roleIds], isBot: member.isBot } : null,
      emoji,
      burst: false,
      guildOwnerId: this.ownerId,
      botUserId: this.botUserId,
      ...overrides,
    });
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

  /** Discord's rule: View Channel, or for a category, any channel in it the bot can view. */
  private botCanView(snap: GuildSnapshot, channel: ChannelInfo): boolean {
    const view = (c: ChannelInfo) => has(botChannelPermissions(snap, c), P.ViewChannel);
    return (
      view(channel) ||
      (channel.kind === 'category' && snap.channels.some((c) => c.parentId === channel.id && view(c)))
    );
  }

  private missingAccess(): never {
    throw new DiscordRequestError('http', 'Discord rejected the request: Missing Access', 403, 50001);
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

  private needsCommunity(type: number): boolean {
    const f = this.guild.features;
    if (f.includes('COMMUNITY') || (type === 5 && f.includes('NEWS'))) return false;
    return (this.options.communityChannelTypes ?? [5, 13]).includes(type);
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

  private invalid(why: string, code = 50035): never {
    throw new DiscordRequestError(
      'http',
      `Discord rejected the request: Invalid Form Body (${why})`,
      400,
      code,
    );
  }

  private unknown(what: string, code: number): never {
    throw new DiscordRequestError('http', `Discord rejected the request: Unknown ${what}`, 404, code);
  }

  private needFeature(feature: string, why: string): void {
    if (!this.guild.features.includes(feature)) this.invalid(why);
  }

  /** Discord stores an image and hands back its hash; animated ones start with a_. */
  private hashOf(dataUri: string | null): string | null {
    if (dataUri === null) return null;
    return `${dataUri.startsWith('data:image/gif') ? 'a_' : ''}${BigInt(makeSnowflake()).toString(16)}`;
  }

  /** Create needs Create Expressions; changing someone else's needs Manage Expressions. */
  private requireExpressionPerm(creatorId: string | null | undefined, create: boolean): void {
    const perms = botStanding(this.snapshotNow()).permissions;
    if (create) {
      if (!has(perms, P.CreateGuildExpressions)) this.forbid('needs Create Expressions');
      return;
    }
    if (has(perms, P.ManageGuildExpressions)) return;
    if (creatorId === this.botUserId && has(perms, P.CreateGuildExpressions)) return;
    this.forbid('needs Manage Expressions');
  }

  private requireEventPerm(creatorId: string | null | undefined, create: boolean): void {
    const perms = botStanding(this.snapshotNow()).permissions;
    if (create) {
      if (!has(perms, P.CreateEvents)) this.forbid('needs Create Events');
      return;
    }
    if (has(perms, P.ManageEvents)) return;
    if (creatorId === this.botUserId && has(perms, P.CreateEvents)) return;
    this.forbid('needs Manage Events');
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
    const extra: ChannelExtras = { ...channel.extra };
    if (body.rtc_region !== undefined) extra.rtcRegion = body.rtc_region;
    if (body.video_quality_mode !== undefined) extra.videoQualityMode = body.video_quality_mode;
    if (body.default_auto_archive_duration !== undefined)
      extra.defaultAutoArchiveDuration = body.default_auto_archive_duration;
    if (body.default_thread_rate_limit_per_user !== undefined)
      extra.defaultThreadRateLimitPerUser = body.default_thread_rate_limit_per_user;
    if (body.available_tags !== undefined) {
      if (body.available_tags.length > 20) this.invalid('available_tags: at most 20');
      extra.availableTags = body.available_tags.map((t) => ({
        id: t.id ?? makeSnowflake(),
        name: t.name,
        moderated: t.moderated ?? false,
        emojiId: t.emoji_id ?? null,
        emojiName: t.emoji_name ?? null,
      }));
    }
    if (body.default_reaction_emoji !== undefined)
      extra.defaultReactionEmoji = body.default_reaction_emoji && {
        emojiId: body.default_reaction_emoji.emoji_id,
        emojiName: body.default_reaction_emoji.emoji_name,
      };
    if (body.default_sort_order !== undefined) extra.defaultSortOrder = body.default_sort_order;
    if (body.default_forum_layout !== undefined) extra.defaultForumLayout = body.default_forum_layout;
    if (body.flags !== undefined) extra.flags = body.flags;
    if (Object.keys(extra).length) channel.extra = extra;
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
    const snap = this.snapshotNow();
    if (!this.options.listHiddenChannels)
      snap.channels = snap.channels.filter((c) => this.botCanView(snap, c));
    return snap;
  }

  async fetchChannel(channelId: string): Promise<ChannelLookup> {
    await this.enter('fetchChannel', [channelId]);
    const channel = this.channels.get(channelId);
    if (!channel) return { status: 'missing' };
    if (!this.botCanView(this.snapshotNow(), channel)) return { status: 'hidden' };
    return { status: 'visible', channel: clone(channel), guildId: this.guildId };
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
    const channel = this.channels.get(channelId);
    if (
      channel &&
      !has(botChannelPermissions(this.snapshotNow(), channel), P.ViewChannel | P.ReadMessageHistory)
    )
      this.missingAccess();
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
    if (this.needsCommunity(type)) {
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
    if (body.type !== undefined && this.needsCommunity(body.type)) {
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
    if (body.icon !== undefined || body.unicode_emoji !== undefined)
      this.needFeature('ROLE_ICONS', 'role icons need boost level 2');
    if (body.icon !== undefined) {
      const hash = this.hashOf(body.icon);
      if (hash) role.icon = hash;
      else delete role.icon;
    }
    if (body.unicode_emoji !== undefined) {
      if (body.unicode_emoji) role.unicodeEmoji = body.unicode_emoji;
      else delete role.unicodeEmoji;
    }
    if (body.colors !== undefined) {
      const { primary_color, secondary_color, tertiary_color } = body.colors;
      if (typeof secondary_color === 'number')
        this.needFeature('ENHANCED_ROLE_COLORS', 'gradient colours need boosts');
      role.color = primary_color;
      if (typeof secondary_color === 'number') role.secondaryColor = secondary_color;
      else delete role.secondaryColor;
      if (typeof tertiary_color === 'number') role.tertiaryColor = tertiary_color;
      else delete role.tertiaryColor;
    }
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
    if (body.icon !== undefined) {
      if (body.icon?.startsWith('data:image/gif'))
        this.needFeature('ANIMATED_ICON', 'animated icons need boosts');
      g.icon = this.hashOf(body.icon);
    }
    if (body.banner !== undefined) {
      this.needFeature('BANNER', 'a banner needs boost level 2');
      g.banner = this.hashOf(body.banner);
    }
    if (body.splash !== undefined) {
      this.needFeature('INVITE_SPLASH', 'an invite splash needs boost level 1');
      g.splash = this.hashOf(body.splash);
    }
    if (body.discovery_splash !== undefined) {
      this.needFeature('DISCOVERABLE', 'a discovery splash needs Discovery');
      g.discoverySplash = this.hashOf(body.discovery_splash);
    }
    if (body.features !== undefined) {
      if (body.features.includes('COMMUNITY') !== g.features.includes('COMMUNITY')) {
        if (!botStanding(this.snapshotNow()).isAdmin) this.forbid('changing Community needs Administrator');
      }
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

  async removeUserReaction(
    channelId: string,
    messageId: string,
    emoji: string,
    userId: string,
  ): Promise<void> {
    const mode = await this.enter('removeUserReaction', [channelId, messageId, emoji, userId]);
    const msg = this.messages.get(messageId);
    if (!msg || msg.channelId !== channelId) {
      throw new DiscordRequestError('http', 'Discord rejected the request: Unknown Message', 404, 10008);
    }
    const perms = botChannelPermissions(this.snapshotNow(), this.requireChannel(channelId));
    if (!has(perms, P.ManageMessages)) this.forbid("removing others' reactions needs Manage Messages");
    this.reactions.get(messageId)?.delete(`${emoji}|${userId}`);
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
    if (!rule || (this.nativeAutomod.has(ruleId) && this.nativeAutomod.get(ruleId) !== 'returns'))
      throw this.notFound();
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
    const native = this.nativeAutomod.get(ruleId);
    if (native === 'returns' && this.automod.has(ruleId)) return this.leave(mode, undefined);
    if (native || !this.automod.delete(ruleId)) throw this.notFound();
    return this.leave(mode, undefined);
  }

  async fetchOnboarding(guildId: string): Promise<OnboardingInfo> {
    await this.enter('fetchOnboarding', [guildId]);
    this.requireGuildPerm(P.ManageGuild, 'onboarding needs Manage Server');
    return clone(this.onboarding);
  }

  async putOnboarding(guildId: string, body: OnboardingWriteBody, reason: string): Promise<OnboardingInfo> {
    const mode = await this.enter('putOnboarding', [guildId, body, reason]);
    this.requireGuildPerm(P.ManageGuild | P.ManageRoles, 'onboarding needs Manage Server and Manage Roles');
    if (!this.guild.features.includes('COMMUNITY')) this.invalid('onboarding needs Community', 350000);
    for (const id of body.default_channel_ids) this.requireChannel(id);
    for (const p of body.prompts)
      for (const o of p.options) {
        for (const id of o.channel_ids) this.requireChannel(id);
        for (const id of o.role_ids) this.requireRole(id);
      }
    // Advanced mode counts channels from answers towards the minimum too.
    const counted = new Set(body.default_channel_ids);
    if (body.mode === 1)
      for (const p of body.prompts) for (const o of p.options) o.channel_ids.forEach((id) => counted.add(id));
    if (body.enabled && counted.size < 7)
      this.invalid('onboarding needs at least 7 default channels', 350000);
    this.onboarding = {
      enabled: body.enabled,
      mode: body.mode,
      defaultChannelIds: [...body.default_channel_ids],
      prompts: body.prompts.map((p) => ({
        id: p.id,
        title: p.title,
        type: p.type,
        singleSelect: p.single_select,
        required: p.required,
        inOnboarding: p.in_onboarding,
        options: p.options.map((o) => ({
          id: o.id,
          title: o.title,
          description: o.description,
          channelIds: [...o.channel_ids],
          roleIds: [...o.role_ids],
          emojiId: o.emoji_id ?? null,
          emojiName: o.emoji_name ?? null,
        })),
      })),
    };
    this.audit_(167, guildId, reason);
    return this.leave(mode, clone(this.onboarding));
  }

  async fetchWelcomeScreen(guildId: string): Promise<WelcomeScreenInfo | null> {
    await this.enter('fetchWelcomeScreen', [guildId]);
    if (!this.welcomeScreen) return null;
    const { enabled: _e, ...info } = this.welcomeScreen;
    return clone(info);
  }

  async editWelcomeScreen(
    guildId: string,
    body: WelcomeScreenWriteBody,
    reason: string,
  ): Promise<WelcomeScreenInfo> {
    const mode = await this.enter('editWelcomeScreen', [guildId, body, reason]);
    this.requireGuildPerm(P.ManageGuild, 'the welcome screen needs Manage Server');
    if (body.welcome_channels && body.welcome_channels.length > 5) this.invalid('at most 5 welcome channels');
    for (const c of body.welcome_channels ?? []) this.requireChannel(c.channel_id);
    const screen = this.welcomeScreen ?? { enabled: false, description: null, channels: [] };
    if (body.enabled !== undefined) screen.enabled = body.enabled;
    if (body.description !== undefined) screen.description = body.description;
    if (body.welcome_channels !== undefined)
      screen.channels = body.welcome_channels.map((c) => ({
        channelId: c.channel_id,
        description: c.description,
        emojiId: c.emoji_id,
        emojiName: c.emoji_name,
      }));
    this.welcomeScreen = screen;
    const { enabled: _e, ...info } = screen;
    this.audit_(1, guildId, reason);
    return this.leave(mode, clone(info));
  }

  async fetchWidget(guildId: string): Promise<WidgetInfo> {
    await this.enter('fetchWidget', [guildId]);
    this.requireGuildPerm(P.ManageGuild, 'the widget needs Manage Server');
    return clone(this.widget);
  }

  async editWidget(
    guildId: string,
    body: { enabled?: boolean; channel_id?: string | null },
    reason: string,
  ): Promise<WidgetInfo> {
    const mode = await this.enter('editWidget', [guildId, body, reason]);
    this.requireGuildPerm(P.ManageGuild, 'the widget needs Manage Server');
    if (body.channel_id) this.requireChannel(body.channel_id);
    if (body.enabled !== undefined) this.widget.enabled = body.enabled;
    if (body.channel_id !== undefined) this.widget.channelId = body.channel_id;
    this.audit_(1, guildId, reason);
    return this.leave(mode, clone(this.widget));
  }

  async setIncidentActions(
    guildId: string,
    body: { invites_disabled_until?: string | null; dms_disabled_until?: string | null },
    reason: string,
  ): Promise<IncidentsInfo> {
    const mode = await this.enter('setIncidentActions', [guildId, body, reason]);
    this.requireGuildPerm(P.ManageGuild, 'security actions need Manage Server');
    const limit = Date.now() + 24 * 3600_000 + 60_000;
    for (const until of [body.invites_disabled_until, body.dms_disabled_until])
      if (until && Date.parse(until) > limit) this.invalid('security actions last at most 24 hours');
    const incidents: IncidentsInfo = {
      invitesDisabledUntil: body.invites_disabled_until ?? null,
      dmsDisabledUntil: body.dms_disabled_until ?? null,
    };
    this.guild.incidents = incidents;
    return this.leave(mode, clone(incidents));
  }

  async editBotProfile(guildId: string, body: BotProfileWriteBody, reason: string): Promise<BotProfileInfo> {
    const mode = await this.enter('editBotProfile', [guildId, body, reason]);
    if (body.nick !== undefined) this.requireGuildPerm(P.ChangeNickname, 'a nickname needs Change Nickname');
    if (body.nick !== undefined) this.botProfile.nick = body.nick || null;
    if (body.avatar !== undefined) this.botProfile.avatar = this.hashOf(body.avatar);
    if (body.banner !== undefined) this.botProfile.banner = this.hashOf(body.banner);
    if (body.bio !== undefined) this.botProfile.bio = body.bio;
    const { bio: _b, ...info } = this.botProfile;
    return this.leave(mode, clone(info));
  }

  async fetchEmojis(guildId: string): Promise<EmojiInfo[]> {
    await this.enter('fetchEmojis', [guildId]);
    return [...this.emojis.values()].map(clone);
  }

  async createEmoji(guildId: string, body: EmojiWriteBody, reason: string): Promise<EmojiInfo> {
    const mode = await this.enter('createEmoji', [guildId, body, reason]);
    this.requireExpressionPerm(undefined, true);
    const animated = Boolean(body.image?.startsWith('data:image/gif'));
    const slots = [50, 100, 150, 250][this.guild.premiumTier] ?? 50;
    if ([...this.emojis.values()].filter((e) => e.animated === animated).length >= slots)
      throw new DiscordRequestError(
        'http',
        'Discord rejected the request: Maximum number of emojis reached',
        400,
        30008,
      );
    for (const id of body.roles ?? []) this.requireRole(id);
    const emoji: EmojiInfo = {
      id: makeSnowflake(),
      name: body.name ?? 'emoji',
      animated,
      roleIds: [...(body.roles ?? [])],
      managed: false,
      available: true,
      creatorId: this.botUserId,
    };
    this.emojis.set(emoji.id, emoji);
    this.audit_(60, emoji.id, reason);
    return this.leave(mode, clone(emoji));
  }

  async editEmoji(
    guildId: string,
    emojiId: string,
    body: EmojiWriteBody,
    reason: string,
  ): Promise<EmojiInfo> {
    const mode = await this.enter('editEmoji', [guildId, emojiId, body, reason]);
    const emoji = this.emojis.get(emojiId) ?? this.unknown('Emoji', 10014);
    this.requireExpressionPerm(emoji.creatorId, false);
    for (const id of body.roles ?? []) this.requireRole(id);
    if (body.name !== undefined) emoji.name = body.name;
    if (body.roles !== undefined) emoji.roleIds = [...body.roles];
    this.audit_(61, emojiId, reason);
    return this.leave(mode, clone(emoji));
  }

  async deleteEmoji(guildId: string, emojiId: string, reason: string): Promise<void> {
    const mode = await this.enter('deleteEmoji', [guildId, emojiId, reason]);
    const emoji = this.emojis.get(emojiId) ?? this.unknown('Emoji', 10014);
    this.requireExpressionPerm(emoji.creatorId, false);
    this.emojis.delete(emojiId);
    this.audit_(62, emojiId, reason);
    return this.leave(mode, undefined);
  }

  async fetchStickers(guildId: string): Promise<StickerInfo[]> {
    await this.enter('fetchStickers', [guildId]);
    return [...this.stickers.values()].map(({ file: _f, ...info }) => clone(info));
  }

  async createSticker(
    guildId: string,
    body: Required<StickerWriteBody>,
    file: StickerFile,
    reason: string,
  ): Promise<StickerInfo> {
    const mode = await this.enter('createSticker', [guildId, body, reason]);
    this.requireExpressionPerm(undefined, true);
    const slots = [5, 15, 30, 60][this.guild.premiumTier] ?? 5;
    if (this.stickers.size >= slots)
      throw new DiscordRequestError(
        'http',
        'Discord rejected the request: Maximum number of stickers reached',
        400,
        30039,
      );
    const formats: Record<string, number> = {
      'image/png': 1,
      'image/apng': 2,
      'application/json': 3,
      'image/gif': 4,
    };
    const sticker = {
      id: makeSnowflake(),
      name: body.name,
      description: body.description || null,
      tags: body.tags,
      formatType: formats[file.contentType] ?? 1,
      available: true,
      creatorId: this.botUserId,
      file: { ...file },
    };
    this.stickers.set(sticker.id, sticker);
    this.audit_(90, sticker.id, reason);
    const { file: _f, ...info } = sticker;
    return this.leave(mode, clone(info));
  }

  async editSticker(
    guildId: string,
    stickerId: string,
    body: StickerWriteBody,
    reason: string,
  ): Promise<StickerInfo> {
    const mode = await this.enter('editSticker', [guildId, stickerId, body, reason]);
    const sticker = this.stickers.get(stickerId) ?? this.unknown('Sticker', 10060);
    this.requireExpressionPerm(sticker.creatorId, false);
    if (body.name !== undefined) sticker.name = body.name;
    if (body.description !== undefined) sticker.description = body.description || null;
    if (body.tags !== undefined) sticker.tags = body.tags;
    this.audit_(91, stickerId, reason);
    const { file: _f, ...info } = sticker;
    return this.leave(mode, clone(info));
  }

  async deleteSticker(guildId: string, stickerId: string, reason: string): Promise<void> {
    const mode = await this.enter('deleteSticker', [guildId, stickerId, reason]);
    const sticker = this.stickers.get(stickerId) ?? this.unknown('Sticker', 10060);
    this.requireExpressionPerm(sticker.creatorId, false);
    this.stickers.delete(stickerId);
    this.audit_(92, stickerId, reason);
    return this.leave(mode, undefined);
  }

  async fetchSounds(guildId: string): Promise<SoundInfo[]> {
    await this.enter('fetchSounds', [guildId]);
    return [...this.sounds.values()].map(clone);
  }

  async createSound(guildId: string, body: SoundWriteBody, reason: string): Promise<SoundInfo> {
    const mode = await this.enter('createSound', [guildId, body, reason]);
    this.requireExpressionPerm(undefined, true);
    const slots = [8, 24, 36, 48][this.guild.premiumTier] ?? 8;
    if (this.sounds.size >= slots)
      throw new DiscordRequestError(
        'http',
        'Discord rejected the request: Maximum number of soundboard sounds reached',
        400,
        30045,
      );
    const sound: SoundInfo = {
      id: makeSnowflake(),
      name: body.name ?? 'sound',
      volume: body.volume ?? 1,
      emojiId: body.emoji_id ?? null,
      emojiName: body.emoji_name ?? null,
      available: true,
      creatorId: this.botUserId,
    };
    this.sounds.set(sound.id, sound);
    this.audit_(130, sound.id, reason);
    return this.leave(mode, clone(sound));
  }

  async editSound(
    guildId: string,
    soundId: string,
    body: SoundWriteBody,
    reason: string,
  ): Promise<SoundInfo> {
    const mode = await this.enter('editSound', [guildId, soundId, body, reason]);
    const sound = this.sounds.get(soundId) ?? this.unknown('Sound', 10097);
    this.requireExpressionPerm(sound.creatorId, false);
    if (body.name !== undefined) sound.name = body.name;
    if (body.volume !== undefined) sound.volume = body.volume ?? 1;
    if (body.emoji_id !== undefined) sound.emojiId = body.emoji_id;
    if (body.emoji_name !== undefined) sound.emojiName = body.emoji_name;
    this.audit_(131, soundId, reason);
    return this.leave(mode, clone(sound));
  }

  async deleteSound(guildId: string, soundId: string, reason: string): Promise<void> {
    const mode = await this.enter('deleteSound', [guildId, soundId, reason]);
    const sound = this.sounds.get(soundId) ?? this.unknown('Sound', 10097);
    this.requireExpressionPerm(sound.creatorId, false);
    this.sounds.delete(soundId);
    this.audit_(132, soundId, reason);
    return this.leave(mode, undefined);
  }

  async fetchScheduledEvents(guildId: string): Promise<ScheduledEventInfo[]> {
    await this.enter('fetchScheduledEvents', [guildId]);
    return [...this.scheduledEvents.values()].map(clone);
  }

  private checkEventShape(e: ScheduledEventInfo): void {
    if (e.entityType === 3) {
      if (!e.location) this.invalid('external events need a location');
      if (!e.endTime) this.invalid('external events need an end time');
      if (e.channelId) this.invalid('external events have no channel');
    } else {
      if (!e.channelId) this.invalid('stage and voice events need a channel');
      const channel = this.requireChannel(e.channelId);
      if (channel.type !== (e.entityType === 1 ? 13 : 2))
        this.invalid('channel type does not match the event');
    }
    if (e.endTime && Date.parse(e.endTime) <= Date.parse(e.startTime)) this.invalid('end before start');
  }

  async createScheduledEvent(
    guildId: string,
    body: ScheduledEventWriteBody,
    reason: string,
  ): Promise<ScheduledEventInfo> {
    const mode = await this.enter('createScheduledEvent', [guildId, body, reason]);
    this.requireEventPerm(undefined, true);
    if (!body.scheduled_start_time || Date.parse(body.scheduled_start_time) < Date.now())
      this.invalid('scheduled_start_time must be in the future');
    const event: ScheduledEventInfo = {
      id: makeSnowflake(),
      name: body.name ?? 'event',
      description: body.description ?? null,
      channelId: body.channel_id ?? null,
      entityType: body.entity_type ?? 3,
      location: body.entity_metadata?.location ?? null,
      startTime: body.scheduled_start_time,
      endTime: body.scheduled_end_time ?? null,
      status: 1,
      userCount: 0,
      image: this.hashOf(body.image ?? null),
      recurrence: clone(body.recurrence_rule ?? null),
      creatorId: this.botUserId,
    };
    this.checkEventShape(event);
    this.scheduledEvents.set(event.id, event);
    this.audit_(100, event.id, reason);
    return this.leave(mode, clone(event));
  }

  async editScheduledEvent(
    guildId: string,
    eventId: string,
    body: ScheduledEventWriteBody,
    reason: string,
  ): Promise<ScheduledEventInfo> {
    const mode = await this.enter('editScheduledEvent', [guildId, eventId, body, reason]);
    const current = this.scheduledEvents.get(eventId) ?? this.unknown('Guild Scheduled Event', 10070);
    this.requireEventPerm(current.creatorId, false);
    const next = clone(current);
    if (body.name !== undefined) next.name = body.name;
    if (body.description !== undefined) next.description = body.description;
    if (body.channel_id !== undefined) next.channelId = body.channel_id;
    if (body.entity_type !== undefined) next.entityType = body.entity_type;
    if (body.entity_metadata !== undefined) next.location = body.entity_metadata?.location ?? null;
    if (body.scheduled_start_time !== undefined) next.startTime = body.scheduled_start_time;
    if (body.scheduled_end_time !== undefined) next.endTime = body.scheduled_end_time;
    if (body.image !== undefined) next.image = this.hashOf(body.image);
    if (body.recurrence_rule !== undefined) next.recurrence = clone(body.recurrence_rule);
    if (body.status !== undefined) {
      const allowed: Record<number, number[]> = { 1: [2, 4], 2: [3] };
      if (!(allowed[current.status] ?? []).includes(body.status))
        this.invalid('that status change is not allowed');
      next.status = body.status;
    }
    this.checkEventShape(next);
    this.scheduledEvents.set(eventId, next);
    this.audit_(101, eventId, reason);
    return this.leave(mode, clone(next));
  }

  async deleteScheduledEvent(guildId: string, eventId: string, reason: string): Promise<void> {
    const mode = await this.enter('deleteScheduledEvent', [guildId, eventId, reason]);
    const event = this.scheduledEvents.get(eventId) ?? this.unknown('Guild Scheduled Event', 10070);
    this.requireEventPerm(event.creatorId, false);
    this.scheduledEvents.delete(eventId);
    this.audit_(102, eventId, reason);
    return this.leave(mode, undefined);
  }

  async fetchInvites(guildId: string): Promise<InviteInfo[]> {
    await this.enter('fetchInvites', [guildId]);
    this.requireGuildPerm(P.ManageGuild, 'listing invites needs Manage Server');
    return [...this.invites.values()].map(clone);
  }

  async createInvite(channelId: string, body: InviteWriteBody, reason: string): Promise<InviteInfo> {
    const mode = await this.enter('createInvite', [channelId, body, reason]);
    const channel = this.requireChannel(channelId);
    const snap = this.snapshotNow();
    if (!has(botChannelPermissions(snap, channel), P.CreateInstantInvite)) this.forbid('needs Create Invite');
    for (const id of body.role_ids ?? []) {
      const verdict = canBotManageRole(snap, this.requireRole(id), 'assign');
      if (!verdict.ok) this.forbid(verdict.reason!);
    }
    const now = new Date();
    const maxAge = body.max_age ?? 86400;
    const invite: InviteInfo = {
      code: BigInt(makeSnowflake()).toString(36).slice(-8),
      channelId,
      inviterId: this.botUserId,
      uses: 0,
      maxUses: body.max_uses ?? 0,
      maxAge,
      temporary: body.temporary ?? false,
      createdAt: now.toISOString(),
      expiresAt: maxAge ? new Date(now.getTime() + maxAge * 1000).toISOString() : null,
      roleIds: [...(body.role_ids ?? [])],
    };
    this.invites.set(invite.code, invite);
    this.audit_(40, channelId, reason);
    return this.leave(mode, clone(invite));
  }

  async deleteInvite(code: string, reason: string): Promise<void> {
    const mode = await this.enter('deleteInvite', [code, reason]);
    const invite = this.invites.get(code) ?? this.unknown('Invite', 10006);
    const snap = this.snapshotNow();
    const channel = invite.channelId ? this.channels.get(invite.channelId) : undefined;
    const ok =
      has(botStanding(snap).permissions, P.ManageGuild) ||
      (channel !== undefined && has(botChannelPermissions(snap, channel), P.ManageChannels));
    if (!ok) this.forbid('deleting invites needs Manage Channels or Manage Server');
    this.invites.delete(code);
    this.audit_(42, invite.channelId, reason);
    return this.leave(mode, undefined);
  }

  async fetchWebhooks(guildId: string): Promise<WebhookInfo[]> {
    await this.enter('fetchWebhooks', [guildId]);
    this.requireGuildPerm(P.ManageWebhooks, 'webhooks need Manage Webhooks');
    return [...this.webhooks.values()].map(clone);
  }

  private checkWebhookName(name: string | undefined): void {
    if (name !== undefined && /clyde|discord/i.test(name))
      this.invalid('webhook names cannot contain "clyde" or "discord"');
  }

  async createWebhook(channelId: string, body: WebhookWriteBody, reason: string): Promise<WebhookInfo> {
    const mode = await this.enter('createWebhook', [channelId, body, reason]);
    const channel = this.requireChannel(channelId);
    if (!has(botChannelPermissions(this.snapshotNow(), channel), P.ManageWebhooks))
      this.forbid('webhooks need Manage Webhooks');
    this.checkWebhookName(body.name);
    if ([...this.webhooks.values()].filter((w) => w.channelId === channelId).length >= 15)
      throw new DiscordRequestError(
        'http',
        'Discord rejected the request: Maximum number of webhooks reached',
        400,
        30007,
      );
    const webhook: WebhookInfo = {
      id: makeSnowflake(),
      type: 1,
      channelId,
      name: body.name ?? 'Captain Hook',
      avatar: this.hashOf(body.avatar ?? null),
      applicationId: this.botUserId,
      creatorId: this.botUserId,
    };
    this.webhooks.set(webhook.id, webhook);
    this.audit_(50, webhook.id, reason);
    return this.leave(mode, clone(webhook));
  }

  async editWebhook(webhookId: string, body: WebhookWriteBody, reason: string): Promise<WebhookInfo> {
    const mode = await this.enter('editWebhook', [webhookId, body, reason]);
    const webhook = this.webhooks.get(webhookId) ?? this.unknown('Webhook', 10015);
    this.requireGuildPerm(P.ManageWebhooks, 'webhooks need Manage Webhooks');
    this.checkWebhookName(body.name);
    if (body.channel_id !== undefined) this.requireChannel(body.channel_id);
    if (body.name !== undefined) webhook.name = body.name;
    if (body.avatar !== undefined) webhook.avatar = this.hashOf(body.avatar);
    if (body.channel_id !== undefined) webhook.channelId = body.channel_id;
    this.audit_(51, webhookId, reason);
    return this.leave(mode, clone(webhook));
  }

  async deleteWebhook(webhookId: string, reason: string): Promise<void> {
    const mode = await this.enter('deleteWebhook', [webhookId, reason]);
    if (!this.webhooks.has(webhookId)) this.unknown('Webhook', 10015);
    this.requireGuildPerm(P.ManageWebhooks, 'webhooks need Manage Webhooks');
    this.webhooks.delete(webhookId);
    this.audit_(52, webhookId, reason);
    return this.leave(mode, undefined);
  }

  async fetchTemplates(guildId: string): Promise<TemplateInfo[]> {
    await this.enter('fetchTemplates', [guildId]);
    this.requireGuildPerm(P.ManageGuild, 'templates need Manage Server');
    return [...this.templates.values()].map(clone);
  }

  async createTemplate(guildId: string, body: TemplateWriteBody, reason: string): Promise<TemplateInfo> {
    const mode = await this.enter('createTemplate', [guildId, body, reason]);
    this.requireGuildPerm(P.ManageGuild, 'templates need Manage Server');
    if (this.templates.size > 0)
      throw new DiscordRequestError(
        'http',
        'Discord rejected the request: Guild already has a template',
        400,
        30031,
      );
    const now = new Date().toISOString();
    const template: TemplateInfo = {
      code: BigInt(makeSnowflake()).toString(36).slice(-12),
      name: body.name ?? 'template',
      description: body.description ?? null,
      usageCount: 0,
      creatorId: this.botUserId,
      createdAt: now,
      updatedAt: now,
      isDirty: false,
    };
    this.templates.set(template.code, template);
    return this.leave(mode, clone(template));
  }

  async editTemplate(
    guildId: string,
    code: string,
    body: TemplateWriteBody,
    reason: string,
  ): Promise<TemplateInfo> {
    const mode = await this.enter('editTemplate', [guildId, code, body, reason]);
    this.requireGuildPerm(P.ManageGuild, 'templates need Manage Server');
    const template = this.templates.get(code) ?? this.unknown('Guild Template', 10057);
    if (body.name !== undefined) template.name = body.name;
    if (body.description !== undefined) template.description = body.description;
    return this.leave(mode, clone(template));
  }

  async syncTemplate(guildId: string, code: string, reason: string): Promise<TemplateInfo> {
    const mode = await this.enter('syncTemplate', [guildId, code, reason]);
    this.requireGuildPerm(P.ManageGuild, 'templates need Manage Server');
    const template = this.templates.get(code) ?? this.unknown('Guild Template', 10057);
    template.updatedAt = new Date().toISOString();
    template.isDirty = false;
    return this.leave(mode, clone(template));
  }

  async deleteTemplate(guildId: string, code: string, reason: string): Promise<void> {
    const mode = await this.enter('deleteTemplate', [guildId, code, reason]);
    this.requireGuildPerm(P.ManageGuild, 'templates need Manage Server');
    if (!this.templates.delete(code)) this.unknown('Guild Template', 10057);
    return this.leave(mode, undefined);
  }

  async fetchIntegrations(guildId: string): Promise<IntegrationInfo[]> {
    await this.enter('fetchIntegrations', [guildId]);
    this.requireGuildPerm(P.ManageGuild, 'integrations need Manage Server');
    return [...this.integrations.values()].map(clone);
  }

  async deleteIntegration(guildId: string, integrationId: string, reason: string): Promise<void> {
    const mode = await this.enter('deleteIntegration', [guildId, integrationId, reason]);
    this.requireGuildPerm(P.ManageGuild, 'integrations need Manage Server');
    if (!this.integrations.delete(integrationId)) this.unknown('Integration', 10005);
    this.audit_(82, integrationId, reason);
    return this.leave(mode, undefined);
  }

  /** Every bit, for tests that want an all-powerful bot without Administrator. */
  static readonly EVERYTHING_BUT_ADMIN = ALL_PERMISSIONS & ~P.Administrator;
}
