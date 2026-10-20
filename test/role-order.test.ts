import { afterEach, describe, expect, test } from 'vitest';
import { canBotManageRole, rolesOutOfBotReach } from '../src/discord/permissions.js';
import type { PositionUpdate } from '../src/discord/types.js';
import { roleOrderPlan } from '../src/ops/ordering.js';
import type { TestEnv } from './helpers/env.js';
import { makeEnv } from './helpers/env.js';
import { MemoryDiscordAdapter } from './helpers/memory-adapter.js';
import type { Running } from './helpers/server.js';
import { FULL_TOKEN, call, connect, startServer } from './helpers/server.js';

/**
 * Discord lets several roles share a `position` and breaks the tie by id (the
 * lower id ranks higher). These tests run against the memory adapter's default
 * 'discord' model: new roles land on position 1 without renumbering anything,
 * and position updates are stored exactly as sent.
 */

let env: TestEnv | undefined;
let running: Running | undefined;
afterEach(async () => {
  await running?.close();
  running = undefined;
  env?.cleanup();
  env = undefined;
});

const roleBlueprint = (keys: string[]) => ({
  version: 1,
  roles: keys.map((key) => ({ key, name: key })),
  categories: [],
  messages: [],
});

/** Role names top first, @everyone left out. */
const order = (d: MemoryDiscordAdapter) =>
  [...d.roles.values()]
    .filter((r) => r.id !== d.guildId)
    .sort((a, b) => b.position - a.position || (BigInt(a.id) < BigInt(b.id) ? -1 : 1))
    .map((r) => r.name);

const positionCalls = (d: MemoryDiscordAdapter) =>
  d.calls.filter((c) => c.method === 'setRolePositions').map((c) => c.args[1] as PositionUpdate[]);

/** A role whose id is lower than the bot's role, so it wins a position tie against it. */
const olderThanBot = (d: MemoryDiscordAdapter, name: string, position: number) =>
  d.addRole({ id: (BigInt(d.botRoleId) - 1000n).toString(), name, position });

async function planAndApply(e: TestEnv, blueprint: unknown, acceptBlocked = false) {
  const { record, body } = await e.service.createPlan({ guildId: e.guildId, blueprint, clientId: 'test' });
  const result = await e.service.apply({
    planId: record.id,
    guildId: e.guildId,
    clientId: 'test',
    canDestroy: false,
    continueOnError: false,
    acceptBlocked,
  });
  return { body, result };
}

function mapRoles(e: TestEnv, names: string[]) {
  return names.map((name) => {
    const role = e.adapter.addRole({ name, position: 1 });
    e.store.setMapping(e.guildId, 'role', name, role.id, 'manual');
    return role;
  });
}

