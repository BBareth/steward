import { z } from 'zod';
import type { GuildSnapshot } from '../../discord/types.js';
import type { OpOutcome, OpSpec } from '../../ops/journal.js';
import { runOperation } from '../../ops/journal.js';
import { StewardError } from '../../util/errors.js';
import type { CallContext } from '../registry.js';

export const snowflake = z.string().regex(/^\d{17,20}$/, 'must be a Discord ID (17-20 digits)');
export const guildIdInput = snowflake.describe(
  'Discord server (guild) ID. Must be one of the configured guilds.',
);
export const reasonInput = z
  .string()
  .max(300)
  .optional()
  .describe('Short reason, recorded in the Discord audit log.');
export const limitInput = z.number().int().min(1).max(200).default(50).describe('Page size (max 200).');
export const cursorInput = z
  .string()
  .regex(/^\d+$/)
  .optional()
  .describe('Pagination cursor from a previous next_cursor.');
export const permissionNamesInput = z
  .array(z.string().min(1).max(64))
  .max(64)
  .describe(
    'Permission names such as ViewChannel, SendMessages, ManageMessages (PascalCase or SCREAMING_SNAKE_CASE).',
  );

export function paginate<T>(items: T[], limit: number, cursor?: string) {
  const offset = cursor ? Number(cursor) : 0;
  const page = items.slice(offset, offset + limit);
  const next = offset + limit < items.length ? String(offset + limit) : null;
  return { total: items.length, items: page, next_cursor: next };
}

export async function snapshotOf(call: CallContext, guildId: string): Promise<GuildSnapshot> {
  call.assertGuild(guildId);
  return call.app.adapter.fetchSnapshot(guildId);
}

/** Wrap text that came from Discord users so it reads as data, not instructions. */
export function untrusted(
  text: string | null | undefined,
  max = 1000,
): { untrusted_text: string; truncated?: true } | null {
  if (!text) return null;
  return text.length > max
    ? { untrusted_text: text.slice(0, max), truncated: true }
    : { untrusted_text: text };
}

/** Run one Discord mutation under the guild lock, journaled. */
export async function mutate<T>(
  call: CallContext,
  guildId: string,
  reason: string | undefined,
  spec: OpSpec<T>,
): Promise<OpOutcome<T>> {
  const release = await call.app.locks.acquire(guildId, `${call.tool} (${call.caller.clientId})`);
  try {
    return await runOperation(
      {
        store: call.app.store,
        adapter: call.app.adapter,
        logger: call.app.logger,
        guildId,
        planId: null,
        stepId: null,
        tool: call.tool,
        clientId: call.caller.clientId,
        userReason: reason,
        backoffMs: call.app.backoffMs,
      },
      spec,
    );
  } finally {
    release();
  }
}

/** Hold the guild lock across several mutations. */
export async function withGuildLock<T>(call: CallContext, guildId: string, fn: () => Promise<T>): Promise<T> {
  const release = await call.app.locks.acquire(guildId, `${call.tool} (${call.caller.clientId})`);
  try {
    return await fn();
  } finally {
    release();
  }
}

export function opContext(call: CallContext, guildId: string, reason?: string) {
  return {
    store: call.app.store,
    adapter: call.app.adapter,
    logger: call.app.logger,
    guildId,
    planId: null,
    stepId: null,
    tool: call.tool,
    clientId: call.caller.clientId,
    userReason: reason,
    backoffMs: call.app.backoffMs,
  };
}

export function idOf<T>(out: OpOutcome<T>, pick: (r: T) => string): string {
  if (out.status === 'recovered') return out.recoveredId;
  if (out.status === 'succeeded') return pick(out.result);
  throw new StewardError('internal', 'operation returned nothing');
}

export function requireFound<T>(value: T | undefined | null, what: string): T {
  if (value === undefined || value === null)
    throw new StewardError('not_found', `${what} not found in this server`);
  return value;
}
