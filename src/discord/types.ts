/**
 * Normalised Discord state. Both the real adapter (discord.js) and the test
 * adapter produce exactly these shapes, so everything above the adapter is
 * testable without a network.
 *
 * Permission bitfields are bigint here and decimal strings in JSON.
 */

export type ChannelKind =
  'text' | 'voice' | 'category' | 'announcement' | 'stage' | 'forum' | 'media' | 'other';

export const CHANNEL_TYPE_NUMBERS: Record<Exclude<ChannelKind, 'other'>, number> = {
  text: 0,
  voice: 2,
  category: 4,
  announcement: 5,
  stage: 13,
  forum: 15,
  media: 16,
};

export function channelKindFromType(type: number): ChannelKind {
  for (const [kind, n] of Object.entries(CHANNEL_TYPE_NUMBERS)) if (n === type) return kind as ChannelKind;
  return 'other';
}

export interface Overwrite {
  /** Role or member id. */
  id: string;
  type: 'role' | 'member';
  allow: bigint;
  deny: bigint;
}

export interface ChannelInfo {
  id: string;
  name: string;
  kind: ChannelKind;
  type: number;
  parentId: string | null;
  position: number;
  topic: string | null;
  nsfw: boolean;
  rateLimitPerUser: number;
  bitrate: number | null;
  userLimit: number | null;
  overwrites: Overwrite[];
  /** Settings only some channel types have, present when Discord returned them. */
  extra?: ChannelExtras;
}

export interface ForumTag {
  id: string;
  name: string;
  moderated: boolean;
  emojiId: string | null;
  emojiName: string | null;
}

export interface ChannelExtras {
  rtcRegion?: string | null;
  videoQualityMode?: number;
  defaultAutoArchiveDuration?: number;
  defaultThreadRateLimitPerUser?: number;
  availableTags?: ForumTag[];
  defaultReactionEmoji?: { emojiId: string | null; emojiName: string | null } | null;
  defaultSortOrder?: number | null;
  defaultForumLayout?: number;
  flags?: number;
}

/**
 * One channel read by id. `hidden`: Discord answered 403, so the channel
 * exists but the bot lacks View Channel there. `missing`: 404, it is gone.
 */
export type ChannelLookup =
  | { status: 'visible'; channel: ChannelInfo; guildId: string | null }
  | { status: 'hidden' }
  | { status: 'missing' };

export interface RoleTags {
  botId?: string;
  integrationId?: string;
  premiumSubscriber?: boolean;
  availableForPurchase?: boolean;
  guildConnections?: boolean;
}

export interface RoleInfo {
  id: string;
  name: string;
  color: number;
  hoist: boolean;
  mentionable: boolean;
  managed: boolean;
  position: number;
  permissions: bigint;
  tags: RoleTags | null;
  /** Present only when set. */
  icon?: string;
  unicodeEmoji?: string;
  secondaryColor?: number;
  tertiaryColor?: number;
}

export interface GuildInfo {
  id: string;
  name: string;
  ownerId: string;
  description: string | null;
  verificationLevel: number;
  defaultMessageNotifications: number;
  explicitContentFilter: number;
  mfaLevel: number;
  nsfwLevel: number;
  preferredLocale: string;
  afkChannelId: string | null;
  afkTimeout: number;
  systemChannelId: string | null;
  systemChannelFlags: number;
  rulesChannelId: string | null;
  publicUpdatesChannelId: string | null;
  safetyAlertsChannelId: string | null;
  premiumProgressBarEnabled: boolean;
  premiumTier: number;
  features: string[];
  approximateMemberCount: number | null;
  /** Image hashes; present when Discord returned them. */
  icon?: string | null;
  banner?: string | null;
  splash?: string | null;
  discoverySplash?: string | null;
  vanityUrlCode?: string | null;
  incidents?: IncidentsInfo | null;
}

export interface MemberInfo {
  userId: string;
  username: string | null;
  isBot: boolean;
  roleIds: string[];
  /** ISO timestamp if the member is timed out. */
  communicationDisabledUntil: string | null;
}

