import type { ClientOptions, Interaction } from 'discord.js';
import { Client, DiscordAPIError, Events, GatewayIntentBits, HTTPError, MessageFlags } from 'discord.js';
import type {
  APIAuditLog,
  APIAutoModerationRule,
  APIChannel,
  APIGuild,
  APIGuildMember,
  APIMessage,
  APIRole,
} from 'discord-api-types/v10';
import { Routes } from 'discord-api-types/v10';
import type { Logger } from '../logger.js';
import { redactText } from '../logger.js';
import { DiscordRequestError, StewardError } from '../util/errors.js';
import type { AdapterEvents, AuditLogEntry, DiscordAdapter, ReactionAddEvent } from './adapter.js';
import {
  normaliseAuditEntry,
  normaliseAutoModRule,
  normaliseChannel,
  normaliseGuild,
  normaliseMember,
  normaliseMessage,
  normaliseRole,
} from './normalize.js';
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
} from './types.js';

export interface DiscordJsAdapterOptions {
  token: string;
  membersIntent: boolean;
  /** Request Guild Message Reactions (not privileged) and deliver reactionAdd events. */
  reactionIntent?: boolean;
  requestTimeoutMs: number;
  allowedGuildIds: readonly string[];
  logger: Logger;
  /** Tests pass a stand-in for the discord.js client. */
  clientFactory?: (options: ClientOptions) => Client;
}

const isId = (v: unknown): v is string => typeof v === 'string' && /^\d{1,20}$/.test(v);

/**
 * The parts of a raw MESSAGE_REACTION_ADD dispatch steward uses, or null for
 * anything else. Raw packets are untyped, so every field is checked. Working
 * from the raw event means reactions on messages discord.js never cached (all
 * of steward's own posts, which go out over REST) are seen without partials.
 */
export function parseReactionAdd(
  packet: unknown,
): Omit<ReactionAddEvent, 'guildOwnerId' | 'botUserId'> | null {
  const p = packet as { op?: unknown; t?: unknown; d?: Record<string, unknown> } | null;
  if (!p || p.op !== 0 || p.t !== 'MESSAGE_REACTION_ADD' || !p.d || typeof p.d !== 'object') return null;
  const d = p.d;
  if (!isId(d.guild_id) || !isId(d.channel_id) || !isId(d.message_id) || !isId(d.user_id)) return null;
  const emoji = d.emoji as { id?: unknown; name?: unknown } | undefined;
  if (!emoji || typeof emoji !== 'object') return null;
  const member = d.member as { roles?: unknown; user?: { bot?: unknown } } | undefined;
  const roles = Array.isArray(member?.roles) ? member.roles.filter(isId) : null;
  return {
    guildId: d.guild_id,
    channelId: d.channel_id,
    messageId: d.message_id,
    userId: d.user_id,
    messageAuthorId: isId(d.message_author_id) ? d.message_author_id : null,
    member: roles
      ? {
          roleIds: roles,
          isBot: member?.user && typeof member.user === 'object' ? member.user.bot === true : null,
        }
      : null,
    emoji: {
      id: isId(emoji.id) ? emoji.id : null,
      name: typeof emoji.name === 'string' && emoji.name ? emoji.name : null,
    },
    burst: d.burst === true,
  };
}

const NETWORK_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']);

/** Map a discord.js / undici failure onto steward's error model. */
export function toRequestError(error: unknown): Error {
  if (error instanceof DiscordRequestError || error instanceof StewardError) return error;
  if (error instanceof DiscordAPIError) {
    return new DiscordRequestError(
      'http',
      `Discord rejected the request: ${error.message}`,
      error.status,
      typeof error.code === 'number' ? error.code : undefined,
    );
  }
  if (error instanceof HTTPError) {
    return new DiscordRequestError(
      'server',
      `Discord returned HTTP ${error.status}; the outcome is unknown`,
      error.status,
    );
  }
  const e = error as { name?: string; code?: string; message?: string; cause?: { code?: string } };
  if (e?.name === 'AbortError') {
    return new DiscordRequestError(
      'timeout',
      'the request to Discord timed out; it may or may not have been applied',
    );
  }
  const code = e?.code ?? e?.cause?.code;
  if (
    (code && (NETWORK_CODES.has(code) || code.startsWith('UND_ERR'))) ||
    /ECONNRESET|socket hang up/i.test(e?.message ?? '')
  ) {
    return new DiscordRequestError(
      'network',
      `network error talking to Discord (${code ?? 'connection reset'})`,
    );
  }
  return new DiscordRequestError('network', redactText(e?.message ?? 'unknown error talking to Discord'));
}

