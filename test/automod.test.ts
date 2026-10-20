import { afterEach, describe, expect, test } from 'vitest';
import YAML from 'yaml';
import type { AutoModRuleInfo, AutoModWriteBody } from '../src/discord/types.js';
import type { TestEnv } from './helpers/env.js';
import { makeEnv } from './helpers/env.js';
import type { Running } from './helpers/server.js';
import { FULL_TOKEN, call, connect, startServer } from './helpers/server.js';

/**
 * Discord can list an AutoMod rule that it keeps for itself (a Community
 * server's built-in mention-spam rule, for example) and answer 404 when a bot
 * changes or deletes it. Nothing here depends on the rule's name or id.
 */

let env: TestEnv | undefined;
let running: Running | undefined;
afterEach(async () => {
  await running?.close();
  running = undefined;
  env?.cleanup();
  env = undefined;
});

type Exported = {
  automod?: Array<{ key: string; name: string; trigger: Record<string, unknown>; actions: unknown[] }>;
  categories: Array<{ key: string; channels: Array<{ key: string; name: string }> }>;
  channels?: Array<{ key: string; name: string }>;
  messages?: unknown[];
  roles: Array<Record<string, unknown>>;
};

/** A mention-spam rule like the one Discord adds, plus an action type steward does not model. */
function kept(e: TestEnv, readable: 'readable' | 'hidden' | 'returns' = 'readable'): AutoModRuleInfo {
  return e.adapter.addAutoModRule(
    {
      name: 'Server mention guard',
      triggerType: 5,
      triggerMetadata: { mention_total_limit: 20, mention_raid_protection_enabled: true },
      actions: [{ type: 1, metadata: { custom_message: '' } }, { type: 4 }],
    },
    readable,
  );
}

async function exportBlueprint(e: TestEnv) {
  const out = await e.service.export({
    guildId: e.guildId,
    format: 'yaml',
    includeIds: false,
    recordMappings: true,
  });
  return { blueprint: YAML.parse(out.text) as Exported, notes: out.notes };
}

async function planAndApply(e: TestEnv, blueprint: unknown, options?: object, canDestroy = false) {
  const { record, body } = await e.service.createPlan({
    guildId: e.guildId,
    blueprint,
    clientId: 'test',
    options: options as never,
  });
  const result = await e.service.apply({
    planId: record.id,
    guildId: e.guildId,
    clientId: 'test',
    canDestroy,
    continueOnError: false,
    acceptBlocked: false,
  });
  return { body, result };
}

const edits = (e: TestEnv) =>
  e.adapter.calls.filter((c) => c.method === 'editAutoModRule').map((c) => c.args[2] as AutoModWriteBody);
const writes = (e: TestEnv, method: string) => e.adapter.calls.filter((c) => c.method === method).length;