export interface GuildSnapshot {
  guild: GuildInfo;
  roles: RoleInfo[];
  channels: ChannelInfo[];
  botMember: MemberInfo;
  fetchedAt: string;
}

export interface EmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

export interface MessageEmbed {
  title?: string;
  description?: string;
  url?: string;
  color?: number;
  fields?: EmbedField[];
  footer?: { text: string };
  author?: { name: string; url?: string };
  image?: { url: string };
  thumbnail?: { url: string };
  timestamp?: string;
}

export interface ButtonComponent {
  type: 2;
  style: 1 | 2 | 3 | 4;
  label?: string;
  emoji?: { id?: string; name?: string };
  custom_id: string;
  disabled?: boolean;
}

export interface ActionRow {
  type: 1;
  components: ButtonComponent[];
}

/** Request body for creating or editing a message. Snake case: it is passed to Discord verbatim. */
export interface MessageBody {
  content?: string;
  embeds?: MessageEmbed[];
  components?: ActionRow[];
  allowed_mentions: { parse: Array<'users' | 'roles' | 'everyone'>; users?: string[]; roles?: string[] };
  nonce?: string;
  enforce_nonce?: boolean;
}

export interface MessageInfo {
  id: string;
  channelId: string;
  authorId: string;
  content: string;
  embeds: MessageEmbed[];
  componentCount: number;
  createdAt: string;
  editedAt: string | null;
}

export interface AutoModAction {
  type: number;
  /** Keys steward does not model are kept, so they can be sent back unchanged. */
  metadata?: {
    channel_id?: string;
    duration_seconds?: number;
    custom_message?: string;
    [key: string]: unknown;
  };
}

export interface AutoModRuleInfo {
  id: string;
  name: string;
  eventType: number;
  triggerType: number;
  triggerMetadata: {
    keyword_filter?: string[];
    regex_patterns?: string[];
    presets?: number[];
    allow_list?: string[];
    mention_total_limit?: number;
    mention_raid_protection_enabled?: boolean;
    /** Keys steward does not model are kept, so they can be sent back unchanged. */
    [key: string]: unknown;
  };
  actions: AutoModAction[];
  enabled: boolean;
  exemptRoles: string[];
  exemptChannels: string[];
  creatorId: string;
}

/** Body shapes passed to Discord. Snake case on purpose. */
export interface ChannelWriteBody {
  name?: string;
  type?: number;
  topic?: string | null;
  nsfw?: boolean;
  rate_limit_per_user?: number;
  bitrate?: number;
  user_limit?: number;
  parent_id?: string | null;
  position?: number;
  permission_overwrites?: Array<{ id: string; type: 0 | 1; allow: string; deny: string }>;
  rtc_region?: string | null;
  /** 1 auto, 2 full (720p). */
  video_quality_mode?: number;
  /** Minutes: 60, 1440, 4320 or 10080. */
  default_auto_archive_duration?: number;
  default_thread_rate_limit_per_user?: number;
  available_tags?: Array<{
    id?: string;
    name: string;
    moderated?: boolean;
    emoji_id?: string | null;
    emoji_name?: string | null;
  }>;
  default_reaction_emoji?: { emoji_id: string | null; emoji_name: string | null } | null;
  /** 0 latest activity, 1 creation date. */
  default_sort_order?: number | null;
  /** 0 not set, 1 list, 2 gallery. */
  default_forum_layout?: number;
  /** RequireTag = 16, HideMediaDownloadOptions = 32768. */
  flags?: number;
}

export interface RoleWriteBody {
  name?: string;
  color?: number;
  hoist?: boolean;
  mentionable?: boolean;
  permissions?: string;
  /** Data URI; needs the ROLE_ICONS feature. */
  icon?: string | null;
  unicode_emoji?: string | null;
  /** Gradient and holographic colours; needs ENHANCED_ROLE_COLORS. */
  colors?: { primary_color: number; secondary_color?: number | null; tertiary_color?: number | null };
}

