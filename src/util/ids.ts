import { randomBytes } from 'node:crypto';

/**
 * Short, sortable-enough identifiers for plans and operations. They appear in
 * Discord audit-log reasons (512 character limit) and message nonces (25
 * character limit), so they are kept well under both.
 */
export function newId(prefix: 'op' | 'pln' | 'run' | 'call' | 'rp'): string {
  const time = Date.now().toString(36);
  const rand = randomBytes(5).toString('hex');
  return `${prefix}_${time}${rand}`;
}

const DISCORD_EPOCH = 1420070400000n;

/** Creation time encoded in a Discord snowflake, in ms since the Unix epoch. */
export function snowflakeTime(id: string): number {
  try {
    return Number((BigInt(id) >> 22n) + DISCORD_EPOCH);
  } catch {
    return 0;
  }
}

export const SNOWFLAKE_RE = /^\d{17,20}$/;

export function isSnowflake(value: unknown): value is string {
  return typeof value === 'string' && SNOWFLAKE_RE.test(value);
}