const truncateReason = (reason: string) => (reason.length > 500 ? `${reason.slice(0, 497)}...` : reason);

export class DiscordJsAdapter implements DiscordAdapter {
  private client: Client | null = null;
  private stopped = false;
  private events: AdapterEvents = {};
  private current: ConnectionStatus = {
    state: 'starting',
    since: new Date().toISOString(),
    detail: null,
    botUserId: null,
    botTag: null,
    applicationId: null,
    guildIds: [],
  };

  constructor(private readonly options: DiscordJsAdapterOptions) {}

  status(): ConnectionStatus {
    return { ...this.current, guildIds: [...this.current.guildIds] };
  }

  private setState(state: ConnectionState, detail: string | null = null): void {
    if (this.current.state !== state || this.current.detail !== detail) {
      this.current = {
        ...this.current,
        state,
        detail: detail ? redactText(detail) : null,
        since: new Date().toISOString(),
      };
      const log =
        state === 'failed' || state === 'disconnected' ? this.options.logger.warn : this.options.logger.info;
      log('discord connection state changed', { state, detail: this.current.detail });
    }
  }

  private intents(): GatewayIntentBits[] {
    // Guilds: guild, channel and role lifecycle. GuildMembers is privileged and
    // only requested for welcome messages and join roles.
    const intents = [GatewayIntentBits.Guilds];
    if (this.options.membersIntent) intents.push(GatewayIntentBits.GuildMembers);
    // Not privileged. Only for the reaction guard; message content is never needed.
    if (this.options.reactionIntent) intents.push(GatewayIntentBits.GuildMessageReactions);
    return intents;
  }

  private buildClient(): Client {
    const make = this.options.clientFactory ?? ((options: ClientOptions) => new Client(options));
    const client = make({
      intents: this.intents(),
      // Retries are disabled on purpose: @discordjs/rest would otherwise replay
      // a timed-out POST, which can create a duplicate channel or role. Rate
      // limits (429) are still queued and waited out by the library.
      rest: { retries: 0, timeout: this.options.requestTimeoutMs },
      allowedMentions: { parse: [] },
    });

    client.once(Events.ClientReady, (c) => {
      this.current = {
        ...this.current,
        botUserId: c.user.id,
        botTag: c.user.tag,
        applicationId: c.application?.id ?? c.user.id,
        guildIds: [...c.guilds.cache.keys()],
      };
      this.setState('ready');
      const missing = this.options.allowedGuildIds.filter((id) => !c.guilds.cache.has(id));
      if (missing.length > 0) {
        this.options.logger.warn('bot is not a member of some configured guilds', { guildIds: missing });
      }
    });
    client.on(Events.ShardDisconnect, (event) =>
      this.setState('disconnected', `gateway closed with code ${event.code}`),
    );
    client.on(Events.ShardReconnecting, () => this.setState('reconnecting', 'gateway reconnecting'));
    client.on(Events.ShardResume, () => this.setState('ready'));
    client.on(Events.ShardReady, () => {
      if (this.current.botUserId) this.setState('ready');
    });
    client.on(Events.Invalidated, () =>
      this.setState('failed', 'Discord invalidated the session; check the bot token'),
    );
    client.on(Events.ShardError, (error) => this.options.logger.warn('gateway error', { error }));
    client.on(Events.Error, (error) => this.options.logger.error('discord client error', { error }));
    client.on(Events.GuildCreate, (g) => {
      if (!this.current.guildIds.includes(g.id)) this.current.guildIds.push(g.id);
    });
    client.on(Events.GuildDelete, (g) => {
      this.current.guildIds = this.current.guildIds.filter((id) => id !== g.id);
    });
    client.on(Events.GuildMemberAdd, (member) => {
      if (!this.options.allowedGuildIds.includes(member.guild.id) || !this.events.memberJoin) return;
      const info: MemberInfo = {
        userId: member.id,
        username: member.user.username,
        isBot: member.user.bot,
        roleIds: [...member.roles.cache.keys()].filter((id) => id !== member.guild.id),
        communicationDisabledUntil: member.communicationDisabledUntil?.toISOString() ?? null,
      };
      this.events
        .memberJoin({ guildId: member.guild.id, member: info })
        .catch((error) =>
          this.options.logger.error('member join handler failed', { error, guildId: member.guild.id }),
        );
    });
    client.on(Events.InteractionCreate, (interaction) => void this.onInteraction(interaction));
    if (this.options.reactionIntent) client.on(Events.Raw, (packet: unknown) => this.onRaw(client, packet));
    return client;
  }