export interface GuildWriteBody {
  name?: string;
  description?: string | null;
  verification_level?: number;
  default_message_notifications?: number;
  explicit_content_filter?: number;
  afk_channel_id?: string | null;
  afk_timeout?: number;
  system_channel_id?: string | null;
  system_channel_flags?: number;
  rules_channel_id?: string | null;
  public_updates_channel_id?: string | null;
  safety_alerts_channel_id?: string | null;
  preferred_locale?: string;
  premium_progress_bar_enabled?: boolean;
  features?: string[];
  /** Data URIs, or null to remove. */
  icon?: string | null;
  banner?: string | null;
  splash?: string | null;
  discovery_splash?: string | null;
}

/** Onboarding as Discord stores it. Emoji are flattened to id/name. */
export interface OnboardingOption {
  id: string;
  title: string;
  description: string | null;
  channelIds: string[];
  roleIds: string[];
  emojiId: string | null;
  emojiName: string | null;
}

export interface OnboardingPrompt {
  id: string;
  title: string;
  /** 0 multiple choice, 1 dropdown. */
  type: number;
  singleSelect: boolean;
  required: boolean;
  inOnboarding: boolean;
  options: OnboardingOption[];
}

export interface OnboardingInfo {
  enabled: boolean;
  /** 0 default, 1 advanced. */
  mode: number;
  defaultChannelIds: string[];
  prompts: OnboardingPrompt[];
}

export interface WelcomeScreenInfo {
  description: string | null;
  channels: Array<{
    channelId: string;
    description: string;
    emojiId: string | null;
    emojiName: string | null;
  }>;
}

export interface WidgetInfo {
  enabled: boolean;
  channelId: string | null;
}

export interface IncidentsInfo {
  invitesDisabledUntil: string | null;
  dmsDisabledUntil: string | null;
  raidDetectedAt?: string | null;
  dmSpamDetectedAt?: string | null;
}

export interface OnboardingWriteBody {
  prompts: Array<{
    id: string;
    title: string;
    type: number;
    single_select: boolean;
    required: boolean;
    in_onboarding: boolean;
    options: Array<{
      id: string;
      title: string;
      description: string | null;
      channel_ids: string[];
      role_ids: string[];
      emoji_id?: string;
      emoji_name?: string;
    }>;
  }>;
  default_channel_ids: string[];
  enabled: boolean;
  mode: number;
}

export interface WelcomeScreenWriteBody {
  enabled?: boolean;
  description?: string | null;
  welcome_channels?: Array<{
    channel_id: string;
    description: string;
    emoji_id: string | null;
    emoji_name: string | null;
  }>;
}

/** The bot's own member profile in one server (hashes, not images). */
export interface BotProfileInfo {
  nick: string | null;
  avatar: string | null;
  banner: string | null;
}

export interface BotProfileWriteBody {
  nick?: string | null;
  /** Data URIs, or null to remove. */
  avatar?: string | null;
  banner?: string | null;
  bio?: string | null;
}

export type ExpressionKind = 'emoji' | 'sticker' | 'sound';

export interface EmojiInfo {
  id: string;
  name: string;
  animated: boolean;
  /** Roles allowed to use it; empty means everyone. */
  roleIds: string[];
  managed: boolean;
  available: boolean;
  creatorId: string | null;
}

export interface StickerInfo {
  id: string;
  name: string;
  description: string | null;
  /** The related emoji name, used for autocomplete. */
  tags: string;
  /** 1 PNG, 2 APNG, 3 Lottie, 4 GIF. */
  formatType: number;
  available: boolean;
  creatorId: string | null;
}

export interface SoundInfo {
  id: string;
  name: string;
  volume: number;
  emojiId: string | null;
  emojiName: string | null;
  available: boolean;
  creatorId: string | null;
}

export interface EmojiWriteBody {
  name?: string;
  /** Data URI; create only. */
  image?: string;
  roles?: string[];
}

export interface StickerWriteBody {
  name?: string;
  description?: string;
  tags?: string;
}

export interface StickerFile {
  data: Buffer;
  filename: string;
  contentType: string;
}