describe('role order with tied positions', () => {
  test('tied roles are renumbered instead of reported as already in order', async () => {
    const d = new MemoryDiscordAdapter({ botRolePosition: 10 });
    const [a, b, c] = ['A', 'B', 'C'].map((name) => d.addRole({ name, position: 1 }));
    expect(order(d)).toEqual(['Steward', 'A', 'B', 'C']);
    const plan = roleOrderPlan(await d.fetchSnapshot(d.guildId), [c!.id, b!.id, a!.id]);
    expect(plan.inOrder).toBe(false);
    expect(plan.blocker).toBeNull();
    expect(plan.updates.length).toBeGreaterThan(0);
    for (const u of plan.updates) d.roles.get(u.id)!.position = u.position;
    expect(order(d)).toEqual(['Steward', 'C', 'B', 'A']);
    expect(roleOrderPlan(await d.fetchSnapshot(d.guildId), [c!.id, b!.id, a!.id]).inOrder).toBe(true);
  });

  test('a shared position is reused only where the id tie-breaker gives the wanted order', async () => {
    // Room for two distinct positions below the bot, four roles to order.
    const d = new MemoryDiscordAdapter({ botRolePosition: 3 });
    const [a, b, c, e] = ['A', 'B', 'C', 'D'].map((name) => d.addRole({ name, position: 1 }));
    const wanted = [a!.id, b!.id, e!.id, c!.id];
    const plan = roleOrderPlan(await d.fetchSnapshot(d.guildId), wanted);
    expect(plan.blocker).toBeNull();
    for (const u of plan.updates) expect(u.position).toBeLessThan(3);
    for (const u of plan.updates) d.roles.get(u.id)!.position = u.position;
    expect(order(d)).toEqual(['Steward', 'A', 'B', 'D', 'C']);
  });

  test('blueprint plan, apply, verify and re-plan agree on tied roles', async () => {
    env = makeEnv();
    mapRoles(env, ['bottom', 'middle', 'top']);
    expect(order(env.adapter)).toEqual(['Steward', 'bottom', 'middle', 'top']);
    const bp = roleBlueprint(['top', 'middle', 'bottom']);

    const { body, result } = await planAndApply(env, bp);
    const step = body.steps.find((s) => s.action === 'reorder_roles')!;
    expect(step.blocked).toBeUndefined();
    const ran = result.steps.find((s) => s.action === 'reorder_roles')!;
    expect(ran.status).toBe('succeeded');
    expect(ran.note).toBeUndefined();
    expect(order(env.adapter)).toEqual(['Steward', 'top', 'middle', 'bottom']);

    const verify = await env.service.verify(env.guildId, bp);
    expect(verify.inSync).toBe(true);
    const again = await env.service.createPlan({ guildId: env.guildId, blueprint: bp, clientId: 'test' });
    expect(again.body.steps.filter((s) => s.action !== 'adopt')).toEqual([]);
  });

  test('a fresh server where every new role lands on position 1 converges in one apply', async () => {
    env = makeEnv();
    // Existing roles sit on position 1 too, as Discord leaves them.
    mapRoles(env, ['member']);
    const bp = roleBlueprint(['admin', 'mod', 'member', 'muted']);
    const { result } = await planAndApply(env, bp);
    expect(result.status).toBe('applied');
    expect(order(env.adapter)).toEqual(['Steward', 'admin', 'mod', 'member', 'muted']);
    expect((await env.service.verify(env.guildId, bp)).inSync).toBe(true);
  });

  test('roles the blueprint does not manage keep their slots', async () => {
    env = makeEnv();
    const [x] = mapRoles(env, ['x']);
    const handMade = env.adapter.addRole({ name: 'Hand-made', position: 1 });
    const [y] = mapRoles(env, ['y']);
    expect(order(env.adapter)).toEqual(['Steward', 'x', 'Hand-made', 'y']);
    const { result } = await planAndApply(env, roleBlueprint(['y', 'x']));
    expect(result.status).toBe('applied');
    expect(order(env.adapter)).toEqual(['Steward', 'y', 'Hand-made', 'x']);
    expect([x, y, handMade].every((r) => env!.adapter.roles.get(r!.id))).toBe(true);
  });

  test('never sends the bot role, roles above it, or a position at or above it', async () => {
    env = makeEnv({ botRolePosition: 50 });
    const owner = env.adapter.addRole({ name: 'Owner', position: 60 });
    mapRoles(env, ['c', 'b', 'a']);
    await planAndApply(env, roleBlueprint(['a', 'b', 'c']));
    const sent = positionCalls(env.adapter).flat();
    expect(sent.length).toBeGreaterThan(0);
    for (const u of sent) {
      expect([env.adapter.botRoleId, owner.id, env.guildId]).not.toContain(u.id);
      expect(u.position).toBeGreaterThan(0);
      expect(u.position).toBeLessThan(50);
    }
    expect(env.adapter.roles.get(owner.id)!.position).toBe(60);
    expect(env.adapter.roles.get(env.adapter.botRoleId)!.position).toBe(50);
  });

  test('the older renumbering model still converges', async () => {
    env = makeEnv({ rolePositions: 'normalised' });
    const bp = roleBlueprint(['one', 'two', 'three']);
    expect((await planAndApply(env, bp)).result.status).toBe('applied');
    mapRoles(env, []);
    expect((await env.service.verify(env.guildId, roleBlueprint(['one', 'two', 'three']))).inSync).toBe(true);
    const flipped = roleBlueprint(['three', 'two', 'one']);
    expect((await planAndApply(env, flipped)).result.status).toBe('applied');
    expect((await env.service.verify(env.guildId, flipped)).inSync).toBe(true);
  });
});

