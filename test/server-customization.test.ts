import { afterEach, describe, expect, test } from 'vitest';
import { P } from '../src/discord/permissions.js';
import { recurrenceFor } from '../src/mcp/tools/events.js';
import { MemoryDiscordAdapter } from './helpers/memory-adapter.js';
import type { Running } from './helpers/server.js';
import { FULL_TOKEN, call, connect, startServer } from './helpers/server.js';

let running: Running | undefined;
afterEach(async () => {
  await running?.close();
  running = undefined;
});

async function setup() {
  running = await startServer();
  const client = await connect(running.url, FULL_TOKEN);
  return { client, d: running.env.adapter, guild_id: running.env.guildId };
}

type Err = { error: { code: string; message: string } };

const PNG = {
  data_uri:
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
};
const GIF = { data_uri: `data:image/gif;base64,${Buffer.from('GIF89a\x01\x00\x01\x00').toString('base64')}` };
const MP3 = { data_uri: `data:audio/mpeg;base64,${Buffer.from('ID3\x03\x00\x00\x00').toString('base64')}` };
const inHours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

function community(d: MemoryDiscordAdapter, count = 7) {
  d.guild.features = ['COMMUNITY'];
  return Array.from({ length: count }, (_, i) => d.addChannel({ name: `chan-${i}` }).id);
}