export interface SoundWriteBody {
  name?: string;
  /** Data URI; create only. */
  sound?: string;
  volume?: number | null;
  emoji_id?: string | null;
  emoji_name?: string | null;
}

export interface RecurrenceRule {
  start: string;
  end?: string | null;
  /** 0 yearly, 1 monthly, 2 weekly, 3 daily. */
  frequency: number;
  interval: number;
  by_weekday?: number[] | null;
  by_n_weekday?: Array<{ n: number; day: number }> | null;
  by_month?: number[] | null;
  by_month_day?: number[] | null;
  by_year_day?: number[] | null;
  count?: number | null;
}

export interface ScheduledEventInfo {
  id: string;
  name: string;
  description: string | null;
  channelId: string | null;
  /** 1 stage, 2 voice, 3 external. */
  entityType: number;
  location: string | null;
  startTime: string;
  endTime: string | null;
  /** 1 scheduled, 2 active, 3 completed, 4 canceled. */
  status: number;
  userCount: number | null;
  image: string | null;
  recurrence: RecurrenceRule | null;
  creatorId: string | null;
}

export interface ScheduledEventWriteBody {
  name?: string;
  description?: string | null;
  channel_id?: string | null;
  entity_type?: number;
  entity_metadata?: { location?: string } | null;
  privacy_level?: number;
  scheduled_start_time?: string;
  scheduled_end_time?: string | null;
  status?: number;
  /** Data URI cover image, or null to remove. */
  image?: string | null;
  recurrence_rule?: RecurrenceRule | null;
}

export interface InviteInfo {
  code: string;
  channelId: string | null;
  inviterId: string | null;
  uses: number;
  maxUses: number;
  /** Seconds; 0 never expires. */
  maxAge: number;
  temporary: boolean;
  createdAt: string | null;
  expiresAt: string | null;
  /** Roles granted to whoever joins through it. */
  roleIds: string[];
}

export interface InviteWriteBody {
  max_age?: number;
  max_uses?: number;
  temporary?: boolean;
  unique?: boolean;
  role_ids?: string[];
}

/** A webhook without its token: steward never hands out webhook credentials. */
export interface WebhookInfo {
  id: string;
  /** 1 incoming, 2 channel follower, 3 application. */
  type: number;
  channelId: string | null;
  name: string | null;
  avatar: string | null;
  applicationId: string | null;
  creatorId: string | null;
}

export interface WebhookWriteBody {
  name?: string;
  /** Data URI, or null to remove. */
  avatar?: string | null;
  channel_id?: string;
}

export interface TemplateInfo {
  code: string;
  name: string;
  description: string | null;
  usageCount: number;
  creatorId: string;
  createdAt: string;
  updatedAt: string;
  /** The server changed since the template was last synced. */
  isDirty: boolean;
}

export interface TemplateWriteBody {
  name?: string;
  description?: string | null;
}

export interface IntegrationInfo {
  id: string;
  name: string;
  /** twitch, youtube, discord or guild_subscription. */
  type: string;
  enabled: boolean;
  applicationId: string | null;
  accountName: string | null;
}

export interface AutoModWriteBody {
  name?: string;
  event_type?: number;
  trigger_type?: number;
  trigger_metadata?: AutoModRuleInfo['triggerMetadata'];
  actions?: AutoModAction[];
  enabled?: boolean;
  exempt_roles?: string[];
  exempt_channels?: string[];
}

export interface PositionUpdate {
  id: string;
  position: number;
}

export type ConnectionState =
  'starting' | 'connecting' | 'ready' | 'reconnecting' | 'disconnected' | 'failed';

export interface ConnectionStatus {
  state: ConnectionState;
  since: string;
  /** Redacted, human-readable reason for the current state when it is not `ready`. */
  detail: string | null;
  botUserId: string | null;
  botTag: string | null;
  applicationId: string | null;
  guildIds: string[];
  /** Gateway inventory, including servers not enabled for management. */
  guilds?: Array<{ id: string; name: string; icon_url: string | null }>;
}