describe('when the order cannot be reached', () => {
  test('too little room under the bot is a concrete blocker at plan time, with no write', async () => {
    env = makeEnv({ botRolePosition: 2 });
    mapRoles(env, ['c', 'b', 'a']);
    const bp = roleBlueprint(['a', 'b', 'c']);
    const { body, result } = await planAndApply(env, bp, true);
    const step = body.steps.find((s) => s.action === 'reorder_roles')!;
    expect(step.blocked).toMatch(
      /needs 3 distinct positions below the bot's highest role "Steward".*position 2.*leaves 1/,
    );
    expect(step.blocked).toMatch(/Drag the bot's role higher/);
    expect(result.steps.find((s) => s.action === 'reorder_roles')!.status).toBe('blocked');
    expect(positionCalls(env.adapter)).toEqual([]);
    expect((await env.service.verify(env.guildId, bp)).inSync).toBe(false);
  });

  test('the bot role sharing position 1 with the roles below it blocks ordering', async () => {
    const d = new MemoryDiscordAdapter({ botRolePosition: 1 });
    const [a, b] = ['A', 'B'].map((name) => d.addRole({ name, position: 1 }));
    // The bot's role is older, so it still ranks above both.
    expect(order(d)).toEqual(['Steward', 'A', 'B']);
    const plan = roleOrderPlan(await d.fetchSnapshot(d.guildId), [b!.id, a!.id]);
    expect(plan.blocker).toMatch(/at position 1, which leaves 0 .*shared positions/);
    expect(plan.updates).toEqual([]);
  });

  test('a blocker that only appears once new roles exist fails the step instead of claiming success', async () => {
    env = makeEnv({ botRolePosition: 2 });
    mapRoles(env, ['member']);
    // "admin" is created after "member", so it loses the tie on position 1.
    const bp = roleBlueprint(['admin', 'member']);
    const { body, result } = await planAndApply(env, bp);
    expect(body.warnings.map((w) => w.code)).toContain('role_order_at_risk');
    const step = result.steps.find((s) => s.action === 'reorder_roles')!;
    expect(step.status).toBe('failed');
    expect(step.error).toMatch(/cannot order the roles: the order needs 2 distinct positions/);
    expect(result.status).not.toBe('applied');
    expect(positionCalls(env.adapter)).toEqual([]);
  });

  test('Discord accepting positions without applying them is reported, not called success', async () => {
    env = makeEnv();
    mapRoles(env, ['c', 'b', 'a']);
    env.adapter.inject('setRolePositions', 'ignored');
    const bp = roleBlueprint(['a', 'b', 'c']);
    const { result } = await planAndApply(env, bp);
    const step = result.steps.find((s) => s.action === 'reorder_roles')!;
    expect(step.status).toBe('failed');
    expect(step.error).toMatch(
      /Discord accepted the new role positions, but the roles are still out of order\. Wanted a > b > c; Discord now reports c > b > a/,
    );
    expect((await env.service.verify(env.guildId, bp)).inSync).toBe(false);
  });
});

describe('hierarchy with equal positions', () => {
  function tiedWithBot() {
    const d = new MemoryDiscordAdapter({ botRolePosition: 5 });
    // Same raw position as the bot's role: the newer one ranks below it, the older one above.
    const below = d.addRole({ name: 'Tied newer', position: 5 });
    const above = olderThanBot(d, 'Tied older', 5);
    return { d, below, above };
  }

  test('warnings, checks and mutations agree on both sides of the tie', async () => {
    const { d, below, above } = tiedWithBot();
    const s = await d.fetchSnapshot(d.guildId);
    expect(order(d)).toEqual(['Tied older', 'Steward', 'Tied newer']);
    expect(rolesOutOfBotReach(s).map((r) => r.name)).toEqual(['Tied older']);
    expect(canBotManageRole(s, below, 'assign').ok).toBe(true);
    expect(canBotManageRole(s, above, 'assign').reason).toMatch(/at or above the bot's highest role/);
  });

  test('MCP tools: overview, hierarchy check, assignment and placement', async () => {
    env = makeEnv({ botRolePosition: 5 });
    const below = env.adapter.addRole({ name: 'Tied newer', position: 5 });
    const above = olderThanBot(env.adapter, 'Tied older', 5);
    running = await startServer({}, env);
    const client = await connect(running.url, FULL_TOKEN);
    const guild_id = env.guildId;

    const overview = await call<{ bot: { roles_at_or_above_bot: number; warnings: string[] } }>(
      client,
      'get_guild_overview',
      { guild_id },
    );
    expect(overview.data.bot.roles_at_or_above_bot).toBe(1);
    expect(overview.data.bot.warnings[0]).toMatch(
      /1 role\(s\) sit at or above the bot's highest role.*: Tied older\./,
    );

    const h = await call<{ items: Array<{ name: string; assign: string; edit: string }> }>(
      client,
      'check_role_hierarchy',
      { guild_id },
    );
    const row = (name: string) => h.data.items.find((r) => r.name === name)!;
    expect(row('Tied newer').assign).toBe('ok');
    expect(row('Tied newer').edit).toBe('ok');
    expect(row('Tied older').assign).toMatch(/at or above the bot's highest role/);

    const m = env.adapter.addMember();
    const ok = await call<{ applied: number }>(client, 'assign_roles', {
      guild_id,
      changes: [{ user_id: m.userId, add: [below.id] }],
    });
    expect(ok.data.applied).toBe(1);
    const refused = await call<{ error: { code: string } }>(client, 'assign_roles', {
      guild_id,
      changes: [{ user_id: m.userId, add: [above.id] }],
    });
    expect(refused.data.error.code).toBe('precondition_failed');

    const underTied = await call<{ role_id: string; placement: { placed: boolean } }>(client, 'create_role', {
      guild_id,
      name: 'Under tied',
      place_below_role_id: below.id,
    });
    expect(underTied.isError).toBe(false);
    expect(underTied.data.placement).toEqual({ placed: true });
    const notUnderOlder = await call<{ error: { message: string } }>(client, 'create_role', {
      guild_id,
      name: 'Nope',
      place_below_role_id: above.id,
    });
    expect(notUnderOlder.data.error.message).toMatch(/above the bot's highest role/);
    const underBot = await call<{ placement: { placed: boolean } }>(client, 'create_role', {
      guild_id,
      name: 'Under bot',
      place_below_role_id: env.adapter.botRoleId,
    });
    expect(underBot.data.placement).toEqual({ placed: true });
    expect(order(env.adapter)).toEqual(['Tied older', 'Steward', 'Under bot', 'Tied newer', 'Under tied']);
  });

  test('the planner blocks only the role on the wrong side of the tie', async () => {
    env = makeEnv({ botRolePosition: 5 });
    const below = env.adapter.addRole({ name: 'below', position: 5 });
    const above = olderThanBot(env.adapter, 'above', 5);
    env.store.setMapping(env.guildId, 'role', 'below', below.id, 'manual');
    env.store.setMapping(env.guildId, 'role', 'above', above.id, 'manual');
    const bp = {
      version: 1,
      roles: [
        { key: 'above', name: 'above', hoist: true },
        { key: 'below', name: 'below', hoist: true },
      ],
      categories: [],
      messages: [],
    };
    const { body } = await env.service.createPlan({ guildId: env.guildId, blueprint: bp, clientId: 'test' });
    const update = (key: string) =>
      body.steps.find((s) => s.action === 'update_role' && s.summary.includes(`"${key}"`))!;
    expect(update('above').blocked).toMatch(/at or above the bot's highest role/);
    expect(update('below').blocked).toBeUndefined();
  });
});
