import type {
  APIAuditLogEntry,
  APIAutoModerationRule,
  APIChannel,
  APIEmbed,
  APIEmoji,
  APIExtendedInvite,
  APIGuild,
  APIGuildForumTag,
  APIGuildIntegration,
  APIGuildMember,
  APIGuildOnboarding,
  APIGuildScheduledEvent,
  APIGuildWelcomeScreen,
  APIGuildWidgetSettings,
  APIIncidentsData,
  APIMessage,
  APIRole,
  APISoundboardSound,
  APISticker,
  APITemplate,
  APIWebhook,
} from 'discord-api-types/v10';
import type { AuditLogEntry } from './adapter.js';
import type {
  AutoModRuleInfo,
  BotProfileInfo,
  ChannelExtras,
  ChannelInfo,
  EmojiInfo,
  GuildInfo,
  IncidentsInfo,
  IntegrationInfo,
  InviteInfo,
  MemberInfo,
  MessageEmbed,
  MessageInfo,
  OnboardingInfo,
  RecurrenceRule,
  RoleInfo,
  ScheduledEventInfo,
  SoundInfo,
  StickerInfo,
  TemplateInfo,
  WebhookInfo,
  WelcomeScreenInfo,
  WidgetInfo,
} from './types.js';
import { channelKindFromType } from './types.js';

/** Converts Discord REST payloads to steward's normalised shapes. */

/** Drop keys whose value is undefined, so normalised objects compare cleanly. */
export function compact<T extends Record<string, unknown>>(obj: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out as T;
}

function channelExtras(c: Record<string, unknown>): ChannelExtras | undefined {
  const tags = c.available_tags as APIGuildForumTag[] | undefined;
  const reaction = c.default_reaction_emoji as
    { emoji_id: string | null; emoji_name: string | null } | null | undefined;
  const extra: ChannelExtras = compact({
    rtcRegion: c.rtc_region as string | null | undefined,
    videoQualityMode: c.video_quality_mode as number | undefined,
    defaultAutoArchiveDuration: c.default_auto_archive_duration as number | undefined,
    defaultThreadRateLimitPerUser: c.default_thread_rate_limit_per_user as number | undefined,
    availableTags: tags?.map((t) => ({
      id: t.id,
      name: t.name,
      moderated: t.moderated,
      emojiId: t.emoji_id ?? null,
      emojiName: t.emoji_name ?? null,
    })),
    defaultReactionEmoji:
      reaction === undefined
        ? undefined
        : reaction && { emojiId: reaction.emoji_id ?? null, emojiName: reaction.emoji_name ?? null },
    defaultSortOrder: c.default_sort_order as number | null | undefined,
    defaultForumLayout: c.default_forum_layout as number | undefined,
    flags: c.flags as number | undefined,
  });
  return Object.keys(extra).length ? extra : undefined;
}

export function normaliseChannel(raw: APIChannel): ChannelInfo {
  const c = raw as unknown as Record<string, unknown>;
  const overwrites =
    (c.permission_overwrites as Array<{ id: string; type: number; allow: string; deny: string }>) ?? [];
  const extra = channelExtras(c);
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
    ...(extra ? { extra } : {}),
  };
}

export function normaliseRole(raw: APIRole): RoleInfo {
  const tags = raw.tags;
  // Discord encodes boolean role tags as `null` when true and absence when false.
  const flag = (t: object | undefined, k: string) => (t ? Object.prototype.hasOwnProperty.call(t, k) : false);
  const colors = (raw as { colors?: { secondary_color?: number | null; tertiary_color?: number | null } })
    .colors;
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
    ...compact({
      icon: raw.icon ?? undefined,
      unicodeEmoji: raw.unicode_emoji ?? undefined,
      secondaryColor: colors?.secondary_color ?? undefined,
      tertiaryColor: colors?.tertiary_color ?? undefined,
    }),
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
    icon: raw.icon ?? null,
    banner: raw.banner ?? null,
    splash: raw.splash ?? null,
    discoverySplash: raw.discovery_splash ?? null,
    vanityUrlCode: raw.vanity_url_code ?? null,
    incidents: raw.incidents_data ? normaliseIncidents(raw.incidents_data) : null,
  };
}

