import { expect, test } from 'vitest';
import { createLogger, redactText, registerSecret } from '../src/logger.js';
import { errorPayload, StewardError } from '../src/util/errors.js';

test('secrets never reach log lines, nested or not', () => {
  const lines: string[] = [];
  const log = createLogger({ write: (l) => lines.push(l) });
  registerSecret('super-secret-mcp-token-value-1234567890');
  const discordLike = 'MTIzNDU2Nzg5MDEyMzQ1Njc4OQ.GaBcDe.abcdefghijklmnopqrstuvwxyz0123456789AB';
  log.info('connecting with super-secret-mcp-token-value-1234567890', {
    headers: { authorization: 'Bearer abcdef' },
    nested: { message: `token was ${discordLike}` },
    error: new Error('failed: Bearer xyz123'),
    apiKey: 'plain',
  });
  const out = lines.join('\n');
  expect(out).not.toContain('super-secret-mcp-token-value');
  expect(out).not.toContain(discordLike);
  expect(out).not.toContain('abcdef');
  expect(out).not.toContain('xyz123');
  expect(out).not.toContain('plain');
  expect(JSON.parse(lines[0]!).msg).toBe('connecting with [redacted]');
});

test('client-facing errors are redacted too, and internal errors are opaque', () => {
  registerSecret('another-secret-value-abcdefghijkl');
  expect(
    errorPayload(new StewardError('invalid_argument', 'bad another-secret-value-abcdefghijkl')).message,
  ).toBe('bad [redacted]');
  expect(errorPayload(new Error('stack details')).message).toBe('internal error; see server logs');
  expect(redactText('Authorization: Bearer abc.def')).toBe('Authorization: Bearer [redacted]');
});

test('log level filters', () => {
  const lines: string[] = [];
  const log = createLogger({ level: 'warn', write: (l) => lines.push(l) });
  log.info('hidden');
  log.warn('shown');
  expect(lines).toHaveLength(1);
});
