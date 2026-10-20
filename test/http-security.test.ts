import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, test } from 'vitest';
import type { Running } from './helpers/server.js';
import { makeEnv } from './helpers/env.js';
import {
  FULL_TOKEN,
  READ_TOKEN,
  WRITE_TOKEN,
  call,
  connect,
  credential,
  startServer,
} from './helpers/server.js';

let running: Running | undefined;
afterEach(async () => {
  await running?.close();
  running = undefined;
});

const init = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'curl', version: '0' } },
};

async function post(url: string, headers: Record<string, string>, body: unknown = init) {
  return fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe('endpoint authentication', () => {
  test('no token, a wrong token, or a malformed header get 401 and never reach MCP', async () => {
    running = await startServer();
    for (const headers of [
      {},
      { authorization: 'Bearer wrong-token-wrong-token-wrong-token' },
      { authorization: FULL_TOKEN },
    ] as Array<Record<string, string>>) {
      const res = await post(running.url, headers);
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toMatch(/^Bearer/);
      expect(await res.text()).not.toContain('serverInfo');
    }
    await expect(connect(running.url, null)).rejects.toThrow();
    const ok = await post(running.url, { authorization: `Bearer ${FULL_TOKEN}` });
    expect(ok.status).toBe(200);
  });

  test('repeated failures from one address are throttled', async () => {
    running = await startServer();
    let last = 0;
    for (let i = 0; i < 22; i++) last = (await post(running.url, { authorization: 'Bearer nope' })).status;
    expect(last).toBe(429);
    // Even a valid token is refused while throttled.
    expect((await post(running.url, { authorization: `Bearer ${FULL_TOKEN}` })).status).toBe(429);
  });

  test('DNS-rebinding protection: unexpected Host or any browser Origin is refused', async () => {
    running = await startServer();
    const auth = { authorization: `Bearer ${FULL_TOKEN}` };
    const rebound = await fetch(running.url.replace('127.0.0.1', 'localhost'), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...auth,
        host: 'evil.example',
      },
      body: JSON.stringify(init),
    }).catch(() => null);
    // fetch may refuse to override Host; check via a raw request below if so.
    if (rebound) expect([403, 200]).toContain(rebound.status);
    const { request } = await import('node:http');
    const status = await new Promise<number>((resolve) => {
      const req = request(
        running!.url,
        {
          method: 'POST',
          headers: { host: 'evil.example:8787', 'content-type': 'application/json', ...auth },
        },
        (res) => resolve(res.statusCode!),
      );
      req.end(JSON.stringify(init));
    });
    expect(status).toBe(403);
    expect((await post(running.url, { ...auth, origin: 'https://evil.example' })).status).toBe(403);
  });

  test('an allowed LAN hostname and an explicitly allowed origin pass', async () => {
    running = await startServer({
      allowedHosts: ['127.0.0.1', 'steward.lan:8787'],
      allowedOrigins: ['https://console.example'],
    });
    const { request } = await import('node:http');
    const status = await new Promise<number>((resolve) => {
      const req = request(
        running!.url,
        {
          method: 'POST',
          headers: {
            host: 'steward.lan:8787',
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            authorization: `Bearer ${FULL_TOKEN}`,
          },
        },
        (res) => resolve(res.statusCode!),
      );
      req.end(JSON.stringify(init));
    });
    expect(status).toBe(200);
    expect(
      (await post(running.url, { authorization: `Bearer ${FULL_TOKEN}`, origin: 'https://console.example' }))
        .status,
    ).toBe(200);
  });
});

describe('health and readiness', () => {
  test('liveness is unauthenticated; readiness reports the Discord connection', async () => {
    running = await startServer();
    const base = running.url.replace('/mcp', '');
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    expect((await fetch(`${base}/readyz`)).status).toBe(200);
    running.env.adapter.setConnection('failed', 'Discord rejected the bot token (TokenInvalid)');
    const res = await fetch(`${base}/readyz`);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({
      status: 'not_ready',
      discord: { state: 'failed', detail: expect.stringContaining('TokenInvalid') },
    });
    expect((await fetch(`${base}/nope`)).status).toBe(404);
  });

  test('Discord tools fail clearly while disconnected; local tools keep working', async () => {
    running = await startServer();
    const client = await connect(running.url, FULL_TOKEN);
    running.env.adapter.setConnection('disconnected', 'gateway closed');
    const r = await call(client, 'list_roles', { guild_id: running.env.guildId });
    expect(r.isError).toBe(true);
    const s = await call<{ discord: { state: string } }>(client, 'steward_status');
    expect(s.data.discord.state).toBe('disconnected');
    await client.close();
  });
});

