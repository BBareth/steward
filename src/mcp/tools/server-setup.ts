import { z } from 'zod';
import { botStanding, channelPermissions, has, P } from '../../discord/permissions.js';
import type {
  BotProfileWriteBody,
  ChannelInfo,
  GuildSnapshot,
  OnboardingWriteBody,
  WelcomeScreenWriteBody,
} from '../../discord/types.js';
import { assertSelfAssignable } from '../../features/role-panels.js';
import { StewardError } from '../../util/errors.js';
import { newSnowflake } from '../../util/ids.js';
import { loadMedia, mediaInput } from '../../util/media.js';
import { defineTool } from '../registry.js';
import {
  cdnUrl,
  emojiInput,
  emojiResolver,
  guildIdInput,
  mutate,
  reasonInput,
  requireFound,
  section,
  snapshotOf,
  snowflake,
  untrusted,
} from './common.js';

const HOUR = 3_600_000;

function requireCommunity(s: GuildSnapshot, what: string) {
  if (!s.guild.features.includes('COMMUNITY'))
    throw new StewardError(
      'precondition_failed',
      `${what} needs Community; turn it on with update_guild_settings (community: true) first`,
    );
}

function requireManageGuild(s: GuildSnapshot) {
  if (!has(botStanding(s).permissions, P.ManageGuild))
    throw new StewardError('precondition_failed', 'the bot lacks Manage Server');
}

/** A channel members can be pointed at: anything but a category. */
function pointableChannel(s: GuildSnapshot, id: string): ChannelInfo {
  const c = requireFound(
    s.channels.find((x) => x.id === id),
    `channel ${id}`,
  );
  if (c.kind === 'category')
    throw new StewardError('invalid_argument', `${c.name} is a category, not a channel`);
  return c;
}

const everyonePerms = (s: GuildSnapshot, c: ChannelInfo) =>
  channelPermissions(s, c, { userId: null, roleIds: [] });

const emojiOut = (id: string | null, name: string | null) => id ?? name ?? null;

const onboardingOption = z.object({
  id: snowflake
    .optional()
    .describe('Keep an existing option (ids from get_server_setup); leave out for a new one.'),
  title: z.string().min(1).max(50),
  description: z.string().max(100).nullable().optional(),
  emoji: emojiInput.optional(),
  role_ids: z.array(snowflake).max(50).default([]).describe('Roles members get by picking this option.'),
  channel_ids: z.array(snowflake).max(50).default([]).describe('Channels shown to members who pick it.'),
});

const onboardingPrompt = z.object({
  id: snowflake.optional().describe('Keep an existing question; leave out for a new one.'),
  title: z.string().min(1).max(100),
  type: z.enum(['multiple_choice', 'dropdown']).default('multiple_choice'),
  single_select: z.boolean().default(false),
  required: z.boolean().default(false),
  in_onboarding: z
    .boolean()
    .default(true)
    .describe('Ask it while joining. False shows it only under Channels & Roles.'),
  options: z.array(onboardingOption).min(1).max(50),
});

