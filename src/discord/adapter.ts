import type {
  AutoModRuleInfo,
  AutoModWriteBody,
  ChannelInfo,
  ChannelLookup,
  ChannelWriteBody,
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

export interface AuditLogEntry {
  id: string;
  actionType: number;
  targetId: string | null;
  userId: string | null;
  reason: string | null;
}

export interface MemberJoinEvent {
  guildId: string;
  member: MemberInfo;
}

export interface ButtonPressEvent {
  guildId: string;
  channelId: string;
  userId: string;
  memberRoleIds: string[];
  customId: string;
  /** Reply privately to the person who pressed the button. */
  reply(text: string): Promise<void>;
}

/** Someone added a reaction to a message in a configured guild (from the raw gateway event). */
export interface ReactionAddEvent {
  guildId: string;
  channelId: string;
  messageId: string;
  userId: string;
  /** Who wrote the message. Discord marks this optional; null when it was left out. */
  messageAuthorId: string | null;
  /** The reacting member as the event carries it; isBot is null when the user object was left out. */
  member: { roleIds: string[]; isBot: boolean | null } | null;
  emoji: { id: string | null; name: string | null };
  /** A super reaction. */
  burst: boolean;
  /** From the gateway session's guild cache; null if unknown. */
  guildOwnerId: string | null;
  /** The bot's own user id as the gateway session knows it; null before READY. */
  botUserId: string | null;
}

export interface AdapterEvents {
  memberJoin?: (event: MemberJoinEvent) => Promise<void>;
  buttonPress?: (event: ButtonPressEvent) => Promise<void>;
  /** Only delivered when the adapter was built with the reaction intent. */
  reactionAdd?: (event: ReactionAddEvent) => Promise<void>;
}

/**
 * Everything steward needs from Discord, and nothing else. Mutations take an
 * audit-log `reason`; reads return normalised shapes.
 *
 * Implementations must NOT retry non-idempotent requests internally: a timed
 * out create may already have happened, and only the caller knows how to
 * check. Failures are thrown as `DiscordRequestError`.
 */
export interface DiscordAdapter {
  status(): ConnectionStatus;
  start(events: AdapterEvents): Promise<void>;
  stop(): Promise<void>;

  /** From 2026-11-16 its channel list leaves out channels the bot cannot view. */
  fetchSnapshot(guildId: string): Promise<GuildSnapshot>;
  /** One channel by id: tells a channel the bot cannot view (403) from a deleted one (404). */
  fetchChannel(channelId: string): Promise<ChannelLookup>;
  fetchMember(guildId: string, userId: string): Promise<MemberInfo | null>;
  fetchAutoModRules(guildId: string): Promise<AutoModRuleInfo[]>;
  /** One rule by id; null when Discord answers 404 for it. */
  fetchAutoModRule(guildId: string, ruleId: string): Promise<AutoModRuleInfo | null>;
  fetchMessage(channelId: string, messageId: string): Promise<MessageInfo | null>;
  /** Most recent messages in a channel, newest first. Content of other people's messages may be empty without the Message Content intent. */
  fetchRecentMessages(channelId: string, limit: number): Promise<MessageInfo[]>;
  fetchAuditLog(guildId: string, actionType: number, limit?: number): Promise<AuditLogEntry[]>;

  createChannel(guildId: string, body: ChannelWriteBody, reason: string): Promise<ChannelInfo>;
  editChannel(channelId: string, body: ChannelWriteBody, reason: string): Promise<ChannelInfo>;
  deleteChannel(channelId: string, reason: string): Promise<void>;
  setChannelPositions(guildId: string, updates: PositionUpdate[], reason: string): Promise<void>;
  putOverwrite(
    channelId: string,
    overwrite: { id: string; type: 'role' | 'member'; allow: bigint; deny: bigint },
    reason: string,
  ): Promise<void>;
  deleteOverwrite(channelId: string, targetId: string, reason: string): Promise<void>;

  createRole(guildId: string, body: RoleWriteBody, reason: string): Promise<RoleInfo>;
  editRole(guildId: string, roleId: string, body: RoleWriteBody, reason: string): Promise<RoleInfo>;
  deleteRole(guildId: string, roleId: string, reason: string): Promise<void>;
  setRolePositions(guildId: string, updates: PositionUpdate[], reason: string): Promise<void>;
  addMemberRole(guildId: string, userId: string, roleId: string, reason: string): Promise<void>;
  removeMemberRole(guildId: string, userId: string, roleId: string, reason: string): Promise<void>;

  editGuild(guildId: string, body: GuildWriteBody, reason: string): Promise<GuildInfo>;

  sendMessage(channelId: string, body: MessageBody): Promise<MessageInfo>;
  editMessage(channelId: string, messageId: string, body: MessageBody): Promise<MessageInfo>;
  deleteMessage(channelId: string, messageId: string, reason: string): Promise<void>;

  createAutoModRule(guildId: string, body: AutoModWriteBody, reason: string): Promise<AutoModRuleInfo>;
  editAutoModRule(
    guildId: string,
    ruleId: string,
    body: AutoModWriteBody,
    reason: string,
  ): Promise<AutoModRuleInfo>;
  deleteAutoModRule(guildId: string, ruleId: string, reason: string): Promise<void>;
  /**
   * Remove one user's reaction. `emoji` is the already URL-encoded route
   * segment. Discord documents no audit-log reason for this endpoint.
   */
  removeUserReaction(channelId: string, messageId: string, emoji: string, userId: string): Promise<void>;
}