describe('onboarding', () => {
  test('saves questions with new ids and keeps them on the next save', async () => {
    const { client, d, guild_id } = await setup();
    const channels = community(d);
    const game = d.addRole({ name: 'Word Arcade', position: 2 });
    const news = d.addRole({ name: 'News', position: 3 });
    const r = await call<{ prompts: Array<{ id: string; options: Array<{ id: string }> }> }>(
      client,
      'configure_onboarding',
      {
        guild_id,
        enabled: true,
        default_channel_ids: channels,
        prompts: [
          {
            title: 'Which games do you play?',
            options: [
              { title: 'Word Arcade', emoji: '🧩', role_ids: [game.id], channel_ids: [channels[0]] },
              { title: 'News', emoji: '📣', role_ids: [news.id] },
            ],
          },
        ],
      },
    );
    expect(r.isError).toBe(false);
    const saved = d.onboarding;
    expect(saved.enabled).toBe(true);
    expect(saved.defaultChannelIds).toEqual(channels);
    expect(saved.prompts[0]!.options[0]).toMatchObject({
      roleIds: [game.id],
      emojiName: '🧩',
      emojiId: null,
    });
    expect(saved.prompts[0]!.id).toMatch(/^\d{17,20}$/);
    expect(r.data.prompts[0]!.id).toBe(saved.prompts[0]!.id);

    const [prompt] = r.data.prompts;
    const again = await call(client, 'configure_onboarding', {
      guild_id,
      enabled: true,
      default_channel_ids: channels,
      prompts: [
        {
          id: prompt!.id,
          title: 'Games',
          options: [{ id: prompt!.options[0]!.id, title: 'Word Arcade', role_ids: [game.id] }],
        },
      ],
    });
    expect(again.isError).toBe(false);
    expect(d.onboarding.prompts[0]).toMatchObject({ id: prompt!.id, title: 'Games' });
    expect(d.onboarding.prompts[0]!.options).toHaveLength(1);

    const stranger = await call<Err>(client, 'configure_onboarding', {
      guild_id,
      enabled: true,
      default_channel_ids: channels,
      prompts: [{ id: '123456789012345678', title: 'x', options: [{ title: 'y', role_ids: [game.id] }] }],
    });
    expect(stranger.data.error.code).toBe('invalid_argument');
  });

  test('needs Community and seven default channels to enable', async () => {
    const { client, d, guild_id } = await setup();
    const few = [d.addChannel({ name: 'a' }).id, d.addChannel({ name: 'b' }).id];
    const args = { guild_id, enabled: true, default_channel_ids: few, prompts: [] };
    const off = await call<Err>(client, 'configure_onboarding', args);
    expect(off.data.error.code).toBe('precondition_failed');
    expect(off.data.error.message).toMatch(/Community/);
    d.guild.features = ['COMMUNITY'];
    const short = await call<Err>(client, 'configure_onboarding', args);
    expect(short.data.error.message).toMatch(/at least 7/);
    const draft = await call(client, 'configure_onboarding', { ...args, enabled: false });
    expect(draft.isError).toBe(false);
    expect(d.calls.filter((c) => c.method === 'putOnboarding')).toHaveLength(1);
  });

  test('advanced mode counts channels from answers, and few writable channels warn', async () => {
    const { client, d, guild_id } = await setup();
    const channels = community(d, 4);
    const extra = [
      d.addChannel({ name: 'x' }).id,
      d.addChannel({ name: 'y' }).id,
      d.addChannel({ name: 'z' }).id,
    ];
    const role = d.addRole({ name: 'Fan', position: 2 });
    const r = await call<{ warnings?: string[] }>(client, 'configure_onboarding', {
      guild_id,
      enabled: true,
      mode: 'advanced',
      default_channel_ids: channels,
      prompts: [{ title: 'Pick', options: [{ title: 'All', role_ids: [role.id], channel_ids: extra }] }],
    });
    expect(r.isError).toBe(false);
    expect(r.data.warnings).toBeUndefined();
    for (const id of channels.slice(0, 3))
      d.channels.get(id)!.overwrites = [{ id: guild_id, type: 'role', allow: 0n, deny: P.SendMessages }];
    const warned = await call<{ warnings?: string[] }>(client, 'configure_onboarding', {
      guild_id,
      enabled: true,
      mode: 'advanced',
      default_channel_ids: channels,
      prompts: [{ title: 'Pick', options: [{ title: 'All', role_ids: [role.id], channel_ids: extra }] }],
    });
    expect(warned.data.warnings?.[0]).toMatch(/at least 5/);
  });

  test('refuses roles that are unsafe to hand out and options that give nothing', async () => {
    const { client, d, guild_id } = await setup();
    const channels = community(d);
    const admin = d.addRole({ name: 'Admin', position: 2, permissions: P.Administrator });
    const unsafe = await call<Err>(client, 'configure_onboarding', {
      guild_id,
      enabled: true,
      default_channel_ids: channels,
      prompts: [{ title: 'Role?', options: [{ title: 'Admin', role_ids: [admin.id] }] }],
    });
    expect(unsafe.data.error.code).toBe('forbidden');
    const empty = await call<Err>(client, 'configure_onboarding', {
      guild_id,
      enabled: true,
      default_channel_ids: channels,
      prompts: [{ title: 'Role?', options: [{ title: 'Nothing' }] }],
    });
    expect(empty.data.error.message).toMatch(/role or a channel/);
    const hidden = await call<Err>(client, 'configure_onboarding', {
      guild_id,
      enabled: true,
      default_channel_ids: channels,
      prompts: [
        {
          title: 'Must',
          required: true,
          in_onboarding: false,
          options: [{ title: 'x', channel_ids: [channels[0]] }],
        },
      ],
    });
    expect(hidden.data.error.message).toMatch(/must be in onboarding/);
    expect(d.calls.filter((c) => c.method === 'putOnboarding')).toHaveLength(0);
  });

  test('get_server_setup reports onboarding, welcome screen, widget and security', async () => {
    const { client, d, guild_id } = await setup();
    const channels = community(d);
    const hidden = d.addChannel({
      name: 'staff',
      overwrites: [{ id: guild_id, type: 'role', allow: 0n, deny: P.ViewChannel }],
    });
    const welcome = await call<{ warnings?: string[] }>(client, 'configure_welcome_screen', {
      guild_id,
      enabled: true,
      description: 'Hi there',
      channels: [
        { channel_id: channels[0], description: 'Start here', emoji: '👋' },
        { channel_id: hidden.id, description: 'Staff only' },
      ],
    });
    expect(welcome.isError).toBe(false);
    expect(welcome.data.warnings).toEqual(['@everyone cannot view #staff']);
    expect(
      (await call(client, 'configure_widget', { guild_id, enabled: true, channel_id: channels[1] })).isError,
    ).toBe(false);
    const setup_ = await call<{
      welcome_screen: { channels: Array<{ channel_name: string; emoji: string | null }> };
      widget: { enabled: boolean; channel_id: string };
      onboarding: { enabled: boolean };
      security: { invites_paused: boolean; raid_alerts: boolean };
    }>(client, 'get_server_setup', { guild_id });
    expect(setup_.data.welcome_screen.channels[0]).toMatchObject({ channel_name: 'chan-0', emoji: '👋' });
    expect(setup_.data.widget).toEqual({ enabled: true, channel_id: channels[1] });
    expect(setup_.data.onboarding.enabled).toBe(false);
    expect(setup_.data.security).toMatchObject({ invites_paused: false, raid_alerts: true });
  });

  test('a section the bot cannot read comes back as an error without sinking the rest', async () => {
    const { client, d, guild_id } = await setup();
    d.setBotPermissions(P.ViewChannel);
    const r = await call<{ onboarding: { error: string }; name: string }>(client, 'get_server_setup', {
      guild_id,
    });
    expect(r.isError).toBe(false);
    expect(r.data.onboarding.error).toBeTruthy();
    expect(r.data.name).toBe('Test Server');
  });
});

