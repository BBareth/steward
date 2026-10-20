import { z } from 'zod';
import {
  botChannelPermissions,
  botStanding,
  has,
  P,
  permissionNames,
  permissionsFromNames,
  ungrantableInChannel,
} from '../../discord/permissions.js';
import type { ChannelInfo, ChannelWriteBody, GuildSnapshot } from '../../discord/types.js';
import { CHANNEL_TYPE_NUMBERS } from '../../discord/types.js';
import { expandAccess } from '../../features/access.js';
import { channelKindNeedsCommunity } from '../../features/community.js';
import { runOperation } from '../../ops/journal.js';
import { bucketMembers, channelGroup, channelPositionUpdates } from '../../ops/ordering.js';
import { StewardError } from '../../util/errors.js';
import { KEY_RE } from '../../blueprint/schema.js';
import { defineTool } from '../registry.js';
import type { CallContext } from '../registry.js';
import {
  guildIdInput,
  idOf,
  mutate,
  opContext,
  permissionNamesInput,
  reasonInput,
  requireFound,
  snapshotOf,
  snowflake,
  withGuildLock,
} from './common.js';

const overwriteInput = z
  .object({
    role_id: z
      .union([snowflake, z.literal('everyone')])
      .optional()
      .describe('Role ID, or "everyone" for @everyone.'),
    member_id: snowflake.optional(),
    allow: permissionNamesInput.default([]),
    deny: permissionNamesInput.default([]),
  })
  .refine(
    (o) => (o.role_id === undefined) !== (o.member_id === undefined),
    'set exactly one of role_id or member_id',
  );

type OverwriteInput = z.infer<typeof overwriteInput>;

const keyInput = z
  .string()
  .regex(KEY_RE)
  .optional()
  .describe('Optional blueprint key to bind this resource to, so blueprints can manage it later.');

function toOverwrites(s: GuildSnapshot, list: OverwriteInput[]) {
  return list.map((o) => {
    const id = o.member_id ?? (o.role_id === 'everyone' ? s.guild.id : o.role_id!);
    if (o.role_id && o.role_id !== 'everyone' && !s.roles.some((r) => r.id === o.role_id)) {
      throw new StewardError('not_found', `role ${o.role_id} not found`);
    }
    const allow = permissionsFromNames(o.allow);
    const deny = permissionsFromNames(o.deny);
    if ((allow & deny) !== 0n)
      throw new StewardError(
        'invalid_argument',
        `permissions both allowed and denied: ${permissionNames(allow & deny).join(', ')}`,
      );
    return { id, type: (o.member_id ? 'member' : 'role') as 'role' | 'member', allow, deny };
  });
}

function checkOverwriteGrant(
  s: GuildSnapshot,
  channel: ChannelInfo | null,
  overwrites: Array<{ allow: bigint; deny: bigint }>,
) {
  const bot = botStanding(s);
  if (!has(bot.permissions, P.ManageRoles))
    throw new StewardError('precondition_failed', 'setting permission overwrites needs Manage Roles');
  const bits = overwrites.reduce((a, o) => a | o.allow | o.deny, 0n);
  const missing = ungrantableInChannel(s, channel, bits);
  if (missing) {
    throw new StewardError(
      'precondition_failed',
      `the bot can only allow or deny permissions it holds itself; it lacks ${permissionNames(missing).join(', ')}`,
    );
  }
}

function requireManageChannels(s: GuildSnapshot, channel: ChannelInfo | null) {
  const perms = channel ? botChannelPermissions(s, channel) : botStanding(s).permissions;
  if (!has(perms, P.ManageChannels)) {
    throw new StewardError(
      'precondition_failed',
      `the bot lacks Manage Channels${channel ? ` in #${channel.name}` : ''}`,
    );
  }
}

function bindKey(call: CallContext, guildId: string, key: string | undefined, id: string) {
  if (!key) return;
  const existing = call.app.store.getMapping(guildId, 'channel', key);
  if (existing && existing.discordId !== id)
    throw new StewardError('conflict', `key "${key}" is already bound to channel ${existing.discordId}`);
  call.app.store.setMapping(guildId, 'channel', key, id, 'manual');
}

