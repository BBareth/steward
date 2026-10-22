import { describe, expect, test } from 'vitest';
import {
  normaliseAutoModRule,
  normaliseChannel,
  normaliseGuild,
  normaliseRole,
} from '../src/discord/normalize.js';
import { toRequestError, truncateReason } from '../src/discord/discordjs-adapter.js';
import { auditReason } from '../src/ops/journal.js';
import { newId } from '../src/util/ids.js';
import { DiscordAPIError, HTTPError } from 'discord.js';
import { channelPositionUpdates, slotFill } from '../src/ops/ordering.js';
import { buildMessageBody, escapeUserText, renderTemplate } from '../src/features/messages.js';
import { expandAccess } from '../src/features/access.js';
import { P } from '../src/discord/permissions.js';
import type { ChannelInfo } from '../src/discord/types.js';
import { slugify } from '../src/blueprint/export.js';
import { hostnamesOnly } from '../src/http/server.js';
import { Authenticator } from '../src/http/auth.js';
import { normaliseScopes } from '../src/config.js';
import { sha256 } from '../src/util/hash.js';

describe('normalising Discord payloads', () => {
  test('channels, roles, guilds and AutoMod rules', () => {
    const ch = normaliseChannel({
      id: '1',
      type: 0,
      name: 'general',
      guild_id: '9',
      position: 3,
      parent_id: '2',
      topic: null,
      nsfw: false,
      rate_limit_per_user: 5,
      permission_overwrites: [{ id: '9', type: 0, allow: '0', deny: '1024' }],
    } as never);
    expect(ch).toMatchObject({
      kind: 'text',
      parentId: '2',
      rateLimitPerUser: 5,
      overwrites: [{ id: '9', type: 'role', deny: 1024n }],
    });
    const role = normaliseRole({
      id: '3',
      name: 'Booster',
      color: 0,
      hoist: false,
      mentionable: false,
      managed: true,
      position: 4,
      permissions: '0',
      tags: { premium_subscriber: null },
    } as never);
    expect(role.tags).toMatchObject({ premiumSubscriber: true, availableForPurchase: false });
    const guild = normaliseGuild({
      id: '9',
      name: 'G',
      owner_id: '1',
      features: ['COMMUNITY'],
      verification_level: 2,
      default_message_notifications: 1,
      explicit_content_filter: 2,
      mfa_level: 0,
      nsfw_level: 0,
      preferred_locale: 'en-US',
      afk_timeout: 300,
      system_channel_flags: 0,
      premium_progress_bar_enabled: false,
      premium_tier: 1,
      roles: [],
    } as never);
    expect(guild).toMatchObject({
      verificationLevel: 2,
      features: ['COMMUNITY'],
      afkChannelId: null,
      approximateMemberCount: null,
    });
    const rule = normaliseAutoModRule({
      id: '5',
      guild_id: '9',
      name: 'r',
      creator_id: '1',
      event_type: 1,
      trigger_type: 1,
      trigger_metadata: { keyword_filter: ['x'] },
      actions: [{ type: 1, metadata: { custom_message: null } }],
      enabled: true,
      exempt_roles: [],
      exempt_channels: [],
    } as never);
    expect(rule.triggerMetadata).toEqual({ keyword_filter: ['x'] });
    expect(rule.actions[0]!.metadata).toEqual({});
  });

  test('discord.js failures map onto certain and uncertain outcomes', () => {
    const missing = toRequestError(
      new DiscordAPIError({ code: 50013, message: 'Missing Permissions' }, 50013, 403, 'POST', '/x', {}),
    );
    expect(missing).toMatchObject({ kind: 'http', status: 403, code: 50013, uncertain: false });
    expect(toRequestError(new HTTPError(502, 'Bad Gateway', 'POST', '/x', {}))).toMatchObject({
      kind: 'server',
      uncertain: true,
    });
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    expect(toRequestError(abort)).toMatchObject({ kind: 'timeout', uncertain: true });
    expect(toRequestError(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }))).toMatchObject(
      { kind: 'network', uncertain: true },
    );
  });
});

describe('audit-log reasons', () => {
  const opId = newId('op');
  const planId = newId('pln');
  const reason = (userReason: string) =>
    auditReason(opId, { planId, userReason }, 'create channel #général in Events');
  const encoded = (s: string) => encodeURIComponent(s).length;

  test('short reasons pass through unchanged', () => {
    const r = reason('tidy up');
    expect(truncateReason(r)).toBe(r);
  });

  test('cuts on encoded length and whole code points, keeping the operation ID', () => {
    for (const filler of ['x', 'a b ', '🎉', '漢字かな', 'é🎉 ']) {
      const r = reason(filler.repeat(600));
      const t = truncateReason(r);
      const kept = t.slice(0, -3);
      expect(t.endsWith('...')).toBe(true);
      expect(encoded(t)).toBeLessThanOrEqual(512);
      // Filled to within one code point (at most 12 encoded) of the limit.
      expect(encoded(t)).toBeGreaterThan(500);
      expect(r.startsWith(kept)).toBe(true);
      expect([...filler]).toContain([...kept].at(-1));
      expect(t.startsWith(`steward ${opId} ${planId}: `)).toBe(true);
    }
  });

  test('spaces count three times', () => {
    const r = reason('please '.repeat(50));
    expect(r.length).toBeLessThan(500);
    expect(encoded(r)).toBeGreaterThan(512);
    expect(encoded(truncateReason(r))).toBeLessThanOrEqual(512);
  });

  test('a reason exactly at the limit is kept whole', () => {
    const fixed = encoded(reason('x')) - 1;
    const atLimit = reason('x'.repeat(512 - fixed));
    expect(encoded(atLimit)).toBe(512);
    expect(truncateReason(atLimit)).toBe(atLimit);
    const emojiAtLimit = reason(`${'x'.repeat(512 - fixed - 12)}🎉`);
    expect(encoded(emojiAtLimit)).toBe(512);
    expect(truncateReason(emojiAtLimit)).toBe(emojiAtLimit);

    const over = reason('x'.repeat(513 - fixed));
    const t = truncateReason(over);
    expect(encoded(t)).toBe(512);
    expect(t).toBe(`${over.slice(0, -4)}...`);
  });

  test('lone surrogates are replaced instead of throwing', () => {
    expect(truncateReason(reason('a\uD83Cb'))).toBe(reason('a\uFFFDb'));
  });
});