describe('security actions and the bot profile', () => {
  test('pausing one thing keeps the other pause and caps at 24 hours', async () => {
    const { client, d, guild_id } = await setup();
    const dms = await call<{ dms_paused_until: string }>(client, 'set_security_actions', {
      guild_id,
      pause_dms_hours: 2,
    });
    expect(Date.parse(dms.data.dms_paused_until)).toBeGreaterThan(Date.now() + 3_500_000);
    const inv = await call<{ invites_paused_until: string; dms_paused_until: string }>(
      client,
      'set_security_actions',
      { guild_id, pause_invites_hours: 24 },
    );
    expect(inv.data.dms_paused_until).toBe(dms.data.dms_paused_until);
    expect(Date.parse(inv.data.invites_paused_until)).toBeLessThan(Date.now() + 24 * 3_600_000);
    expect(d.guild.incidents?.invitesDisabledUntil).toBe(inv.data.invites_paused_until);
    const resume = await call<{ invites_paused_until: null }>(client, 'set_security_actions', {
      guild_id,
      pause_invites_hours: 0,
    });
    expect(resume.data.invites_paused_until).toBeNull();
  });

  test('the bot profile changes per server, and a nickname needs Change Nickname', async () => {
    const { client, d, guild_id } = await setup();
    const r = await call(client, 'update_bot_profile', {
      guild_id,
      nick: 'Bromine Bot',
      bio: 'hi',
      avatar: PNG,
    });
    expect(r.isError).toBe(false);
    expect(d.botProfile).toMatchObject({ nick: 'Bromine Bot', bio: 'hi' });
    expect(d.botProfile.avatar).toBeTruthy();
    d.setBotPermissions(P.ManageGuild);
    const refused = await call<Err>(client, 'update_bot_profile', { guild_id, nick: 'x' });
    expect(refused.data.error.code).toBe('precondition_failed');
    const notImage = await call<Err>(client, 'update_bot_profile', { guild_id, avatar: MP3 });
    expect(notImage.data.error.code).toBe('invalid_argument');
  });
});

