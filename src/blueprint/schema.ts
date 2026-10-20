import YAML from 'yaml';
import { z } from 'zod';
import { colorSchema, embedSchema } from '../features/messages.js';
import { StewardError } from '../util/errors.js';

/**
 * The blueprint format. See docs/BLUEPRINTS.md for the prose version.
 *
 * Identity is the `key`, never the name: keys are bound to Discord IDs in the
 * database the first time a resource is created, exported or adopted, and
 * every later plan uses that binding.
 */

export const KEY_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const key = z
  .string()
  .regex(KEY_RE, 'keys are 1-64 characters of a-z, 0-9, "-" and "_", starting with a letter or digit')
  .refine((k) => !/^\d{17,20}$/.test(k), 'a key must not look like a Discord ID');

/** A role reference: a role key, "everyone", or a raw Discord role ID. */
const roleRef = z.string().min(1).max(64);
/** A channel reference: a channel/category key or a raw Discord channel ID. */
const channelRef = z.string().min(1).max(64);
const snowflake = z.string().regex(/^\d{17,20}$/, 'must be a Discord ID');
const permissionList = z.array(z.string().min(1).max(64)).max(64);

export const overwriteSchema = z
  .object({
    role: roleRef.optional(),
    member: snowflake.optional(),
    allow: permissionList.default([]),
    deny: permissionList.default([]),
  })
  .strict()
  .refine(
    (o) => (o.role === undefined) !== (o.member === undefined),
    'set exactly one of "role" or "member"',
  );

export const accessSchema = z
  .object({
    private: z.boolean().optional(),
    visible_to: z.array(roleRef).max(50).optional(),
    read_only: z.boolean().optional(),
    writers: z.array(roleRef).max(50).optional(),
  })
  .strict();

export const CHANNEL_TYPES = ['text', 'voice', 'announcement', 'stage', 'forum', 'media'] as const;

export const channelSchema = z
  .object({
    key,
    name: z.string().min(1).max(100),
    type: z.enum(CHANNEL_TYPES).default('text'),
    id: snowflake.optional(),
    topic: z.string().max(4096).nullable().optional(),
    nsfw: z.boolean().optional(),
    slowmode_seconds: z.number().int().min(0).max(21600).optional(),
    bitrate: z.number().int().min(8000).max(384000).optional(),
    user_limit: z.number().int().min(0).max(99).optional(),
    sync_permissions: z.boolean().optional(),
    permissions: z.array(overwriteSchema).max(100).optional(),
    access: accessSchema.optional(),
  })
  .strict();

export const categorySchema = z
  .object({
    key,
    name: z.string().min(1).max(100),
    id: snowflake.optional(),
    permissions: z.array(overwriteSchema).max(100).optional(),
    access: accessSchema.optional(),
    channels: z.array(channelSchema).max(50).default([]),
  })
  .strict();

export const roleSchema = z
  .object({
    key,
    name: z.string().min(1).max(100),
    id: snowflake.optional(),
    color: colorSchema.optional(),
    hoist: z.boolean().optional(),
    mentionable: z.boolean().optional(),
    permissions: permissionList.optional(),
    /** Staff roles are never handed out by self-role panels or on join, whatever their permissions. */
    staff: z.boolean().optional(),
  })
  .strict();

export const VERIFICATION_LEVELS = { none: 0, low: 1, medium: 2, high: 3, very_high: 4 } as const;
export const NOTIFICATION_LEVELS = { all_messages: 0, only_mentions: 1 } as const;
export const CONTENT_FILTERS = { disabled: 0, members_without_roles: 1, all_members: 2 } as const;
export const SYSTEM_CHANNEL_FLAGS = {
  suppress_join_notifications: 1 << 0,
  suppress_premium_subscriptions: 1 << 1,
  suppress_guild_reminders: 1 << 2,
  suppress_join_notification_replies: 1 << 3,
} as const;

const enumKeys = <T extends Record<string, number>>(o: T) =>
  Object.keys(o) as [keyof T & string, ...(keyof T & string)[]];

export const settingsSchema = z
  .object({
    name: z.string().min(2).max(100).optional(),
    description: z.string().max(120).nullable().optional(),
    verification_level: z.enum(enumKeys(VERIFICATION_LEVELS)).optional(),
    default_notifications: z.enum(enumKeys(NOTIFICATION_LEVELS)).optional(),
    explicit_content_filter: z.enum(enumKeys(CONTENT_FILTERS)).optional(),
    afk_channel: channelRef.nullable().optional(),
    afk_timeout: z
      .union([z.literal(60), z.literal(300), z.literal(900), z.literal(1800), z.literal(3600)])
      .optional(),
    system_channel: channelRef.nullable().optional(),
    system_channel_flags: z
      .object({
        suppress_join_notifications: z.boolean().optional(),
        suppress_premium_subscriptions: z.boolean().optional(),
        suppress_guild_reminders: z.boolean().optional(),
        suppress_join_notification_replies: z.boolean().optional(),
      })
      .strict()
      .optional(),
    rules_channel: channelRef.nullable().optional(),
    public_updates_channel: channelRef.nullable().optional(),
    safety_alerts_channel: channelRef.nullable().optional(),
    preferred_locale: z.string().min(2).max(10).optional(),
    premium_progress_bar: z.boolean().optional(),
    community: z.boolean().optional(),
  })
  .strict();