describe('ordering', () => {
  test('slot fill keeps unmanaged items in place', () => {
    expect(slotFill(['a', 'x', 'b', 'y', 'c'], ['c', 'a', 'b'])).toEqual(['c', 'x', 'a', 'y', 'b']);
    expect(slotFill(['a', 'b'], ['b', 'a', 'missing'])).toEqual(['b', 'a']);
  });

  test('channel positions reuse existing slots when they are unique, renumber when not', () => {
    const ch = (id: string, position: number) => ({ id, position }) as ChannelInfo;
    expect(
      channelPositionUpdates(
        [ch('100000000000000001', 0), ch('100000000000000002', 5), ch('100000000000000003', 9)],
        ['100000000000000003', '100000000000000001'],
      ),
    ).toEqual([
      { id: '100000000000000003', position: 0 },
      { id: '100000000000000001', position: 9 },
    ]);
    const dup = channelPositionUpdates(
      [ch('100000000000000001', 0), ch('100000000000000002', 0)],
      ['100000000000000002', '100000000000000001'],
    );
    expect(dup).toEqual([{ id: '100000000000000001', position: 1 }]);
  });
});

describe('messages and presets', () => {
  test('mentions are locked down unless listed', () => {
    expect(buildMessageBody({ content: '@everyone hi' }).allowed_mentions).toEqual({ parse: [] });
    expect(buildMessageBody({ content: 'x' }, { everyone: true }).allowed_mentions.parse).toEqual([
      'everyone',
    ]);
    expect(() => buildMessageBody({})).toThrow(/needs content or at least one embed/);
    expect(buildMessageBody({ embeds: [{ title: 'T', color: '#ff0000' }] }).embeds![0]!.color).toBe(0xff0000);
  });

  test('user-controlled text in welcome templates is escaped', () => {
    const out = renderTemplate('Hi {user} ({username}) to {server}', {
      userId: '1',
      username: '**x** @everyone <@&2>',
      serverName: 'S_1',
      memberCount: 3,
    });
    expect(out).toBe('Hi <@1> (\\*\\*x\\*\\* @\u200beveryone <\u200b@\u200b&2\\>) to S\\_1');
    expect(out).not.toMatch(/<@&2>|@everyone/);
    expect(escapeUserText('`code`')).toBe('\\`code\\`');
  });

  test('access presets', () => {
    const [everyone, mod] = expandAccess(
      { private: true, visible_to: ['mod'], read_only: true, writers: ['mod'] },
      'text',
    );
    expect(everyone).toMatchObject({
      target: 'everyone',
      deny:
        P.ViewChannel |
        P.SendMessages |
        P.SendMessagesInThreads |
        P.CreatePublicThreads |
        P.CreatePrivateThreads,
    });
    expect(mod!.allow & (P.ViewChannel | P.SendMessages)).toBe(P.ViewChannel | P.SendMessages);
    const [v] = expandAccess({ private: true }, 'voice');
    expect(v!.deny).toBe(P.ViewChannel);
  });
});

describe('small helpers', () => {
  test('slugify produces valid keys', () => {
    expect(slugify('Événements & Fun!', 'x')).toBe('evenements-fun');
    expect(slugify('🎉', 'channel-123')).toBe('channel-123');
  });

  test('allowed hosts drop ports for the SDK guards', () => {
    expect(hostnamesOnly(['NAS.lan:8787', '[::1]:8787', '192.168.1.5'])).toEqual([
      'nas.lan',
      '[::1]',
      '192.168.1.5',
    ]);
  });

  test('authenticator matches by hash and ignores malformed headers', () => {
    const a = new Authenticator([
      { name: 'n', sha256: sha256('t'.repeat(40)), scopes: normaliseScopes(['read']), guilds: null },
    ]);
    expect(a.verify(`Bearer ${'t'.repeat(40)}`)?.clientId).toBe('n');
    expect(a.verify(`bearer ${'t'.repeat(40)}`)?.clientId).toBe('n');
    expect(a.verify(`Basic ${'t'.repeat(40)}`)).toBeNull();
    expect(a.verify(`Bearer ${'t'.repeat(39)}`)).toBeNull();
  });
});
