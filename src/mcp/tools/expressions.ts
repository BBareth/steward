import { z } from 'zod';
import { botStanding, has, P, roleById } from '../../discord/permissions.js';
import type { GuildSnapshot, SoundWriteBody, StickerWriteBody } from '../../discord/types.js';
import { StewardError } from '../../util/errors.js';
import { loadMedia, mediaInput } from '../../util/media.js';
import { defineTool } from '../registry.js';
import {
  emojiInput,
  emojiResolver,
  guildIdInput,
  mutate,
  reasonInput,
  requireFound,
  snapshotOf,
  snowflake,
  untrusted,
} from './common.js';

/** Slots per boost tier (0-3). Emoji slots count static and animated separately. */
const SLOTS = {
  emoji: [50, 100, 150, 250],
  sticker: [5, 15, 30, 60],
  sound: [8, 24, 36, 48],
} as const;

const slots = (kind: keyof typeof SLOTS, tier: number) => SLOTS[kind][tier] ?? SLOTS[kind][0];

/**
 * Create Expressions lets the bot add expressions and change or delete its own;
 * Manage Expressions covers everyone's.
 */
function requireExpressionPerm(s: GuildSnapshot, creatorId: string | null | undefined, creating: boolean) {
  const perms = botStanding(s).permissions;
  if (has(perms, P.ManageGuildExpressions)) return;
  const own = creating || (!!creatorId && creatorId === s.botMember.userId);
  if (own && has(perms, P.CreateGuildExpressions)) return;
  throw new StewardError(
    'precondition_failed',
    creating
      ? 'the bot lacks Create Expressions'
      : 'the bot lacks Manage Expressions (Create Expressions only covers expressions the bot added)',
  );
}

const kindInput = z.enum(['emoji', 'sticker', 'sound']);