const accessInput = z.object({
  private: z.boolean().optional().describe('Hide from @everyone.'),
  visible_to_role_ids: z
    .array(snowflake)
    .max(50)
    .optional()
    .describe('Roles that can still see a private channel.'),
  read_only: z.boolean().optional().describe('@everyone cannot post.'),
  writer_role_ids: z
    .array(snowflake)
    .max(50)
    .optional()
    .describe('Roles that can still post in a read-only channel.'),
});

function presetOverwrites(s: GuildSnapshot, access: z.infer<typeof accessInput>, kind: ChannelInfo['kind']) {
  return expandAccess(
    {
      private: access.private,
      read_only: access.read_only,
      visible_to: access.visible_to_role_ids,
      writers: access.writer_role_ids,
    },
    kind,
  ).map((o) => {
    const id = o.target === 'everyone' ? s.guild.id : o.target;
    if (!s.roles.some((r) => r.id === id)) throw new StewardError('not_found', `role ${id} not found`);
    return { id, type: 'role' as const, allow: o.allow, deny: o.deny };
  });
}

/** Keep a non-admin bot able to manage a channel it hides from @everyone. */
function withBotAccess(
  s: GuildSnapshot,
  list: Array<{ id: string; type: 'role' | 'member'; allow: bigint; deny: bigint }>,
) {
  const bot = botStanding(s);
  const everyone = list.find((o) => o.id === s.guild.id);
  if (bot.isAdmin || !everyone || (everyone.deny & P.ViewChannel) === 0n) return list;
  const botRole = s.roles.find((r) => r.managed && r.tags?.botId === bot.userId);
  const id = botRole?.id ?? bot.userId;
  const bits =
    (P.ViewChannel |
      P.ManageChannels |
      P.ManageRoles |
      P.ReadMessageHistory |
      P.SendMessages |
      P.EmbedLinks) &
    bot.permissions;
  const existing = list.find((o) => o.id === id);
  if (existing) existing.allow |= bits;
  else list.push({ id, type: botRole ? 'role' : 'member', allow: bits, deny: 0n });
  return list;
}

const kinds = ['text', 'voice', 'category', 'announcement', 'stage', 'forum', 'media'] as const;

