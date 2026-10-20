import { z } from 'zod';
import {
  AUTOMOD_PRESETS,
  CONTENT_FILTERS,
  KEY_RE,
  NOTIFICATION_LEVELS,
  SYSTEM_CHANNEL_FLAGS,
  VERIFICATION_LEVELS,
} from '../../blueprint/schema.js';
import { botChannelPermissions, botStanding, has, P, roleById } from '../../discord/permissions.js';
import type { AutoModWriteBody, GuildSnapshot, GuildWriteBody } from '../../discord/types.js';
import { assertSelfAssignable, buildPanelMessage } from '../../features/role-panels.js';
import { buildMessageBody, embedSchema, messageFingerprint } from '../../features/messages.js';
import { automodPatch, writeListedRule } from '../../ops/automod.js';
import { runOperation } from '../../ops/journal.js';
import { StewardError } from '../../util/errors.js';
import { hashValue } from '../../util/hash.js';
import { newId } from '../../util/ids.js';
import { defineTool } from '../registry.js';
import {
  guildIdInput,
  idOf,
  mutate,
  opContext,
  reasonInput,
  requireFound,
  snapshotOf,
  snowflake,
  withGuildLock,
} from './common.js';

const enumOf = <T extends Record<string, number>>(o: T) =>
  z.enum(Object.keys(o) as [keyof T & string, ...(keyof T & string)[]]);

const messageInput = {
  content: z.string().max(2000).optional(),
  embeds: z.array(embedSchema).max(10).optional(),
};

function requireTextChannel(s: GuildSnapshot, channelId: string, embeds: boolean) {
  const ch = requireFound(
    s.channels.find((c) => c.id === channelId),
    `channel ${channelId}`,
  );
  if (!['text', 'announcement'].includes(ch.kind))
    throw new StewardError(
      'invalid_argument',
      `#${ch.name} is a ${ch.kind} channel; messages need a text or announcement channel`,
    );
  const perms = botChannelPermissions(s, ch);
  if (!has(perms, P.ViewChannel | P.SendMessages))
    throw new StewardError('precondition_failed', `the bot cannot post in #${ch.name}`);
  if (embeds && !has(perms, P.EmbedLinks))
    throw new StewardError('precondition_failed', `the bot lacks Embed Links in #${ch.name}`);
  return ch;
}

const automodTrigger = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('keyword'),
    keywords: z.array(z.string().min(1).max(60)).max(1000).default([]),
    regex_patterns: z.array(z.string().min(1).max(260)).max(10).default([]),
    allow_list: z.array(z.string().min(1).max(60)).max(100).default([]),
  }),
  z.object({ type: z.literal('spam') }),
  z.object({
    type: z.literal('keyword_preset'),
    presets: z.array(enumOf(AUTOMOD_PRESETS)).min(1),
    allow_list: z.array(z.string().min(1).max(60)).max(1000).default([]),
  }),
  z.object({
    type: z.literal('mention_spam'),
    mention_total_limit: z.number().int().min(1).max(50),
    raid_protection: z.boolean().default(false),
  }),
]);

const automodAction = z.discriminatedUnion('type', [
  z.object({ type: z.literal('block_message'), custom_message: z.string().max(150).optional() }),
  z.object({ type: z.literal('alert'), channel_id: snowflake }),
  z.object({ type: z.literal('timeout'), duration_seconds: z.number().int().min(1).max(2419200) }),
]);