describe('expressions', () => {
  test('emoji: add, list with slots, rename, refuse a new image, delete by name', async () => {
    const { client, d, guild_id } = await setup();
    const r = await call<{ emoji_id: string; usage: string }>(client, 'upsert_emoji', {
      guild_id,
      name: 'bromine',
      image: PNG,
    });
    expect(r.isError).toBe(false);
    expect(r.data.usage).toBe(`<:bromine:${r.data.emoji_id}>`);
    const list = await call<{
      emojis: { static_slots: { used: number; max: number }; items: Array<{ created_by_bot: boolean }> };
    }>(client, 'list_expressions', { guild_id, kind: 'emoji' });
    expect(list.data.emojis.static_slots).toEqual({ used: 1, max: 50 });
    expect(list.data.emojis.items[0]!.created_by_bot).toBe(true);
    const renamed = await call(client, 'upsert_emoji', { guild_id, emoji_id: r.data.emoji_id, name: 'br' });
    expect(renamed.isError).toBe(false);
    expect(d.emojis.get(r.data.emoji_id)!.name).toBe('br');
    const image = await call<Err>(client, 'upsert_emoji', {
      guild_id,
      emoji_id: r.data.emoji_id,
      image: GIF,
    });
    expect(image.data.error.code).toBe('invalid_argument');
    const wrong = await call<Err>(client, 'delete_expression', {
      guild_id,
      kind: 'emoji',
      id: r.data.emoji_id,
      confirm_name: 'bromine',
    });
    expect(wrong.data.error.code).toBe('precondition_failed');
    const del = await call(client, 'delete_expression', {
      guild_id,
      kind: 'emoji',
      id: r.data.emoji_id,
      confirm_name: 'br',
    });
    expect(del.isError).toBe(false);
    expect(d.emojis.size).toBe(0);
  });

  test('Create Expressions covers what the bot made, not what others made', async () => {
    const { client, d, guild_id } = await setup();
    d.setBotPermissions(P.CreateGuildExpressions);
    const theirs = d.addEmoji({ name: 'theirs' });
    const mine = await call<{ emoji_id: string }>(client, 'upsert_emoji', {
      guild_id,
      name: 'mine',
      image: PNG,
    });
    expect(mine.isError).toBe(false);
    expect(
      (await call(client, 'upsert_emoji', { guild_id, emoji_id: mine.data.emoji_id, name: 'mine2' })).isError,
    ).toBe(false);
    const refused = await call<Err>(client, 'upsert_emoji', { guild_id, emoji_id: theirs.id, name: 'nope' });
    expect(refused.data.error.code).toBe('precondition_failed');
  });

  test('stickers and soundboard sounds', async () => {
    const { client, d, guild_id } = await setup();
    const sticker = await call<{ sticker_id: string }>(client, 'upsert_sticker', {
      guild_id,
      name: 'wave',
      tags: 'wave',
      file: PNG,
    });
    expect(sticker.isError).toBe(false);
    expect(d.stickers.get(sticker.data.sticker_id)?.name).toBe('wave');
    const notSound = await call<Err>(client, 'upsert_soundboard_sound', {
      guild_id,
      name: 'boom',
      sound: PNG,
    });
    expect(notSound.data.error.code).toBe('invalid_argument');
    const sound = await call<{ sound_id: string }>(client, 'upsert_soundboard_sound', {
      guild_id,
      name: 'boom',
      sound: MP3,
      volume: 0.5,
      emoji: '💥',
    });
    expect(sound.isError).toBe(false);
    expect(d.sounds.get(sound.data.sound_id)).toMatchObject({ volume: 0.5, emojiName: '💥' });
  });
});

