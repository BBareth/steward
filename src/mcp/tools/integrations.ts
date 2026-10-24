import { z } from 'zod';
import { botChannelPermissions, botStanding, has, P } from '../../discord/permissions.js';
import type { ChannelInfo, GuildSnapshot, WebhookWriteBody } from '../../discord/types.js';
import { assertSelfAssignable } from '../../features/role-panels.js';
import { StewardError } from '../../util/errors.js';
import { loadMedia, mediaInput } from '../../util/media.js';
import { defineTool } from '../registry.js';
import {
  cdnUrl,
  guildIdInput,
  mutate,
  reasonInput,
  requireFound,
  snapshotOf,
  snowflake,
  untrusted,
} from './common.js';

function requireGuildPerm(s: GuildSnapshot, bit: bigint, name: string) {
  if (!has(botStanding(s).permissions, bit))
    throw new StewardError('precondition_failed', `the bot lacks ${name}`);
}

function channelOf(s: GuildSnapshot, id: string): ChannelInfo {
  return requireFound(
    s.channels.find((c) => c.id === id),
    `channel ${id}`,
  );
}

const channelName = (s: GuildSnapshot, id: string | null) =>
  (id && s.channels.find((c) => c.id === id)?.name) ?? null;

const WEBHOOK_TYPES = ['', 'incoming', 'channel_follower', 'application'];

/** Discord refuses webhook names containing these, and "everyone"/"here" as a whole name. */
function checkWebhookName(name: string) {
  if (/clyde|discord/i.test(name) || /^(everyone|here)$/i.test(name))
    throw new StewardError(
      'invalid_argument',
      'webhook names cannot contain "clyde" or "discord", or be "everyone" or "here"',
    );
}