export const featureTools = [
  defineTool({
    name: 'update_guild_settings',
    title: 'Update server settings',
    description:
      'Change server settings Discord exposes to bots: name, description, verification level, notification default, content filter, AFK channel/timeout, system/rules/updates/safety channels and flags, locale, boost bar, and the Community feature. Needs Manage Server.',
    scope: 'write',
    input: z.object({
      guild_id: guildIdInput,
      name: z.string().min(2).max(100).optional(),
      description: z.string().max(120).nullable().optional(),
      verification_level: enumOf(VERIFICATION_LEVELS).optional(),
      default_notifications: enumOf(NOTIFICATION_LEVELS).optional(),
      explicit_content_filter: enumOf(CONTENT_FILTERS).optional(),
      afk_channel_id: snowflake.nullable().optional(),
      afk_timeout: z
        .union([z.literal(60), z.literal(300), z.literal(900), z.literal(1800), z.literal(3600)])
        .optional(),
      system_channel_id: snowflake.nullable().optional(),
      system_channel_flags: z
        .object({
          suppress_join_notifications: z.boolean().optional(),
          suppress_premium_subscriptions: z.boolean().optional(),
          suppress_guild_reminders: z.boolean().optional(),
          suppress_join_notification_replies: z.boolean().optional(),
        })
        .optional(),
      rules_channel_id: snowflake.nullable().optional(),
      public_updates_channel_id: snowflake.nullable().optional(),
      safety_alerts_channel_id: snowflake.nullable().optional(),
      preferred_locale: z.string().min(2).max(10).optional(),
      premium_progress_bar: z.boolean().optional(),
      community: z
        .boolean()
        .optional()
        .describe(
          'Enable or disable Community. Needs Administrator. Enabling needs rules and updates text channels, verification "low"+ and content filter "all_members".',
        ),
      reason: reasonInput,
    }),
    guildOf: (a) => a.guild_id,
    handler: async (a, call) => {
      const s = await snapshotOf(call, a.guild_id);
      if (!has(botStanding(s).permissions, P.ManageGuild))
        throw new StewardError('precondition_failed', 'the bot lacks Manage Server');
      const body: GuildWriteBody = {};
      const chan = (id: string | null | undefined) => {
        if (id)
          requireFound(
            s.channels.find((c) => c.id === id),
            `channel ${id}`,
          );
        return id;
      };
      if (a.name !== undefined) body.name = a.name;
      if (a.description !== undefined) body.description = a.description;
      if (a.verification_level) body.verification_level = VERIFICATION_LEVELS[a.verification_level];
      if (a.default_notifications)
        body.default_message_notifications = NOTIFICATION_LEVELS[a.default_notifications];
      if (a.explicit_content_filter)
        body.explicit_content_filter = CONTENT_FILTERS[a.explicit_content_filter];
      if (a.afk_channel_id !== undefined) body.afk_channel_id = chan(a.afk_channel_id);
      if (a.afk_timeout !== undefined) body.afk_timeout = a.afk_timeout;
      if (a.system_channel_id !== undefined) body.system_channel_id = chan(a.system_channel_id);
      if (a.rules_channel_id !== undefined) body.rules_channel_id = chan(a.rules_channel_id);
      if (a.public_updates_channel_id !== undefined)
        body.public_updates_channel_id = chan(a.public_updates_channel_id);
      if (a.safety_alerts_channel_id !== undefined)
        body.safety_alerts_channel_id = chan(a.safety_alerts_channel_id);
      if (a.preferred_locale !== undefined) body.preferred_locale = a.preferred_locale;
      if (a.premium_progress_bar !== undefined) body.premium_progress_bar_enabled = a.premium_progress_bar;
      if (a.system_channel_flags) {
        let flags = s.guild.systemChannelFlags;
        for (const [k, bit] of Object.entries(SYSTEM_CHANNEL_FLAGS)) {
          const v = a.system_channel_flags[k as keyof typeof SYSTEM_CHANNEL_FLAGS];
          if (v === true) flags |= bit;
          if (v === false) flags &= ~bit;
        }
        body.system_channel_flags = flags;
      }
      if (a.community !== undefined) {
        if (a.community !== s.guild.features.includes('COMMUNITY') && !botStanding(s).isAdmin)
          throw new StewardError(
            'precondition_failed',
            'Discord requires Administrator to turn Community on or off',
          );
        const f = new Set(s.guild.features);
        if (a.community) f.add('COMMUNITY');
        else f.delete('COMMUNITY');
        body.features = [...f];
      }
      if (Object.keys(body).length === 0) throw new StewardError('invalid_argument', 'nothing to change');
      const out = await mutate(call, a.guild_id, a.reason, {
        action: 'update_settings',
        resourceKind: 'guild',
        targetId: a.guild_id,
        summary: `update server settings: ${Object.keys(body).join(', ')}`,
        idempotent: true,
        run: (reason) => call.app.adapter.editGuild(a.guild_id, body, reason),
      });
      return { op_id: out.opId, changed: Object.keys(body) };
    },
  }),

  defineTool({
    name: 'post_message',
    title: 'Post a bot message',
    description:
      'Post a message (content and/or up to 10 embeds) as the bot. Nothing pings unless listed in mention_user_ids/mention_role_ids; @everyone/@here only with allow_everyone_mention. With a key, the message is managed: posting the same key again edits it in place instead of posting twice.',
    scope: 'write',
    input: z.object({
      guild_id: guildIdInput,
      channel_id: snowflake,
      ...messageInput,
      key: z.string().regex(KEY_RE).optional().describe('Managed-message key, e.g. "rules-post".'),
      mention_user_ids: z.array(snowflake).max(20).optional(),
      mention_role_ids: z.array(snowflake).max(20).optional(),
      allow_everyone_mention: z.boolean().default(false),
    }),
    guildOf: (a) => a.guild_id,
    handler: async (a, call) => {
      const s = await snapshotOf(call, a.guild_id);
      const ch = requireTextChannel(s, a.channel_id, !!a.embeds?.length);
      const body = buildMessageBody(
        { content: a.content, embeds: a.embeds },
        { users: a.mention_user_ids, roles: a.mention_role_ids, everyone: a.allow_everyone_mention },
      );
      const payloadHash = hashValue(body);
      const { store } = call.app;
      return withGuildLock(call, a.guild_id, async () => {
        const ctx = opContext(call, a.guild_id);
        const existing = a.key ? store.getManagedMessage(a.guild_id, a.key) : undefined;
        if (existing && existing.channelId !== ch.id) {
          throw new StewardError(
            'conflict',
            `managed message "${a.key}" lives in another channel (${existing.channelId}); delete it first or use another key`,
          );
        }
        if (existing && (await call.app.adapter.fetchMessage(existing.channelId, existing.messageId))) {
          const out = await runOperation(ctx, {
            action: 'edit_message',
            resourceKind: 'message',
            resourceKey: a.key,
            targetId: existing.messageId,
            summary: `edit managed message ${a.key}`,
            idempotent: true,
            run: () => call.app.adapter.editMessage(ch.id, existing.messageId, body),
          });
          store.setManagedMessage({
            guildId: a.guild_id,
            key: a.key!,
            channelId: ch.id,
            messageId: existing.messageId,
            payloadHash,
          });
          return { op_id: out.opId, message_id: existing.messageId, edited: true };
        }
        const out = await runOperation(ctx, {
          action: 'post_message',
          resourceKind: 'message',
          resourceKey: a.key,
          targetId: ch.id,
          summary: `post message${a.key ? ` ${a.key}` : ''} in #${ch.name}`,
          idempotent: true,
          recordMatch: a.key
            ? {
                kind: 'message',
                key: a.key,
                channelId: ch.id,
                payloadHash,
                fingerprint: messageFingerprint(body),
              }
            : undefined,
          run: (_r, opId) =>
            call.app.adapter.sendMessage(ch.id, { ...body, nonce: opId.slice(0, 25), enforce_nonce: true }),
          resultId: (m) => m.id,
        });
        const id = idOf(out, (m) => m.id);
        if (a.key)
          store.setManagedMessage({
            guildId: a.guild_id,
            key: a.key,
            channelId: ch.id,
            messageId: id,
            payloadHash,
          });
        return { op_id: out.opId, message_id: id, edited: false };
      });
    },
  }),

  defineTool({
    name: 'edit_message',
    title: 'Edit a bot message',
    description:
      'Replace the content and embeds of a message the bot posted, by managed key or by channel/message ID. Mentions stay disabled.',
    scope: 'write',
    input: z.object({
      guild_id: guildIdInput,
      key: z.string().regex(KEY_RE).optional(),
      channel_id: snowflake.optional(),
      message_id: snowflake.optional(),
      ...messageInput,
    }),
    guildOf: (a) => a.guild_id,
    handler: async (a, call) => {
      const s = await snapshotOf(call, a.guild_id);
      const managed = a.key
        ? requireFound(call.app.store.getManagedMessage(a.guild_id, a.key), `managed message "${a.key}"`)
        : undefined;
      const channelId = managed?.channelId ?? a.channel_id;
      const messageId = managed?.messageId ?? a.message_id;
      if (!channelId || !messageId)
        throw new StewardError('invalid_argument', 'pass key, or channel_id and message_id');
      requireTextChannel(s, channelId, !!a.embeds?.length);
      const msg = requireFound(
        await call.app.adapter.fetchMessage(channelId, messageId),
        `message ${messageId}`,
      );
      if (msg.authorId !== s.botMember.userId)
        throw new StewardError('forbidden', 'only messages the bot posted can be edited');
      const body = buildMessageBody({ content: a.content, embeds: a.embeds });
      const out = await mutate(call, a.guild_id, undefined, {
        action: 'edit_message',
        resourceKind: 'message',
        resourceKey: a.key,
        targetId: messageId,
        summary: `edit message ${messageId}`,
        idempotent: true,
        run: () => call.app.adapter.editMessage(channelId, messageId, body),
      });
      if (managed) call.app.store.setManagedMessage({ ...managed, payloadHash: hashValue(body) });
      return { op_id: out.opId, message_id: messageId };
    },
  }),

  defineTool({
    name: 'delete_message',
    title: 'Delete a bot message',
    description: 'Delete a message the bot posted (by managed key or channel/message ID) and forget its key.',
    scope: 'destructive',
    input: z.object({
      guild_id: guildIdInput,
      key: z.string().regex(KEY_RE).optional(),
      channel_id: snowflake.optional(),
      message_id: snowflake.optional(),
      reason: reasonInput,
    }),
    guildOf: (a) => a.guild_id,
    handler: async (a, call) => {
      const s = await snapshotOf(call, a.guild_id);
      const managed = a.key
        ? requireFound(call.app.store.getManagedMessage(a.guild_id, a.key), `managed message "${a.key}"`)
        : undefined;
      const channelId = managed?.channelId ?? a.channel_id;
      const messageId = managed?.messageId ?? a.message_id;
      if (!channelId || !messageId)
        throw new StewardError('invalid_argument', 'pass key, or channel_id and message_id');
      requireFound(
        s.channels.find((c) => c.id === channelId),
        `channel ${channelId}`,
      );
      const msg = await call.app.adapter.fetchMessage(channelId, messageId);
      if (msg && msg.authorId !== s.botMember.userId)
        throw new StewardError('forbidden', 'only messages the bot posted can be deleted with this tool');
      const out = await mutate(call, a.guild_id, a.reason, {
        action: 'delete_message',
        resourceKind: 'message',
        resourceKey: a.key,
        targetId: messageId,
        summary: `delete message ${messageId}`,
        idempotent: true,
        notFoundIsSuccess: true,
        run: (reason) => call.app.adapter.deleteMessage(channelId, messageId, reason),
      });
      if (managed) call.app.store.deleteManagedMessage(a.guild_id, managed.key);
      return { op_id: out.opId, deleted: messageId };
    },
  }),

  defineTool({
    name: 'configure_welcome',
    title: 'Welcome message and join roles',
    description:
      'Configure what happens when someone joins: an optional message in a channel (placeholders {user}, {username}, {server}, {member_count}; only the new member is pinged) and optional join roles (never privileged ones). Needs DISCORD_MEMBERS_INTENT=true to run.',
    scope: 'write',
    input: z.object({
      guild_id: guildIdInput,
      enabled: z.boolean(),
      channel_id: snowflake.nullable().optional(),
      message: z.object(messageInput).optional(),
      join_role_ids: z.array(snowflake).max(10).default([]),
    }),
    guildOf: (a) => a.guild_id,
    handler: async (a, call) => {
      const s = await snapshotOf(call, a.guild_id);
      if (a.channel_id) requireTextChannel(s, a.channel_id, !!a.message?.embeds?.length);
      if (a.message) buildMessageBody(a.message);
      if (a.enabled && a.message && !a.channel_id)
        throw new StewardError('invalid_argument', 'a welcome message needs channel_id');
      const prot = new Set(call.app.store.listProtectedRoles(a.guild_id));
      for (const id of a.join_role_ids) assertSelfAssignable(s, id, prot);
      call.app.store.setWelcome({
        guildId: a.guild_id,
        enabled: a.enabled,
        channelId: a.channel_id ?? null,
        message: a.message ?? null,
        joinRoleIds: a.join_role_ids,
      });
      return {
        saved: true,
        active: a.enabled && call.app.config.membersIntent,
        warning:
          a.enabled && !call.app.config.membersIntent
            ? 'saved, but inactive: set DISCORD_MEMBERS_INTENT=true and enable Server Members Intent in the developer portal'
            : undefined,
      };
    },
  }),

  defineTool({
    name: 'manage_self_roles',
    title: 'Self-role allowlist',
    description:
      'Add or remove roles on the self-assign allowlist (only these can appear on role panels), and mark staff roles as protected so they can never be self-assigned or given on join. Privileged roles are refused.',
    scope: 'write',
    input: z.object({
      guild_id: guildIdInput,
      add: z.array(snowflake).max(50).default([]),
      remove: z.array(snowflake).max(50).default([]),
      protect: z.array(snowflake).max(50).default([]),
      unprotect: z.array(snowflake).max(50).default([]),
    }),
    guildOf: (a) => a.guild_id,
    handler: async (a, call) => {
      const s = await snapshotOf(call, a.guild_id);
      const { store } = call.app;
      for (const id of [...a.protect, ...a.unprotect]) requireFound(roleById(s, id), `role ${id}`);
      const prot = new Set(store.listProtectedRoles(a.guild_id));
      for (const id of a.protect) prot.add(id);
      for (const id of a.unprotect) prot.delete(id);
      for (const id of a.add) assertSelfAssignable(s, id, prot);
      const removedForProtection: string[] = [];
      store.transaction(() => {
        for (const id of a.protect) store.addProtectedRole(a.guild_id, id);
        for (const id of a.unprotect) store.removeProtectedRole(a.guild_id, id);
        for (const id of a.remove) store.removeSelfRole(a.guild_id, id);
        for (const id of a.add) store.addSelfRole(a.guild_id, id);
        for (const id of store.listSelfRoles(a.guild_id)) {
          if (prot.has(id)) {
            store.removeSelfRole(a.guild_id, id);
            removedForProtection.push(id);
          }
        }
      });
      return {
        self_assignable_role_ids: store.listSelfRoles(a.guild_id),
        protected_role_ids: store.listProtectedRoles(a.guild_id),
        removed_because_protected: removedForProtection.length ? removedForProtection : undefined,
      };
    },
  }),

  defineTool({
    name: 'upsert_role_panel',
    title: 'Create or update a role panel',
    description:
      'Post (or update in place) a self-role panel: an embed with one button per role, up to 25. Every role must be on the self-role allowlist (pass add_to_allowlist to add safe ones) and below the bot. mode "single" lets a member hold only one of the panel\'s roles.',
    scope: 'write',
    input: z.object({
      guild_id: guildIdInput,
      key: z.string().regex(KEY_RE),
      channel_id: snowflake,
      title: z.string().min(1).max(256),
      description: z.string().max(4000).optional(),
      mode: z.enum(['multiple', 'single']).default('multiple'),
      options: z
        .array(
          z.object({
            role_id: snowflake,
            label: z.string().min(1).max(80),
            emoji: z.string().min(1).max(64).optional(),
            style: z.enum(['primary', 'secondary', 'success', 'danger']).optional(),
          }),
        )
        .min(1)
        .max(25),
      add_to_allowlist: z.boolean().default(false),
    }),
    guildOf: (a) => a.guild_id,
    handler: async (a, call) => {
      const s = await snapshotOf(call, a.guild_id);
      const ch = requireTextChannel(s, a.channel_id, true);
      if (!has(botStanding(s).permissions, P.ManageRoles))
        throw new StewardError('precondition_failed', 'role panels need Manage Roles');
      const { store } = call.app;
      const prot = new Set(store.listProtectedRoles(a.guild_id));
      const allow = new Set(store.listSelfRoles(a.guild_id));
      const ids = a.options.map((o) => o.role_id);
      if (new Set(ids).size !== ids.length)
        throw new StewardError('invalid_argument', 'a role appears twice on the panel');
      for (const id of ids) {
        assertSelfAssignable(s, id, prot);
        if (!allow.has(id) && !a.add_to_allowlist) {
          throw new StewardError(
            'precondition_failed',
            `role ${roleById(s, id)!.name} is not on the self-role allowlist; pass add_to_allowlist: true or call manage_self_roles`,
          );
        }
      }
      return withGuildLock(call, a.guild_id, async () => {
        if (a.add_to_allowlist) for (const id of ids) store.addSelfRole(a.guild_id, id);
        const existing = store.getPanelByKey(a.guild_id, a.key);
        const panelId = existing?.id ?? newId('rp');
        const content = {
          title: a.title,
          description: a.description ?? null,
          mode: a.mode,
          options: a.options.map((o) => ({
            roleId: o.role_id,
            label: o.label,
            ...(o.emoji ? { emoji: o.emoji } : {}),
            ...(o.style ? { style: o.style } : {}),
          })),
        };
        const body = buildPanelMessage(panelId, content);
        const ctx = opContext(call, a.guild_id);
        const live =
          existing?.messageId && existing.channelId === ch.id
            ? await call.app.adapter.fetchMessage(existing.channelId, existing.messageId)
            : null;
        let messageId: string;
        let opId: string;
        if (live) {
          const out = await runOperation(ctx, {
            action: 'edit_message',
            resourceKind: 'role_panel',
            resourceKey: a.key,
            targetId: live.id,
            summary: `update role panel ${a.key}`,
            idempotent: true,
            run: () => call.app.adapter.editMessage(ch.id, live.id, body),
          });
          messageId = live.id;
          opId = out.opId;
        } else {
          const out = await runOperation(ctx, {
            action: 'post_message',
            resourceKind: 'role_panel',
            resourceKey: a.key,
            targetId: ch.id,
            summary: `post role panel ${a.key} in #${ch.name}`,
            idempotent: true,
            recordMatch: {
              kind: 'panel',
              key: a.key,
              channelId: ch.id,
              fingerprint: messageFingerprint(body),
              panel: { id: panelId, ...content },
            },
            run: (_r, op) =>
              call.app.adapter.sendMessage(ch.id, { ...body, nonce: op.slice(0, 25), enforce_nonce: true }),
            resultId: (m) => m.id,
          });
          messageId = idOf(out, (m) => m.id);
          opId = out.opId;
          if (existing?.messageId && existing.channelId !== ch.id) {
            await runOperation(ctx, {
              action: 'delete_message',
              resourceKind: 'role_panel',
              resourceKey: a.key,
              targetId: existing.messageId,
              summary: `remove old role panel ${a.key} message`,
              idempotent: true,
              notFoundIsSuccess: true,
              run: (reason) =>
                call.app.adapter.deleteMessage(existing.channelId, existing.messageId!, reason),
            });
          }
        }
        store.upsertPanel({
          id: panelId,
          guildId: a.guild_id,
          key: a.key,
          channelId: ch.id,
          messageId,
          ...content,
        });
        return { op_id: opId, panel_key: a.key, message_id: messageId, updated_in_place: !!live };
      });
    },
  }),

  defineTool({
    name: 'delete_role_panel',
    title: 'Delete a role panel',
    description:
      "Delete a role panel's message and stop handling its buttons. Roles members already hold are not removed.",
    scope: 'destructive',
    input: z.object({ guild_id: guildIdInput, key: z.string().regex(KEY_RE) }),
    guildOf: (a) => a.guild_id,
    handler: async (a, call) => {
      call.assertGuild(a.guild_id);
      const panel = requireFound(call.app.store.getPanelByKey(a.guild_id, a.key), `role panel "${a.key}"`);
      let opId: string | undefined;
      if (panel.messageId) {
        const out = await mutate(call, a.guild_id, undefined, {
          action: 'delete_message',
          resourceKind: 'role_panel',
          resourceKey: a.key,
          targetId: panel.messageId,
          summary: `delete role panel ${a.key}`,
          idempotent: true,
          notFoundIsSuccess: true,
          run: (reason) => call.app.adapter.deleteMessage(panel.channelId, panel.messageId!, reason),
        });
        opId = out.opId;
      }
      call.app.store.deletePanel(panel.id);
      return { op_id: opId, deleted: a.key };
    },
  }),

  defineTool({
    name: 'upsert_automod_rule',
    title: 'Create or update an AutoMod rule',
    description:
      "Create or update a Discord AutoMod rule by key: keyword/regex, spam, keyword presets (profanity, sexual_content, slurs) or mention spam, with block, alert-channel and timeout actions and role/channel exemptions. Discord's own limits apply (6 keyword rules, 1 of each other kind).",
    scope: 'write',
    input: z.object({
      guild_id: guildIdInput,
      key: z.string().regex(KEY_RE),
      name: z.string().min(1).max(100),
      enabled: z.boolean().default(true),
      trigger: automodTrigger,
      actions: z.array(automodAction).min(1).max(3),
      exempt_role_ids: z.array(snowflake).max(20).default([]),
      exempt_channel_ids: z.array(snowflake).max(50).default([]),
      reason: reasonInput,
    }),
    guildOf: (a) => a.guild_id,
    handler: async (a, call) => {
      const s = await snapshotOf(call, a.guild_id);
      if (!has(botStanding(s).permissions, P.ManageGuild))
        throw new StewardError('precondition_failed', 'AutoMod needs Manage Server');
      for (const act of a.actions) {
        if (act.type === 'alert') requireTextChannel(s, act.channel_id, false);
        if (act.type === 'timeout' && a.trigger.type !== 'keyword' && a.trigger.type !== 'mention_spam') {
          throw new StewardError(
            'invalid_argument',
            'Discord only allows the timeout action on keyword and mention_spam rules',
          );
        }
      }
      for (const id of a.exempt_role_ids) requireFound(roleById(s, id), `role ${id}`);
      for (const id of a.exempt_channel_ids)
        requireFound(
          s.channels.find((c) => c.id === id),
          `channel ${id}`,
        );
      const t = a.trigger;
      const [triggerType, meta] =
        t.type === 'keyword'
          ? [1, { keyword_filter: t.keywords, regex_patterns: t.regex_patterns, allow_list: t.allow_list }]
          : t.type === 'spam'
            ? [3, {}]
            : t.type === 'keyword_preset'
              ? [4, { presets: t.presets.map((p) => AUTOMOD_PRESETS[p]), allow_list: t.allow_list }]
              : [
                  5,
                  {
                    mention_total_limit: t.mention_total_limit,
                    mention_raid_protection_enabled: t.raid_protection,
                  },
                ];
      const body: AutoModWriteBody = {
        name: a.name,
        enabled: a.enabled,
        trigger_metadata: meta,
        actions: a.actions.map((x) =>
          x.type === 'block_message'
            ? { type: 1, ...(x.custom_message ? { metadata: { custom_message: x.custom_message } } : {}) }
            : x.type === 'alert'
              ? { type: 2, metadata: { channel_id: x.channel_id } }
              : { type: 3, metadata: { duration_seconds: x.duration_seconds } },
        ),
        exempt_roles: a.exempt_role_ids,
        exempt_channels: a.exempt_channel_ids,
      };
      const { store } = call.app;
      const mapped = store.getMapping(a.guild_id, 'automod', a.key);
      const rules = await call.app.adapter.fetchAutoModRules(a.guild_id);
      const current = mapped ? rules.find((r) => r.id === mapped.discordId) : undefined;
      if (current) {
        if (current.triggerType !== triggerType)
          throw new StewardError(
            'precondition_failed',
            'an AutoMod rule cannot change its trigger type; delete it and create a new one',
          );
        // Send only what differs; actions steward cannot express stay as they are.
        const patch = automodPatch(current, body);
        if (patch.fields.length === 0) return { rule_id: current.id, created: false, changed: [] };
        const out = await writeListedRule(
          call.app.adapter,
          a.guild_id,
          current,
          { verb: 'change', fields: patch.fields },
          () =>
            mutate(call, a.guild_id, a.reason, {
              action: 'update_automod',
              resourceKind: 'automod',
              resourceKey: a.key,
              targetId: current.id,
              summary: `update AutoMod rule ${a.name} (${patch.fields.join(', ')})`,
              idempotent: true,
              run: (reason) => call.app.adapter.editAutoModRule(a.guild_id, current.id, patch.body, reason),
            }),
        );
        return { op_id: out.opId, rule_id: current.id, created: false, changed: patch.fields };
      }
      const out = await mutate(call, a.guild_id, a.reason, {
        action: 'create_automod',
        resourceKind: 'automod',
        resourceKey: a.key,
        summary: `create AutoMod rule ${a.name}`,
        idempotent: false,
        match: { kind: 'automod', name: a.name },
        run: (reason) =>
          call.app.adapter.createAutoModRule(
            a.guild_id,
            { ...body, event_type: 1, trigger_type: triggerType },
            reason,
          ),
        resultId: (r) => r.id,
      });
      const id = idOf(out, (r) => r.id);
      store.setMapping(a.guild_id, 'automod', a.key, id, 'manual');
      return { op_id: out.opId, rule_id: id, created: true };
    },
  }),

  defineTool({
    name: 'delete_automod_rule',
    title: 'Delete an AutoMod rule',
    description: 'Delete an AutoMod rule. confirm_name must equal its current name.',
    scope: 'destructive',
    input: z.object({
      guild_id: guildIdInput,
      rule_id: snowflake,
      confirm_name: z.string().min(1).max(100),
      reason: reasonInput,
    }),
    guildOf: (a) => a.guild_id,
    handler: async (a, call) => {
      call.assertGuild(a.guild_id);
      const rule = requireFound(
        (await call.app.adapter.fetchAutoModRules(a.guild_id)).find((r) => r.id === a.rule_id),
        `AutoMod rule ${a.rule_id}`,
      );
      if (rule.name !== a.confirm_name)
        throw new StewardError(
          'precondition_failed',
          `confirm_name "${a.confirm_name}" does not match the rule's name "${rule.name}"`,
        );
      // Not notFoundIsSuccess: Discord can answer 404 for a listed rule it keeps itself.
      const out = await writeListedRule(call.app.adapter, a.guild_id, rule, { verb: 'delete' }, () =>
        mutate(call, a.guild_id, a.reason, {
          action: 'delete_automod',
          resourceKind: 'automod',
          targetId: rule.id,
          summary: `delete AutoMod rule ${rule.name}`,
          idempotent: true,
          run: (reason) => call.app.adapter.deleteAutoModRule(a.guild_id, rule.id, reason),
        }),
      );
      call.app.store.deleteMappingById(a.guild_id, 'automod', rule.id);
      return { op_id: out.opId, deleted: rule.id };
    },
  }),
];