describe('scheduled events', () => {
  test('recurrence follows the start time', () => {
    // 2026-11-12 is the second Thursday of November.
    const start = '2026-11-12T18:00:00.000Z';
    expect(recurrenceFor('weekly', start)).toMatchObject({ frequency: 2, interval: 1, by_weekday: [3] });
    expect(recurrenceFor('every_other_week', start)).toMatchObject({ interval: 2, by_weekday: [3] });
    expect(recurrenceFor('monthly', start).by_n_weekday).toEqual([{ n: 2, day: 3 }]);
    expect(recurrenceFor('yearly', start)).toMatchObject({
      frequency: 0,
      by_month: [11],
      by_month_day: [12],
    });
    expect(recurrenceFor('weekdays', start).by_weekday).toEqual([0, 1, 2, 3, 4]);
  });

  test('external events need a place and an end; status only moves forward', async () => {
    const { client, d, guild_id } = await setup();
    const missing = await call<Err>(client, 'upsert_scheduled_event', {
      guild_id,
      name: 'Launch',
      type: 'external',
      location: 'Roblox',
      start_time: inHours(2),
    });
    expect(missing.data.error.message).toMatch(/end_time/);
    const r = await call<{ event_id: string; link: string; repeats: string }>(
      client,
      'upsert_scheduled_event',
      {
        guild_id,
        name: 'Launch',
        type: 'external',
        location: 'Roblox',
        start_time: inHours(2),
        end_time: inHours(3),
        repeat: 'weekly',
      },
    );
    expect(r.isError).toBe(false);
    expect(r.data.link).toBe(`https://discord.com/events/${guild_id}/${r.data.event_id}`);
    expect(r.data.repeats).toMatch(/^every week on /);
    const moved = await call<Err>(client, 'upsert_scheduled_event', {
      guild_id,
      event_id: r.data.event_id,
      start_time: inHours(4),
      end_time: inHours(5),
    });
    expect(moved.data.error.message).toMatch(/pass repeat again/);
    const backwards = await call<Err>(client, 'upsert_scheduled_event', {
      guild_id,
      event_id: r.data.event_id,
      status: 'completed',
    });
    expect(backwards.data.error.message).toMatch(/scheduled cannot become completed/);
    const live = await call(client, 'upsert_scheduled_event', {
      guild_id,
      event_id: r.data.event_id,
      status: 'active',
    });
    expect(live.isError).toBe(false);
    expect(d.scheduledEvents.get(r.data.event_id)!.status).toBe(2);
  });

  test('voice events need a voice channel; delete needs the name', async () => {
    const { client, d, guild_id } = await setup();
    const text = d.addChannel({ name: 'general' });
    const voice = d.addChannel({ name: 'Hangout', type: 2 });
    const wrong = await call<Err>(client, 'upsert_scheduled_event', {
      guild_id,
      name: 'Game night',
      type: 'voice',
      channel_id: text.id,
      start_time: inHours(1),
    });
    expect(wrong.data.error.message).toMatch(/voice channel/);
    const past = await call<Err>(client, 'upsert_scheduled_event', {
      guild_id,
      name: 'Game night',
      type: 'voice',
      channel_id: voice.id,
      start_time: inHours(-1),
    });
    expect(past.data.error.message).toMatch(/future/);
    const r = await call<{ event_id: string }>(client, 'upsert_scheduled_event', {
      guild_id,
      name: 'Game night',
      type: 'voice',
      channel_id: voice.id,
      start_time: inHours(1),
    });
    expect(r.isError).toBe(false);
    const listed = await call<{ events: Array<{ type: string; status: string }> }>(
      client,
      'list_scheduled_events',
      {
        guild_id,
      },
    );
    expect(listed.data.events[0]).toMatchObject({ type: 'voice', status: 'scheduled' });
    const del = await call(client, 'delete_scheduled_event', {
      guild_id,
      event_id: r.data.event_id,
      confirm_name: 'Game night',
    });
    expect(del.isError).toBe(false);
    expect(d.scheduledEvents.size).toBe(0);
  });
});

