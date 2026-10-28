import { request } from 'node:http';
import { afterEach, expect, test } from 'vitest';
import { ALL_TOOLS } from '../src/mcp/server.js';
import { Store } from '../src/store.js';
import { makeEnv } from './helpers/env.js';
import type { Running } from './helpers/server.js';
import { call, connect, credential, FULL_TOKEN, READ_TOKEN, startServer } from './helpers/server.js';

let running: Running | undefined;
afterEach(async () => {
  await running?.close();
  running = undefined;
});

async function login(token = FULL_TOKEN) {
  const base = running!.url.replace('/mcp', '');
  const response = await fetch(`${base}/api/session`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, origin: base },
  });
  const body = (await response.json()) as { csrf: string };
  return { response, csrf: body.csrf, cookie: response.headers.get('set-cookie')!.split(';')[0]!, base };
}
async function invoke(session: Awaited<ReturnType<typeof login>>, name: string, args: unknown, headers = {}) {
  const response = await fetch(`${session.base}/api/tools/${name}`, {
    method: 'POST',
    headers: {
      cookie: session.cookie,
      'x-steward-csrf': session.csrf,
      'x-steward-confirm': name,
      'content-type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(args),
  });
  // Tool responses are heterogeneous; assertions below inspect the relevant schema.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const body = (await response.json()) as { ok: boolean; data: Record<string, any> };
  return { response, ...body };
}

test('dashboard assets load without credentials, with a strict CSP and no inline scripts', async () => {
  running = await startServer();
  const base = running.url.replace('/mcp', '');
  const html = await fetch(base);
  expect(html.status).toBe(200);
  expect(html.headers.get('content-security-policy')).toContain("script-src 'self'");
  expect(html.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
  const source = await html.text();
  expect(source).toContain('Welcome to Steward.');
  expect(source).not.toContain(FULL_TOKEN);
  for (const path of ['/assets/app.js', '/assets/style.css', '/favicon.svg'])
    expect((await fetch(base + path)).status).toBe(200);
  expect((await fetch(base + '/api/tools')).status).toBe(401);
  expect((await fetch(base + '/assets/../../.env')).status).toBe(404);
  const foreign = await new Promise<number>((resolve) => {
    const req = request(base, { headers: { host: 'evil.test' } }, (res) => {
      res.resume();
      resolve(res.statusCode!);
    });
    req.end();
  });
  expect(foreign).toBe(403);
});

test('login uses an HttpOnly session, validates origins, rotates sessions and revokes logout', async () => {
  running = await startServer();
  const session = await login();
  expect(session.response.status).toBe(200);
  expect(session.response.headers.get('set-cookie')).toMatch(/HttpOnly; SameSite=Strict/);
  expect(session.cookie).not.toContain(FULL_TOKEN);
  expect(session.csrf).toMatch(/^[a-f0-9]{64}$/);
  expect((await fetch(`${session.base}/api/health`, { headers: { cookie: session.cookie } })).status).toBe(
    200,
  );
  expect(
    (
      await fetch(`${session.base}/api/session`, {
        method: 'POST',
        headers: { authorization: `Bearer ${FULL_TOKEN}`, origin: 'https://evil.test' },
      })
    ).status,
  ).toBe(403);
  expect(
    (await invoke(session, 'list_roles', { guild_id: running.env.guildId }, { 'x-steward-csrf': '' }))
      .response.status,
  ).toBe(403);
  expect(
    (
      await invoke(
        session,
        'list_roles',
        { guild_id: running.env.guildId },
        { 'x-steward-csrf': 'é'.repeat(64) },
      )
    ).response.status,
  ).toBe(403);
  expect(
    (await invoke(session, 'list_roles', { guild_id: running.env.guildId }, { origin: 'https://evil.test' }))
      .response.status,
  ).toBe(403);
  const rotated = await fetch(`${session.base}/api/session`, {
    method: 'POST',
    headers: { cookie: session.cookie, authorization: `Bearer ${FULL_TOKEN}` },
  });
  expect(rotated.status).toBe(200);
  expect((await fetch(`${session.base}/api/session`, { headers: { cookie: session.cookie } })).status).toBe(
    401,
  );
  const next = await login();
  const logout = await fetch(`${next.base}/api/session`, {
    method: 'DELETE',
    headers: { cookie: next.cookie, 'x-steward-csrf': next.csrf },
  });
  expect(logout.status).toBe(200);
  expect((await invoke(next, 'steward_status', {})).response.status).toBe(401);
});

test('session expiry and authentication throttling apply to the dashboard', async () => {
  running = await startServer();
  const session = await login();
  const { vi } = await import('vitest');
  const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 9 * 60 * 60_000);
  try {
    expect((await fetch(`${session.base}/api/session`, { headers: { cookie: session.cookie } })).status).toBe(
      401,
    );
  } finally {
    now.mockRestore();
  }
  let status = 0;
  for (let i = 0; i < 22; i++)
    status = (
      await fetch(`${session.base}/api/session`, {
        method: 'POST',
        headers: { authorization: 'Bearer wrong' },
      })
    ).status;
  expect(status).toBe(429);
});

test('every allowed MCP operation has a dashboard schema; read credentials cannot mutate', async () => {
  running = await startServer();
  const full = await login();
  const catalog = (await (
    await fetch(`${full.base}/api/tools`, { headers: { cookie: full.cookie } })
  ).json()) as { tools: Array<{ name: string; inputSchema: { type: string } }> };
  expect(catalog.tools.map((t) => t.name).sort()).toEqual(ALL_TOOLS.map((t) => t.name).sort());
  expect(catalog.tools.every((t) => t.inputSchema.type === 'object')).toBe(true);
  const reader = await login(READ_TOKEN);
  const readCatalog = (await (
    await fetch(`${reader.base}/api/tools`, { headers: { cookie: reader.cookie } })
  ).json()) as { tools: Array<{ scope: string }> };
  expect(readCatalog.tools.every((t) => t.scope === 'read')).toBe(true);
  const result = await invoke(reader, 'create_role', { guild_id: running.env.guildId, name: 'Forbidden' });
  expect(result.response.status).toBe(422);
  expect(result.data.error.code).toBe('forbidden');
  expect(running.env.adapter.calls.filter((c) => c.method === 'createRole')).toHaveLength(0);
});

test('dashboard edits are validated, confirmed, journaled and read back through MCP', async () => {
  running = await startServer();
  const session = await login();
  const guild_id = running.env.guildId;
  const args = { guild_id, name: 'Dashboard role', color: '#336699', permissions: ['ViewChannel'] };
  expect((await invoke(session, 'create_role', args, { 'x-steward-confirm': '' })).response.status).toBe(409);
  expect((await invoke(session, 'create_role', { ...args, name: '' })).data.error.code).toBe(
    'invalid_argument',
  );
  expect(
    (await invoke(session, 'create_role', { ...args, guild_id: '999999999999999999' })).data.error.code,
  ).toBe('guild_not_allowed');
  const created = await invoke(session, 'create_role', args);
  expect(created.ok).toBe(true);
  const client = await connect(running.url, FULL_TOKEN);
  try {
    const roles = await call<{ items: Array<{ id: string; name: string }> }>(client, 'list_roles', {
      guild_id,
    });
    const role = roles.data.items.find((r) => r.name === args.name)!;
    expect(role).toBeDefined();
    const updated = await invoke(session, 'update_role', {
      guild_id,
      role_id: role.id,
      name: 'Renamed from web',
    });
    expect(updated.ok).toBe(true);
    const inspected = await call<{ name: string }>(client, 'get_role', { guild_id, role_id: role.id });
    expect(inspected.data.name).toBe('Renamed from web');
    expect(
      running.env.store
        .listToolCalls(100, 0)
        .items.some((c) => c.tool === 'update_role' && c.clientId === 'full' && c.outcome === 'ok'),
    ).toBe(true);
    expect(
      (await invoke(session, 'delete_role', { guild_id, role_id: role.id, confirm_name: 'wrong' })).ok,
    ).toBe(false);
    expect(
      (await invoke(session, 'delete_role', { guild_id, role_id: role.id, confirm_name: 'Renamed from web' }))
        .ok,
    ).toBe(true);
  } finally {
    await client.close();
  }
});

test('read-only server mode and restricted guild credentials stay enforced', async () => {
  const env = makeEnv();
  const narrow = 'stw_narrow_abcdefghijklmnopqrstuvwxyz123456';
  running = await startServer(
    {
      readOnly: true,
      credentials: [
        credential('full', FULL_TOKEN, ['read', 'write']),
        credential('narrow', narrow, ['read', 'write'], ['888888888888888888']),
      ],
    },
    env,
  );
  const session = await login();
  expect(
    (await invoke(session, 'create_channel', { guild_id: env.guildId, name: 'nope' })).data.error.code,
  ).toBe('read_only');
  const restricted = await login(narrow);
  expect((await invoke(restricted, 'get_guild_overview', { guild_id: env.guildId })).data.error.code).toBe(
    'guild_not_allowed',
  );
  expect((await invoke(restricted, 'list_guilds', {})).data.items).toEqual([]);
});

test('membership inventory includes unconfigured guilds without permitting management', async () => {
  running = await startServer();
  const session = await login();
  const original = running.app.adapter.status.bind(running.app.adapter);
  running.app.adapter.status = () => ({
    ...original(),
    guildIds: [running!.env.guildId, '999999999999999999'],
    guilds: [{ id: '999999999999999999', name: 'Another server', icon_url: null }],
  });
  const inventory = await invoke(session, 'list_guilds', {});
  expect(inventory.data.items).toContainEqual(
    expect.objectContaining({
      name: 'Another server',
      bot_present: true,
      configured: false,
      manageable: false,
    }),
  );
  expect(
    (await invoke(session, 'get_guild_overview', { guild_id: '999999999999999999' })).data.error.code,
  ).toBe('guild_not_allowed');
});

test('blueprints can plan, apply and verify through the authenticated dashboard', async () => {
  running = await startServer();
  const session = await login();
  const guild_id = running.env.guildId;
  const blueprint = {
    version: 1,
    roles: [{ key: 'web-role', name: 'Web role' }],
    channels: [{ key: 'web-room', name: 'web-room' }],
  };
  const planned = await invoke(session, 'plan_blueprint', { guild_id, blueprint });
  expect(planned.ok).toBe(true);
  const applied = await invoke(session, 'apply_plan', { guild_id, plan_id: planned.data.plan_id });
  expect(applied.ok).toBe(true);
  expect(applied.data.status).toBe('applied');
  const verified = await invoke(session, 'verify_blueprint', { guild_id, blueprint });
  expect(verified.data.in_sync).toBe(true);
});

test('prompt inbox persists, is guild-scoped and supports agent replies through MCP', async () => {
  running = await startServer();
  const session = await login();
  const guild_id = running.env.guildId;
  const queued = await invoke(session, 'submit_dashboard_prompt', {
    guild_id,
    prompt: '<script>inspect roles</script>',
  });
  expect(queued.data.status).toBe('pending');
  const reopened = new Store(running.env.dbPath);
  try {
    expect(
      reopened.db.prepare('SELECT prompt FROM dashboard_prompts WHERE id = ?').get(queued.data.id),
    ).toEqual({ prompt: '<script>inspect roles</script>' });
  } finally {
    reopened.close();
  }
  const client = await connect(running.url, FULL_TOKEN);
  try {
    const inbox = await call<{ items: Array<{ prompt: { untrusted_text: string } }> }>(
      client,
      'list_dashboard_prompts',
      { guild_id },
    );
    expect(inbox.data.items[0]!.prompt.untrusted_text).toBe('<script>inspect roles</script>');
    const reply = await call(client, 'reply_dashboard_prompt', {
      guild_id,
      prompt_id: queued.data.id,
      reply: 'Inspected. No changes made.',
    });
    expect(reply.isError).toBe(false);
    const updated = await invoke(session, 'list_dashboard_prompts', { guild_id, status: 'all' });
    expect(updated.data.items[0].status).toBe('completed');
    expect(updated.data.items[0].reply.untrusted_text).toBe('Inspected. No changes made.');
    expect(
      (
        await call(client, 'reply_dashboard_prompt', {
          guild_id,
          prompt_id: queued.data.id,
          reply: 'Duplicate',
        })
      ).isError,
    ).toBe(true);
  } finally {
    await client.close();
  }
  expect(running.env.adapter.calls).toEqual([]);
});

test('exporting for the dashboard pins IDs so planning does not duplicate existing resources', async () => {
  running = await startServer();
  const session = await login();
  const guild_id = running.env.guildId;
  running.env.adapter.addRole({ name: 'Existing role' });
  running.env.adapter.addChannel({ name: 'existing-room' });
  const exported = await invoke(session, 'export_blueprint', {
    guild_id,
    record_mappings: false,
    include_ids: true,
  });
  expect(exported.ok).toBe(true);
  const planned = await invoke(session, 'plan_blueprint', { guild_id, blueprint: exported.data.blueprint });
  expect(planned.ok).toBe(true);
  expect(planned.data.summary.create).toBe(0);
  expect(planned.data.blocked).toEqual([]);
});