describe('per-tool authorisation', () => {
  test('a read-only credential sees no write tools and cannot call them', async () => {
    running = await startServer();
    const reader = await connect(running.url, READ_TOKEN);
    const names = (await reader.listTools()).tools.map((t) => t.name);
    expect(names).toContain('plan_blueprint');
    expect(names).not.toContain('apply_plan');
    expect(names).not.toContain('create_channel');
    expect(names).not.toContain('delete_role');
    // Unlisted tools are unknown to this session: the call fails at the protocol level.
    await expect(
      reader.callTool({ name: 'create_channel', arguments: { guild_id: running.env.guildId, name: 'x' } }),
    ).rejects.toThrow(/not found/);
    expect(running.env.adapter.channels.size).toBe(0);
    await reader.close();
  });

  test('write without destructive cannot delete, nor apply a plan that deletes', async () => {
    running = await startServer();
    const writer = await connect(running.url, WRITE_TOKEN);
    const names = (await writer.listTools()).tools.map((t) => t.name);
    expect(names).toContain('create_channel');
    expect(names).not.toContain('delete_channel');
    const guild_id = running.env.guildId;
    await call(writer, 'create_channel', { guild_id, name: 'temp', key: 'temp' });
    const plan = await call<{ plan_id: string; destructive_steps: number }>(writer, 'plan_blueprint', {
      guild_id,
      blueprint: { version: 1 },
      prune: { channels: true },
    });
    expect(plan.data.destructive_steps).toBe(1);
    const applied = await call<{ error: { code: string } }>(writer, 'apply_plan', {
      guild_id,
      plan_id: plan.data.plan_id,
    });
    expect(applied.isError).toBe(true);
    expect(applied.data.error.code).toBe('forbidden');
    expect(running.env.adapter.channelByName('temp')).toBeDefined();
    await writer.close();
  });

  test('READ_ONLY mode hides every write tool, even for full credentials', async () => {
    running = await startServer({ readOnly: true });
    const client = await connect(running.url, FULL_TOKEN);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain('apply_plan');
    expect(names).not.toContain('post_message');
    expect(names).toContain('export_blueprint');
    await client.close();
  });

  test('ALLOW_DESTRUCTIVE=false hides destructive tools', async () => {
    running = await startServer({ allowDestructive: false });
    const client = await connect(running.url, FULL_TOKEN);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain('create_role');
    expect(names.filter((n) => n.startsWith('delete_'))).toEqual([]);
    await client.close();
  });
});

describe('guild restrictions', () => {
  test('guilds outside DISCORD_GUILD_IDS are refused before Discord is contacted', async () => {
    running = await startServer();
    const client = await connect(running.url, FULL_TOKEN);
    running.env.adapter.calls = [];
    const r = await call<{ error: { code: string } }>(client, 'get_guild_overview', {
      guild_id: '999999999999999999',
    });
    expect(r.isError).toBe(true);
    expect(r.data.error.code).toBe('guild_not_allowed');
    expect(running.env.adapter.calls).toEqual([]);
    await client.close();
  });

  test('a credential limited to other guilds cannot touch this one, or read its plans', async () => {
    const other = '888888888888888888';
    const narrowToken = 'stw_narrow_0123456789abcdefghijklmnopqrs';
    const env = makeEnv();
    running = await startServer(
      {
        guildIds: [env.guildId, other],
        credentials: [
          credential('full', FULL_TOKEN, ['read', 'write', 'destructive']),
          credential('narrow', narrowToken, ['read', 'write'], [other]),
        ],
      },
      env,
    );
    const full = await connect(running.url, FULL_TOKEN);
    const plan = await call<{ plan_id: string }>(full, 'plan_blueprint', {
      guild_id: env.guildId,
      blueprint: { version: 1 },
    });
    expect(plan.isError).toBe(false);
    const narrow = await connect(running.url, narrowToken);
    expect((await call(narrow, 'list_roles', { guild_id: env.guildId })).isError).toBe(true);
    const peek = await call<{ error: { code: string } }>(narrow, 'get_plan', { plan_id: plan.data.plan_id });
    expect(peek.data.error.code).toBe('guild_not_allowed');
    const apply = await call<{ error: { code: string } }>(narrow, 'apply_plan', {
      plan_id: plan.data.plan_id,
      guild_id: env.guildId,
    });
    expect(apply.data.error.code).toBe('guild_not_allowed');
    expect((await call(narrow, 'list_history', {})).isError).toBe(true);
    await full.close();
    await narrow.close();
  });

  test('every tool call is recorded with the client name and outcome', async () => {
    running = await startServer();
    const client = await connect(running.url, READ_TOKEN);
    await call(client, 'get_guild_overview', { guild_id: running.env.guildId });
    await call(client, 'get_guild_overview', { guild_id: '999999999999999999' });
    const { items } = running.env.store.listToolCalls(10, 0);
    expect(items.map((i) => [i.clientId, i.tool, i.outcome])).toEqual([
      ['reader', 'get_guild_overview', 'denied'],
      ['reader', 'get_guild_overview', 'ok'],
    ]);
    await client.close();
  });
});

describe('protocol eras', () => {
  test('a 2026-era client negotiates the modern protocol and calls tools', async () => {
    running = await startServer();
    const client = new Client({ name: 'modern', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(running.url), {
        requestInit: { headers: { Authorization: `Bearer ${FULL_TOKEN}` } },
      }),
    );
    expect(client.getDiscoverResult()).toBeDefined();
    const r = (await client.callTool({ name: 'steward_status', arguments: {} })) as {
      content: Array<{ text: string }>;
    };
    expect(JSON.parse(r.content[0]!.text).you.client).toBe('full');
    await client.close();
  });
});