describe('invites, webhooks, templates and integrations', () => {
  test('invites: create with a self-assignable role, list, refuse the vanity code', async () => {
    const { client, d, guild_id } = await setup();
    const ch = d.addChannel({ name: 'welcome' });
    const fan = d.addRole({ name: 'Fan', position: 2 });
    const admin = d.addRole({ name: 'Admin', position: 3, permissions: P.Administrator });
    const unsafe = await call<Err>(client, 'create_invite', {
      guild_id,
      channel_id: ch.id,
      role_ids: [admin.id],
    });
    expect(unsafe.data.error.code).toBe('forbidden');
    const r = await call<{ code: string; url: string }>(client, 'create_invite', {
      guild_id,
      channel_id: ch.id,
      max_age_seconds: 0,
      role_ids: [fan.id],
    });
    expect(r.isError).toBe(false);
    expect(r.data.url).toBe(`https://discord.gg/${r.data.code}`);
    const list = await call<{ invites: Array<{ code: string; role_ids: string[]; expires_at: null }> }>(
      client,
      'list_invites',
      { guild_id },
    );
    expect(list.data.invites[0]).toMatchObject({ code: r.data.code, role_ids: [fan.id], expires_at: null });
    d.guild.vanityUrlCode = 'bromine';
    const vanity = await call<Err>(client, 'delete_invite', { guild_id, code: 'bromine' });
    expect(vanity.data.error.code).toBe('precondition_failed');
    expect((await call(client, 'delete_invite', { guild_id, code: r.data.code })).isError).toBe(false);
    expect(d.invites.size).toBe(0);
  });

  test('webhooks: create, refuse reserved names, never show tokens, delete by name', async () => {
    const { client, d, guild_id } = await setup();
    const ch = d.addChannel({ name: 'game-updates' });
    const cat = d.addChannel({ name: 'Info', type: 4 });
    const reserved = await call<Err>(client, 'upsert_webhook', {
      guild_id,
      channel_id: ch.id,
      name: 'Clyde',
    });
    expect(reserved.data.error.code).toBe('invalid_argument');
    const inCategory = await call<Err>(client, 'upsert_webhook', { guild_id, channel_id: cat.id, name: 'x' });
    expect(inCategory.data.error.code).toBe('invalid_argument');
    const r = await call<{ webhook_id: string; note: string }>(client, 'upsert_webhook', {
      guild_id,
      channel_id: ch.id,
      name: 'Release Bot',
      avatar: PNG,
    });
    expect(r.isError).toBe(false);
    expect(r.data.note).toMatch(/Integrations/);
    const list = await call(client, 'list_webhooks', { guild_id });
    expect(JSON.stringify(list.data)).not.toMatch(/token/i);
    const del = await call(client, 'delete_webhook', {
      guild_id,
      webhook_id: r.data.webhook_id,
      confirm_name: 'Release Bot',
    });
    expect(del.isError).toBe(false);
    expect(d.webhooks.size).toBe(0);
  });

  test('templates: one per server, edit and sync by code, delete by name', async () => {
    const { client, d, guild_id } = await setup();
    const r = await call<{ code: string; url: string }>(client, 'upsert_template', {
      guild_id,
      name: 'Studio',
    });
    expect(r.isError).toBe(false);
    expect(r.data.url).toBe(`https://discord.new/${r.data.code}`);
    const second = await call<Err>(client, 'upsert_template', { guild_id, name: 'Another' });
    expect(second.data.error.message).toMatch(/already has template/);
    const sync = await call<{ synced: boolean; changed: string[] }>(client, 'upsert_template', {
      guild_id,
      code: r.data.code,
      description: 'Game studio layout',
      sync: true,
    });
    expect(sync.data).toMatchObject({ synced: true, changed: ['description'] });
    expect(d.calls.some((c) => c.method === 'syncTemplate')).toBe(true);
    const del = await call(client, 'delete_template', {
      guild_id,
      code: r.data.code,
      confirm_name: 'Studio',
    });
    expect(del.isError).toBe(false);
    expect(d.templates.size).toBe(0);
  });

  test('integrations: steward is marked and cannot remove itself', async () => {
    const { client, d, guild_id } = await setup();
    const self = d.addIntegration({ name: 'steward', applicationId: d.botUserId, type: 'discord' });
    const other = d.addIntegration({ name: 'Carl-bot', applicationId: '235148962103951360' });
    const list = await call<{ integrations: Array<{ id: string; is_steward: boolean }> }>(
      client,
      'list_integrations',
      { guild_id },
    );
    expect(list.data.integrations.find((i) => i.id === self.id)!.is_steward).toBe(true);
    expect(list.data.integrations.find((i) => i.id === other.id)!.is_steward).toBe(false);
    const own = await call<Err>(client, 'delete_integration', {
      guild_id,
      integration_id: self.id,
      confirm_name: 'steward',
    });
    expect(own.data.error.message).toMatch(/its own integration/);
    const del = await call(client, 'delete_integration', {
      guild_id,
      integration_id: other.id,
      confirm_name: 'Carl-bot',
    });
    expect(del.isError).toBe(false);
    expect(d.integrations.has(other.id)).toBe(false);
  });
});

