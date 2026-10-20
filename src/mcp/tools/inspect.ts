import { z } from 'zod';
import {
  assessRolePrivilege,
  botChannelPermissions,
  botStanding,
  canBotManageRole,
  channelPermissions,
  basePermissions,
  ELEVATED_PERMISSIONS,
  has,
  P,
  permissionNames,
  permissionsFromNames,
  roleById,
  rolesTopDown,
} from '../../discord/permissions.js';
import type { ChannelInfo, GuildSnapshot, RoleInfo } from '../../discord/types.js';
import { formatColor } from '../../features/messages.js';
import { channelGroup, sortChannels } from '../../ops/ordering.js';
import { CONTENT_FILTERS, NOTIFICATION_LEVELS, VERIFICATION_LEVELS } from '../../blueprint/schema.js';
import { StewardError } from '../../util/errors.js';
import { defineTool } from '../registry.js';
import {
  cursorInput,
  guildIdInput,
  limitInput,
  paginate,
  permissionNamesInput,
  requireFound,
  snapshotOf,
  snowflake,
  untrusted,
} from './common.js';

const name = <T extends Record<string, number>>(o: T, v: number) =>
  Object.entries(o).find(([, n]) => n === v)?.[0] ?? String(v);

function keyIndex(
  call: {
    app: { store: { listMappings: (g: string) => Array<{ kind: string; key: string; discordId: string }> } };
  },
  guildId: string,
) {
  const m = new Map<string, string>();
  for (const x of call.app.store.listMappings(guildId)) m.set(`${x.kind}:${x.discordId}`, x.key);
  return m;
}

function everyoneCanView(s: GuildSnapshot, c: ChannelInfo) {
  return has(channelPermissions(s, c, { userId: null, roleIds: [] }), P.ViewChannel);
}

function targetName(s: GuildSnapshot, id: string, type: 'role' | 'member') {
  if (type === 'member') return `member ${id}`;
  if (id === s.guild.id) return '@everyone';
  return roleById(s, id)?.name ?? id;
}

function roleSummary(s: GuildSnapshot, r: RoleInfo, keys: Map<string, string>) {
  const elevated = r.permissions & ELEVATED_PERMISSIONS;
  return {
    id: r.id,
    name: r.name,
    position: r.position,
    key: keys.get(`role:${r.id}`),
    color: r.color ? formatColor(r.color) : undefined,
    managed: r.managed || undefined,
    hoist: r.hoist || undefined,
    mentionable: r.mentionable || undefined,
    administrator: has(r.permissions, P.Administrator) || undefined,
    elevated: elevated ? permissionNames(elevated) : undefined,
    manageable_by_bot: canBotManageRole(s, r, 'edit').ok,
  };
}

function botReport(s: GuildSnapshot) {
  const bot = botStanding(s);
  const above = rolesTopDown(s).filter(
    (r) =>
      bot.highestRole &&
      r.id !== bot.highestRole.id &&
      r.position >= bot.highestPosition &&
      r.id !== s.guild.id,
  );
  const key = (bit: bigint) => has(bot.permissions, bit);
  const warnings: string[] = [];
  if (above.length > 0) {
    warnings.push(
      `${above.length} role(s) sit at or above the bot's highest role and cannot be edited, assigned or reordered by it: ${above
        .slice(0, 10)
        .map((r) => r.name)
        .join(
          ', ',
        )}${above.length > 10 ? ', ...' : ''}. Drag the bot's role higher in Server Settings → Roles if it should manage them.`,
    );
  }
  if (bot.isAdmin)
    warnings.push(
      'The bot has Administrator. Discord still enforces role hierarchy: it cannot touch roles at or above its own.',
    );
  if (!key(P.ManageRoles))
    warnings.push(
      'Missing Manage Roles: roles, permission overwrites, role panels and join roles will not work.',
    );
  if (!key(P.ManageChannels))
    warnings.push('Missing Manage Channels: channels and categories cannot be created or edited.');
  if (!key(P.ManageGuild))
    warnings.push('Missing Manage Server: server settings and AutoMod cannot be changed.');
  if (!key(P.ViewAuditLog))
    warnings.push(
      'Missing View Audit Log: steward falls back to a weaker check when recovering from timeouts.',
    );
  return {
    user_id: bot.userId,
    highest_role: bot.highestRole
      ? { id: bot.highestRole.id, name: bot.highestRole.name, position: bot.highestRole.position }
      : null,
    administrator: bot.isAdmin,
    permissions: {
      ManageRoles: key(P.ManageRoles),
      ManageChannels: key(P.ManageChannels),
      ManageGuild: key(P.ManageGuild),
      ViewAuditLog: key(P.ViewAuditLog),
      SendMessages: key(P.SendMessages),
      EmbedLinks: key(P.EmbedLinks),
      ModerateMembers: key(P.ModerateMembers),
    },
    roles_at_or_above_bot: above.length,
    warnings,
  };
}

