import { z } from 'zod';
import { botChannelPermissions, botStanding, has, P } from '../../discord/permissions.js';
import type {
  GuildSnapshot,
  RecurrenceRule,
  ScheduledEventInfo,
  ScheduledEventWriteBody,
} from '../../discord/types.js';
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

const TYPES = { stage: 1, voice: 2, external: 3 } as const;
const TYPE_NAMES = ['', 'stage', 'voice', 'external'];
const STATUSES = { scheduled: 1, active: 2, completed: 3, canceled: 4 } as const;
const STATUS_NAMES = ['', 'scheduled', 'active', 'completed', 'canceled'];
/** Discord only lets an event move forward: scheduled → active or canceled, active → completed. */
const NEXT_STATUS: Record<number, number[]> = { 1: [2, 4], 2: [3] };

const REPEATS = ['daily', 'weekdays', 'weekly', 'every_other_week', 'monthly', 'yearly'] as const;
type Repeat = (typeof REPEATS)[number];
const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

/**
 * Discord's recurrence rules, which accept only the patterns its client offers,
 * all anchored on the start time (UTC). Weekdays run 0 = Monday to 6 = Sunday.
 */
export function recurrenceFor(repeat: Repeat, start: string): RecurrenceRule {
  const d = new Date(start);
  const day = (d.getUTCDay() + 6) % 7;
  const base = { start, by_weekday: null, by_n_weekday: null, by_month: null, by_month_day: null };
  switch (repeat) {
    case 'daily':
      return { ...base, frequency: 3, interval: 1 };
    case 'weekdays':
      return { ...base, frequency: 3, interval: 1, by_weekday: [0, 1, 2, 3, 4] };
    case 'weekly':
      return { ...base, frequency: 2, interval: 1, by_weekday: [day] };
    case 'every_other_week':
      return { ...base, frequency: 2, interval: 2, by_weekday: [day] };
    case 'monthly':
      return {
        ...base,
        frequency: 1,
        interval: 1,
        by_n_weekday: [{ n: Math.ceil(d.getUTCDate() / 7), day }],
      };
    case 'yearly':
      return {
        ...base,
        frequency: 0,
        interval: 1,
        by_month: [d.getUTCMonth() + 1],
        by_month_day: [d.getUTCDate()],
      };
  }
}

function describeRecurrence(r: RecurrenceRule | null): string | null {
  if (!r) return null;
  const days = (r.by_weekday ?? []).map((d) => WEEKDAYS[d]).join(', ');
  if (r.frequency === 3) return days ? `daily on ${days}` : 'daily';
  if (r.frequency === 2) return `every ${r.interval === 2 ? 'other ' : ''}week on ${days}`;
  if (r.frequency === 1) {
    const n = r.by_n_weekday?.[0];
    return n
      ? `monthly on the ${['', '1st', '2nd', '3rd', '4th', '5th'][n.n]} ${WEEKDAYS[n.day]}`
      : 'monthly';
  }
  return `yearly on ${r.by_month?.[0]}/${r.by_month_day?.[0]}`;
}

function requireEventPerm(s: GuildSnapshot, creatorId: string | null | undefined, creating: boolean) {
  const perms = botStanding(s).permissions;
  if (creating) {
    if (!has(perms, P.CreateEvents))
      throw new StewardError('precondition_failed', 'the bot lacks Create Events');
    return;
  }
  if (has(perms, P.ManageEvents)) return;
  if (creatorId === s.botMember.userId && has(perms, P.CreateEvents)) return;
  throw new StewardError(
    'precondition_failed',
    'the bot lacks Manage Events (Create Events only covers events the bot made)',
  );
}

function eventOut(guildId: string, e: ScheduledEventInfo) {
  return {
    id: e.id,
    name: e.name,
    description: untrusted(e.description),
    type: TYPE_NAMES[e.entityType] ?? 'unknown',
    channel_id: e.channelId,
    location: untrusted(e.location),
    start_time: e.startTime,
    end_time: e.endTime,
    status: STATUS_NAMES[e.status] ?? 'unknown',
    repeats: describeRecurrence(e.recurrence),
    interested: e.userCount,
    cover: cdnUrl(`guild-events/${e.id}`, e.image),
    link: `https://discord.com/events/${guildId}/${e.id}`,
  };
}

