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
}

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
  metadata?: { channel_id?: string; duration_seconds?: number; custom_message?: string };
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
}

export interface RoleWriteBody {
  name?: string;
  color?: number;
  hoist?: boolean;
  mentionable?: boolean;
  permissions?: string;
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
}
