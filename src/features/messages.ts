import { z } from 'zod';
import { StewardError } from '../util/errors.js';
import type { MessageBody, MessageEmbed } from '../discord/types.js';

export const colorSchema = z.union([
  z.string().regex(/^#?[0-9a-fA-F]{6}$/, 'colours are "#rrggbb"'),
  z.number().int().min(0).max(0xffffff),
]);

export function parseColor(value: string | number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'number') return value;
  return parseInt(value.replace('#', ''), 16);
}

export function formatColor(value: number): string {
  return `#${value.toString(16).padStart(6, '0')}`;
}

const httpUrl = z
  .string()
  .max(2048)
  .regex(/^https?:\/\//, 'must be an http(s) URL');

export const embedSchema = z
  .object({
    title: z.string().max(256).optional(),
    description: z.string().max(4096).optional(),
    url: httpUrl.optional(),
    color: colorSchema.optional(),
    fields: z
      .array(
        z.object({
          name: z.string().min(1).max(256),
          value: z.string().min(1).max(1024),
          inline: z.boolean().optional(),
        }),
      )
      .max(25)
      .optional(),
    footer: z.object({ text: z.string().min(1).max(2048) }).optional(),
    author: z.object({ name: z.string().min(1).max(256), url: httpUrl.optional() }).optional(),
    image: z.object({ url: httpUrl }).optional(),
    thumbnail: z.object({ url: httpUrl }).optional(),
  })
  .strict();

export type EmbedInput = z.infer<typeof embedSchema>;

export const messageContentSchema = z
  .object({
    content: z.string().max(2000).optional(),
    embeds: z.array(embedSchema).max(10).optional(),
  })
  .strict();

export type MessageContent = z.infer<typeof messageContentSchema>;

function embedLength(e: EmbedInput): number {
  return (
    (e.title?.length ?? 0) +
    (e.description?.length ?? 0) +
    (e.footer?.text.length ?? 0) +
    (e.author?.name.length ?? 0) +
    (e.fields ?? []).reduce((n, f) => n + f.name.length + f.value.length, 0)
  );
}

export function checkMessageContent(msg: MessageContent): string[] {
  const problems: string[] = [];
  if (!msg.content?.trim() && !(msg.embeds && msg.embeds.length > 0))
    problems.push('a message needs content or at least one embed');
  const total = (msg.embeds ?? []).reduce((n, e) => n + embedLength(e), 0);
  if (total > 6000) problems.push(`embeds total ${total} characters; Discord allows 6000`);
  for (const [i, e] of (msg.embeds ?? []).entries()) {
    if (embedLength(e) === 0 && !e.image && !e.thumbnail) problems.push(`embed ${i + 1} is empty`);
  }
  return problems;
}

export function toEmbed(e: EmbedInput): MessageEmbed {
  const out: MessageEmbed = {};
  if (e.title !== undefined) out.title = e.title;
  if (e.description !== undefined) out.description = e.description;
  if (e.url !== undefined) out.url = e.url;
  if (e.color !== undefined) out.color = parseColor(e.color);
  if (e.fields)
    out.fields = e.fields.map((f) => ({ name: f.name, value: f.value, inline: f.inline ?? false }));
  if (e.footer) out.footer = { text: e.footer.text };
  if (e.author)
    out.author = e.author.url ? { name: e.author.name, url: e.author.url } : { name: e.author.name };
  if (e.image) out.image = { url: e.image.url };
  if (e.thumbnail) out.thumbnail = { url: e.thumbnail.url };
  return out;
}

export interface MentionPolicy {
  users?: string[];
  roles?: string[];
  /** Allow @everyone / @here. Never on by default. */
  everyone?: boolean;
}

/**
 * Build a message body with mentions locked down. Nothing pings unless it is
 * listed explicitly; @everyone and @here only with an explicit opt-in.
 */
export function buildMessageBody(msg: MessageContent, mentions: MentionPolicy = {}): MessageBody {
  const problems = checkMessageContent(msg);
  if (problems.length > 0) throw new StewardError('invalid_argument', problems.join('; '));
  const body: MessageBody = {
    allowed_mentions: { parse: mentions.everyone ? ['everyone'] : [] },
  };
  if (mentions.users?.length) body.allowed_mentions.users = [...new Set(mentions.users)].slice(0, 100);
  if (mentions.roles?.length) body.allowed_mentions.roles = [...new Set(mentions.roles)].slice(0, 100);
  if (msg.content !== undefined) body.content = msg.content;
  if (msg.embeds) body.embeds = msg.embeds.map(toEmbed);
  return body;
}

/** Escape Discord markdown and mention syntax in text that came from a user. */
export function escapeUserText(text: string): string {
  return text
    .replace(/([\\*_`~|>#[\]()-])/g, '\\$1')
    .replace(/@/g, '@\u200b')
    .replace(/<(?=[@#:a])/g, '<\u200b');
}

export interface WelcomeVars {
  userId: string;
  username: string | null;
  serverName: string;
  memberCount: number | null;
}

/** Fill {user}, {username}, {server} and {member_count}. Values from Discord are escaped. */
export function renderTemplate(text: string, vars: WelcomeVars): string {
  return text
    .replace(/\{user\}/g, `<@${vars.userId}>`)
    .replace(/\{username\}/g, escapeUserText(vars.username ?? 'new member'))
    .replace(/\{server\}/g, escapeUserText(vars.serverName))
    .replace(/\{member_count\}/g, vars.memberCount !== null ? String(vars.memberCount) : 'many');
}

export function renderWelcome(msg: MessageContent, vars: WelcomeVars): MessageContent {
  const r = (s: string | undefined) => (s === undefined ? undefined : renderTemplate(s, vars));
  return {
    content: r(msg.content),
    embeds: msg.embeds?.map((e) => ({
      ...e,
      title: r(e.title),
      description: r(e.description),
      fields: e.fields?.map((f) => ({ ...f, name: r(f.name)!, value: r(f.value)! })),
      footer: e.footer ? { text: r(e.footer.text)! } : undefined,
    })),
  };
}

/**
 * A short fingerprint of what a posted message looks like, used to recognise
 * our own message after an interrupted post. Discord decorates embeds on the
 * way back, so only the fields it returns unchanged are used.
 */
export function messageFingerprint(m: {
  content?: string;
  embeds?: Array<{ title?: string; description?: string }>;
}): string {
  const e = m.embeds?.[0];
  return JSON.stringify([m.content ?? '', e?.title ?? '', e?.description ?? '', m.embeds?.length ?? 0]);
}