  private onRaw(client: Client, packet: unknown): void {
    const event = parseReactionAdd(packet);
    if (!event || !this.events.reactionAdd || !this.options.allowedGuildIds.includes(event.guildId)) return;
    this.events
      .reactionAdd({
        ...event,
        guildOwnerId: client.guilds.cache.get(event.guildId)?.ownerId ?? null,
        // Known once the session is ready. Reactions that arrive earlier are
        // kept: REST calls are refused until then anyway.
        botUserId: this.current.botUserId,
      })
      .catch((error) =>
        this.options.logger.error('reaction handler failed', { error, guildId: event.guildId }),
      );
  }

  private async onInteraction(interaction: Interaction): Promise<void> {
    if (!interaction.isButton() || !interaction.inGuild() || !interaction.customId.startsWith('stw:')) return;
    if (!this.options.allowedGuildIds.includes(interaction.guildId) || !this.events.buttonPress) {
      await interaction
        .reply({ content: 'This panel is not active.', flags: MessageFlags.Ephemeral })
        .catch(() => {});
      return;
    }
    try {
      // Discord wants an answer within three seconds; role changes can take longer.
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const member = interaction.member;
      const roleIds = Array.isArray(member.roles) ? [...member.roles] : [...member.roles.cache.keys()];
      await this.events.buttonPress({
        guildId: interaction.guildId,
        channelId: interaction.channelId,
        userId: interaction.user.id,
        memberRoleIds: roleIds.filter((id) => id !== interaction.guildId),
        customId: interaction.customId,
        reply: async (text) => {
          await interaction.editReply({ content: text, allowedMentions: { parse: [] } });
        },
      });
    } catch (error) {
      this.options.logger.error('button handler failed', { error, guildId: interaction.guildId });
      await interaction.editReply({ content: 'Something went wrong; nothing was changed.' }).catch(() => {});
    }
  }

  async start(events: AdapterEvents): Promise<void> {
    this.events = events;
    void this.loginLoop();
  }

