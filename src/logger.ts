/**
 * A deliberately small structured logger: one JSON object per line on stdout.
 *
 * Redaction happens here, at the last moment, rather than at call sites,
 * because a secret that reaches a log line through an error message or a
 * nested object is just as leaked as one logged on purpose.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const SENSITIVE_KEY = /(token|secret|password|authorization|cookie|api[_-]?key|credential)/i;
// Discord bot tokens: base64 user id, timestamp, HMAC.
const DISCORD_TOKEN_RE = /[A-Za-z0-9_-]{23,28}\.[A-Za-z0-9_-]{6,7}\.[A-Za-z0-9_-]{27,}/g;
const BEARER_RE = /(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi;

const knownSecrets = new Set<string>();

/** Register a secret value so it is scrubbed from every log line and client-facing error. */
export function registerSecret(value: string | undefined): void {
  if (value && value.length >= 8) knownSecrets.add(value);
}

export function redactText(text: string): string {
  let out = text;
  for (const secret of knownSecrets) {
    if (out.includes(secret)) out = out.split(secret).join('[redacted]');
  }
  return out.replace(DISCORD_TOKEN_RE, '[redacted]').replace(BEARER_RE, '$1[redacted]');
}

export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[truncated]';
  if (typeof value === 'string') return redactText(value);
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactText(value.message),
      stack: value.stack ? redactText(value.stack) : undefined,
    };
  }
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY.test(k) && typeof v === 'string' ? '[redacted]' : redactValue(v, depth + 1);
    }
    return out;
  }
  return value;
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

export interface LoggerOptions {
  level?: LogLevel;
  write?: (line: string) => void;
  bindings?: Record<string, unknown>;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const threshold = LEVELS[options.level ?? 'info'];
  const write = options.write ?? ((line: string) => process.stdout.write(line + '\n'));
  const bindings = options.bindings ?? {};

  const emit = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => {
    if (LEVELS[level] < threshold) return;
    const record = redactValue({ time: new Date().toISOString(), level, msg, ...bindings, ...fields });
    let line: string;
    try {
      line = JSON.stringify(record);
    } catch {
      line = JSON.stringify({
        time: new Date().toISOString(),
        level,
        msg: redactText(msg),
        note: 'unserialisable fields',
      });
    }
    write(line);
  };

  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    child: (b) => createLogger({ ...options, bindings: { ...bindings, ...b } }),
  };
}

/** A logger that drops everything; handy in tests. */
export const silentLogger: Logger = createLogger({ write: () => {} });