export function normaliseIncidents(raw: APIIncidentsData): IncidentsInfo {
  return compact({
    invitesDisabledUntil: raw.invites_disabled_until ?? null,
    dmsDisabledUntil: raw.dms_disabled_until ?? null,
    raidDetectedAt: raw.raid_detected_at ?? undefined,
    dmSpamDetectedAt: raw.dm_spam_detected_at ?? undefined,
  });
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
  // Every key is kept, including ones steward does not model, so an update can
  // send them back instead of erasing them.
  return {
    id: raw.id,
    name: raw.name,
    eventType: raw.event_type,
    triggerType: raw.trigger_type,
    triggerMetadata: compact({ ...(raw.trigger_metadata ?? {}) } as AutoModRuleInfo['triggerMetadata']),
    actions: raw.actions.map((a) => ({
      type: a.type,
      metadata: a.metadata
        ? compact({ ...a.metadata, custom_message: a.metadata.custom_message ?? undefined })
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

export function normaliseBotProfile(raw: APIGuildMember): BotProfileInfo {
  return { nick: raw.nick ?? null, avatar: raw.avatar ?? null, banner: raw.banner ?? null };
}

export function normaliseOnboarding(raw: APIGuildOnboarding): OnboardingInfo {
  return {
    enabled: raw.enabled,
    mode: raw.mode,
    defaultChannelIds: [...raw.default_channel_ids],
    prompts: raw.prompts.map((p) => ({
      id: p.id,
      title: p.title,
      type: p.type,
      singleSelect: p.single_select,
      required: p.required,
      inOnboarding: p.in_onboarding,
      options: p.options.map((o) => ({
        id: o.id,
        title: o.title,
        description: o.description ?? null,
        channelIds: [...o.channel_ids],
        roleIds: [...o.role_ids],
        emojiId: o.emoji?.id ?? null,
        emojiName: o.emoji?.name ?? null,
      })),
    })),
  };
}

export function normaliseWelcomeScreen(raw: APIGuildWelcomeScreen): WelcomeScreenInfo {
  return {
    description: raw.description ?? null,
    channels: raw.welcome_channels.map((c) => ({
      channelId: c.channel_id,
      description: c.description,
      emojiId: c.emoji_id ?? null,
      emojiName: c.emoji_name ?? null,
    })),
  };
}

export function normaliseWidget(raw: APIGuildWidgetSettings): WidgetInfo {
  return { enabled: raw.enabled, channelId: raw.channel_id ?? null };
}

export function normaliseEmoji(raw: APIEmoji): EmojiInfo {
  return {
    id: raw.id ?? '',
    name: raw.name ?? '',
    animated: Boolean(raw.animated),
    roleIds: [...(raw.roles ?? [])],
    managed: Boolean(raw.managed),
    available: raw.available ?? true,
    creatorId: raw.user?.id ?? null,
  };
}

export function normaliseSticker(raw: APISticker): StickerInfo {
  return {
    id: raw.id,
    name: raw.name,
    description: raw.description ?? null,
    tags: raw.tags,
    formatType: raw.format_type,
    available: raw.available ?? true,
    creatorId: raw.user?.id ?? null,
  };
}

export function normaliseSound(raw: APISoundboardSound): SoundInfo {
  return {
    id: raw.sound_id,
    name: raw.name,
    volume: raw.volume,
    emojiId: raw.emoji_id ?? null,
    emojiName: raw.emoji_name ?? null,
    available: raw.available,
    creatorId: raw.user?.id ?? null,
  };
}

export function normaliseScheduledEvent(raw: APIGuildScheduledEvent): ScheduledEventInfo {
  return {
    id: raw.id,
    name: raw.name,
    description: raw.description ?? null,
    channelId: raw.channel_id ?? null,
    entityType: raw.entity_type,
    location: raw.entity_metadata?.location ?? null,
    startTime: raw.scheduled_start_time,
    endTime: raw.scheduled_end_time ?? null,
    status: raw.status,
    userCount: raw.user_count ?? null,
    image: raw.image ?? null,
    recurrence: (raw.recurrence_rule as RecurrenceRule | null) ?? null,
    creatorId: raw.creator_id ?? null,
  };
}

export function normaliseInvite(raw: APIExtendedInvite): InviteInfo {
  return {
    code: raw.code,
    channelId: raw.channel?.id ?? null,
    inviterId: raw.inviter?.id ?? null,
    uses: raw.uses,
    maxUses: raw.max_uses,
    maxAge: raw.max_age,
    temporary: raw.temporary,
    createdAt: raw.created_at ?? null,
    expiresAt: raw.expires_at ?? null,
    roleIds: (raw.roles ?? []).map((x) => x.id),
  };
}

/** Drops the token and URL: either lets anyone post as the webhook. */
export function normaliseWebhook(raw: APIWebhook): WebhookInfo {
  return {
    id: raw.id,
    type: raw.type,
    channelId: raw.channel_id ?? null,
    name: raw.name ?? null,
    avatar: raw.avatar ?? null,
    applicationId: raw.application_id ?? null,
    creatorId: raw.user?.id ?? null,
  };
}

export function normaliseTemplate(raw: APITemplate): TemplateInfo {
  return {
    code: raw.code,
    name: raw.name,
    description: raw.description ?? null,
    usageCount: raw.usage_count,
    creatorId: raw.creator_id,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    isDirty: Boolean(raw.is_dirty),
  };
}

export function normaliseIntegration(raw: APIGuildIntegration): IntegrationInfo {
  return {
    id: raw.id,
    name: raw.name,
    type: raw.type,
    enabled: Boolean(raw.enabled),
    applicationId: raw.application?.id ?? null,
    accountName: raw.account?.name ?? null,
  };
}
