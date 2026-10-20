import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, test } from 'vitest';
import type { Running } from './helpers/server.js';
import { FULL_TOKEN, call, connect, startServer } from './helpers/server.js';

let running: Running | undefined;
afterEach(async () => {
  await running?.close();
  running = undefined;
});

describe('MCP over Streamable HTTP with a real client', () => {
  test('initialize, discover tools, and run the blueprint workflow end to end', async () => {
    running = await startServer();
    const client = await connect(running.url, FULL_TOKEN);
    expect(client.getServerVersion()?.name).toBe('steward');
    expect(client.getInstructions()).toContain('untrusted');

    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const expected of [
      'steward_status',
      'plan_blueprint',
      'apply_plan',
      'verify_blueprint',
      'delete_channel',
      'export_blueprint',
    ]) {
      expect(names).toContain(expected);
    }
    const del = tools.find((t) => t.name === 'delete_channel')!;
    expect(del.annotations?.destructiveHint).toBe(true);
    expect(tools.find((t) => t.name === 'list_roles')!.annotations?.readOnlyHint).toBe(true);

    const status = await call(client, 'steward_status');
    expect(status.isError).toBe(false);
    expect((status.data.discord as { state: string }).state).toBe('ready');

    const guild_id = running.env.guildId;
    const blueprint = readFileSync('examples/community.yaml', 'utf8');
    const valid = await call(client, 'validate_blueprint', { blueprint });
    expect(valid.data.valid).toBe(true);

    const plan = await call<{ plan_id: string; summary: { create: number; blocked: number } }>(
      client,
      'plan_blueprint',
      { guild_id, blueprint },
    );
    expect(plan.isError).toBe(false);
    expect(plan.data.summary.create).toBeGreaterThan(30);
    expect(plan.data.summary.blocked).toBe(0);

    const applied = await call<{ status: string }>(client, 'apply_plan', {
      guild_id,
      plan_id: plan.data.plan_id,
    });
    expect(applied.data.status).toBe('applied');

    const verified = await call<{ in_sync: boolean }>(client, 'verify_blueprint', { guild_id, blueprint });
    expect(verified.data.in_sync).toBe(true);

    const again = await call<{
      summary: { create: number; update: number; delete: number };
      steps: string[];
    }>(client, 'plan_blueprint', { guild_id, blueprint });
    expect(again.data.summary).toMatchObject({ create: 0, update: 0, delete: 0 });
    expect(again.data.steps).toEqual([]);

    const exported = await call<{ blueprint: string }>(client, 'export_blueprint', { guild_id });
    expect(exported.data.blueprint).toContain('key: staff-chat');

    const overview = await call<{ bot: { administrator: boolean } }>(client, 'get_guild_overview', {
      guild_id,
    });
    expect(overview.data.bot.administrator).toBe(true);
    await client.close();
  });
});