describe('server, role and channel customisation', () => {
  test('server images need their unlock; invite pause and raid alerts toggle features', async () => {
    const { client, d, guild_id } = await setup();
    const icon = await call(client, 'update_guild_settings', { guild_id, icon: PNG });
    expect(icon.isError).toBe(false);
    expect(d.guild.icon).toBeTruthy();
    const animated = await call<Err>(client, 'update_guild_settings', { guild_id, icon: GIF });
    expect(animated.data.error.message).toMatch(/ANIMATED_ICON/);
    const banner = await call<Err>(client, 'update_guild_settings', { guild_id, banner: PNG });
    expect(banner.data.error.message).toMatch(/BANNER/);
    d.guild.features = ['BANNER'];
    expect((await call(client, 'update_guild_settings', { guild_id, banner: PNG })).isError).toBe(false);
    const toggles = await call<{ warnings?: string[] }>(client, 'update_guild_settings', {
      guild_id,
      invites_paused: true,
      raid_alerts: false,
    });
    expect(toggles.isError).toBe(false);
    expect(d.guild.features.sort()).toEqual(['BANNER', 'INVITES_DISABLED', 'RAID_ALERTS_DISABLED']);
    const on = await call<{ warnings?: string[] }>(client, 'update_guild_settings', {
      guild_id,
      raid_alerts: true,
    });
    expect(d.guild.features).not.toContain('RAID_ALERTS_DISABLED');
    expect(on.data.warnings?.join(' ')).toMatch(/safety/);
    const removed = await call(client, 'update_guild_settings', { guild_id, banner: null });
    expect(removed.isError).toBe(false);
    expect(d.guild.banner).toBeNull();
  });

  test('role gradients, holographic colours and icons need their unlocks', async () => {
    const { client, d, guild_id } = await setup();
    const role = d.addRole({ name: 'Word Arcade', position: 2 });
    const gradient = await call<Err>(client, 'update_role', {
      guild_id,
      role_id: role.id,
      color: '#ff0000',
      secondary_color: '#0000ff',
    });
    expect(gradient.data.error.message).toMatch(/ENHANCED_ROLE_COLORS/);
    const icon = await call<Err>(client, 'update_role', { guild_id, role_id: role.id, unicode_emoji: '🧩' });
    expect(icon.data.error.message).toMatch(/ROLE_ICONS/);
    d.guild.features = ['ENHANCED_ROLE_COLORS', 'ROLE_ICONS'];
    expect(
      (
        await call(client, 'update_role', {
          guild_id,
          role_id: role.id,
          color: '#ff0000',
          secondary_color: '#0000ff',
        })
      ).isError,
    ).toBe(false);
    expect(d.roles.get(role.id)).toMatchObject({ color: 0xff0000, secondaryColor: 0x0000ff });
    const mixed = await call<Err>(client, 'update_role', {
      guild_id,
      role_id: role.id,
      holographic: true,
      color: '#00ff00',
    });
    expect(mixed.data.error.code).toBe('invalid_argument');
    expect(
      (await call(client, 'update_role', { guild_id, role_id: role.id, holographic: true })).isError,
    ).toBe(false);
    expect(d.roles.get(role.id)).toMatchObject({
      color: 11127295,
      secondaryColor: 16759788,
      tertiaryColor: 16761760,
    });
    expect(
      (await call(client, 'update_role', { guild_id, role_id: role.id, unicode_emoji: '🧩' })).isError,
    ).toBe(false);
    expect(d.roles.get(role.id)!.unicodeEmoji).toBe('🧩');
    const both = await call<Err>(client, 'update_role', {
      guild_id,
      role_id: role.id,
      unicode_emoji: '🧩',
      icon: PNG,
    });
    expect(both.data.error.code).toBe('invalid_argument');
  });

  test('forum settings: tags, default reaction, sort order and required tags', async () => {
    const { client, d, guild_id } = await setup();
    const forum = d.addChannel({ name: 'bug-reports', type: 15 });
    const text = d.addChannel({ name: 'general' });
    const r = await call(client, 'update_channel', {
      guild_id,
      channel_id: forum.id,
      forum_tags: [
        { name: 'Bug', emoji: '🐛' },
        { name: 'Fixed', moderated: true },
      ],
      default_reaction_emoji: '👍',
      default_sort_order: 'creation_date',
      default_forum_layout: 'gallery',
      default_auto_archive_minutes: 10080,
      require_tag: true,
    });
    expect(r.isError).toBe(false);
    const extra = d.channels.get(forum.id)!.extra!;
    expect(extra.availableTags).toHaveLength(2);
    expect(extra.availableTags![0]).toMatchObject({ name: 'Bug', emojiName: '🐛', moderated: false });
    expect(extra.defaultReactionEmoji).toEqual({ emojiId: null, emojiName: '👍' });
    expect(extra.flags! & 16).toBe(16);

    const details = await call<{
      settings: {
        forum_tags: Array<{ id: string; name: string }>;
        require_tag: boolean;
        default_forum_layout: string;
      };
    }>(client, 'get_channel', { guild_id, channel_id: forum.id });
    expect(details.data.settings).toMatchObject({
      require_tag: true,
      default_forum_layout: 'gallery',
      default_sort_order: 'creation_date',
      default_reaction_emoji: '👍',
      default_auto_archive_minutes: 10080,
    });
    const bug = details.data.settings.forum_tags[0]!;
    const keep = await call(client, 'update_channel', {
      guild_id,
      channel_id: forum.id,
      forum_tags: [{ id: bug.id, name: 'Bugs' }],
      require_tag: false,
    });
    expect(keep.isError).toBe(false);
    expect(d.channels.get(forum.id)!.extra!.availableTags).toEqual([
      { id: bug.id, name: 'Bugs', moderated: false, emojiId: null, emojiName: null },
    ]);
    expect(d.channels.get(forum.id)!.extra!.flags! & 16).toBe(0);

    const unknownTag = await call<Err>(client, 'update_channel', {
      guild_id,
      channel_id: forum.id,
      forum_tags: [{ id: '123456789012345678', name: 'Ghost' }],
    });
    expect(unknownTag.data.error.code).toBe('invalid_argument');
    const wrongKind = await call<Err>(client, 'update_channel', {
      guild_id,
      channel_id: text.id,
      forum_tags: [{ name: 'Bug' }],
    });
    expect(wrongKind.data.error.message).toMatch(/forum and media channels, not text/);
  });

  test('voice settings apply to voice channels only', async () => {
    const { client, d, guild_id } = await setup();
    const voice = d.addChannel({ name: 'Hangout', type: 2 });
    const text = d.addChannel({ name: 'general' });
    const r = await call(client, 'update_channel', {
      guild_id,
      channel_id: voice.id,
      rtc_region: 'rotterdam',
      video_quality: 'full',
    });
    expect(r.isError).toBe(false);
    expect(d.channels.get(voice.id)!.extra).toMatchObject({ rtcRegion: 'rotterdam', videoQualityMode: 2 });
    const details = await call<{ settings: { rtc_region: string; video_quality: string } }>(
      client,
      'get_channel',
      {
        guild_id,
        channel_id: voice.id,
      },
    );
    expect(details.data.settings).toMatchObject({ rtc_region: 'rotterdam', video_quality: 'full' });
    const wrong = await call<Err>(client, 'update_channel', {
      guild_id,
      channel_id: text.id,
      rtc_region: 'us-east',
    });
    expect(wrong.data.error.code).toBe('invalid_argument');
    expect(
      (
        await call(client, 'update_channel', {
          guild_id,
          channel_id: text.id,
          default_thread_slowmode_seconds: 30,
        })
      ).isError,
    ).toBe(false);
    expect(d.channels.get(text.id)!.extra!.defaultThreadRateLimitPerUser).toBe(30);
  });

  test('new tools carry the right MCP hints', async () => {
    const { client } = await setup();
    const { tools } = await client.listTools();
    const hints = (name: string) => tools.find((t) => t.name === name)!.annotations!;
    expect(hints('create_invite').destructiveHint).toBe(false);
    expect(hints('configure_onboarding').idempotentHint).toBe(true);
    expect(hints('delete_expression').idempotentHint).toBe(true);
    expect(hints('upsert_emoji').idempotentHint).toBe(false);
    expect(hints('get_server_setup').readOnlyHint).toBe(true);
    expect(MemoryDiscordAdapter.EVERYTHING_BUT_ADMIN & P.ManageGuildExpressions).toBe(
      P.ManageGuildExpressions,
    );
  });
});