export const messageSchema = z
  .object({
    key,
    channel: channelRef,
    content: z.string().max(2000).optional(),
    embeds: z.array(embedSchema).max(10).optional(),
  })
  .strict();

export const welcomeSchema = z
  .object({
    enabled: z.boolean().default(true),
    channel: channelRef.nullable().optional(),
    message: z
      .object({ content: z.string().max(2000).optional(), embeds: z.array(embedSchema).max(10).optional() })
      .strict()
      .optional(),
    join_roles: z.array(roleRef).max(10).default([]),
  })
  .strict();

export const panelSchema = z
  .object({
    key,
    channel: channelRef,
    title: z.string().min(1).max(256),
    description: z.string().max(4000).optional(),
    mode: z.enum(['multiple', 'single']).default('multiple'),
    options: z
      .array(
        z
          .object({
            role: roleRef,
            label: z.string().min(1).max(80),
            emoji: z.string().min(1).max(64).optional(),
            style: z.enum(['primary', 'secondary', 'success', 'danger']).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(25),
  })
  .strict();

export const selfRolesSchema = z
  .object({
    /** The allowlist: the only roles members may give themselves. */
    roles: z.array(roleRef).max(100).default([]),
    panels: z.array(panelSchema).max(25).default([]),
  })
  .strict();

export const AUTOMOD_PRESETS = { profanity: 1, sexual_content: 2, slurs: 3 } as const;

export const automodSchema = z
  .object({
    key,
    name: z.string().min(1).max(100),
    enabled: z.boolean().default(true),
    trigger: z.discriminatedUnion('type', [
      z
        .object({
          type: z.literal('keyword'),
          keywords: z.array(z.string().min(1).max(60)).max(1000).default([]),
          regex_patterns: z.array(z.string().min(1).max(260)).max(10).default([]),
          allow_list: z.array(z.string().min(1).max(60)).max(100).default([]),
        })
        .strict(),
      z.object({ type: z.literal('spam') }).strict(),
      z
        .object({
          type: z.literal('keyword_preset'),
          presets: z.array(z.enum(enumKeys(AUTOMOD_PRESETS))).min(1),
          allow_list: z.array(z.string().min(1).max(60)).max(1000).default([]),
        })
        .strict(),
      z
        .object({
          type: z.literal('mention_spam'),
          mention_total_limit: z.number().int().min(1).max(50),
          raid_protection: z.boolean().default(false),
        })
        .strict(),
    ]),
    actions: z
      .array(
        z.discriminatedUnion('type', [
          z
            .object({ type: z.literal('block_message'), custom_message: z.string().max(150).optional() })
            .strict(),
          z.object({ type: z.literal('alert'), channel: channelRef }).strict(),
          z
            .object({ type: z.literal('timeout'), duration_seconds: z.number().int().min(1).max(2419200) })
            .strict(),
        ]),
      )
      .min(1)
      .max(3),
    exempt_roles: z.array(roleRef).max(20).default([]),
    exempt_channels: z.array(channelRef).max(50).default([]),
  })
  .strict();

export const blueprintSchema = z
  .object({
    version: z.literal(1),
    name: z.string().max(100).optional(),
    description: z.string().max(2000).optional(),
    settings: settingsSchema.optional(),
    everyone: z.object({ permissions: permissionList }).strict().optional(),
    roles: z.array(roleSchema).max(250).default([]),
    categories: z.array(categorySchema).max(50).default([]),
    channels: z.array(channelSchema).max(500).default([]),
    messages: z.array(messageSchema).max(50).default([]),
    welcome: welcomeSchema.optional(),
    self_roles: selfRolesSchema.optional(),
    automod: z.array(automodSchema).max(10).default([]),
  })
  .strict();

export type Blueprint = z.infer<typeof blueprintSchema>;
export type BlueprintRole = z.infer<typeof roleSchema>;
export type BlueprintChannel = z.infer<typeof channelSchema>;
export type BlueprintCategory = z.infer<typeof categorySchema>;
export type BlueprintOverwrite = z.infer<typeof overwriteSchema>;
export type BlueprintMessage = z.infer<typeof messageSchema>;
export type BlueprintPanel = z.infer<typeof panelSchema>;
export type BlueprintAutoMod = z.infer<typeof automodSchema>;
export type BlueprintSettings = z.infer<typeof settingsSchema>;

export interface Issue {
  path: string;
  message: string;
}

export const MAX_BLUEPRINT_BYTES = 1_000_000;

/** Parse YAML or JSON text, or accept an already-parsed object. */
export function parseBlueprintInput(input: unknown): unknown {
  if (typeof input !== 'string') return input;
  if (input.length > MAX_BLUEPRINT_BYTES) {
    throw new StewardError('invalid_argument', `blueprint is larger than ${MAX_BLUEPRINT_BYTES} bytes`);
  }
  try {
    // YAML is a superset of JSON, so one parser covers both. Aliases are
    // capped to keep a hostile document from expanding without bound.
    return YAML.parse(input, { maxAliasCount: 100, prettyErrors: true });
  } catch (error) {
    throw new StewardError(
      'invalid_argument',
      `blueprint is not valid YAML or JSON: ${(error as Error).message}`,
    );
  }
}

export function schemaIssues(error: z.ZodError): Issue[] {
  return error.issues.map((i) => ({ path: i.path.join('.') || '(root)', message: i.message }));
}