export const inspectTools = [
  defineTool({
    name: 'get_guild_overview',
    title: 'Server overview',
    description:
      "Server settings, channel and role counts, the bot's position and permissions, hierarchy warnings, and what steward manages here. Start here before changing a server.",
    scope: 'read',
    input: z.object({ guild_id: guildIdInput }),
    guildOf: (a) => a.guild_id,
    handler: async ({ guild_id }, call) => {
      const s = await snapshotOf(call, guild_id);
      const g = s.guild;
      const byKind: Record<string, number> = {};
      for (const c of s.channels) byKind[c.kind] = (byKind[c.kind] ?? 0) + 1;
      const chan = (id: string | null) =>
        id ? { id, name: s.channels.find((c) => c.id === id)?.name ?? null } : null;
      const { store } = call.app;
      return {
        guild: {
          id: g.id,
          name: g.name,
          owner_id: g.ownerId,
          approximate_member_count: g.approximateMemberCount,
          description: untrusted(g.description),
          community: g.features.includes('COMMUNITY'),
          features: g.features,
          premium_tier: g.premiumTier,
          verification_level: name(VERIFICATION_LEVELS, g.verificationLevel),
          default_notifications: name(NOTIFICATION_LEVELS, g.defaultMessageNotifications),
          explicit_content_filter: name(CONTENT_FILTERS, g.explicitContentFilter),
          mfa_level: g.mfaLevel,
          preferred_locale: g.preferredLocale,
          afk_channel: chan(g.afkChannelId),
          afk_timeout: g.afkTimeout,
          system_channel: chan(g.systemChannelId),
          rules_channel: chan(g.rulesChannelId),
          public_updates_channel: chan(g.publicUpdatesChannelId),
          safety_alerts_channel: chan(g.safetyAlertsChannelId),
        },
        counts: { roles: s.roles.length - 1, channels: byKind },
        bot: botReport(s),
        steward: {
          mapped_resources: store.listMappings(guild_id).length,
          managed_messages: store.listManagedMessages(guild_id).length,
          role_panels: store.listPanels(guild_id).length,
          self_assignable_roles: store.listSelfRoles(guild_id).length,
          protected_roles: store.listProtectedRoles(guild_id).length,
          welcome_enabled: store.getWelcome(guild_id)?.enabled ?? false,
          members_intent: call.app.config.membersIntent,
        },
      };
    },
  }),

  defineTool({
    name: 'list_channels',
    title: 'List channels',
    description:
      'Channels and categories in display order, with keys, overwrite counts and visibility. Filter by kind, parent or name.',
    scope: 'read',
    input: z.object({
      guild_id: guildIdInput,
      kind: z.enum(['text', 'voice', 'category', 'announcement', 'stage', 'forum', 'media']).optional(),
      parent_id: snowflake.optional().describe('Only channels in this category.'),
      name_contains: z.string().max(100).optional(),
      limit: limitInput,
      cursor: cursorInput,
    }),
    guildOf: (a) => a.guild_id,
    handler: async (a, call) => {
      const s = await snapshotOf(call, a.guild_id);
      const keys = keyIndex(call, a.guild_id);
      const cats = s.channels.filter((c) => c.kind === 'category').sort(sortChannels);
      const children = (parent: string | null) =>
        s.channels
          .filter((c) => c.kind !== 'category' && (c.parentId ?? null) === parent)
          .sort((x, y) =>
            channelGroup(x.kind) === channelGroup(y.kind)
              ? sortChannels(x, y)
              : channelGroup(x.kind) === 'text'
                ? -1
                : 1,
          );
      const ordered = [...children(null), ...cats.flatMap((c) => [c, ...children(c.id)])];
      const filtered = ordered.filter(
        (c) =>
          (!a.kind || c.kind === a.kind) &&
          (!a.parent_id || c.parentId === a.parent_id) &&
          (!a.name_contains || c.name.toLowerCase().includes(a.name_contains.toLowerCase())),
      );
      return paginate(
        filtered.map((c) => ({
          id: c.id,
          name: c.name,
          kind: c.kind,
          parent_id: c.parentId ?? undefined,
          position: c.position,
          key: keys.get(`channel:${c.id}`),
          overwrites: c.overwrites.length,
          hidden_from_everyone: !everyoneCanView(s, c) || undefined,
        })),
        a.limit,
        a.cursor,
      );
    },
  }),

  defineTool({
    name: 'get_channel',
    title: 'Channel details',
    description:
      "One channel or category: settings, decoded permission overwrites, who can see it, the bot's own permissions there.",
    scope: 'read',
    input: z.object({ guild_id: guildIdInput, channel_id: snowflake }),
    guildOf: (a) => a.guild_id,
    handler: async ({ guild_id, channel_id }, call) => {
      const s = await snapshotOf(call, guild_id);
      const c = requireFound(
        s.channels.find((x) => x.id === channel_id),
        `channel ${channel_id}`,
      );
      const parent = c.parentId ? s.channels.find((x) => x.id === c.parentId) : undefined;
      const synced =
        parent &&
        parent.overwrites.length === c.overwrites.length &&
        parent.overwrites.every((o) =>
          c.overwrites.some((p) => p.id === o.id && p.allow === o.allow && p.deny === o.deny),
        );
      return {
        id: c.id,
        name: c.name,
        kind: c.kind,
        key: keyIndex(call, guild_id).get(`channel:${c.id}`),
        parent: parent ? { id: parent.id, name: parent.name } : null,
        position: c.position,
        topic: untrusted(c.topic),
        nsfw: c.nsfw,
        slowmode_seconds: c.rateLimitPerUser,
        bitrate: c.bitrate ?? undefined,
        user_limit: c.userLimit ?? undefined,
        synced_with_category: parent ? !!synced : undefined,
        everyone_can_view: everyoneCanView(s, c),
        overwrites: c.overwrites.map((o) => ({
          target_id: o.id,
          type: o.type,
          target: targetName(s, o.id, o.type),
          allow: permissionNames(o.allow),
          deny: permissionNames(o.deny),
        })),
        bot_permissions_here: permissionNames(botChannelPermissions(s, c)),
      };
    },
  }),

  defineTool({
    name: 'list_roles',
    title: 'List roles',
    description:
      'Roles top to bottom with keys, managed/admin flags, elevated permissions, and whether the bot can manage each one.',
    scope: 'read',
    input: z.object({
      guild_id: guildIdInput,
      name_contains: z.string().max(100).optional(),
      limit: limitInput,
      cursor: cursorInput,
    }),
    guildOf: (a) => a.guild_id,
    handler: async (a, call) => {
      const s = await snapshotOf(call, a.guild_id);
      const keys = keyIndex(call, a.guild_id);
      const roles = rolesTopDown(s).filter(
        (r) => !a.name_contains || r.name.toLowerCase().includes(a.name_contains.toLowerCase()),
      );
      return paginate(
        roles.map((r) => roleSummary(s, r, keys)),
        a.limit,
        a.cursor,
      );
    },
  }),

  defineTool({
    name: 'get_role',
    title: 'Role details',
    description:
      'One role: full permission list, where channel overwrites mention it, whether it is privileged, and exactly which operations the bot can perform on it (with reasons).',
    scope: 'read',
    input: z.object({ guild_id: guildIdInput, role_id: snowflake }),
    guildOf: (a) => a.guild_id,
    handler: async ({ guild_id, role_id }, call) => {
      const s = await snapshotOf(call, guild_id);
      const r = requireFound(roleById(s, role_id), `role ${role_id}`);
      const prot = new Set(call.app.store.listProtectedRoles(guild_id));
      const privilege = assessRolePrivilege(s, r, prot);
      const verdict = (op: 'assign' | 'edit' | 'delete' | 'move') => {
        const v = canBotManageRole(s, r, op);
        return v.ok ? true : v.reason;
      };
      return {
        ...roleSummary(s, r, keyIndex(call, guild_id)),
        permissions: permissionNames(r.permissions),
        tags: r.tags ?? undefined,
        bot_can: {
          assign: verdict('assign'),
          edit: verdict('edit'),
          move: verdict('move'),
          delete: verdict('delete'),
        },
        privileged: privilege.privileged,
        privilege_reasons: privilege.reasons,
        unlocks_hidden_channels: privilege.unlocksHiddenChannels,
        protected: prot.has(r.id),
        self_assignable: call.app.store.listSelfRoles(guild_id).includes(r.id),
        overwrites: s.channels
          .filter((c) => c.overwrites.some((o) => o.id === r.id))
          .map((c) => {
            const o = c.overwrites.find((x) => x.id === r.id)!;
            return {
              channel_id: c.id,
              channel: c.name,
              allow: permissionNames(o.allow),
              deny: permissionNames(o.deny),
            };
          }),
      };
    },
  }),

  defineTool({
    name: 'get_member',
    title: 'Member details',
    description:
      "A member's roles and whether the bot can change each of them. Works without the members intent.",
    scope: 'read',
    input: z.object({ guild_id: guildIdInput, user_id: snowflake }),
    guildOf: (a) => a.guild_id,
    handler: async ({ guild_id, user_id }, call) => {
      const s = await snapshotOf(call, guild_id);
      const m = requireFound(await call.app.adapter.fetchMember(guild_id, user_id), `member ${user_id}`);
      return {
        user_id: m.userId,
        username: untrusted(m.username, 100),
        bot: m.isBot,
        owner: m.userId === s.guild.ownerId,
        timed_out_until: m.communicationDisabledUntil,
        roles: m.roleIds
          .map((id) => roleById(s, id))
          .filter((r): r is RoleInfo => !!r)
          .sort((x, y) => y.position - x.position)
          .map((r) => {
            const v = canBotManageRole(s, r, 'assign');
            return { id: r.id, name: r.name, position: r.position, bot_can_remove: v.ok ? true : v.reason };
          }),
        guild_permissions: permissionNames(basePermissions(s, { userId: m.userId, roleIds: m.roleIds })),
      };
    },
  }),

  defineTool({
    name: 'check_permissions',
    title: 'Check effective permissions',
    description:
      "Compute effective permissions (Discord's full algorithm: @everyone, roles, Administrator, owner, overwrites, timeouts) for a member, a set of roles, or the bot, at server level or in one channel. Optionally check specific permissions.",
    scope: 'read',
    input: z.object({
      guild_id: guildIdInput,
      subject: z
        .object({
          member_id: snowflake.optional(),
          role_ids: z.array(snowflake).max(50).optional(),
          bot: z.boolean().optional(),
        })
        .describe('Exactly one of member_id, role_ids, or bot: true.'),
      channel_id: snowflake.optional(),
      permissions: permissionNamesInput.optional(),
    }),
    guildOf: (a) => a.guild_id,
    handler: async (a, call) => {
      const s = await snapshotOf(call, a.guild_id);
      const chosen = [a.subject.member_id, a.subject.role_ids, a.subject.bot].filter(
        (x) => x !== undefined && x !== false,
      );
      if (chosen.length !== 1)
        throw new StewardError(
          'invalid_argument',
          'set exactly one of subject.member_id, subject.role_ids or subject.bot',
        );
      let subject: { userId: string | null; roleIds: string[]; timedOut?: boolean };
      let label: string;
      if (a.subject.bot) {
        subject = { userId: s.botMember.userId, roleIds: s.botMember.roleIds };
        label = 'the bot';
      } else if (a.subject.member_id) {
        const m = requireFound(
          await call.app.adapter.fetchMember(a.guild_id, a.subject.member_id),
          `member ${a.subject.member_id}`,
        );
        const timedOut =
          !!m.communicationDisabledUntil && Date.parse(m.communicationDisabledUntil) > Date.now();
        subject = { userId: m.userId, roleIds: m.roleIds, timedOut };
        label = `member ${m.userId}`;
      } else {
        const unknown = a.subject.role_ids!.filter((id) => !roleById(s, id));
        if (unknown.length) throw new StewardError('not_found', `unknown role(s): ${unknown.join(', ')}`);
        subject = { userId: null, roleIds: a.subject.role_ids! };
        label = `a member with roles ${a.subject.role_ids!.map((id) => roleById(s, id)!.name).join(', ') || '(only @everyone)'}`;
      }
      const channel = a.channel_id
        ? requireFound(
            s.channels.find((c) => c.id === a.channel_id),
            `channel ${a.channel_id}`,
          )
        : null;
      const perms = channel ? channelPermissions(s, channel, subject) : basePermissions(s, subject);
      const out: Record<string, unknown> = {
        subject: label,
        where: channel ? `#${channel.name}` : 'server-wide',
        administrator: has(perms, P.Administrator),
        is_owner: subject.userId === s.guild.ownerId,
        timed_out: subject.timedOut || undefined,
      };
      if (a.permissions) {
        const wanted = permissionsFromNames(a.permissions);
        out.checks = Object.fromEntries(
          permissionNames(wanted).map((n) => [n, permissionNames(perms).includes(n)]),
        );
        out.missing = permissionNames(wanted & ~perms);
      } else {
        out.permissions = permissionNames(perms);
      }
      return out;
    },
  }),

  defineTool({
    name: 'check_role_hierarchy',
    title: 'Check role hierarchy',
    description:
      'For each role (or the ones given): can the bot assign, edit, move or delete it, and is it privileged? Use before writes to catch hierarchy problems. Returns concrete fixes.',
    scope: 'read',
    input: z.object({
      guild_id: guildIdInput,
      role_ids: z.array(snowflake).max(100).optional(),
      limit: limitInput,
      cursor: cursorInput,
    }),
    guildOf: (a) => a.guild_id,
    handler: async (a, call) => {
      const s = await snapshotOf(call, a.guild_id);
      const prot = new Set(call.app.store.listProtectedRoles(a.guild_id));
      const roles = a.role_ids
        ? a.role_ids.map((id) => requireFound(roleById(s, id), `role ${id}`))
        : rolesTopDown(s).filter((r) => r.id !== s.guild.id);
      const rows = roles.map((r) => {
        const assign = canBotManageRole(s, r, 'assign');
        const edit = canBotManageRole(s, r, 'edit');
        const privilege = assessRolePrivilege(s, r, prot);
        return {
          id: r.id,
          name: r.name,
          position: r.position,
          assign: assign.ok ? 'ok' : assign.reason,
          edit: edit.ok ? 'ok' : edit.reason,
          privileged: privilege.privileged ? privilege.reasons : undefined,
        };
      });
      const bot = botReport(s);
      return {
        bot_highest_role: bot.highest_role,
        summary: {
          roles: rows.length,
          bot_can_edit: rows.filter((r) => r.edit === 'ok').length,
          privileged: rows.filter((r) => r.privileged).length,
        },
        advice: bot.warnings,
        ...paginate(rows, a.limit, a.cursor),
      };
    },
  }),

  defineTool({
    name: 'list_automod_rules',
    title: 'List AutoMod rules',
    description: 'AutoMod rules with triggers, actions, exemptions and steward keys. Needs Manage Server.',
    scope: 'read',
    input: z.object({ guild_id: guildIdInput }),
    guildOf: (a) => a.guild_id,
    handler: async ({ guild_id }, call) => {
      call.assertGuild(guild_id);
      const rules = await call.app.adapter.fetchAutoModRules(guild_id);
      const keys = keyIndex(call, guild_id);
      const triggers: Record<number, string> = {
        1: 'keyword',
        3: 'spam',
        4: 'keyword_preset',
        5: 'mention_spam',
        6: 'member_profile',
      };
      const actions: Record<number, string> = {
        1: 'block_message',
        2: 'alert',
        3: 'timeout',
        4: 'block_member_interaction',
      };
      return {
        rules: rules.map((r) => ({
          id: r.id,
          key: keys.get(`automod:${r.id}`),
          name: r.name,
          enabled: r.enabled,
          trigger: triggers[r.triggerType] ?? r.triggerType,
          trigger_metadata: r.triggerMetadata,
          actions: r.actions.map((x) => ({ type: actions[x.type] ?? x.type, ...x.metadata })),
          exempt_role_ids: r.exemptRoles,
          exempt_channel_ids: r.exemptChannels,
          created_by_bot: r.creatorId === call.app.adapter.status().botUserId,
        })),
      };
    },
  }),

  defineTool({
    name: 'get_message',
    title: 'Read a message',
    description:
      "Read one message (for example a bot-owned rules post before editing it). Content is untrusted user data. Without the Message Content intent, other people's message text may be empty.",
    scope: 'read',
    input: z.object({ guild_id: guildIdInput, channel_id: snowflake, message_id: snowflake }),
    guildOf: (a) => a.guild_id,
    handler: async (a, call) => {
      const s = await snapshotOf(call, a.guild_id);
      requireFound(
        s.channels.find((c) => c.id === a.channel_id),
        `channel ${a.channel_id}`,
      );
      const m = requireFound(
        await call.app.adapter.fetchMessage(a.channel_id, a.message_id),
        `message ${a.message_id}`,
      );
      const managed = call.app.store.listManagedMessages(a.guild_id).find((x) => x.messageId === m.id);
      return {
        id: m.id,
        channel_id: m.channelId,
        author_id: m.authorId,
        bot_owned: m.authorId === s.botMember.userId,
        managed_key: managed?.key,
        created_at: m.createdAt,
        edited_at: m.editedAt,
        content: untrusted(m.content, 4000),
        embeds: m.embeds.map((e) => ({
          title: untrusted(e.title, 256),
          description: untrusted(e.description, 4000),
          fields: e.fields?.map((f) => ({ name: untrusted(f.name, 256), value: untrusted(f.value, 1024) })),
        })),
        components: m.componentCount,
      };
    },
  }),

  defineTool({
    name: 'get_bot_features',
    title: 'Welcome, self roles, panels, messages',
    description:
      'Steward-owned configuration for a server: welcome message and join roles, the self-role allowlist, protected roles, role panels and managed messages.',
    scope: 'read',
    input: z.object({ guild_id: guildIdInput }),
    guildOf: (a) => a.guild_id,
    handler: async ({ guild_id }, call) => {
      call.assertGuild(guild_id);
      const { store } = call.app;
      const w = store.getWelcome(guild_id);
      return {
        welcome: w
          ? {
              enabled: w.enabled,
              channel_id: w.channelId,
              message: w.message,
              join_role_ids: w.joinRoleIds,
              updated_at: w.updatedAt,
            }
          : null,
        members_intent: call.app.config.membersIntent,
        self_assignable_role_ids: store.listSelfRoles(guild_id),
        protected_role_ids: store.listProtectedRoles(guild_id),
        role_panels: store.listPanels(guild_id).map((p) => ({
          key: p.key,
          channel_id: p.channelId,
          message_id: p.messageId,
          title: p.title,
          mode: p.mode,
          options: p.options,
        })),
        managed_messages: store.listManagedMessages(guild_id).map((m) => ({
          key: m.key,
          channel_id: m.channelId,
          message_id: m.messageId,
          updated_at: m.updatedAt,
        })),
      };
    },
  }),

  defineTool({
    name: 'list_mappings',
    title: 'List key mappings',
    description:
      'Blueprint keys bound to Discord IDs in this server, and how each binding was made (created, exported, adopted, recovered, manual).',
    scope: 'read',
    input: z.object({
      guild_id: guildIdInput,
      kind: z.enum(['role', 'channel', 'automod']).optional(),
      limit: limitInput,
      cursor: cursorInput,
    }),
    guildOf: (a) => a.guild_id,
    handler: async (a, call) => {
      call.assertGuild(a.guild_id);
      const rows = call.app.store.listMappings(a.guild_id, a.kind).map((m) => ({
        kind: m.kind,
        key: m.key,
        id: m.discordId,
        source: m.source,
        updated_at: m.updatedAt,
      }));
      return paginate(rows, a.limit, a.cursor);
    },
  }),

  defineTool({
    name: 'list_history',
    title: 'Operation history',
    description:
      'Journal of Discord changes steward made (operation id, time, target, outcome, audit-log reason), or of MCP tool calls. Filter by guild, plan, status or tool.',
    scope: 'read',
    input: z.object({
      kind: z.enum(['operations', 'tool_calls']).default('operations'),
      guild_id: guildIdInput.optional(),
      plan_id: z.string().max(40).optional(),
      status: z.enum(['in_progress', 'succeeded', 'failed', 'uncertain', 'recovered', 'skipped']).optional(),
      tool: z.string().max(64).optional(),
      limit: limitInput,
      cursor: cursorInput,
    }),
    guildOf: (a) => a.guild_id,
    handler: async (a, call) => {
      const offset = a.cursor ? Number(a.cursor) : 0;
      if (call.caller.guilds && !a.guild_id) {
        throw new StewardError(
          'invalid_argument',
          'your credential is limited to specific guilds; pass guild_id',
        );
      }
      const restrict = (guildId: string | null) =>
        !guildId ||
        (call.app.config.guildIds.includes(guildId) &&
          (!call.caller.guilds || call.caller.guilds.includes(guildId)));
      if (a.kind === 'tool_calls') {
        const { items, total } = call.app.store.listToolCalls(a.limit, offset, a.guild_id);
        return {
          total,
          next_cursor: offset + a.limit < total ? String(offset + a.limit) : null,
          items: items.filter((i) => restrict(i.guildId)),
        };
      }
      const { items, total } = call.app.store.listOperations({
        guildId: a.guild_id,
        planId: a.plan_id,
        status: a.status,
        tool: a.tool,
        limit: a.limit,
        offset,
      });
      return {
        total,
        next_cursor: offset + a.limit < total ? String(offset + a.limit) : null,
        items: items
          .filter((o) => restrict(o.guildId))
          .map((o) => ({
            op_id: o.id,
            at: o.startedAt,
            finished_at: o.finishedAt,
            guild_id: o.guildId,
            tool: o.tool,
            client: o.clientId,
            plan_id: o.planId ?? undefined,
            step: o.stepId ?? undefined,
            action: o.action,
            target: o.targetId ?? undefined,
            key: o.resourceKey ?? undefined,
            status: o.status,
            attempts: o.attempts,
            summary: o.summary,
            error: o.error ?? undefined,
            audit_reason: o.auditReason ?? undefined,
          })),
      };
    },
  }),
];
