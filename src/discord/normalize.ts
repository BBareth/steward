import type {
  APIAuditLogEntry,
  APIAutoModerationRule,
  APIChannel,
  APIEmbed,
  APIGuild,
  APIGuildMember,
  APIMessage,
  APIRole,
} from 'discord-api-types/v10';
import type { AuditLogEntry } from './adapter.js';
import type {
  AutoModRuleInfo,
  ChannelInfo,
  GuildInfo,
  MemberInfo,
  MessageEmbed,
  MessageInfo,
  RoleInfo,
} from './types.js';
import { channelKindFromType } from './types.js';

/** Converts Discord REST payloads to steward's normalised shapes. */

/** Drop keys whose value is undefined, so normalised objects compare cleanly. */
export function compact<T extends Record<string, unknown>>(obj: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out as T;
}

export function normaliseChannel(raw: APIChannel): ChannelInfo {
  const c = raw as unknown as Record<string, unknown>;
  const overwrites =
    (c.permission_overwrites as Array<{ id: string; type: number; allow: string; deny: string }>) ?? [];
  return {
    id: raw.id,
    name: (c.name as string) ?? '',
    kind: channelKindFromType(raw.type),
    type: raw.type,
    parentId: (c.parent_id as string | null | undefined) ?? null,
    position: (c.position as number | undefined) ?? 0,
    topic: (c.topic as string | null | undefined) ?? null,
    nsfw: Boolean(c.nsfw),
    rateLimitPerUser: (c.rate_limit_per_user as number | undefined) ?? 0,
    bitrate: (c.bitrate as number | undefined) ?? null,
    userLimit: (c.user_limit as number | undefined) ?? null,
    overwrites: overwrites.map((o) => ({
      id: o.id,
      type: o.type === 1 ? 'member' : 'role',
      allow: BigInt(o.allow),
      deny: BigInt(o.deny),
    })),
  };
}

export function normaliseRole(raw: APIRole): RoleInfo {
  const tags = raw.tags;
  // Discord encodes boolean role tags as `null` when true and absence when false.
  const flag = (t: object | undefined, k: string) => (t ? Object.prototype.hasOwnProperty.call(t, k) : false);
  return {
    id: raw.id,
    name: raw.name,
    color: raw.color,
    hoist: raw.hoist,
    mentionable: raw.mentionable,
    managed: raw.managed,
    position: raw.position,
    permissions: BigInt(raw.permissions),
    tags: tags
      ? {
          botId: tags.bot_id,
          integrationId: tags.integration_id,
          premiumSubscriber: flag(tags, 'premium_subscriber'),
          availableForPurchase: flag(tags, 'available_for_purchase'),
          guildConnections: flag(tags, 'guild_connections'),
        }
      : null,
  };
}

export function normaliseGuild(raw: APIGuild): GuildInfo {
  return {
    id: raw.id,
    name: raw.name,
    ownerId: raw.owner_id,
    description: raw.description ?? null,
    verificationLevel: raw.verification_level,
    defaultMessageNotifications: raw.default_message_notifications,
    explicitContentFilter: raw.explicit_content_filter,
    mfaLevel: raw.mfa_level,
    nsfwLevel: raw.nsfw_level,
    preferredLocale: raw.preferred_locale,
    afkChannelId: raw.afk_channel_id ?? null,
    afkTimeout: raw.afk_timeout,
    systemChannelId: raw.system_channel_id ?? null,
    systemChannelFlags: raw.system_channel_flags,
    rulesChannelId: raw.rules_channel_id ?? null,
    publicUpdatesChannelId: raw.public_updates_channel_id ?? null,
    safetyAlertsChannelId: raw.safety_alerts_channel_id ?? null,
    premiumProgressBarEnabled: raw.premium_progress_bar_enabled,
    premiumTier: raw.premium_tier,
    features: [...raw.features],
    approximateMemberCount: raw.approximate_member_count ?? null,
  };
}

export function normaliseMember(raw: APIGuildMember): MemberInfo {
  return {
    userId: raw.user.id,
    username: raw.user.username ?? null,
    isBot: Boolean(raw.user.bot),
    roleIds: [...raw.roles],
    communicationDisabledUntil: raw.communication_disabled_until ?? null,
  };
}

function normaliseEmbed(e: APIEmbed): MessageEmbed {
  const out: MessageEmbed = {};
  if (e.title !== undefined) out.title = e.title;
  if (e.description !== undefined) out.description = e.description;
  if (e.url !== undefined) out.url = e.url;
  if (e.color !== undefined) out.color = e.color;
  if (e.fields) out.fields = e.fields.map((f) => ({ name: f.name, value: f.value, inline: f.inline }));
  if (e.footer) out.footer = { text: e.footer.text };
  if (e.author) out.author = { name: e.author.name, url: e.author.url };
  if (e.image) out.image = { url: e.image.url };
  if (e.thumbnail) out.thumbnail = { url: e.thumbnail.url };
  if (e.timestamp) out.timestamp = e.timestamp;
  return out;
}

export function normaliseMessage(raw: APIMessage): MessageInfo {
  return {
    id: raw.id,
    channelId: raw.channel_id,
    authorId: raw.author.id,
    content: raw.content ?? '',
    embeds: (raw.embeds ?? []).map(normaliseEmbed),
    componentCount: (raw.components ?? []).length,
    createdAt: raw.timestamp,
    editedAt: raw.edited_timestamp ?? null,
  };
}

export function normaliseAutoModRule(raw: APIAutoModerationRule): AutoModRuleInfo {
  const m = raw.trigger_metadata ?? {};
  return {
    id: raw.id,
    name: raw.name,
    eventType: raw.event_type,
    triggerType: raw.trigger_type,
    triggerMetadata: compact({
      keyword_filter: m.keyword_filter,
      regex_patterns: m.regex_patterns,
      presets: m.presets as number[] | undefined,
      allow_list: m.allow_list,
      mention_total_limit: m.mention_total_limit,
      mention_raid_protection_enabled: m.mention_raid_protection_enabled,
    }),
    actions: raw.actions.map((a) => ({
      type: a.type,
      metadata: a.metadata
        ? compact({
            channel_id: a.metadata.channel_id,
            duration_seconds: a.metadata.duration_seconds,
            custom_message: a.metadata.custom_message ?? undefined,
          })
        : undefined,
    })),
    enabled: raw.enabled,
    exemptRoles: [...raw.exempt_roles],
    exemptChannels: [...raw.exempt_channels],
    creatorId: raw.creator_id,
  };
}

export function normaliseAuditEntry(raw: APIAuditLogEntry): AuditLogEntry {
  return {
    id: raw.id,
    actionType: raw.action_type,
    targetId: raw.target_id ?? null,
    userId: raw.user_id ?? null,
    reason: raw.reason ?? null,
  };
}