export const eventTools = [
  defineTool({
    name: 'list_scheduled_events',
    title: 'List scheduled events',
    description:
      "The server's scheduled events with their type, times, status, repeat pattern and interest count.",
    scope: 'read',
    input: z.object({ guild_id: guildIdInput }),
    guildOf: (a) => a.guild_id,
    handler: async ({ guild_id }, call) => {
      await snapshotOf(call, guild_id);
      const events = await call.app.adapter.fetchScheduledEvents(guild_id);
      return { guild_id, events: events.map((e) => eventOut(guild_id, e)) };
    },
  }),

  defineTool({
    name: 'upsert_scheduled_event',
    title: 'Create or edit a scheduled event',
    description:
      'Create a scheduled event, or edit one with event_id. type external needs location and end_time; voice and stage need channel_id. repeat makes it recur on the pattern of start_time (UTC). On an edit, status moves it forward: scheduled → active or canceled, active → completed. Needs Create Events, or Manage Events for events the bot did not make.',
    scope: 'write',
    input: z.object({
      guild_id: guildIdInput,
      event_id: snowflake.optional().describe('Edit this event; leave out to create one.'),
      name: z.string().min(1).max(100).optional(),
      description: z.string().max(1000).nullable().optional(),
      type: z.enum(['stage', 'voice', 'external']).optional(),
      channel_id: snowflake.nullable().optional(),
      location: z.string().min(1).max(100).optional().describe('Where an external event happens.'),
      start_time: z
        .string()
        .datetime({ offset: true })
        .optional()
        .describe('ISO 8601, e.g. 2026-11-01T18:00:00Z.'),
      end_time: z.string().datetime({ offset: true }).nullable().optional(),
      cover_image: mediaInput.nullable().optional().describe('png, jpeg or webp; 800x320 works best.'),
      repeat: z.enum(REPEATS).nullable().optional().describe('null stops it repeating.'),
      status: z.enum(['active', 'completed', 'canceled']).optional().describe('Edits only.'),
      reason: reasonInput,
    }),
    guildOf: (a) => a.guild_id,
    handler: async (a, call) => {
      const s = await snapshotOf(call, a.guild_id);
      const { adapter } = call.app;
      const current = a.event_id
        ? requireFound(
            (await adapter.fetchScheduledEvents(a.guild_id)).find((e) => e.id === a.event_id),
            `event ${a.event_id}`,
          )
        : null;
      requireEventPerm(s, current?.creatorId, !current);
      if (!current) {
        if (!a.name || !a.type || !a.start_time)
          throw new StewardError('invalid_argument', 'a new event needs name, type and start_time');
        if (a.status) throw new StewardError('invalid_argument', 'status applies to existing events only');
      }

      // The event as it will be, to check the rules that tie fields together.
      const type = a.type ? TYPES[a.type] : current!.entityType;
      const channelId =
        a.channel_id !== undefined ? a.channel_id : type === 3 ? null : (current?.channelId ?? null);
      const location = a.location ?? (type === 3 ? current?.location : null) ?? null;
      const start = a.start_time ?? current!.startTime;
      const end = a.end_time !== undefined ? a.end_time : (current?.endTime ?? null);
      if (type === 3) {
        if (channelId)
          throw new StewardError('invalid_argument', 'an external event takes location, not channel_id');
        if (!location) throw new StewardError('invalid_argument', 'an external event needs location');
        if (!end) throw new StewardError('invalid_argument', 'an external event needs end_time');
      } else {
        if (a.location) throw new StewardError('invalid_argument', 'location is for external events only');
        const ch = requireFound(
          s.channels.find((c) => c.id === channelId),
          channelId ? `channel ${channelId}` : 'channel_id',
        );
        const want = type === 1 ? 'stage' : 'voice';
        if (ch.kind !== want)
          throw new StewardError('invalid_argument', `a ${want} event needs a ${want} channel`);
        const needs =
          type === 1 ? P.ManageChannels | P.MuteMembers | P.MoveMembers : P.ViewChannel | P.Connect;
        if (!has(botChannelPermissions(s, ch), needs))
          throw new StewardError(
            'precondition_failed',
            type === 1
              ? `stage events need Manage Channels, Mute Members and Move Members in #${ch.name}`
              : `voice events need View Channel and Connect in #${ch.name}`,
          );
      }
      if (a.start_time && Date.parse(a.start_time) <= Date.now())
        throw new StewardError('invalid_argument', 'start_time must be in the future');
      if (end && Date.parse(end) <= Date.parse(start))
        throw new StewardError('invalid_argument', 'end_time must be after start_time');

      const body: ScheduledEventWriteBody = {};
      if (a.name !== undefined) body.name = a.name;
      if (a.description !== undefined) body.description = a.description;
      if (a.type !== undefined || !current) {
        body.entity_type = type;
        body.channel_id = channelId;
        body.entity_metadata = type === 3 ? { location: location! } : null;
      } else {
        if (a.channel_id !== undefined) body.channel_id = channelId;
        if (a.location !== undefined) body.entity_metadata = { location: a.location };
      }
      if (a.start_time !== undefined) body.scheduled_start_time = a.start_time;
      if (a.end_time !== undefined || (!current && end)) body.scheduled_end_time = end;
      if (a.cover_image !== undefined)
        body.image = a.cover_image && (await loadMedia(a.cover_image, 'event_cover')).dataUri;
      if (a.repeat !== undefined) body.recurrence_rule = a.repeat && recurrenceFor(a.repeat, start);
      else if (a.start_time && current?.recurrence)
        throw new StewardError(
          'invalid_argument',
          'this event repeats; pass repeat again (or null) when moving its start_time',
        );
      if (a.status) {
        const to = STATUSES[a.status];
        if (!NEXT_STATUS[current!.status]?.includes(to))
          throw new StewardError(
            'invalid_argument',
            `an event that is ${STATUS_NAMES[current!.status]} cannot become ${a.status}`,
          );
        body.status = to;
      }

      if (current) {
        if (Object.keys(body).length === 0) throw new StewardError('invalid_argument', 'nothing to change');
        const out = await mutate(call, a.guild_id, a.reason, {
          action: 'upsert_scheduled_event',
          resourceKind: 'scheduled_event',
          targetId: current.id,
          summary: `edit event ${current.name}: ${Object.keys(body).join(', ')}`,
          idempotent: true,
          run: (reason) => adapter.editScheduledEvent(a.guild_id, current.id, body, reason),
        });
        return { op_id: out.opId, event_id: current.id, created: false, changed: Object.keys(body) };
      }
      body.privacy_level = 2;
      const out = await mutate(call, a.guild_id, a.reason, {
        action: 'upsert_scheduled_event',
        resourceKind: 'scheduled_event',
        resourceKey: a.name,
        summary: `create event ${a.name} at ${start}`,
        idempotent: false,
        run: (reason) => adapter.createScheduledEvent(a.guild_id, body, reason),
        resultId: (e) => e.id,
      });
      const id =
        out.status === 'succeeded' ? out.result.id : out.status === 'recovered' ? out.recoveredId : null;
      return {
        op_id: out.opId,
        event_id: id,
        created: true,
        link: id ? `https://discord.com/events/${a.guild_id}/${id}` : null,
        repeats: describeRecurrence(body.recurrence_rule ?? null),
      };
    },
  }),

  defineTool({
    name: 'delete_scheduled_event',
    title: 'Delete a scheduled event',
    description:
      "Permanently delete a scheduled event. To call it off but keep it visible, set status canceled with upsert_scheduled_event instead. confirm_name must equal the event's name.",
    scope: 'destructive',
    input: z.object({
      guild_id: guildIdInput,
      event_id: snowflake,
      confirm_name: z.string().min(1).max(100),
      reason: reasonInput,
    }),
    guildOf: (a) => a.guild_id,
    handler: async (a, call) => {
      const s = await snapshotOf(call, a.guild_id);
      const { adapter } = call.app;
      const e = requireFound(
        (await adapter.fetchScheduledEvents(a.guild_id)).find((x) => x.id === a.event_id),
        `event ${a.event_id}`,
      );
      if (e.name !== a.confirm_name)
        throw new StewardError(
          'precondition_failed',
          `confirm_name "${a.confirm_name}" does not match the event's name "${e.name}"`,
        );
      requireEventPerm(s, e.creatorId, false);
      const out = await mutate(call, a.guild_id, a.reason, {
        action: 'delete_scheduled_event',
        resourceKind: 'scheduled_event',
        targetId: e.id,
        summary: `delete event ${e.name}`,
        idempotent: true,
        notFoundIsSuccess: true,
        run: (reason) => adapter.deleteScheduledEvent(a.guild_id, e.id, reason),
      });
      return { op_id: out.opId, deleted: e.id, name: e.name };
    },
  }),
];