export const integrationTools = [
  defineTool({
    name: 'list_invites',
    title: 'List invites',
    description:
      "The server's active invite links with uses, expiry and any roles they grant. Needs Manage Server.",
    scope: 'read',
    input: z.object({ guild_id: guildIdInput }),
    guildOf: (a) => a.guild_id,
    handler: async ({ guild_id }, call) => {
      const s = await snapshotOf(call, guild_id);
      requireGuildPerm(s, P.ManageGuild, 'Manage Server');
      const invites = await call.app.adapter.fetchInvites(guild_id);
      return {
        guild_id,
        invites: invites.map((i) => ({
          code: i.code,
          url: `https://discord.gg/${i.code}`,
          channel_id: i.channelId,
          channel_name: channelName(s, i.channelId),
          inviter_id: i.inviterId,
          uses: i.uses,
          max_uses: i.maxUses || null,
          temporary: i.temporary,
          expires_at: i.expiresAt,
          role_ids: i.roleIds,
        })),
      };
    },
  }),

  defineTool({
    name: 'create_invite',
    title: 'Create an invite',
    description:
      'Create an invite link to a channel. max_age_seconds 0 never expires (default one day), max_uses 0 is unlimited, temporary members are removed when they go offline without a role. role_ids are granted to whoever joins through it and must be safe to self-assign. Needs Create Invite in the channel.',
    scope: 'write',
    input: z.object({
      guild_id: guildIdInput,
      channel_id: snowflake,
      max_age_seconds: z.number().int().min(0).max(604_800).default(86_400),
      max_uses: z.number().int().min(0).max(100).default(0),
      temporary: z.boolean().default(false),
      unique: z
        .boolean()
        .default(true)
        .describe('False may hand back an existing invite with the same settings.'),
      role_ids: z.array(snowflake).max(10).default([]),
      reason: reasonInput,
    }),
    guildOf: (a) => a.guild_id,
    handler: async (a, call) => {
      const s = await snapshotOf(call, a.guild_id);
      const ch = channelOf(s, a.channel_id);
      if (ch.kind === 'category') throw new StewardError('invalid_argument', `${ch.name} is a category`);
      if (!has(botChannelPermissions(s, ch), P.CreateInstantInvite))
        throw new StewardError('precondition_failed', `the bot lacks Create Invite in #${ch.name}`);
      if (a.role_ids.length) {
        requireGuildPerm(s, P.ManageRoles, 'Manage Roles');
        const prot = new Set(call.app.store.listProtectedRoles(a.guild_id));
        for (const id of a.role_ids) assertSelfAssignable(s, id, prot);
      }
      const out = await mutate(call, a.guild_id, a.reason, {
        action: 'create_invite',
        resourceKind: 'invite',
        targetId: ch.id,
        summary: `create invite to #${ch.name}`,
        idempotent: false,
        run: (reason) =>
          call.app.adapter.createInvite(
            ch.id,
            {
              max_age: a.max_age_seconds,
              max_uses: a.max_uses,
              temporary: a.temporary,
              unique: a.unique,
              ...(a.role_ids.length ? { role_ids: a.role_ids } : {}),
            },
            reason,
          ),
        resultId: (i) => i.code,
      });
      const invite = out.status === 'succeeded' ? out.result : null;
      return {
        op_id: out.opId,
        code: invite?.code ?? null,
        url: invite ? `https://discord.gg/${invite.code}` : null,
        expires_at: invite?.expiresAt ?? null,
      };
    },
  }),

  defineTool({
    name: 'delete_invite',
    title: 'Revoke an invite',
    description:
      'Revoke an invite link by its code. Needs Manage Server. The vanity URL cannot be revoked here.',
    scope: 'destructive',
    input: z.object({
      guild_id: guildIdInput,
      code: z.string().regex(/^[\w-]{2,32}$/, 'an invite code such as abc123'),
      reason: reasonInput,
    }),
    guildOf: (a) => a.guild_id,
    handler: async (a, call) => {
      const s = await snapshotOf(call, a.guild_id);
      requireGuildPerm(s, P.ManageGuild, 'Manage Server');
      // The vanity code is not in the invite list, so refuse it before looking it up.
      if (s.guild.vanityUrlCode && a.code === s.guild.vanityUrlCode)
        throw new StewardError('precondition_failed', 'that is the vanity URL; change it in Server Settings');
      const invite = requireFound(
        (await call.app.adapter.fetchInvites(a.guild_id)).find((i) => i.code === a.code),
        `invite ${a.code}`,
      );
      const out = await mutate(call, a.guild_id, a.reason, {
        action: 'delete_invite',
        resourceKind: 'invite',
        resourceKey: invite.code,
        summary: `revoke invite ${invite.code}`,
        idempotent: true,
        notFoundIsSuccess: true,
        run: (reason) => call.app.adapter.deleteInvite(invite.code, reason),
      });
      return { op_id: out.opId, deleted: invite.code };
    },
  }),

  defineTool({
    name: 'list_webhooks',
    title: 'List webhooks',
    description:
      "The server's webhooks: name, channel, type and owner. Webhook URLs and tokens are never returned; copy a URL from Server Settings > Integrations. Needs Manage Webhooks.",
    scope: 'read',
    input: z.object({ guild_id: guildIdInput }),
    guildOf: (a) => a.guild_id,
    handler: async ({ guild_id }, call) => {
      const s = await snapshotOf(call, guild_id);
      requireGuildPerm(s, P.ManageWebhooks, 'Manage Webhooks');
      const hooks = await call.app.adapter.fetchWebhooks(guild_id);
      return {
        guild_id,
        webhooks: hooks.map((w) => ({
          id: w.id,
          name: untrusted(w.name),
          type: WEBHOOK_TYPES[w.type] ?? 'unknown',
          channel_id: w.channelId,
          channel_name: channelName(s, w.channelId),
          avatar: cdnUrl(`avatars/${w.id}`, w.avatar),
          application_id: w.applicationId,
          created_by_bot: w.creatorId === s.botMember.userId,
        })),
      };
    },
  }),

  defineTool({
    name: 'upsert_webhook',
    title: 'Create or edit a webhook',
    description:
      "Create an incoming webhook in a channel, or with webhook_id rename it, change its avatar or move it. steward never returns the webhook URL: copy it from the channel's Integrations settings. Needs Manage Webhooks.",
    scope: 'write',
    input: z.object({
      guild_id: guildIdInput,
      webhook_id: snowflake.optional(),
      channel_id: snowflake.optional().describe('Required when creating; moves the webhook on an edit.'),
      name: z.string().min(1).max(80).optional(),
      avatar: mediaInput.nullable().optional(),
      reason: reasonInput,
    }),
    guildOf: (a) => a.guild_id,
    handler: async (a, call) => {
      const s = await snapshotOf(call, a.guild_id);
      const { adapter } = call.app;
      const ch = a.channel_id ? channelOf(s, a.channel_id) : null;
      if (ch && !['text', 'announcement', 'voice', 'stage', 'forum', 'media'].includes(ch.kind))
        throw new StewardError('invalid_argument', `#${ch.name} cannot hold webhooks`);
      if (ch && !has(botChannelPermissions(s, ch), P.ManageWebhooks))
        throw new StewardError('precondition_failed', `the bot lacks Manage Webhooks in #${ch.name}`);
      if (a.name) checkWebhookName(a.name);
      const body: WebhookWriteBody = {};
      if (a.name !== undefined) body.name = a.name;
      if (a.avatar !== undefined)
        body.avatar = a.avatar && (await loadMedia(a.avatar, 'webhook_avatar')).dataUri;
      const note = "Copy the webhook URL from the channel's settings under Integrations > Webhooks.";

      if (a.webhook_id) {
        requireGuildPerm(s, P.ManageWebhooks, 'Manage Webhooks');
        const hook = requireFound(
          (await adapter.fetchWebhooks(a.guild_id)).find((w) => w.id === a.webhook_id),
          `webhook ${a.webhook_id}`,
        );
        if (hook.type === 3)
          throw new StewardError('precondition_failed', "an application's webhook is managed by that app");
        if (ch) body.channel_id = ch.id;
        if (Object.keys(body).length === 0) throw new StewardError('invalid_argument', 'nothing to change');
        const out = await mutate(call, a.guild_id, a.reason, {
          action: 'upsert_webhook',
          resourceKind: 'webhook',
          targetId: hook.id,
          summary: `edit webhook ${hook.name ?? hook.id}: ${Object.keys(body).join(', ')}`,
          idempotent: true,
          run: (reason) => adapter.editWebhook(hook.id, body, reason),
        });
        return { op_id: out.opId, webhook_id: hook.id, created: false, changed: Object.keys(body) };
      }
      if (!ch || !a.name)
        throw new StewardError('invalid_argument', 'a new webhook needs channel_id and name');
      const out = await mutate(call, a.guild_id, a.reason, {
        action: 'upsert_webhook',
        resourceKind: 'webhook',
        resourceKey: a.name,
        summary: `create webhook ${a.name} in #${ch.name}`,
        idempotent: false,
        run: (reason) => adapter.createWebhook(ch.id, body, reason),
        resultId: (w) => w.id,
      });
      const id =
        out.status === 'succeeded' ? out.result.id : out.status === 'recovered' ? out.recoveredId : null;
      return { op_id: out.opId, webhook_id: id, created: true, note };
    },
  }),

  defineTool({
    name: 'delete_webhook',
    title: 'Delete a webhook',
    description:
      "Permanently delete a webhook; anything posting through its URL stops working. confirm_name must equal the webhook's name. Needs Manage Webhooks.",
    scope: 'destructive',
    input: z.object({
      guild_id: guildIdInput,
      webhook_id: snowflake,
      confirm_name: z.string().min(1).max(80),
      reason: reasonInput,
    }),
    guildOf: (a) => a.guild_id,
    handler: async (a, call) => {
      const s = await snapshotOf(call, a.guild_id);
      requireGuildPerm(s, P.ManageWebhooks, 'Manage Webhooks');
      const hook = requireFound(
        (await call.app.adapter.fetchWebhooks(a.guild_id)).find((w) => w.id === a.webhook_id),
        `webhook ${a.webhook_id}`,
      );
      if (hook.name !== a.confirm_name)
        throw new StewardError(
          'precondition_failed',
          `confirm_name "${a.confirm_name}" does not match the webhook's name "${hook.name}"`,
        );
      const out = await mutate(call, a.guild_id, a.reason, {
        action: 'delete_webhook',
        resourceKind: 'webhook',
        targetId: hook.id,
        summary: `delete webhook ${hook.name}`,
        idempotent: true,
        notFoundIsSuccess: true,
        run: (reason) => call.app.adapter.deleteWebhook(hook.id, reason),
      });
      return { op_id: out.opId, deleted: hook.id, name: hook.name };
    },
  }),

  defineTool({
    name: 'list_templates',
    title: 'List server templates',
    description:
      "The server's template (a reusable copy of its channels, roles and settings) with its discord.new link. is_dirty means the server changed since the last sync. Needs Manage Server.",
    scope: 'read',
    input: z.object({ guild_id: guildIdInput }),
    guildOf: (a) => a.guild_id,
    handler: async ({ guild_id }, call) => {
      const s = await snapshotOf(call, guild_id);
      requireGuildPerm(s, P.ManageGuild, 'Manage Server');
      const templates = await call.app.adapter.fetchTemplates(guild_id);
      return {
        guild_id,
        templates: templates.map((t) => ({
          code: t.code,
          url: `https://discord.new/${t.code}`,
          name: untrusted(t.name),
          description: untrusted(t.description),
          usage_count: t.usageCount,
          updated_at: t.updatedAt,
          is_dirty: t.isDirty,
        })),
      };
    },
  }),

  defineTool({
    name: 'upsert_template',
    title: 'Create, edit or sync the server template',
    description:
      "Create the server's template, or with code rename it, change its description, or sync it to the server as it is now (sync: true). A server has at most one template. Needs Manage Server.",
    scope: 'write',
    input: z.object({
      guild_id: guildIdInput,
      code: z
        .string()
        .regex(/^[\w-]{2,64}$/)
        .optional(),
      name: z.string().min(1).max(100).optional(),
      description: z.string().max(120).nullable().optional(),
      sync: z.boolean().default(false),
      reason: reasonInput,
    }),
    guildOf: (a) => a.guild_id,
    handler: async (a, call) => {
      const s = await snapshotOf(call, a.guild_id);
      requireGuildPerm(s, P.ManageGuild, 'Manage Server');
      const { adapter } = call.app;
      const existing = await adapter.fetchTemplates(a.guild_id);
      const body = {
        ...(a.name !== undefined && { name: a.name }),
        ...(a.description !== undefined && { description: a.description }),
      };
      if (a.code) {
        const t = requireFound(
          existing.find((x) => x.code === a.code),
          `template ${a.code}`,
        );
        if (Object.keys(body).length === 0 && !a.sync)
          throw new StewardError('invalid_argument', 'nothing to change');
        let opId = '';
        if (Object.keys(body).length) {
          const out = await mutate(call, a.guild_id, a.reason, {
            action: 'upsert_template',
            resourceKind: 'template',
            resourceKey: t.code,
            summary: `edit template ${t.name}: ${Object.keys(body).join(', ')}`,
            idempotent: true,
            run: (reason) => adapter.editTemplate(a.guild_id, t.code, body, reason),
          });
          opId = out.opId;
        }
        if (a.sync) {
          const out = await mutate(call, a.guild_id, a.reason, {
            action: 'upsert_template',
            resourceKind: 'template',
            resourceKey: t.code,
            summary: `sync template ${t.name}`,
            idempotent: true,
            run: (reason) => adapter.syncTemplate(a.guild_id, t.code, reason),
          });
          opId = out.opId;
        }
        return { op_id: opId, code: t.code, created: false, changed: Object.keys(body), synced: a.sync };
      }
      if (existing.length)
        throw new StewardError(
          'precondition_failed',
          `the server already has template ${existing[0]!.code}; pass its code to edit or sync it`,
        );
      if (!a.name) throw new StewardError('invalid_argument', 'a new template needs a name');
      const name = a.name;
      const out = await mutate(call, a.guild_id, a.reason, {
        action: 'upsert_template',
        resourceKind: 'template',
        resourceKey: name,
        summary: `create template ${name}`,
        idempotent: false,
        run: (reason) => adapter.createTemplate(a.guild_id, { ...body, name }, reason),
        resultId: (t) => t.code,
      });
      const code = out.status === 'succeeded' ? out.result.code : null;
      return { op_id: out.opId, code, url: code ? `https://discord.new/${code}` : null, created: true };
    },
  }),

  defineTool({
    name: 'delete_template',
    title: 'Delete the server template',
    description:
      "Delete the server's template; its discord.new link stops working. confirm_name must equal the template's name. Needs Manage Server.",
    scope: 'destructive',
    input: z.object({
      guild_id: guildIdInput,
      code: z.string().regex(/^[\w-]{2,64}$/),
      confirm_name: z.string().min(1).max(100),
      reason: reasonInput,
    }),
    guildOf: (a) => a.guild_id,
    handler: async (a, call) => {
      const s = await snapshotOf(call, a.guild_id);
      requireGuildPerm(s, P.ManageGuild, 'Manage Server');
      const t = requireFound(
        (await call.app.adapter.fetchTemplates(a.guild_id)).find((x) => x.code === a.code),
        `template ${a.code}`,
      );
      if (t.name !== a.confirm_name)
        throw new StewardError(
          'precondition_failed',
          `confirm_name "${a.confirm_name}" does not match the template's name "${t.name}"`,
        );
      const out = await mutate(call, a.guild_id, a.reason, {
        action: 'delete_template',
        resourceKind: 'template',
        resourceKey: t.code,
        summary: `delete template ${t.name}`,
        idempotent: true,
        notFoundIsSuccess: true,
        run: (reason) => call.app.adapter.deleteTemplate(a.guild_id, t.code, reason),
      });
      return { op_id: out.opId, deleted: t.code, name: t.name };
    },
  }),

  defineTool({
    name: 'list_integrations',
    title: 'List integrations',
    description:
      'Bots, apps and connected accounts (Twitch, YouTube) added to the server. is_steward marks this bot. Needs Manage Server.',
    scope: 'read',
    input: z.object({ guild_id: guildIdInput }),
    guildOf: (a) => a.guild_id,
    handler: async ({ guild_id }, call) => {
      const s = await snapshotOf(call, guild_id);
      requireGuildPerm(s, P.ManageGuild, 'Manage Server');
      const own = call.app.adapter.status().applicationId;
      const list = await call.app.adapter.fetchIntegrations(guild_id);
      return {
        guild_id,
        integrations: list.map((i) => ({
          id: i.id,
          name: untrusted(i.name),
          type: i.type,
          enabled: i.enabled,
          application_id: i.applicationId,
          account: untrusted(i.accountName),
          is_steward: !!own && (i.applicationId === own || i.id === own),
        })),
      };
    },
  }),

  defineTool({
    name: 'delete_integration',
    title: 'Remove an integration',
    description:
      "Remove an integration: kicks its bot and deletes its managed role, or disconnects a Twitch/YouTube account. steward cannot remove itself. confirm_name must equal the integration's name. Needs Manage Server.",
    scope: 'destructive',
    input: z.object({
      guild_id: guildIdInput,
      integration_id: snowflake,
      confirm_name: z.string().min(1).max(100),
      reason: reasonInput,
    }),
    guildOf: (a) => a.guild_id,
    handler: async (a, call) => {
      const s = await snapshotOf(call, a.guild_id);
      requireGuildPerm(s, P.ManageGuild, 'Manage Server');
      const { adapter } = call.app;
      const i = requireFound(
        (await adapter.fetchIntegrations(a.guild_id)).find((x) => x.id === a.integration_id),
        `integration ${a.integration_id}`,
      );
      const own = adapter.status().applicationId;
      if (own && (i.applicationId === own || i.id === own))
        throw new StewardError('precondition_failed', 'steward will not remove its own integration');
      if (i.name !== a.confirm_name)
        throw new StewardError(
          'precondition_failed',
          `confirm_name "${a.confirm_name}" does not match the integration's name "${i.name}"`,
        );
      const out = await mutate(call, a.guild_id, a.reason, {
        action: 'delete_integration',
        resourceKind: 'integration',
        targetId: i.id,
        summary: `remove integration ${i.name}`,
        idempotent: true,
        notFoundIsSuccess: true,
        run: (reason) => adapter.deleteIntegration(a.guild_id, i.id, reason),
      });
      return { op_id: out.opId, deleted: i.id, name: i.name };
    },
  }),
];