export const expressionTools = [
  defineTool({
    name: 'list_expressions',
    title: 'List emojis, stickers and sounds',
    description:
      "The server's custom emojis, stickers and soundboard sounds, with the slots its boost tier allows. created_by_bot marks the ones the bot can change with Create Expressions alone.",
    scope: 'read',
    input: z.object({ guild_id: guildIdInput, kind: kindInput.optional() }),
    guildOf: (a) => a.guild_id,
    handler: async ({ guild_id, kind }, call) => {
      const s = await snapshotOf(call, guild_id);
      const { adapter } = call.app;
      const tier = s.guild.premiumTier;
      const bot = s.botMember.userId;
      const want = (k: z.infer<typeof kindInput>) => !kind || kind === k;
      const [emojis, stickers, sounds] = await Promise.all([
        want('emoji') ? adapter.fetchEmojis(guild_id) : null,
        want('sticker') ? adapter.fetchStickers(guild_id) : null,
        want('sound') ? adapter.fetchSounds(guild_id) : null,
      ]);
      return {
        guild_id,
        boost_tier: tier,
        ...(emojis && {
          emojis: {
            static_slots: { used: emojis.filter((e) => !e.animated).length, max: slots('emoji', tier) },
            animated_slots: { used: emojis.filter((e) => e.animated).length, max: slots('emoji', tier) },
            items: emojis.map((e) => ({
              id: e.id,
              name: e.name,
              animated: e.animated,
              role_ids: e.roleIds,
              managed: e.managed,
              available: e.available,
              created_by_bot: e.creatorId === bot,
              url: `https://cdn.discordapp.com/emojis/${e.id}.${e.animated ? 'gif' : 'png'}`,
            })),
          },
        }),
        ...(stickers && {
          stickers: {
            slots: { used: stickers.length, max: slots('sticker', tier) },
            items: stickers.map((x) => ({
              id: x.id,
              name: x.name,
              description: untrusted(x.description),
              tags: x.tags,
              format: ['png', 'apng', 'lottie', 'gif'][x.formatType - 1] ?? 'unknown',
              available: x.available,
              created_by_bot: x.creatorId === bot,
            })),
          },
        }),
        ...(sounds && {
          sounds: {
            slots: { used: sounds.length, max: slots('sound', tier) },
            items: sounds.map((x) => ({
              id: x.id,
              name: x.name,
              volume: x.volume,
              emoji: x.emojiId ?? x.emojiName,
              available: x.available,
              created_by_bot: x.creatorId === bot,
              url: `https://cdn.discordapp.com/soundboard-sounds/${x.id}`,
            })),
          },
        }),
      };
    },
  }),

  defineTool({
    name: 'upsert_emoji',
    title: 'Add or edit a custom emoji',
    description:
      'Add a custom emoji (image: png, jpeg, gif or webp, at most 256 KB) or, with emoji_id, rename it or limit it to roles. The image cannot change after upload. Needs Create Expressions, or Manage Expressions to edit emojis the bot did not add.',
    scope: 'write',
    input: z.object({
      guild_id: guildIdInput,
      emoji_id: snowflake.optional().describe('Edit this emoji; leave out to add a new one.'),
      name: z
        .string()
        .regex(/^\w{2,32}$/, '2-32 letters, digits or underscores')
        .optional(),
      image: mediaInput.optional().describe('Required when adding; it cannot change later.'),
      role_ids: z
        .array(snowflake)
        .max(250)
        .optional()
        .describe('Only these roles may use it; [] lets everyone.'),
      reason: reasonInput,
    }),
    guildOf: (a) => a.guild_id,
    handler: async (a, call) => {
      const s = await snapshotOf(call, a.guild_id);
      for (const id of a.role_ids ?? []) requireFound(roleById(s, id), `role ${id}`);
      const { adapter } = call.app;
      if (a.emoji_id) {
        if (a.image)
          throw new StewardError('invalid_argument', "an emoji's image cannot change; add a new one");
        const emojis = await adapter.fetchEmojis(a.guild_id);
        const e = requireFound(
          emojis.find((x) => x.id === a.emoji_id),
          `emoji ${a.emoji_id}`,
        );
        if (e.managed)
          throw new StewardError('precondition_failed', `${e.name} is managed by an integration`);
        requireExpressionPerm(s, e.creatorId, false);
        const body = { ...(a.name && { name: a.name }), ...(a.role_ids && { roles: a.role_ids }) };
        if (Object.keys(body).length === 0) throw new StewardError('invalid_argument', 'nothing to change');
        const out = await mutate(call, a.guild_id, a.reason, {
          action: 'upsert_emoji',
          resourceKind: 'emoji',
          targetId: e.id,
          summary: `edit emoji ${e.name}: ${Object.keys(body).join(', ')}`,
          idempotent: true,
          run: (reason) => adapter.editEmoji(a.guild_id, e.id, body, reason),
        });
        return { op_id: out.opId, emoji_id: e.id, created: false, changed: Object.keys(body) };
      }
      if (!a.name || !a.image) throw new StewardError('invalid_argument', 'a new emoji needs name and image');
      requireExpressionPerm(s, null, true);
      const media = await loadMedia(a.image, 'emoji');
      const name = a.name;
      const out = await mutate(call, a.guild_id, a.reason, {
        action: 'upsert_emoji',
        resourceKind: 'emoji',
        resourceKey: name,
        summary: `add emoji ${name}`,
        idempotent: false,
        run: (reason) =>
          adapter.createEmoji(a.guild_id, { name, image: media.dataUri, roles: a.role_ids ?? [] }, reason),
        resultId: (e) => e.id,
      });
      const id =
        out.status === 'succeeded' ? out.result.id : out.status === 'recovered' ? out.recoveredId : null;
      return { op_id: out.opId, emoji_id: id, created: true, usage: id ? `<:${name}:${id}>` : null };
    },
  }),

  defineTool({
    name: 'upsert_sticker',
    title: 'Add or edit a sticker',
    description:
      'Add a server sticker (png or gif, at most 512 KB, ideally 320x320) or, with sticker_id, change its name, description or tag. tags is the name of a unicode emoji used for suggestions, such as "wave". Needs Create Expressions, or Manage Expressions for stickers the bot did not add.',
    scope: 'write',
    input: z.object({
      guild_id: guildIdInput,
      sticker_id: snowflake.optional(),
      name: z.string().min(2).max(30).optional(),
      description: z
        .string()
        .max(100)
        .refine((d) => d.length === 0 || d.length >= 2, 'empty or 2-100 characters')
        .optional(),
      tags: z.string().min(1).max(200).optional(),
      file: mediaInput.optional().describe('Required when adding.'),
      reason: reasonInput,
    }),
    guildOf: (a) => a.guild_id,
    handler: async (a, call) => {
      const s = await snapshotOf(call, a.guild_id);
      const { adapter } = call.app;
      const body: StickerWriteBody = {};
      if (a.name !== undefined) body.name = a.name;
      if (a.description !== undefined) body.description = a.description;
      if (a.tags !== undefined) body.tags = a.tags;
      if (a.sticker_id) {
        if (a.file)
          throw new StewardError('invalid_argument', "a sticker's file cannot change; add a new one");
        const stickers = await adapter.fetchStickers(a.guild_id);
        const x = requireFound(
          stickers.find((t) => t.id === a.sticker_id),
          `sticker ${a.sticker_id}`,
        );
        requireExpressionPerm(s, x.creatorId, false);
        if (Object.keys(body).length === 0) throw new StewardError('invalid_argument', 'nothing to change');
        const out = await mutate(call, a.guild_id, a.reason, {
          action: 'upsert_sticker',
          resourceKind: 'sticker',
          targetId: x.id,
          summary: `edit sticker ${x.name}: ${Object.keys(body).join(', ')}`,
          idempotent: true,
          run: (reason) => adapter.editSticker(a.guild_id, x.id, body, reason),
        });
        return { op_id: out.opId, sticker_id: x.id, created: false, changed: Object.keys(body) };
      }
      if (!a.name || !a.tags || !a.file)
        throw new StewardError('invalid_argument', 'a new sticker needs name, tags and file');
      requireExpressionPerm(s, null, true);
      const media = await loadMedia(a.file, 'sticker');
      const full = { name: a.name, description: a.description ?? '', tags: a.tags };
      const out = await mutate(call, a.guild_id, a.reason, {
        action: 'upsert_sticker',
        resourceKind: 'sticker',
        resourceKey: full.name,
        summary: `add sticker ${full.name}`,
        idempotent: false,
        run: (reason) =>
          adapter.createSticker(
            a.guild_id,
            full,
            { data: media.data, filename: `sticker.${media.extension}`, contentType: media.contentType },
            reason,
          ),
        resultId: (x) => x.id,
      });
      const id =
        out.status === 'succeeded' ? out.result.id : out.status === 'recovered' ? out.recoveredId : null;
      return { op_id: out.opId, sticker_id: id, created: true };
    },
  }),

  defineTool({
    name: 'upsert_soundboard_sound',
    title: 'Add or edit a soundboard sound',
    description:
      'Add a soundboard sound (mp3 or ogg, at most 512 KB and 5 seconds) or, with sound_id, change its name, volume or emoji. Needs Create Expressions, or Manage Expressions for sounds the bot did not add.',
    scope: 'write',
    input: z.object({
      guild_id: guildIdInput,
      sound_id: snowflake.optional(),
      name: z.string().min(2).max(32).optional(),
      sound: mediaInput.optional().describe('Required when adding.'),
      volume: z.number().min(0).max(1).optional(),
      emoji: emojiInput.nullable().optional(),
      reason: reasonInput,
    }),
    guildOf: (a) => a.guild_id,
    handler: async (a, call) => {
      const s = await snapshotOf(call, a.guild_id);
      const { adapter } = call.app;
      const body: SoundWriteBody = {};
      if (a.name !== undefined) body.name = a.name;
      if (a.volume !== undefined) body.volume = a.volume;
      if (a.emoji !== undefined) {
        const e = a.emoji === null ? null : (await emojiResolver(call, a.guild_id, [a.emoji]))(a.emoji);
        body.emoji_id = e?.id ?? null;
        body.emoji_name = e && !e.id ? e.name : null;
      }
      if (a.sound_id) {
        if (a.sound)
          throw new StewardError('invalid_argument', "a sound's audio cannot change; add a new one");
        const sounds = await adapter.fetchSounds(a.guild_id);
        const x = requireFound(
          sounds.find((t) => t.id === a.sound_id),
          `sound ${a.sound_id}`,
        );
        requireExpressionPerm(s, x.creatorId, false);
        if (Object.keys(body).length === 0) throw new StewardError('invalid_argument', 'nothing to change');
        const out = await mutate(call, a.guild_id, a.reason, {
          action: 'upsert_soundboard_sound',
          resourceKind: 'sound',
          targetId: x.id,
          summary: `edit sound ${x.name}: ${Object.keys(body).join(', ')}`,
          idempotent: true,
          run: (reason) => adapter.editSound(a.guild_id, x.id, body, reason),
        });
        return { op_id: out.opId, sound_id: x.id, created: false, changed: Object.keys(body) };
      }
      if (!a.name || !a.sound) throw new StewardError('invalid_argument', 'a new sound needs name and sound');
      requireExpressionPerm(s, null, true);
      const media = await loadMedia(a.sound, 'sound');
      const name = a.name;
      const out = await mutate(call, a.guild_id, a.reason, {
        action: 'upsert_soundboard_sound',
        resourceKind: 'sound',
        resourceKey: name,
        summary: `add sound ${name}`,
        idempotent: false,
        run: (reason) => adapter.createSound(a.guild_id, { ...body, name, sound: media.dataUri }, reason),
        resultId: (x) => x.id,
      });
      const id =
        out.status === 'succeeded' ? out.result.id : out.status === 'recovered' ? out.recoveredId : null;
      return { op_id: out.opId, sound_id: id, created: true };
    },
  }),

  defineTool({
    name: 'delete_expression',
    title: 'Delete an emoji, sticker or sound',
    description:
      'Permanently delete a custom emoji, sticker or soundboard sound. confirm_name must equal its current name. Needs Manage Expressions, or Create Expressions for ones the bot added.',
    scope: 'destructive',
    input: z.object({
      guild_id: guildIdInput,
      kind: kindInput,
      id: snowflake,
      confirm_name: z.string().min(1).max(32),
      reason: reasonInput,
    }),
    guildOf: (a) => a.guild_id,
    handler: async (a, call) => {
      const s = await snapshotOf(call, a.guild_id);
      const { adapter } = call.app;
      const list =
        a.kind === 'emoji'
          ? await adapter.fetchEmojis(a.guild_id)
          : a.kind === 'sticker'
            ? await adapter.fetchStickers(a.guild_id)
            : await adapter.fetchSounds(a.guild_id);
      const x = requireFound(
        list.find((t) => t.id === a.id),
        `${a.kind} ${a.id}`,
      );
      if (x.name !== a.confirm_name)
        throw new StewardError(
          'precondition_failed',
          `confirm_name "${a.confirm_name}" does not match the ${a.kind}'s name "${x.name}"`,
        );
      if ('managed' in x && x.managed)
        throw new StewardError('precondition_failed', `${x.name} is managed by an integration`);
      requireExpressionPerm(s, x.creatorId, false);
      const out = await mutate(call, a.guild_id, a.reason, {
        action: 'delete_expression',
        resourceKind: a.kind,
        targetId: x.id,
        summary: `delete ${a.kind} ${x.name}`,
        idempotent: true,
        notFoundIsSuccess: true,
        run: (reason) =>
          a.kind === 'emoji'
            ? adapter.deleteEmoji(a.guild_id, x.id, reason)
            : a.kind === 'sticker'
              ? adapter.deleteSticker(a.guild_id, x.id, reason)
              : adapter.deleteSound(a.guild_id, x.id, reason),
      });
      return { op_id: out.opId, deleted: x.id, kind: a.kind, name: x.name };
    },
  }),
];
