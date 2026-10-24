import type {
  AutoModRuleInfo,
  AutoModWriteBody,
  BotProfileInfo,
  BotProfileWriteBody,
  ChannelInfo,
  ChannelLookup,
  ChannelWriteBody,
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

  // Server setup singletons. Each needs Manage Server unless noted.
  fetchOnboarding(guildId: string): Promise<OnboardingInfo>;
  /** Replaces the whole onboarding configuration. */
  putOnboarding(guildId: string, body: OnboardingWriteBody, reason: string): Promise<OnboardingInfo>;
  /** Null when the server has never had a welcome screen (Discord answers 404). */
  fetchWelcomeScreen(guildId: string): Promise<WelcomeScreenInfo | null>;
  editWelcomeScreen(
    guildId: string,
    body: WelcomeScreenWriteBody,
    reason: string,
  ): Promise<WelcomeScreenInfo>;
  fetchWidget(guildId: string): Promise<WidgetInfo>;
  editWidget(
    guildId: string,
    body: { enabled?: boolean; channel_id?: string | null },
    reason: string,
  ): Promise<WidgetInfo>;
  /** Pause invites or DMs until a time (at most 24 hours ahead), or null to resume. */
  setIncidentActions(
    guildId: string,
    body: { invites_disabled_until?: string | null; dms_disabled_until?: string | null },
    reason: string,
  ): Promise<IncidentsInfo>;
  /** The bot's own nickname, avatar, banner and bio in one server. Needs Change Nickname for nick. */
  editBotProfile(guildId: string, body: BotProfileWriteBody, reason: string): Promise<BotProfileInfo>;

  // Expressions. Create needs Create Expressions; edit and delete need Manage Expressions
  // (or Create Expressions for ones the bot made).
  fetchEmojis(guildId: string): Promise<EmojiInfo[]>;
  createEmoji(guildId: string, body: EmojiWriteBody, reason: string): Promise<EmojiInfo>;
  editEmoji(guildId: string, emojiId: string, body: EmojiWriteBody, reason: string): Promise<EmojiInfo>;
  deleteEmoji(guildId: string, emojiId: string, reason: string): Promise<void>;
  fetchStickers(guildId: string): Promise<StickerInfo[]>;
  createSticker(
    guildId: string,
    body: Required<StickerWriteBody>,
    file: StickerFile,
    reason: string,
  ): Promise<StickerInfo>;
  editSticker(
    guildId: string,
    stickerId: string,
    body: StickerWriteBody,
    reason: string,
  ): Promise<StickerInfo>;
  deleteSticker(guildId: string, stickerId: string, reason: string): Promise<void>;
  fetchSounds(guildId: string): Promise<SoundInfo[]>;
  createSound(guildId: string, body: SoundWriteBody, reason: string): Promise<SoundInfo>;
  editSound(guildId: string, soundId: string, body: SoundWriteBody, reason: string): Promise<SoundInfo>;
  deleteSound(guildId: string, soundId: string, reason: string): Promise<void>;

  /** Create needs Create Events; edit and delete need Manage Events (or Create Events for the bot's own). */
  fetchScheduledEvents(guildId: string): Promise<ScheduledEventInfo[]>;
  createScheduledEvent(
    guildId: string,
    body: ScheduledEventWriteBody,
    reason: string,
  ): Promise<ScheduledEventInfo>;
  editScheduledEvent(
    guildId: string,
    eventId: string,
    body: ScheduledEventWriteBody,
    reason: string,
  ): Promise<ScheduledEventInfo>;
  deleteScheduledEvent(guildId: string, eventId: string, reason: string): Promise<void>;

  /** Listing needs Manage Server; creating needs Create Invite on the channel. */
  fetchInvites(guildId: string): Promise<InviteInfo[]>;
  createInvite(channelId: string, body: InviteWriteBody, reason: string): Promise<InviteInfo>;
  /** Needs Manage Channels on the invite's channel, or Manage Server. */
  deleteInvite(code: string, reason: string): Promise<void>;

  /** Needs Manage Webhooks. Results never include webhook tokens. */
  fetchWebhooks(guildId: string): Promise<WebhookInfo[]>;
  createWebhook(channelId: string, body: WebhookWriteBody, reason: string): Promise<WebhookInfo>;
  editWebhook(webhookId: string, body: WebhookWriteBody, reason: string): Promise<WebhookInfo>;
  deleteWebhook(webhookId: string, reason: string): Promise<void>;

  fetchTemplates(guildId: string): Promise<TemplateInfo[]>;
  createTemplate(guildId: string, body: TemplateWriteBody, reason: string): Promise<TemplateInfo>;
  editTemplate(guildId: string, code: string, body: TemplateWriteBody, reason: string): Promise<TemplateInfo>;
  /** Update the template to the server's current structure. */
  syncTemplate(guildId: string, code: string, reason: string): Promise<TemplateInfo>;
  deleteTemplate(guildId: string, code: string, reason: string): Promise<void>;

  fetchIntegrations(guildId: string): Promise<IntegrationInfo[]>;
  /** Removes the integration and kicks its bot, if it has one. */
  deleteIntegration(guildId: string, integrationId: string, reason: string): Promise<void>;
}
