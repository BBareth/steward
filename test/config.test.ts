import { describe, expect, test } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';
import { sha256 } from '../src/util/hash.js';
import { VERSION } from '../src/version.js';
import pkg from '../package.json' with { type: 'json' };

const GUILD = '123456789012345678';
const TOKEN = 'a'.repeat(40);
const base = { DISCORD_TOKEN: 'discord-token-value', DISCORD_GUILD_IDS: GUILD, MCP_AUTH_TOKEN: TOKEN };

function problems(env: Record<string, string>, files: Record<string, string> = {}): string[] {
  try {
    loadConfig(env, (p) => {
      if (!(p in files)) throw new Error('ENOENT');
      return files[p]!;
    });
    return [];
  } catch (e) {
    if (e instanceof ConfigError) return e.problems;
    throw e;
  }
}

describe('configuration', () => {
  test('refuses to start without an MCP credential', () => {
    const p = problems({ DISCORD_TOKEN: 'x', DISCORD_GUILD_IDS: GUILD });
    expect(p.join('\n')).toMatch(/no MCP credential configured/);
  });

  test('refuses a short MCP token and one equal to the Discord token', () => {
    expect(problems({ ...base, MCP_AUTH_TOKEN: 'short' }).join()).toMatch(/at least 32 characters/);
    expect(problems({ ...base, DISCORD_TOKEN: TOKEN }).join()).toMatch(/must not be the Discord bot token/);
  });

  test('requires a Discord token and explicit, valid guild IDs', () => {
    const p = problems({ MCP_AUTH_TOKEN: TOKEN, DISCORD_GUILD_IDS: 'abc' });
    expect(p.join('\n')).toMatch(/DISCORD_TOKEN .* is required/);
    expect(p.join('\n')).toMatch(/"abc", which is not a Discord ID/);
    expect(problems({ DISCORD_TOKEN: 'x', MCP_AUTH_TOKEN: TOKEN }).join()).toMatch(
      /DISCORD_GUILD_IDS is required/,
    );
  });

  test('defaults are safe: localhost only, destructive tools off, members intent off', () => {
    const c = loadConfig(base);
    expect(c.allowedHosts).toEqual(['localhost', '127.0.0.1', '[::1]']);
    expect(c.allowDestructive).toBe(false);
    expect(c.readOnly).toBe(false);
    expect(c.membersIntent).toBe(false);
    expect(c.reactionGuard).toBe(false);
    expect(loadConfig({ ...base, DISCORD_BOT_REACTION_GUARD: 'true' }).reactionGuard).toBe(true);
    expect(c.credentials).toHaveLength(1);
    expect(c.credentials[0]!.sha256).toBe(sha256(TOKEN));
    expect([...c.credentials[0]!.scopes].sort()).toEqual(['destructive', 'read', 'write']);
  });

  test('reads secrets from *_FILE and rejects setting both forms', () => {
    const c = loadConfig(
      {
        DISCORD_TOKEN_FILE: '/run/secrets/d',
        DISCORD_GUILD_IDS: GUILD,
        MCP_AUTH_TOKEN_FILE: '/run/secrets/m',
      },
      (p) => (p === '/run/secrets/d' ? 'discord\n' : `${TOKEN}\n`),
    );
    expect(c.discordToken).toBe('discord');
    expect(problems({ ...base, MCP_AUTH_TOKEN_FILE: '/x' }, { '/x': TOKEN }).join()).toMatch(/not both/);
  });

  test('loads scoped, guild-limited credentials from a tokens file', () => {
    const file = JSON.stringify({
      tokens: [{ name: 'codex-ro', sha256: sha256('b'.repeat(40)), scopes: ['read'], guilds: [GUILD] }],
    });
    const c = loadConfig(
      { DISCORD_TOKEN: 'x', DISCORD_GUILD_IDS: GUILD, MCP_TOKENS_FILE: '/t.json' },
      () => file,
    );
    expect(c.credentials[0]).toMatchObject({ name: 'codex-ro', guilds: [GUILD] });
    expect([...c.credentials[0]!.scopes]).toEqual(['read']);
    const bad = JSON.stringify({
      tokens: [{ name: 'x', sha256: 'nothex', scopes: ['read'], guilds: ['999999999999999999'] }],
    });
    expect(
      problems(
        { DISCORD_TOKEN: 'x', DISCORD_GUILD_IDS: GUILD, MCP_TOKENS_FILE: '/t.json' },
        { '/t.json': bad },
      ).join(),
    ).toMatch(/malformed/);
  });

  test('write scope implies read; destructive implies write', () => {
    const c = loadConfig({ ...base, MCP_AUTH_TOKEN_SCOPES: 'destructive' });
    expect([...c.credentials[0]!.scopes].sort()).toEqual(['destructive', 'read', 'write']);
  });

  test('version constant matches package.json', () => {
    expect(VERSION).toBe(pkg.version);
  });
});