export const serverSetupTools = [
  defineTool({
    name: 'get_server_setup',
    title: 'Server setup',
    description:
      'Onboarding, welcome screen, widget, security actions (paused invites and DMs, raid alerts), server images, vanity URL and which boost-gated customisations this server has unlocked. Parts the bot may not read come back as { error }.',
    scope: 'read',
    input: z.object({ guild_id: guildIdInput }),
    guildOf: (a) => a.guild_id,
    handler: async ({ guild_id }, call) => {
      const s = await snapshotOf(call, guild_id);
      const { adapter } = call.app;
      const g = s.guild;
      const f = new Set(g.features);
      const channelName = (id: string) => s.channels.find((c) => c.id === id)?.name ?? null;
      const [onboarding, welcome, widget] = await Promise.all([
        section(adapter.fetchOnboarding(guild_id), (o) => ({
          enabled: o.enabled,
          mode: o.mode === 1 ? 'advanced' : 'default',
          default_channels: o.defaultChannelIds.map((id) => ({ id, name: channelName(id) })),
          prompts: o.prompts.map((p) => ({
            id: p.id,
            title: p.title,
            type: p.type === 1 ? 'dropdown' : 'multiple_choice',
            single_select: p.singleSelect,
            required: p.required,
            in_onboarding: p.inOnboarding,
            options: p.options.map((x) => ({
              id: x.id,
              title: x.title,
              description: untrusted(x.description),
              emoji: emojiOut(x.emojiId, x.emojiName),
              role_ids: x.roleIds,
              channel_ids: x.channelIds,
            })),
          })),
        })),
        section(adapter.fetchWelcomeScreen(guild_id), (w) =>
          w
            ? {
                enabled: f.has('WELCOME_SCREEN_ENABLED'),
                description: untrusted(w.description),
                channels: w.channels.map((c) => ({
                  channel_id: c.channelId,
                  channel_name: channelName(c.channelId),
                  description: untrusted(c.description),
                  emoji: emojiOut(c.emojiId, c.emojiName),
                })),
              }
            : null,
        ),
        section(adapter.fetchWidget(guild_id), (w) => ({ enabled: w.enabled, channel_id: w.channelId })),
      ]);
      const incidents = g.incidents ?? null;
      return {
        guild_id,
        name: g.name,
        community: f.has('COMMUNITY'),
        boost_tier: g.premiumTier,
        images: {
          icon: cdnUrl(`icons/${guild_id}`, g.icon),
          banner: cdnUrl(`banners/${guild_id}`, g.banner),
          invite_splash: cdnUrl(`splashes/${guild_id}`, g.splash),
          discovery_splash: cdnUrl(`discovery-splashes/${guild_id}`, g.discoverySplash),
        },
        vanity_url_code: g.vanityUrlCode ?? null,
        onboarding,
        welcome_screen: welcome,
        widget,
        security: {
          invites_paused: f.has('INVITES_DISABLED'),
          raid_alerts: !f.has('RAID_ALERTS_DISABLED'),
          invites_paused_until: incidents?.invitesDisabledUntil ?? null,
          dms_paused_until: incidents?.dmsDisabledUntil ?? null,
          raid_detected_at: incidents?.raidDetectedAt ?? null,
          dm_spam_detected_at: incidents?.dmSpamDetectedAt ?? null,
        },
        unlocked: {
          animated_icon: f.has('ANIMATED_ICON'),
          banner: f.has('BANNER'),
          animated_banner: f.has('ANIMATED_BANNER'),
          invite_splash: f.has('INVITE_SPLASH'),
          vanity_url: f.has('VANITY_URL'),
          role_icons: f.has('ROLE_ICONS'),
          enhanced_role_colors: f.has('ENHANCED_ROLE_COLORS'),
          discoverable: f.has('DISCOVERABLE'),
        },
      };
    },
  }),

  defineTool({
    name: 'configure_onboarding',
    title: 'Configure onboarding',
    description:
      "Replace the server's whole onboarding: the questions new members answer, the roles and channels each answer gives, and the default channels. Pass every question you want to keep, with its id from get_server_setup. Roles must be safe to self-assign. Needs Community, Manage Server and Manage Roles; enabling needs at least 7 default channels.",
    scope: 'write',
    input: z.object({
      guild_id: guildIdInput,
      enabled: z.boolean(),
      mode: z
        .enum(['default', 'advanced'])
        .default('default')
        .describe('advanced also counts channels from questions towards the default-channel minimum.'),
      default_channel_ids: z.array(snowflake).max(500),
      prompts: z.array(onboardingPrompt).max(15),
      reason: reasonInput,
    }),
    guildOf: (a) => a.guild_id,
    handler: async (a, call) => {
      const s = await snapshotOf(call, a.guild_id);
      requireCommunity(s, 'onboarding');
      if (!has(botStanding(s).permissions, P.ManageGuild | P.ManageRoles))
        throw new StewardError('precondition_failed', 'onboarding needs Manage Server and Manage Roles');
      if (new Set(a.default_channel_ids).size !== a.default_channel_ids.length)
        throw new StewardError('invalid_argument', 'a default channel appears twice');
      for (const id of a.default_channel_ids) pointableChannel(s, id);

      const current = await call.app.adapter.fetchOnboarding(a.guild_id);
      const knownPrompts = new Set(current.prompts.map((p) => p.id));
      const knownOptions = new Set(current.prompts.flatMap((p) => p.options.map((o) => o.id)));
      const used = new Set<string>();
      const idFor = (id: string | undefined, known: Set<string>, what: string) => {
        if (id === undefined) return newSnowflake();
        if (!known.has(id))
          throw new StewardError(
            'invalid_argument',
            `${what} ${id} is not in the current onboarding; leave id out to add a new one`,
          );
        if (used.has(id)) throw new StewardError('invalid_argument', `${what} ${id} appears twice`);
        used.add(id);
        return id;
      };
      const prot = new Set(call.app.store.listProtectedRoles(a.guild_id));
      const emoji = await emojiResolver(
        call,
        a.guild_id,
        a.prompts.flatMap((p) => p.options.map((o) => o.emoji)),
      );

      const prompts: OnboardingWriteBody['prompts'] = a.prompts.map((p) => {
        if (p.required && !p.in_onboarding)
          throw new StewardError('invalid_argument', `"${p.title}" is required, so it must be in onboarding`);
        return {
          id: idFor(p.id, knownPrompts, 'question'),
          title: p.title,
          type: p.type === 'dropdown' ? 1 : 0,
          single_select: p.single_select,
          required: p.required,
          in_onboarding: p.in_onboarding,
          options: p.options.map((o) => {
            if (o.role_ids.length + o.channel_ids.length === 0)
              throw new StewardError('invalid_argument', `option "${o.title}" must give a role or a channel`);
            for (const id of o.role_ids) assertSelfAssignable(s, id, prot);
            for (const id of o.channel_ids) pointableChannel(s, id);
            const e = o.emoji ? emoji(o.emoji) : null;
            return {
              id: idFor(o.id, knownOptions, 'option'),
              title: o.title,
              description: o.description ?? null,
              channel_ids: o.channel_ids,
              role_ids: o.role_ids,
              ...(e ? { ...(e.id ? { emoji_id: e.id } : {}), emoji_name: e.name } : {}),
            };
          }),
        };
      });

      const mode = a.mode === 'advanced' ? 1 : 0;
      const counted = new Set(a.default_channel_ids);
      if (mode === 1)
        for (const p of prompts) for (const o of p.options) o.channel_ids.forEach((id) => counted.add(id));
      if (a.enabled && counted.size < 7)
        throw new StewardError(
          'precondition_failed',
          `Discord needs at least 7 default channels to enable onboarding; ${counted.size} given`,
        );
      const warnings: string[] = [];
      const sendable = [...counted].filter((id) =>
        has(everyonePerms(s, pointableChannel(s, id)), P.ViewChannel | P.SendMessages),
      ).length;
      if (a.enabled && sendable < 5)
        warnings.push(
          `Discord expects at least 5 default channels where @everyone can send messages; ${sendable} found`,
        );

      const body: OnboardingWriteBody = {
        prompts,
        default_channel_ids: a.default_channel_ids,
        enabled: a.enabled,
        mode,
      };
      const out = await mutate(call, a.guild_id, a.reason, {
        action: 'configure_onboarding',
        resourceKind: 'onboarding',
        targetId: a.guild_id,
        summary: `${a.enabled ? 'enable' : 'save'} onboarding: ${prompts.length} questions, ${a.default_channel_ids.length} default channels`,
        idempotent: true,
        run: (reason) => call.app.adapter.putOnboarding(a.guild_id, body, reason),
      });
      const saved = out.status === 'succeeded' ? out.result.prompts : null;
      return {
        op_id: out.opId,
        enabled: a.enabled,
        mode: a.mode,
        default_channel_count: a.default_channel_ids.length,
        prompts: (saved ?? prompts).map((p) => ({
          id: p.id,
          title: p.title,
          options: p.options.map((o) => ({ id: o.id, title: o.title })),
        })),
        ...(warnings.length ? { warnings } : {}),
      };
    },
  }),

  defineTool({
    name: 'configure_welcome_screen',
    title: 'Configure welcome screen',
    description:
      'Set the welcome screen new members see before onboarding: on/off, a description and up to 5 recommended channels with a short line and emoji each. Fields left out stay as they are; channels replaces the whole list. Needs Community and Manage Server.',
    scope: 'write',
    input: z.object({
      guild_id: guildIdInput,
      enabled: z.boolean().optional(),
      description: z.string().max(140).nullable().optional(),
      channels: z
        .array(
          z.object({
            channel_id: snowflake,
            description: z.string().min(1).max(50),
            emoji: emojiInput.optional(),
          }),
        )
        .max(5)
        .optional(),
      reason: reasonInput,
    }),
    guildOf: (a) => a.guild_id,
    handler: async (a, call) => {
      const s = await snapshotOf(call, a.guild_id);
      requireCommunity(s, 'the welcome screen');
      requireManageGuild(s);
      const body: WelcomeScreenWriteBody = {};
      const warnings: string[] = [];
      if (a.enabled !== undefined) body.enabled = a.enabled;
      if (a.description !== undefined) body.description = a.description;
      if (a.channels) {
        const emoji = await emojiResolver(
          call,
          a.guild_id,
          a.channels.map((c) => c.emoji),
        );
        if (new Set(a.channels.map((c) => c.channel_id)).size !== a.channels.length)
          throw new StewardError('invalid_argument', 'a channel appears twice');
        body.welcome_channels = a.channels.map((c) => {
          const ch = pointableChannel(s, c.channel_id);
          if (!has(everyonePerms(s, ch), P.ViewChannel)) warnings.push(`@everyone cannot view #${ch.name}`);
          const e = c.emoji ? emoji(c.emoji) : null;
          return {
            channel_id: ch.id,
            description: c.description,
            emoji_id: e?.id ?? null,
            emoji_name: e?.name ?? null,
          };
        });
      }
      if (Object.keys(body).length === 0) throw new StewardError('invalid_argument', 'nothing to change');
      const out = await mutate(call, a.guild_id, a.reason, {
        action: 'configure_welcome_screen',
        resourceKind: 'welcome_screen',
        targetId: a.guild_id,
        summary: `update welcome screen: ${Object.keys(body).join(', ')}`,
        idempotent: true,
        run: (reason) => call.app.adapter.editWelcomeScreen(a.guild_id, body, reason),
      });
      return { op_id: out.opId, changed: Object.keys(body), ...(warnings.length ? { warnings } : {}) };
    },
  }),

  defineTool({
    name: 'configure_widget',
    title: 'Configure server widget',
    description:
      'Turn the server widget (the embeddable member list) on or off and choose the channel its invite button points to. Needs Manage Server.',
    scope: 'write',
    input: z.object({
      guild_id: guildIdInput,
      enabled: z.boolean().optional(),
      channel_id: snowflake.nullable().optional().describe('Invite channel, or null for none.'),
      reason: reasonInput,
    }),
    guildOf: (a) => a.guild_id,
    handler: async (a, call) => {
      const s = await snapshotOf(call, a.guild_id);
      requireManageGuild(s);
      const body: { enabled?: boolean; channel_id?: string | null } = {};
      if (a.enabled !== undefined) body.enabled = a.enabled;
      if (a.channel_id !== undefined) body.channel_id = a.channel_id && pointableChannel(s, a.channel_id).id;
      if (Object.keys(body).length === 0) throw new StewardError('invalid_argument', 'nothing to change');
      const out = await mutate(call, a.guild_id, a.reason, {
        action: 'configure_widget',
        resourceKind: 'widget',
        targetId: a.guild_id,
        summary: `update widget: ${Object.keys(body).join(', ')}`,
        idempotent: true,
        run: (reason) => call.app.adapter.editWidget(a.guild_id, body, reason),
      });
      return { op_id: out.opId, changed: Object.keys(body) };
    },
  }),

  defineTool({
    name: 'set_security_actions',
    title: 'Pause invites or DMs',
    description:
      "Temporarily pause new joins through invites, or DMs between members who aren't friends, for up to 24 hours (0 resumes). For an indefinite invite pause or raid alerts, use update_guild_settings. Needs Manage Server.",
    scope: 'write',
    input: z.object({
      guild_id: guildIdInput,
      pause_invites_hours: z.number().min(0).max(24).optional(),
      pause_dms_hours: z.number().min(0).max(24).optional(),
      reason: reasonInput,
    }),
    guildOf: (a) => a.guild_id,
    handler: async (a, call) => {
      const s = await snapshotOf(call, a.guild_id);
      requireManageGuild(s);
      if (a.pause_invites_hours === undefined && a.pause_dms_hours === undefined)
        throw new StewardError('invalid_argument', 'nothing to change');
      const now = Date.now();
      // Discord caps the pause at 24 hours from when it receives the request.
      const until = (hours: number) =>
        hours === 0 ? null : new Date(now + Math.min(hours * HOUR, 24 * HOUR - 60_000)).toISOString();
      // Both fields are sent every time, so the one not being changed keeps its value.
      const still = (v: string | null | undefined) => (v && Date.parse(v) > now ? v : null);
      const cur = s.guild.incidents;
      const body = {
        invites_disabled_until:
          a.pause_invites_hours !== undefined
            ? until(a.pause_invites_hours)
            : still(cur?.invitesDisabledUntil),
        dms_disabled_until:
          a.pause_dms_hours !== undefined ? until(a.pause_dms_hours) : still(cur?.dmsDisabledUntil),
      };
      const out = await mutate(call, a.guild_id, a.reason, {
        action: 'set_security_actions',
        resourceKind: 'guild',
        targetId: a.guild_id,
        summary: `security actions: invites ${body.invites_disabled_until ?? 'open'}, DMs ${body.dms_disabled_until ?? 'open'}`,
        idempotent: true,
        run: (reason) => call.app.adapter.setIncidentActions(a.guild_id, body, reason),
      });
      return {
        op_id: out.opId,
        invites_paused_until: body.invites_disabled_until,
        dms_paused_until: body.dms_disabled_until,
      };
    },
  }),

  defineTool({
    name: 'update_bot_profile',
    title: "Update the bot's server profile",
    description:
      "Change the bot's nickname, avatar, banner or bio in this server only. Images are { url } (https) or { data_uri }; null resets to the bot's global profile. The nickname needs Change Nickname.",
    scope: 'write',
    input: z.object({
      guild_id: guildIdInput,
      nick: z.string().min(1).max(32).nullable().optional(),
      avatar: mediaInput.nullable().optional(),
      banner: mediaInput.nullable().optional(),
      bio: z.string().max(190).nullable().optional(),
      reason: reasonInput,
    }),
    guildOf: (a) => a.guild_id,
    handler: async (a, call) => {
      const s = await snapshotOf(call, a.guild_id);
      if (a.nick !== undefined && !has(botStanding(s).permissions, P.ChangeNickname))
        throw new StewardError('precondition_failed', 'the bot lacks Change Nickname');
      const body: BotProfileWriteBody = {};
      if (a.nick !== undefined) body.nick = a.nick;
      if (a.avatar !== undefined) body.avatar = a.avatar && (await loadMedia(a.avatar, 'avatar')).dataUri;
      if (a.banner !== undefined)
        body.banner = a.banner && (await loadMedia(a.banner, 'profile_banner')).dataUri;
      if (a.bio !== undefined) body.bio = a.bio;
      if (Object.keys(body).length === 0) throw new StewardError('invalid_argument', 'nothing to change');
      const out = await mutate(call, a.guild_id, a.reason, {
        action: 'update_bot_profile',
        resourceKind: 'member',
        targetId: s.botMember.userId,
        summary: `update the bot's server profile: ${Object.keys(body).join(', ')}`,
        idempotent: true,
        run: (reason) => call.app.adapter.editBotProfile(a.guild_id, body, reason),
      });
      return { op_id: out.opId, changed: Object.keys(body) };
    },
  }),
];
