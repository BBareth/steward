import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { LogLevel } from './logger.js';
import { registerSecret } from './logger.js';
import { sha256 } from './util/hash.js';
import { SNOWFLAKE_RE } from './util/ids.js';

export const SCOPES = ['read', 'write', 'destructive'] as const;
export type Scope = (typeof SCOPES)[number];

export interface Credential {
  /** Shown in logs and history so you can tell clients apart. Never the token. */
  name: string;
  /** SHA-256 of the token, hex. The plaintext token is not kept in memory beyond startup. */
  sha256: string;
  scopes: ReadonlySet<Scope>;
  /** Optional narrower guild list for this credential. `null` means every configured guild. */
  guilds: readonly string[] | null;
}

export interface Config {
  discordToken: string;
  guildIds: readonly string[];
  membersIntent: boolean;
  credentials: readonly Credential[];
  allowedHosts: readonly string[];
  allowedOrigins: readonly string[];
  host: string;
  port: number;
  readOnly: boolean;
  allowDestructive: boolean;
  databasePath: string;
  logLevel: LogLevel;
  planTtlMinutes: number;
  applyWaitSeconds: number;
  discordRequestTimeoutMs: number;
}

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`invalid configuration:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ConfigError';
  }
}

export const MIN_TOKEN_LENGTH = 32;

/** Expand implied scopes: destructive needs write, write needs read. */
export function normaliseScopes(scopes: Iterable<string>): Set<Scope> {
  const out = new Set<Scope>();
  for (const s of scopes) {
    if (!(SCOPES as readonly string[]).includes(s)) throw new Error(`unknown scope "${s}"`);
    out.add(s as Scope);
  }
  if (out.has('destructive')) out.add('write');
  if (out.has('write')) out.add('read');
  return out;
}

const tokenFileSchema = z.object({
  tokens: z
    .array(
      z.object({
        name: z.string().min(1).max(64),
        sha256: z.string().regex(/^[a-f0-9]{64}$/, 'must be 64 lowercase hex characters'),
        scopes: z.array(z.enum(SCOPES)).min(1),
        guilds: z.array(z.string().regex(SNOWFLAKE_RE)).optional(),
      }),
    )
    .min(1),
});

type Env = Record<string, string | undefined>;
type FileReader = (path: string) => string;

const defaultReader: FileReader = (path) => readFileSync(path, 'utf8');

/** Read VAR, or the contents of the file named by VAR_FILE (Docker secrets). */
function secretFromEnv(env: Env, name: string, read: FileReader, problems: string[]): string | undefined {
  const direct = env[name]?.trim();
  const file = env[`${name}_FILE`]?.trim();
  if (direct && file) {
    problems.push(`set either ${name} or ${name}_FILE, not both`);
    return undefined;
  }
  if (file) {
    try {
      return read(file).trim() || undefined;
    } catch {
      problems.push(`${name}_FILE points at "${file}", which cannot be read`);
      return undefined;
    }
  }
  return direct || undefined;
}

function bool(env: Env, name: string, fallback: boolean, problems: string[]): boolean {
  const raw = env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === '') return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  problems.push(`${name} must be true or false, got "${env[name]}"`);
  return fallback;
}

function int(env: Env, name: string, fallback: number, min: number, max: number, problems: string[]): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    problems.push(`${name} must be an integer between ${min} and ${max}, got "${raw}"`);
    return fallback;
  }
  return n;
}

function list(env: Env, name: string): string[] {
  return (env[name] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function loadConfig(env: Env = process.env, read: FileReader = defaultReader): Config {
  const problems: string[] = [];

  const discordToken = secretFromEnv(env, 'DISCORD_TOKEN', read, problems);
  registerSecret(discordToken);
  if (!discordToken) problems.push('DISCORD_TOKEN (or DISCORD_TOKEN_FILE) is required');

  const guildIds = list(env, 'DISCORD_GUILD_IDS');
  if (guildIds.length === 0) {
    problems.push(
      'DISCORD_GUILD_IDS is required: a comma-separated list of the server IDs steward may manage',
    );
  }
  for (const id of guildIds) {
    if (!SNOWFLAKE_RE.test(id))
      problems.push(`DISCORD_GUILD_IDS contains "${id}", which is not a Discord ID`);
  }

  const credentials: Credential[] = [];
  const singleToken = secretFromEnv(env, 'MCP_AUTH_TOKEN', read, problems);
  registerSecret(singleToken);
  if (singleToken) {
    if (singleToken.length < MIN_TOKEN_LENGTH) {
      problems.push(
        `MCP_AUTH_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters; generate one with "npm run token"`,
      );
    } else if (discordToken && singleToken === discordToken) {
      problems.push('MCP_AUTH_TOKEN must not be the Discord bot token');
    } else {
      let scopes: Set<Scope> = normaliseScopes(SCOPES);
      const rawScopes = list(env, 'MCP_AUTH_TOKEN_SCOPES');
      if (rawScopes.length > 0) {
        try {
          scopes = normaliseScopes(rawScopes);
        } catch (e) {
          problems.push(`MCP_AUTH_TOKEN_SCOPES: ${(e as Error).message}`);
        }
      }
      credentials.push({ name: 'default', sha256: sha256(singleToken), scopes, guilds: null });
    }
  }

  const tokensFile = env.MCP_TOKENS_FILE?.trim();
  if (tokensFile) {
    try {
      const parsed = tokenFileSchema.safeParse(JSON.parse(read(tokensFile)));
      if (!parsed.success) {
        problems.push(
          `MCP_TOKENS_FILE is malformed: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
        );
      } else {
        for (const t of parsed.data.tokens) {
          if (credentials.some((c) => c.name === t.name))
            problems.push(`duplicate credential name "${t.name}"`);
          if (t.guilds?.some((g) => !guildIds.includes(g))) {
            problems.push(`credential "${t.name}" lists a guild that is not in DISCORD_GUILD_IDS`);
          }
          credentials.push({
            name: t.name,
            sha256: t.sha256,
            scopes: normaliseScopes(t.scopes),
            guilds: t.guilds ?? null,
          });
        }
      }
    } catch {
      problems.push(`MCP_TOKENS_FILE "${tokensFile}" cannot be read or is not valid JSON`);
    }
  }
  if (credentials.length === 0 && !problems.some((p) => p.startsWith('MCP_'))) {
    problems.push(
      'no MCP credential configured: set MCP_AUTH_TOKEN (generate one with "npm run token") or MCP_TOKENS_FILE',
    );
  }

  const allowedHosts = list(env, 'MCP_ALLOWED_HOSTS');
  const hosts = allowedHosts.length > 0 ? allowedHosts : ['localhost', '127.0.0.1', '[::1]'];
  const allowedOrigins = list(env, 'MCP_ALLOWED_ORIGINS');

  const logLevel = (env.LOG_LEVEL?.trim().toLowerCase() || 'info') as LogLevel;
  if (!['debug', 'info', 'warn', 'error'].includes(logLevel)) {
    problems.push(`LOG_LEVEL must be debug, info, warn or error, got "${env.LOG_LEVEL}"`);
  }

  const config: Config = {
    discordToken: discordToken ?? '',
    guildIds,
    membersIntent: bool(env, 'DISCORD_MEMBERS_INTENT', false, problems),
    credentials,
    allowedHosts: hosts,
    allowedOrigins,
    host: env.HOST?.trim() || '0.0.0.0',
    port: int(env, 'PORT', 8787, 1, 65535, problems),
    readOnly: bool(env, 'READ_ONLY', false, problems),
    allowDestructive: bool(env, 'ALLOW_DESTRUCTIVE', false, problems),
    databasePath: env.DATABASE_PATH?.trim() || './data/steward.db',
    logLevel,
    planTtlMinutes: int(env, 'PLAN_TTL_MINUTES', 30, 1, 24 * 60, problems),
    applyWaitSeconds: int(env, 'APPLY_WAIT_SECONDS', 40, 0, 600, problems),
    discordRequestTimeoutMs: int(env, 'DISCORD_REQUEST_TIMEOUT_MS', 15000, 1000, 120000, problems),
  };

  if (problems.length > 0) throw new ConfigError(problems);
  return config;
}