export const channelTools = [
  defineTool({
    name: 'create_channel',
    title: 'Create channel or category',
    description:
      'Create one channel or category. Permission overwrites are sent in the same request, so a private channel is never briefly public. For many channels at once, use a blueprint instead.',
    scope: 'write',
    input: z.object({
      guild_id: guildIdInput,
      name: z.string().min(1).max(100),
      kind: z.enum(kinds).default('text'),
      parent_id: snowflake.optional().describe('Category to create it in.'),
      topic: z.string().max(1024).optional(),
      nsfw: z.boolean().optional(),
      slowmode_seconds: z.number().int().min(0).max(21600).optional(),
      bitrate: z.number().int().min(8000).max(384000).optional(),
      user_limit: z.number().int().min(0).max(99).optional(),
      overwrites: z.array(overwriteInput).max(100).optional(),
      access: accessInput.optional().describe('Shortcut presets, merged under explicit overwrites.'),
      sync_with_category: z
        .boolean()
        .optional()
        .describe("Copy the category's overwrites (default when no overwrites/access are given)."),
      key: keyInput,
      reason: reasonInput,
    }),
    guildOf: (a) => a.guild_id,
    handler: async (a, call) => {
      const s = await snapshotOf(call, a.guild_id);
      requireManageChannels(s, null);
      const parent = a.parent_id
        ? requireFound(
            s.channels.find((c) => c.id === a.parent_id && c.kind === 'category'),
            `category ${a.parent_id}`,
          )
        : null;
      if (a.kind === 'category' && parent)
        throw new StewardError('invalid_argument', 'categories cannot be nested');
      if (channelKindNeedsCommunity(s.guild.features, a.kind)) {
        throw new StewardError('precondition_failed', `${a.kind} channels need the Community feature`);
      }
      let overwrites = [
        ...(a.access ? presetOverwrites(s, a.access, a.kind) : []),
        ...toOverwrites(s, a.overwrites ?? []),
      ];
      const byId = new Map(overwrites.map((o) => [o.id, o]));
      overwrites = [...byId.values()];
      if (overwrites.length === 0 && parent && a.sync_with_category !== false)
        overwrites = parent.overwrites.map((o) => ({ ...o }));
      overwrites = withBotAccess(s, overwrites);
      if (overwrites.length) checkOverwriteGrant(s, parent, overwrites);
      const body: ChannelWriteBody = {
        name: a.name,
        type: CHANNEL_TYPE_NUMBERS[a.kind],
        parent_id: parent?.id ?? null,
        ...(a.topic !== undefined ? { topic: a.topic } : {}),
        ...(a.nsfw !== undefined ? { nsfw: a.nsfw } : {}),
        ...(a.slowmode_seconds !== undefined ? { rate_limit_per_user: a.slowmode_seconds } : {}),
        ...(a.bitrate !== undefined ? { bitrate: a.bitrate } : {}),
        ...(a.user_limit !== undefined ? { user_limit: a.user_limit } : {}),
        ...(overwrites.length
          ? {
              permission_overwrites: overwrites.map((o) => ({
                id: o.id,
                type: o.type === 'member' ? (1 as const) : (0 as const),
                allow: o.allow.toString(),
                deny: o.deny.toString(),
              })),
            }
          : {}),
      };
      if (a.key && call.app.store.getMapping(a.guild_id, 'channel', a.key)) {
        throw new StewardError(
          'conflict',
          `key "${a.key}" is already bound; pick another or unbind it with map_resource`,
        );
      }
      const out = await mutate(call, a.guild_id, a.reason, {
        action: 'create_channel',
        resourceKind: 'channel',
        resourceKey: a.key,
        summary: `create ${a.kind} ${a.name}`,
        idempotent: false,
        match: { kind: 'channel', name: a.name, type: body.type, parentId: body.parent_id },
        run: (reason) => call.app.adapter.createChannel(a.guild_id, body, reason),
        resultId: (c) => c.id,
      });
      const id = idOf(out, (c) => c.id);
      bindKey(call, a.guild_id, a.key, id);
      return {
        op_id: out.opId,
        channel_id: id,
        status: out.status,
        name: out.status === 'succeeded' ? out.result.name : a.name,
        overwrites: overwrites.length,
        note:
          out.status === 'recovered'
            ? 'Discord did not confirm the request, but the channel was found and adopted'
            : undefined,
      };
    },
  }),

  defineTool({
    name: 'update_channel',
    title: 'Update channel',
    description:
      'Rename, retopic, move between categories (parent_id null moves it out), or change slowmode, NSFW, bitrate or user limit.',
    scope: 'write',
    input: z.object({
      guild_id: guildIdInput,
      channel_id: snowflake,
      name: z.string().min(1).max(100).optional(),
      topic: z.string().max(1024).nullable().optional(),
      nsfw: z.boolean().optional(),
      slowmode_seconds: z.number().int().min(0).max(21600).optional(),
      bitrate: z.number().int().min(8000).max(384000).optional(),
      user_limit: z.number().int().min(0).max(99).optional(),
      parent_id: snowflake.nullable().optional(),
      sync_with_category: z
        .boolean()
        .optional()
        .describe("After moving, copy the new category's overwrites."),
      reason: reasonInput,
    }),
    guildOf: (a) => a.guild_id,
    handler: async (a, call) => {
      const s = await snapshotOf(call, a.guild_id);
      const ch = requireFound(
        s.channels.find((c) => c.id === a.channel_id),
        `channel ${a.channel_id}`,
      );
      requireManageChannels(s, ch);
      const body: ChannelWriteBody = {};
      if (a.name !== undefined) body.name = a.name;
      if (a.topic !== undefined) body.topic = a.topic;
      if (a.nsfw !== undefined) body.nsfw = a.nsfw;
      if (a.slowmode_seconds !== undefined) body.rate_limit_per_user = a.slowmode_seconds;
      if (a.bitrate !== undefined) body.bitrate = a.bitrate;
      if (a.user_limit !== undefined) body.user_limit = a.user_limit;
      if (a.parent_id !== undefined) {
        if (ch.kind === 'category')
          throw new StewardError('invalid_argument', 'categories cannot have a parent');
        const parent = a.parent_id
          ? requireFound(
              s.channels.find((c) => c.id === a.parent_id && c.kind === 'category'),
              `category ${a.parent_id}`,
            )
          : null;
        body.parent_id = parent?.id ?? null;
        if (a.sync_with_category && parent) {
          checkOverwriteGrant(s, parent, parent.overwrites);
          body.permission_overwrites = parent.overwrites.map((o) => ({
            id: o.id,
            type: o.type === 'member' ? 1 : 0,
            allow: o.allow.toString(),
            deny: o.deny.toString(),
          }));
        }
      }
      if (Object.keys(body).length === 0) throw new StewardError('invalid_argument', 'nothing to change');
      const out = await mutate(call, a.guild_id, a.reason, {
        action: 'update_channel',
        resourceKind: 'channel',
        targetId: ch.id,
        summary: `update #${ch.name}: ${Object.keys(body).join(', ')}`,
        idempotent: true,
        run: (reason) => call.app.adapter.editChannel(ch.id, body, reason),
      });
      return { op_id: out.opId, channel_id: ch.id, changed: Object.keys(body) };
    },
  }),

  defineTool({
    name: 'reorder_channels',
    title: 'Reorder channels',
    description:
      'Put channels that share a parent (or categories) in the given order. Only the listed channels move; others keep their slots. Text and voice channels sort separately in Discord, so list one kind at a time.',
    scope: 'write',
    input: z.object({
      guild_id: guildIdInput,
      channel_ids: z.array(snowflake).min(2).max(100),
      reason: reasonInput,
    }),
    guildOf: (a) => a.guild_id,
    handler: async (a, call) => {
      const s = await snapshotOf(call, a.guild_id);
      requireManageChannels(s, null);
      const chans = a.channel_ids.map((id) =>
        requireFound(
          s.channels.find((c) => c.id === id),
          `channel ${id}`,
        ),
      );
      const group = channelGroup(chans[0]!.kind);
      const parent = group === 'category' ? null : (chans[0]!.parentId ?? null);
      if (
        chans.some(
          (c) => channelGroup(c.kind) !== group || (group !== 'category' && (c.parentId ?? null) !== parent),
        )
      ) {
        throw new StewardError(
          'invalid_argument',
          'all channels must be the same group (categories, text-like, or voice-like) and share a parent',
        );
      }
      const updates = channelPositionUpdates(bucketMembers(s, parent, group), a.channel_ids);
      if (updates.length === 0) return { changed: 0, note: 'already in that order' };
      const out = await mutate(call, a.guild_id, a.reason, {
        action: 'reorder_channels',
        resourceKind: 'channel',
        summary: `reorder ${chans.length} ${group === 'category' ? 'categories' : 'channels'}`,
        idempotent: true,
        run: (reason) => call.app.adapter.setChannelPositions(a.guild_id, updates, reason),
      });
      return { op_id: out.opId, changed: updates.length };
    },
  }),

  defineTool({
    name: 'set_channel_permissions',
    title: 'Set permission overwrites',
    description:
      "Set or remove permission overwrites on a channel or category. Each listed overwrite replaces that role's or member's overwrite entirely; others are untouched unless listed in remove_target_ids. Restrictive changes are applied first.",
    scope: 'write',
    input: z.object({
      guild_id: guildIdInput,
      channel_id: snowflake,
      overwrites: z.array(overwriteInput).max(100).default([]),
      remove_target_ids: z
        .array(snowflake)
        .max(100)
        .default([])
        .describe('Role or member IDs whose overwrite should be removed.'),
      reason: reasonInput,
    }),
    guildOf: (a) => a.guild_id,
    handler: async (a, call) => {
      const s = await snapshotOf(call, a.guild_id);
      const ch = requireFound(
        s.channels.find((c) => c.id === a.channel_id),
        `channel ${a.channel_id}`,
      );
      const list = toOverwrites(s, a.overwrites);
      if (list.length === 0 && a.remove_target_ids.length === 0)
        throw new StewardError('invalid_argument', 'nothing to change');
      checkOverwriteGrant(s, ch, list);
      list.sort((x, y) => Number(y.deny !== 0n) - Number(x.deny !== 0n));
      return withGuildLock(call, a.guild_id, async () => {
        const ops: string[] = [];
        const ctx = opContext(call, a.guild_id, a.reason);
        for (const o of list) {
          const out = await runOperation(ctx, {
            action: 'put_overwrite',
            resourceKind: 'overwrite',
            targetId: ch.id,
            summary: `#${ch.name}: set overwrite for ${o.type} ${o.id}`,
            idempotent: true,
            run: (reason) => call.app.adapter.putOverwrite(ch.id, o, reason),
          });
          ops.push(out.opId);
        }
        for (const id of a.remove_target_ids) {
          const out = await runOperation(ctx, {
            action: 'delete_overwrite',
            resourceKind: 'overwrite',
            targetId: ch.id,
            summary: `#${ch.name}: remove overwrite for ${id}`,
            idempotent: true,
            notFoundIsSuccess: true,
            run: (reason) => call.app.adapter.deleteOverwrite(ch.id, id, reason),
          });
          ops.push(out.opId);
        }
        return { op_ids: ops, set: list.length, removed: a.remove_target_ids.length };
      });
    },
  }),

  defineTool({
    name: 'configure_channel_access',
    title: 'Private / read-only presets',
    description:
      'One-call presets: make a channel or category private to some roles, and/or read-only except for some roles (e.g. announcements). Merges with existing overwrites. A bot without Administrator keeps its own access.',
    scope: 'write',
    input: z.object({
      guild_id: guildIdInput,
      channel_id: snowflake,
      ...accessInput.shape,
      reason: reasonInput,
    }),
    guildOf: (a) => a.guild_id,
    handler: async (a, call) => {
      const s = await snapshotOf(call, a.guild_id);
      const ch = requireFound(
        s.channels.find((c) => c.id === a.channel_id),
        `channel ${a.channel_id}`,
      );
      if (!a.private && !a.read_only)
        throw new StewardError('invalid_argument', 'set private and/or read_only');
      const wanted = withBotAccess(s, presetOverwrites(s, a, ch.kind));
      // Merge: add the preset's bits to whatever each target already has.
      const merged = wanted.map((w) => {
        const cur = ch.overwrites.find((o) => o.id === w.id);
        return {
          ...w,
          allow: ((cur?.allow ?? 0n) & ~w.deny) | w.allow,
          deny: ((cur?.deny ?? 0n) & ~w.allow) | w.deny,
        };
      });
      checkOverwriteGrant(s, ch, merged);
      merged.sort((x, y) => Number(y.deny !== 0n) - Number(x.deny !== 0n));
      return withGuildLock(call, a.guild_id, async () => {
        const ctx = opContext(call, a.guild_id, a.reason);
        const ops: string[] = [];
        for (const o of merged) {
          const out = await runOperation(ctx, {
            action: 'put_overwrite',
            resourceKind: 'overwrite',
            targetId: ch.id,
            summary: `#${ch.name}: access preset for ${o.id === s.guild.id ? '@everyone' : o.id}`,
            idempotent: true,
            run: (reason) => call.app.adapter.putOverwrite(ch.id, o, reason),
          });
          ops.push(out.opId);
        }
        const others = ch.overwrites.filter(
          (o) => !merged.some((m) => m.id === o.id) && (o.allow & P.ViewChannel) !== 0n,
        );
        return {
          op_ids: ops,
          overwrites_set: merged.length,
          warning:
            a.private && others.length
              ? `${others.length} other overwrite(s) still grant View Channel: ${others.map((o) => o.id).join(', ')}`
              : undefined,
        };
      });
    },
  }),

  defineTool({
    name: 'delete_channel',
    title: 'Delete channel or category',
    description:
      'Permanently delete a channel or category (its messages are lost; channels inside a deleted category are kept, uncategorised). confirm_name must equal the current name.',
    scope: 'destructive',
    input: z.object({
      guild_id: guildIdInput,
      channel_id: snowflake,
      confirm_name: z.string().min(1).max(100),
      reason: reasonInput,
    }),
    guildOf: (a) => a.guild_id,
    handler: async (a, call) => {
      const s = await snapshotOf(call, a.guild_id);
      const ch = requireFound(
        s.channels.find((c) => c.id === a.channel_id),
        `channel ${a.channel_id}`,
      );
      if (ch.name !== a.confirm_name)
        throw new StewardError(
          'precondition_failed',
          `confirm_name "${a.confirm_name}" does not match the channel's name "${ch.name}"`,
        );
      requireManageChannels(s, ch);
      const out = await mutate(call, a.guild_id, a.reason, {
        action: 'delete_channel',
        resourceKind: 'channel',
        targetId: ch.id,
        summary: `delete ${ch.kind} #${ch.name}`,
        idempotent: true,
        notFoundIsSuccess: true,
        run: (reason) => call.app.adapter.deleteChannel(ch.id, reason),
      });
      call.app.store.deleteMappingById(a.guild_id, 'channel', ch.id);
      return { op_id: out.opId, deleted: ch.id, name: ch.name };
    },
  }),
];