  private async loginLoop(): Promise<void> {
    let delay = 5_000;
    while (!this.stopped) {
      this.setState('connecting');
      const client = this.buildClient();
      this.client = client;
      try {
        await client.login(this.options.token);
        return;
      } catch (error) {
        const e = error as { code?: string; message?: string };
        await client.destroy().catch(() => {});
        if (e.code === 'TokenInvalid') {
          this.setState(
            'failed',
            'Discord rejected the bot token (TokenInvalid); reset it in the developer portal',
          );
          return;
        }
        if (e.code === 'DisallowedIntents' || /disallowed intents/i.test(e.message ?? '')) {
          this.setState(
            'failed',
            'Discord refused the requested gateway intents. Enable "Server Members Intent" in the developer portal, or set DISCORD_MEMBERS_INTENT=false',
          );
          return;
        }
        this.setState(
          'disconnected',
          `login failed: ${e.message ?? 'unknown error'}; retrying in ${delay / 1000}s`,
        );
        await new Promise((r) => setTimeout(r, delay).unref());
        delay = Math.min(delay * 2, 300_000);
      }
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.client?.destroy().catch(() => {});
    this.setState('disconnected', 'stopped');
  }

  private rest() {
    const state = this.current.state;
    if (!this.client || !this.current.botUserId || (state !== 'ready' && state !== 'reconnecting')) {
      throw new StewardError(
        'discord_unavailable',
        `Discord is not connected (state: ${state}${this.current.detail ? `; ${this.current.detail}` : ''})`,
      );
    }
    return this.client.rest;
  }

  private async call<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      throw toRequestError(error);
    }
  }

  async fetchSnapshot(guildId: string): Promise<GuildSnapshot> {
    const rest = this.rest();
    const botId = this.current.botUserId!;
    return this.call(async () => {
      let guild: APIGuild;
      try {
        guild = (await rest.get(Routes.guild(guildId), {
          query: new URLSearchParams({ with_counts: 'true' }),
        })) as APIGuild;
      } catch (error) {
        const e = toRequestError(error);
        if (e instanceof DiscordRequestError && (e.status === 404 || e.status === 403)) {
          throw new StewardError(
            'not_found',
            `the bot is not a member of guild ${guildId}, or it does not exist; invite it with generate_invite_link`,
          );
        }
        throw e;
      }
      const [channels, member] = await Promise.all([
        rest.get(Routes.guildChannels(guildId)) as Promise<APIChannel[]>,
        rest.get(Routes.guildMember(guildId, botId)) as Promise<APIGuildMember>,
      ]);
      return {
        guild: normaliseGuild(guild),
        roles: guild.roles.map(normaliseRole),
        channels: channels.map(normaliseChannel),
        botMember: normaliseMember(member),
        fetchedAt: new Date().toISOString(),
      };
    });
  }

  async fetchMember(guildId: string, userId: string): Promise<MemberInfo | null> {
    const rest = this.rest();
    try {
      return normaliseMember((await rest.get(Routes.guildMember(guildId, userId))) as APIGuildMember);
    } catch (error) {
      const e = toRequestError(error);
      if (e instanceof DiscordRequestError && e.status === 404) return null;
      throw e;
    }
  }

  async fetchAutoModRules(guildId: string): Promise<AutoModRuleInfo[]> {
    const rest = this.rest();
    return this.call(async () =>
      ((await rest.get(Routes.guildAutoModerationRules(guildId))) as APIAutoModerationRule[]).map(
        normaliseAutoModRule,
      ),
    );
  }

  async fetchAutoModRule(guildId: string, ruleId: string): Promise<AutoModRuleInfo | null> {
    const rest = this.rest();
    try {
      return normaliseAutoModRule(
        (await rest.get(Routes.guildAutoModerationRule(guildId, ruleId))) as APIAutoModerationRule,
      );
    } catch (error) {
      const e = toRequestError(error);
      if (e instanceof DiscordRequestError && e.status === 404) return null;
      throw e;
    }
  }

  async fetchMessage(channelId: string, messageId: string): Promise<MessageInfo | null> {
    const rest = this.rest();
    try {
      return normaliseMessage((await rest.get(Routes.channelMessage(channelId, messageId))) as APIMessage);
    } catch (error) {
      const e = toRequestError(error);
      if (e instanceof DiscordRequestError && e.status === 404) return null;
      throw e;
    }
  }

  async fetchRecentMessages(channelId: string, limit: number): Promise<MessageInfo[]> {
    const rest = this.rest();
    return this.call(async () => {
      const query = new URLSearchParams({ limit: String(Math.min(Math.max(limit, 1), 100)) });
      return ((await rest.get(Routes.channelMessages(channelId), { query })) as APIMessage[]).map(
        normaliseMessage,
      );
    });
  }

  async fetchAuditLog(guildId: string, actionType: number, limit = 50): Promise<AuditLogEntry[]> {
    const rest = this.rest();
    return this.call(async () => {
      const query = new URLSearchParams({
        action_type: String(actionType),
        limit: String(limit),
        user_id: this.current.botUserId!,
      });
      const log = (await rest.get(Routes.guildAuditLog(guildId), { query })) as APIAuditLog;
      return log.audit_log_entries.map(normaliseAuditEntry);
    });
  }

  async createChannel(guildId: string, body: ChannelWriteBody, reason: string): Promise<ChannelInfo> {
    const rest = this.rest();
    return this.call(async () =>
      normaliseChannel(
        (await rest.post(Routes.guildChannels(guildId), {
          body,
          reason: truncateReason(reason),
        })) as APIChannel,
      ),
    );
  }

  async editChannel(channelId: string, body: ChannelWriteBody, reason: string): Promise<ChannelInfo> {
    const rest = this.rest();
    return this.call(async () =>
      normaliseChannel(
        (await rest.patch(Routes.channel(channelId), { body, reason: truncateReason(reason) })) as APIChannel,
      ),
    );
  }

  async deleteChannel(channelId: string, reason: string): Promise<void> {
    const rest = this.rest();
    await this.call(() => rest.delete(Routes.channel(channelId), { reason: truncateReason(reason) }));
  }

  async setChannelPositions(guildId: string, updates: PositionUpdate[], reason: string): Promise<void> {
    const rest = this.rest();
    await this.call(() =>
      rest.patch(Routes.guildChannels(guildId), { body: updates, reason: truncateReason(reason) }),
    );
  }

  async putOverwrite(
    channelId: string,
    overwrite: { id: string; type: 'role' | 'member'; allow: bigint; deny: bigint },
    reason: string,
  ): Promise<void> {
    const rest = this.rest();
    await this.call(() =>
      rest.put(Routes.channelPermission(channelId, overwrite.id), {
        body: {
          type: overwrite.type === 'member' ? 1 : 0,
          allow: overwrite.allow.toString(),
          deny: overwrite.deny.toString(),
        },
        reason: truncateReason(reason),
      }),
    );
  }

  async deleteOverwrite(channelId: string, targetId: string, reason: string): Promise<void> {
    const rest = this.rest();
    await this.call(() =>
      rest.delete(Routes.channelPermission(channelId, targetId), { reason: truncateReason(reason) }),
    );
  }

  async createRole(guildId: string, body: RoleWriteBody, reason: string): Promise<RoleInfo> {
    const rest = this.rest();
    return this.call(async () =>
      normaliseRole(
        (await rest.post(Routes.guildRoles(guildId), { body, reason: truncateReason(reason) })) as APIRole,
      ),
    );
  }

  async editRole(guildId: string, roleId: string, body: RoleWriteBody, reason: string): Promise<RoleInfo> {
    const rest = this.rest();
    return this.call(async () =>
      normaliseRole(
        (await rest.patch(Routes.guildRole(guildId, roleId), {
          body,
          reason: truncateReason(reason),
        })) as APIRole,
      ),
    );
  }

  async deleteRole(guildId: string, roleId: string, reason: string): Promise<void> {
    const rest = this.rest();
    await this.call(() => rest.delete(Routes.guildRole(guildId, roleId), { reason: truncateReason(reason) }));
  }

  async setRolePositions(guildId: string, updates: PositionUpdate[], reason: string): Promise<void> {
    const rest = this.rest();
    await this.call(() =>
      rest.patch(Routes.guildRoles(guildId), { body: updates, reason: truncateReason(reason) }),
    );
  }

  async addMemberRole(guildId: string, userId: string, roleId: string, reason: string): Promise<void> {
    const rest = this.rest();
    await this.call(() =>
      rest.put(Routes.guildMemberRole(guildId, userId, roleId), { reason: truncateReason(reason) }),
    );
  }

  async removeMemberRole(guildId: string, userId: string, roleId: string, reason: string): Promise<void> {
    const rest = this.rest();
    await this.call(() =>
      rest.delete(Routes.guildMemberRole(guildId, userId, roleId), { reason: truncateReason(reason) }),
    );
  }

  async editGuild(guildId: string, body: GuildWriteBody, reason: string): Promise<GuildInfo> {
    const rest = this.rest();
    return this.call(async () =>
      normaliseGuild(
        (await rest.patch(Routes.guild(guildId), { body, reason: truncateReason(reason) })) as APIGuild,
      ),
    );
  }

  async sendMessage(channelId: string, body: MessageBody): Promise<MessageInfo> {
    const rest = this.rest();
    return this.call(async () =>
      normaliseMessage((await rest.post(Routes.channelMessages(channelId), { body })) as APIMessage),
    );
  }

  async editMessage(channelId: string, messageId: string, body: MessageBody): Promise<MessageInfo> {
    const rest = this.rest();
    const { nonce: _n, enforce_nonce: _e, ...rest_ } = body;
    return this.call(async () =>
      normaliseMessage(
        (await rest.patch(Routes.channelMessage(channelId, messageId), { body: rest_ })) as APIMessage,
      ),
    );
  }

  async deleteMessage(channelId: string, messageId: string, reason: string): Promise<void> {
    const rest = this.rest();
    await this.call(() =>
      rest.delete(Routes.channelMessage(channelId, messageId), { reason: truncateReason(reason) }),
    );
  }

  async createAutoModRule(guildId: string, body: AutoModWriteBody, reason: string): Promise<AutoModRuleInfo> {
    const rest = this.rest();
    return this.call(async () =>
      normaliseAutoModRule(
        (await rest.post(Routes.guildAutoModerationRules(guildId), {
          body,
          reason: truncateReason(reason),
        })) as APIAutoModerationRule,
      ),
    );
  }

  async editAutoModRule(
    guildId: string,
    ruleId: string,
    body: AutoModWriteBody,
    reason: string,
  ): Promise<AutoModRuleInfo> {
    const rest = this.rest();
    return this.call(async () =>
      normaliseAutoModRule(
        (await rest.patch(Routes.guildAutoModerationRule(guildId, ruleId), {
          body,
          reason: truncateReason(reason),
        })) as APIAutoModerationRule,
      ),
    );
  }

  async removeUserReaction(
    channelId: string,
    messageId: string,
    emoji: string,
    userId: string,
  ): Promise<void> {
    const rest = this.rest();
    await this.call(() =>
      rest.delete(Routes.channelMessageUserReaction(channelId, messageId, emoji, userId)),
    );
  }

  async deleteAutoModRule(guildId: string, ruleId: string, reason: string): Promise<void> {
    const rest = this.rest();
    await this.call(() =>
      rest.delete(Routes.guildAutoModerationRule(guildId, ruleId), { reason: truncateReason(reason) }),
    );
  }
}