describe('AutoMod rules Discord keeps for itself', () => {
  test('export keeps what is there, and re-planning it changes nothing', async () => {
    env = makeEnv();
    const rule = kept(env);
    const { blueprint, notes } = await exportBlueprint(env);
    expect(blueprint.automod).toEqual([
      expect.objectContaining({
        name: 'Server mention guard',
        trigger: { type: 'mention_spam', mention_total_limit: 20, raid_protection: true },
        actions: [{ type: 'block_message' }],
      }),
    ]);
    expect(notes.join('\n')).toMatch(
      /"Server mention guard" has 1 action\(s\) blueprints cannot describe \(type 4\)/,
    );
    const { body } = await env.service.createPlan({ guildId: env.guildId, blueprint, clientId: 'test' });
    expect(body.steps).toEqual([]);
    expect(body.warnings.map((w) => w.code)).toContain('automod_unmodelled');
    expect((await env.service.verify(env.guildId, blueprint)).inSync).toBe(true);
    expect(env.adapter.automod.get(rule.id)).toEqual(rule);
  });

  test('list, export, edit, then a 404: the step fails with a diagnosis and the rest of the apply runs', async () => {
    env = makeEnv();
    const rule = kept(env);
    env.adapter.addChannel({ name: 'general' });
    const { blueprint } = await exportBlueprint(env);
    blueprint.automod![0]!.trigger.mention_total_limit = 10;
    const general = [...(blueprint.channels ?? []), ...blueprint.categories.flatMap((c) => c.channels)].find(
      (c) => c.name === 'general',
    )!;
    blueprint.messages = [{ key: 'hello', channel: general.key, content: 'Hello!' }];
    env.adapter.calls = [];

    const { body, result } = await planAndApply(env, blueprint);
    expect(body.steps.find((s) => s.action === 'update_automod')!.summary).toBe(
      'update AutoMod rule "Server mention guard": trigger_metadata',
    );
    const step = result.steps.find((s) => s.action === 'update_automod')!;
    expect(step.status).toBe('failed');
    expect(step.error).toMatch(
      /Discord answered 404 Not Found when steward tried to change AutoMod rule "Server mention guard" \(\d+, mention_spam\) \(trigger_metadata\)\. Discord still lists it and returns it when read by its id, but refuses this change\./,
    );
    expect(step.error).toMatch(/did not delete, recreate or skip it/);
    expect(step.error).toMatch(/Change it in the server's AutoMod settings in Discord/);
    expect(step.opIds).toHaveLength(1);
    // Only the differing field was sent, laid over the live metadata.
    expect(edits(env)).toEqual([
      { trigger_metadata: { mention_total_limit: 10, mention_raid_protection_enabled: true } },
    ]);
    // Independent work after the refusal still happened; nothing was deleted or recreated.
    expect(result.steps.find((s) => s.action === 'post_message')!.status).toBe('succeeded');
    expect(result.status).toBe('partial');
    expect(result.notes.join()).toMatch(/Discord refused "update AutoMod rule/);
    expect(writes(env, 'deleteAutoModRule') + writes(env, 'createAutoModRule')).toBe(0);
    expect(env.adapter.automod.get(rule.id)).toEqual(rule);
    // Verify still reports the difference instead of hiding it.
    expect((await env.service.verify(env.guildId, blueprint)).inSync).toBe(false);
  });

  test('a rule that cannot be read by id either is reported as such', async () => {
    env = makeEnv();
    kept(env, 'hidden');
    const { blueprint } = await exportBlueprint(env);
    blueprint.automod![0]!.trigger.raid_protection = false;
    const { result } = await planAndApply(env, blueprint);
    expect(result.steps.find((s) => s.action === 'update_automod')!.error).toMatch(
      /Discord still lists it, but answers 404 when the rule is read by its id too, so bots cannot address it/,
    );
  });

  test('a rule deleted while the apply runs is reported as stale, with no write', async () => {
    env = makeEnv();
    const rule = env.adapter.addAutoModRule({
      name: 'Links',
      triggerType: 1,
      triggerMetadata: { keyword_filter: ['*http*'] },
    });
    const { blueprint } = await exportBlueprint(env);
    blueprint.automod![0]!.trigger.keywords = ['*discord.gg*'];
    const { record } = await env.service.createPlan({ guildId: env.guildId, blueprint, clientId: 'test' });
    // The apply's own freshness check passes; the rule goes just before the step runs.
    const list = env.adapter.fetchAutoModRules.bind(env.adapter);
    let reads = 0;
    env.adapter.fetchAutoModRules = async () => {
      if (++reads === 2) env!.adapter.automod.delete(rule.id);
      return list();
    };
    const result = await env.service.apply({
      planId: record.id,
      guildId: env.guildId,
      clientId: 'test',
      canDestroy: false,
      continueOnError: false,
      acceptBlocked: false,
    });
    const step = result.steps.find((s) => s.action === 'update_automod')!;
    expect(step.status).toBe('failed');
    expect(step.error).toMatch(/"Links" \(\d+\) is no longer listed by Discord.*plan again/);
    expect(edits(env)).toEqual([]);
    expect(writes(env, 'createAutoModRule')).toBe(0);
  });

  test('an exported rule steward did not create is not pruned without prune_unmanaged', async () => {
    env = makeEnv();
    const rule = kept(env);
    await exportBlueprint(env);
    const empty = { version: 1, roles: [], categories: [], messages: [] };
    const { body } = await env.service.createPlan({
      guildId: env.guildId,
      blueprint: empty,
      clientId: 'test',
      options: { prune: { automod: true } } as never,
    });
    expect(body.steps).toEqual([]);
    expect(body.warnings.find((w) => w.code === 'automod_not_pruned')!.message).toMatch(
      /"Server mention guard" is bound to ".*" but steward did not create it/,
    );
    expect(env.adapter.automod.has(rule.id)).toBe(true);
  });

  test('a 404 on deleting a listed rule is a refusal, not "already gone"', async () => {
    env = makeEnv();
    const rule = kept(env);
    await exportBlueprint(env);
    const empty = { version: 1, roles: [], categories: [], messages: [] };
    const { body, result } = await planAndApply(
      env,
      empty,
      { prune: { automod: true }, prune_unmanaged: true },
      true,
    );
    expect(body.steps.map((s) => s.summary)).toEqual([
      'delete AutoMod rule "Server mention guard" (not created by steward)',
    ]);
    const step = result.steps[0]!;
    expect(step.status).toBe('failed');
    expect(step.error).toMatch(
      /404 Not Found when steward tried to delete AutoMod rule "Server mention guard"/,
    );
    expect(step.error).toMatch(/did not delete, recreate or skip it/);
    expect(env.store.getOperation(step.opIds[0]!)!.status).toBe('failed');
    expect(env.adapter.automod.has(rule.id)).toBe(true);
    expect(env.store.findMappingById(env.guildId, 'automod', rule.id)).toBeDefined();
  });

  test('a delete Discord accepts but does not carry out is reported', async () => {
    env = makeEnv();
    const rule = kept(env, 'returns');
    env.store.setMapping(env.guildId, 'automod', 'mentions', rule.id, 'created');
    const empty = { version: 1, roles: [], categories: [], messages: [] };
    const { result } = await planAndApply(env, empty, { prune: { automod: true } }, true);
    const step = result.steps[0]!;
    expect(step.status).toBe('failed');
    expect(step.error).toMatch(
      /answered the delete of AutoMod rule "Server mention guard" .* with success, but still lists the rule/,
    );
    expect(step.opIds).toHaveLength(1);
    expect(env.store.findMappingById(env.guildId, 'automod', rule.id)).toBeDefined();
  });

  test('a rule steward created is pruned as before', async () => {
    env = makeEnv();
    const bp = {
      version: 1,
      roles: [],
      categories: [],
      messages: [],
      automod: [
        { key: 'spam', name: 'Spam', trigger: { type: 'spam' }, actions: [{ type: 'block_message' }] },
      ],
    };
    await planAndApply(env, bp);
    const id = env.store.getMapping(env.guildId, 'automod', 'spam')!.discordId;
    const empty = { version: 1, roles: [], categories: [], messages: [] };
    const { result } = await planAndApply(env, empty, { prune: { automod: true } }, true);
    expect(result.status).toBe('applied');
    expect(env.adapter.automod.has(id)).toBe(false);
    expect(env.store.getMapping(env.guildId, 'automod', 'spam')).toBeUndefined();
  });
});

describe('AutoMod deletes and refusals, found in review', () => {
  const empty = { version: 1, roles: [], categories: [], messages: [] };
  const createdRule = (e: TestEnv) => {
    const rule = e.adapter.addAutoModRule({ name: 'Spam', triggerType: 3, creatorId: e.adapter.botUserId });
    e.store.setMapping(e.guildId, 'automod', 'spam', rule.id, 'created');
    return rule;
  };

  test('a delete whose response was lost, then 404s on retry, is done once the rule is gone', async () => {
    env = makeEnv();
    const rule = createdRule(env);
    env.adapter.inject('deleteAutoModRule', 'timeout_after');
    const { result } = await planAndApply(env, empty, { prune: { automod: true } }, true);
    expect(result.status).toBe('applied');
    expect(env.adapter.automod.has(rule.id)).toBe(false);
    expect(env.store.getOperation(result.steps[0]!.opIds[0]!)!.status).toBe('succeeded');
    expect(env.store.getMapping(env.guildId, 'automod', 'spam')).toBeUndefined();
  });

  test('a delete that cannot be read back still counts, with a note', async () => {
    env = makeEnv();
    const rule = createdRule(env);
    env.adapter.inject('fetchAutoModRules', 'timeout_before', {
      when: () => !env!.adapter.automod.has(rule.id),
    });
    const { result } = await planAndApply(env, empty, { prune: { automod: true } }, true);
    const step = result.steps[0]!;
    expect(step.status).toBe('succeeded');
    expect(step.note).toMatch(/could not list the rules afterwards to confirm it/);
    expect(env.store.getMapping(env.guildId, 'automod', 'spam')).toBeUndefined();
  });

  test('after a refusal, deletions in the same run wait unless continue_on_error is set', async () => {
    for (const continueOnError of [false, true]) {
      env?.cleanup();
      env = makeEnv();
      const old = env.adapter.addChannel({ name: 'old-log' });
      env.store.setMapping(env.guildId, 'channel', 'old-log', old.id, 'created');
      const rule = kept(env);
      env.store.setMapping(env.guildId, 'automod', 'mentions', rule.id, 'exported');
      const bp = {
        ...empty,
        automod: [
          {
            key: 'mentions',
            name: 'Server mention guard',
            trigger: { type: 'mention_spam', mention_total_limit: 9, raid_protection: true },
            actions: [{ type: 'block_message' }],
          },
        ],
      };
      const { record } = await env.service.createPlan({
        guildId: env.guildId,
        blueprint: bp,
        clientId: 'test',
        options: { prune: { channels: true } } as never,
      });
      const result = await env.service.apply({
        planId: record.id,
        guildId: env.guildId,
        clientId: 'test',
        canDestroy: true,
        continueOnError,
        acceptBlocked: false,
      });
      const del = result.steps.find((s) => s.action === 'delete_channel')!;
      expect(result.steps.find((s) => s.action === 'update_automod')!.status).toBe('failed');
      if (continueOnError) {
        expect(del.status).toBe('succeeded');
      } else {
        expect(del.status).toBe('skipped');
        expect(del.error).toMatch(/Discord refused step .* deletions wait/);
        expect(env.adapter.channels.has(old.id)).toBe(true);
      }
    }
  });
});

describe('AutoMod updates send only what changed', () => {
  test('actions steward does not model are carried over, not erased', async () => {
    env = makeEnv();
    const alerts = env.adapter.addChannel({ name: 'mod-log' });
    const rule = env.adapter.addAutoModRule({
      name: 'Bad words',
      triggerType: 1,
      triggerMetadata: { keyword_filter: ['badword'], future_key: 'kept' },
      actions: [{ type: 1 }, { type: 9, metadata: { something: 1 } }],
    });
    const { blueprint } = await exportBlueprint(env);
    const entry = blueprint.automod![0]!;

    (entry as { enabled?: boolean }).enabled = false;
    await planAndApply(env, blueprint);
    expect(edits(env)).toEqual([{ enabled: false }]);

    const modLog = blueprint.categories
      .flatMap((c) => c.channels)
      .concat(blueprint.channels ?? [])
      .find((c) => c.name === 'mod-log')!;
    entry.actions.push({ type: 'alert', channel: modLog.key });
    entry.trigger.keywords = ['badword', 'worseword'];
    await planAndApply(env, blueprint);
    const second = edits(env)[1]!;
    expect(second.actions).toEqual([
      { type: 1 },
      { type: 2, metadata: { channel_id: alerts.id } },
      { type: 9, metadata: { something: 1 } },
    ]);
    expect(second.trigger_metadata).toMatchObject({
      keyword_filter: ['badword', 'worseword'],
      future_key: 'kept',
    });
    expect(env.adapter.automod.get(rule.id)!.actions).toContainEqual({ type: 9, metadata: { something: 1 } });
    expect((await env.service.verify(env.guildId, blueprint)).inSync).toBe(true);
  });

  test('a second mention-spam rule is blocked with the existing one named, not created', async () => {
    env = makeEnv();
    kept(env);
    const bp = {
      version: 1,
      roles: [],
      categories: [],
      messages: [],
      automod: [
        {
          key: 'mentions',
          name: 'Mentions',
          trigger: { type: 'mention_spam', mention_total_limit: 8 },
          actions: [{ type: 'block_message' }],
        },
      ],
    };
    const { body } = await env.service.createPlan({ guildId: env.guildId, blueprint: bp, clientId: 'test' });
    expect(body.steps[0]!.blocked).toMatch(
      /maximum number of mention_spam rules \(1\): "Server mention guard".*same name.*instead of creating another/,
    );
  });
});

describe('AutoMod MCP tools', () => {
  test('upsert and delete report a rule Discord keeps instead of claiming success', async () => {
    env = makeEnv();
    const rule = kept(env);
    env.store.setMapping(env.guildId, 'automod', 'mentions', rule.id, 'manual');
    running = await startServer({}, env);
    const client = await connect(running.url, FULL_TOKEN);
    const guild_id = env.guildId;

    const same = await call<{ changed: string[] }>(client, 'upsert_automod_rule', {
      guild_id,
      key: 'mentions',
      name: 'Server mention guard',
      trigger: { type: 'mention_spam', mention_total_limit: 20, raid_protection: true },
      actions: [{ type: 'block_message' }],
    });
    expect(same.data.changed).toEqual([]);
    expect(edits(env)).toEqual([]);

    const changed = await call<{
      error: { message: string; details: { listed: boolean; readable_by_id: boolean } };
    }>(client, 'upsert_automod_rule', {
      guild_id,
      key: 'mentions',
      name: 'Server mention guard',
      trigger: { type: 'mention_spam', mention_total_limit: 5, raid_protection: true },
      actions: [{ type: 'block_message' }],
    });
    expect(changed.isError).toBe(true);
    expect(changed.data.error.message).toMatch(/404 Not Found when steward tried to change/);
    expect(changed.data.error.details).toMatchObject({ listed: true, readable_by_id: true });

    const del = await call<{ error: { message: string } }>(client, 'delete_automod_rule', {
      guild_id,
      rule_id: rule.id,
      confirm_name: 'Server mention guard',
    });
    expect(del.isError).toBe(true);
    expect(del.data.error.message).toMatch(/404 Not Found when steward tried to delete/);
    expect(env.adapter.automod.has(rule.id)).toBe(true);
    expect(env.store.getMapping(guild_id, 'automod', 'mentions')?.discordId).toBe(rule.id);
  });
});
