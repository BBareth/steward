import { randomBytes } from 'node:crypto';

/**
 * Short, sortable-enough identifiers for plans and operations. They appear in
 * Discord audit-log reasons (512 character limit) and message nonces (25
 * character limit), so they are kept well under both.
 */
export function newId(prefix: 'op' | 'pln' | 'run' | 'call' | 'rp' | 'prompt'): string {
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

let snowflakeSeq = 0;

/**
 * A fresh snowflake for ids Discord lets the client choose, such as new
 * onboarding prompts and options.
 */
export function newSnowflake(): string {
  snowflakeSeq = (snowflakeSeq + 1) & 0xfff;
  const worker = BigInt(randomBytes(2).readUInt16BE() & 0x3ff);
  return (((BigInt(Date.now()) - DISCORD_EPOCH) << 22n) | (worker << 12n) | BigInt(snowflakeSeq)).toString();
}
