import { z } from 'zod';
import type { ApplyResult } from '../../blueprint/apply.js';
import type { PlanBody, PlanStep } from '../../blueprint/plan-types.js';
import { KEY_RE } from '../../blueprint/schema.js';
import { validateBlueprint } from '../../blueprint/validate.js';
import type { PlanRecord } from '../../store.js';
import { StewardError } from '../../util/errors.js';
import { defineTool } from '../registry.js';
import type { CallContext } from '../registry.js';
import {
  cursorInput,
  guildIdInput,
  limitInput,
  paginate,
  requireFound,
  snapshotOf,
  snowflake,
} from './common.js';

const blueprintInput = z
  .union([z.string().max(1_000_000), z.record(z.string(), z.unknown())])
  .describe('The blueprint as YAML or JSON text, or as an object. See blueprint_reference for the format.');

const detailInput = z
  .enum(['summary', 'full'])
  .default('summary')
  .describe('"summary" returns one line per step; "full" returns every field and change.');

const pruneInput = z
  .object({
    roles: z.boolean().optional(),
    channels: z.boolean().optional(),
    overwrites: z.boolean().optional(),
    messages: z.boolean().optional(),
    automod: z.boolean().optional(),
    panels: z.boolean().optional(),
  })
  .optional()
  .describe(
    'Delete steward-managed resources the blueprint no longer lists. Off unless set. Applying a plan with deletions needs the destructive scope.',
  );

function line(s: PlanStep): string {
  return `${s.id} ${s.summary}${s.destructive ? ' [destructive]' : ''}${s.blocked ? ` [BLOCKED: ${s.blocked}]` : ''}`;
}

function planView(record: PlanRecord, body: PlanBody, detail: 'summary' | 'full', limit = 150) {
  const blocked = body.steps.filter((s) => s.blocked);
  const destructive = body.steps.filter((s) => s.destructive);
  const nothing = body.steps.length === 0;
  return {
    plan_id: record.id,
    guild: { id: body.guildId, name: body.guildName },
    status: record.status,
    expires_at: record.expiresAt,
    blueprint: { name: body.blueprintName, hash: body.blueprintHash },
    options: body.options,
    summary: body.summary,
    destructive_steps: destructive.length,
    blocked: blocked.slice(0, 30).map((s) => ({ step: s.id, summary: s.summary, reason: s.blocked })),
    unsupported: body.unsupported,
    warnings: body.warnings.slice(0, 40).map((w) => w.message),
    more_warnings: Math.max(0, body.warnings.length - 40) || undefined,
    steps: detail === 'full' ? body.steps.slice(0, limit) : body.steps.slice(0, limit).map(line),
    more_steps: Math.max(0, body.steps.length - limit) || undefined,
    next: nothing
      ? 'Nothing to do: the server already matches the blueprint.'
      : `Review the steps, then call apply_plan with plan_id "${record.id}" and guild_id before ${record.expiresAt}.${
          blocked.length
            ? ' Blocked steps will not run; fix them and re-plan, or pass accept_blocked: true.'
            : ''
        }${destructive.length ? ' This plan deletes or removes things and needs the destructive scope.' : ''}`,
  };
}

function applyView(result: ApplyResult, detail: 'summary' | 'full', running: boolean) {
  const done = new Set(['succeeded', 'recovered', 'noop']);
  return {
    plan_id: result.planId,
    status: running ? 'running' : result.status,
    started_at: result.startedAt,
    finished_at: result.finishedAt,
    counts: result.counts,
    problems: result.steps
      .filter((s) => !done.has(s.status) && s.status !== 'not_started')
      .map((s) => ({
        step: s.stepId,
        summary: s.summary,
        status: s.status,
        error: s.error,
        op_ids: s.opIds,
      })),
    not_started: result.steps.filter((s) => s.status === 'not_started').length,
    notes: result.steps.filter((s) => s.note).map((s) => `${s.stepId}: ${s.note}`),
    steps: detail === 'full' ? result.steps : undefined,
    next: running
      ? `Still running; call get_apply_status with plan_id "${result.planId}".`
      : result.status === 'applied'
        ? 'Done. Call verify_blueprint to confirm the server matches.'
        : 'Not everything was applied. Discord has no rollback; steps marked succeeded are in effect. Fix the problems and create a new plan from the same blueprint: it starts from the real state and will not repeat finished work.',
  };
}

function planFor(call: CallContext, planId: string) {
  const { record, body } = call.app.blueprints.getPlan(planId);
  call.assertGuild(record.guildId);
  return { record, body };
}

export const blueprintTools = [
  defineTool({
    name: 'validate_blueprint',
    title: 'Validate a blueprint',
    description:
      'Check a blueprint offline: schema, keys, references, permission names, Discord limits, and role-safety rules for join and self-assignable roles. Does not contact Discord.',
    scope: 'read',
    input: z.object({ blueprint: blueprintInput }),
    handler: async ({ blueprint }) => {
      const v = validateBlueprint(blueprint);
      return {
        valid: v.ok,
        errors: v.errors.slice(0, 100),
        warnings: v.warnings.slice(0, 50),
        hash: v.hash,
        stats: v.stats,
      };
    },
  }),

  defineTool({
    name: 'export_blueprint',
    title: 'Export server as blueprint',
    description:
      'Export the live server (roles, categories, channels, ordering, overwrites, settings, AutoMod, and steward-managed messages, welcome, self roles and panels) as a blueprint. Assigns stable keys and, by default, records them so later plans manage the same resources instead of creating copies.',
    scope: 'read',
    input: z.object({
      guild_id: guildIdInput,
      format: z.enum(['yaml', 'json']).default('yaml'),
      include_ids: z
        .boolean()
        .default(false)
        .describe('Pin entries to their Discord IDs (only useful for this server).'),
      record_mappings: z
        .boolean()
        .default(true)
        .describe('Remember the assigned keys. Turn off for a template you will apply elsewhere.'),
    }),
    guildOf: (a) => a.guild_id,
    handler: async (a, call) => {
      const out = await call.app.blueprints.export({
        guildId: a.guild_id,
        format: a.format,
        includeIds: a.include_ids,
        recordMappings: a.record_mappings,
      });
      return {
        format: a.format,
        keys: out.keys,
        recorded_mappings: out.recordedMappings,
        notes: out.notes,
        blueprint: out.text,
      };
    },
  }),

  defineTool({
    name: 'plan_blueprint',
    title: 'Plan a blueprint (dry run)',
    description:
      'Compare a blueprint with the live server and store a plan: creates, updates, reorders, deletions (only with prune), unsupported items, blocked steps (with reasons such as hierarchy or missing permissions) and warnings. Changes nothing on Discord. The plan is bound to this guild, this blueprint and the current server state, and expires.',
    scope: 'read',
    input: z.object({
      guild_id: guildIdInput,
      blueprint: blueprintInput,
      prune: pruneInput,
      prune_unmanaged: z
        .boolean()
        .default(false)
        .describe('Also delete resources steward never managed. Dangerous.'),
      adopt_by_name: z
        .boolean()
        .default(false)
        .describe(
          'Bind blueprint entries to existing unmanaged resources with the same name instead of creating new ones.',
        ),
      detail: detailInput,
    }),
    guildOf: (a) => a.guild_id,
    handler: async (a, call) => {
      const { record, body, notes } = await call.app.blueprints.createPlan({
        guildId: a.guild_id,
        blueprint: a.blueprint,
        options: {
          prune: a.prune ?? {},
          prune_unmanaged: a.prune_unmanaged,
          adopt_by_name: a.adopt_by_name,
        } as never,
        clientId: call.caller.clientId,
      });
      return { ...planView(record, body, a.detail), notes: notes.length ? notes : undefined };
    },
  }),

  defineTool({
    name: 'get_plan',
    title: 'Show a stored plan',
    description:
      "Page through a plan's steps, optionally filtered by action (e.g. create_channel) or only blocked/destructive steps.",
    scope: 'read',
    input: z.object({
      plan_id: z.string().max(40),
      detail: detailInput,
      action: z.string().max(40).optional(),
      only: z.enum(['blocked', 'destructive']).optional(),
      limit: limitInput,
      cursor: cursorInput,
    }),
    handler: async (a, call) => {
      const { record, body } = planFor(call, a.plan_id);
      const steps = body.steps.filter(
        (s) =>
          (!a.action || s.action === a.action) &&
          (!a.only || (a.only === 'blocked' ? !!s.blocked : s.destructive)),
      );
      const page = paginate(steps, a.limit, a.cursor);
      return {
        plan_id: record.id,
        status: record.status,
        summary: body.summary,
        ...page,
        items: a.detail === 'full' ? page.items : page.items.map(line),
      };
    },
  }),

  defineTool({
    name: 'apply_plan',
    title: 'Apply a plan',
    description:
      "Execute a stored plan. First re-reads the server and refuses if anything relevant changed since planning (stale plan), the plan expired, or it was already used. Steps run in order, journaled, at Discord's rate limits. Not atomic: on failure, finished steps stay in effect and the result says exactly which. Returns after wait_seconds even if still running; poll get_apply_status.",
    scope: 'write',
    input: z.object({
      plan_id: z.string().max(40),
      guild_id: guildIdInput.describe('Must match the plan, as a guard against applying the wrong plan.'),
      continue_on_error: z
        .boolean()
        .default(false)
        .describe('Keep going past a failed step (dependents are still skipped).'),
      accept_blocked: z
        .boolean()
        .default(false)
        .describe('Apply the plan even though some steps are blocked; those steps are skipped.'),
      wait_seconds: z.number().int().min(0).max(300).optional(),
      detail: detailInput,
    }),
    guildOf: (a) => a.guild_id,
    handler: async (a, call) => {
      planFor(call, a.plan_id);
      const result = await call.app.blueprints.apply({
        planId: a.plan_id,
        guildId: a.guild_id,
        clientId: call.caller.clientId,
        canDestroy: call.caller.scopes.has('destructive'),
        continueOnError: a.continue_on_error,
        acceptBlocked: a.accept_blocked,
        waitSeconds: a.wait_seconds,
      });
      return applyView(result, a.detail, result.status === 'running');
    },
  }),

  defineTool({
    name: 'get_apply_status',
    title: 'Apply progress and result',
    description:
      'Progress or final result of an apply_plan run, including per-step status, operation IDs and errors.',
    scope: 'read',
    input: z.object({ plan_id: z.string().max(40), detail: detailInput }),
    handler: async (a, call) => {
      planFor(call, a.plan_id);
      const { record, result, running } = call.app.blueprints.applyStatus(a.plan_id);
      if (!result)
        return {
          plan_id: record.id,
          status: record.status,
          note: record.status === 'planned' ? 'not applied yet' : undefined,
        };
      if ('reason' in (result as object)) return { plan_id: record.id, status: record.status, result };
      return applyView(result, a.detail, running);
    },
  }),

  defineTool({
    name: 'verify_blueprint',
    title: 'Verify server against blueprint',
    description:
      'Re-read the server and report whether it matches the blueprint, listing any remaining differences. Changes nothing and stores no plan.',
    scope: 'read',
    input: z.object({ guild_id: guildIdInput, blueprint: blueprintInput, detail: detailInput }),
    guildOf: (a) => a.guild_id,
    handler: async (a, call) => {
      const { inSync, body } = await call.app.blueprints.verify(a.guild_id, a.blueprint);
      return {
        in_sync: inSync,
        summary: body.summary,
        differences: a.detail === 'full' ? body.steps : body.steps.map(line),
        unsupported: body.unsupported,
        warnings: body.warnings.map((w) => w.message),
      };
    },
  }),

  defineTool({
    name: 'map_resource',
    title: 'Bind or unbind a key',
    description:
      'Bind a blueprint key to an existing Discord role, channel/category or AutoMod rule (so plans manage it instead of creating a copy), or pass discord_id null to unbind. Use this to resolve an ambiguous recovery.',
    scope: 'write',
    input: z.object({
      guild_id: guildIdInput,
      kind: z.enum(['role', 'channel', 'automod']),
      key: z.string().regex(KEY_RE),
      discord_id: snowflake.nullable(),
    }),
    guildOf: (a) => a.guild_id,
    handler: async (a, call) => {
      const { store, adapter } = call.app;
      if (a.discord_id === null) return { unbound: store.deleteMapping(a.guild_id, a.kind, a.key) };
      if (a.kind === 'automod') {
        requireFound(
          (await adapter.fetchAutoModRules(a.guild_id)).find((r) => r.id === a.discord_id),
          `AutoMod rule ${a.discord_id}`,
        );
      } else {
        const s = await snapshotOf(call, a.guild_id);
        if (a.kind === 'role') {
          const r = requireFound(
            s.roles.find((x) => x.id === a.discord_id),
            `role ${a.discord_id}`,
          );
          if (r.id === s.guild.id || r.managed)
            throw new StewardError(
              'invalid_argument',
              '@everyone and integration-managed roles cannot be bound to keys',
            );
        } else {
          requireFound(
            s.channels.find((x) => x.id === a.discord_id),
            `channel ${a.discord_id}`,
          );
        }
      }
      const previous = store.findMappingById(a.guild_id, a.kind, a.discord_id);
      store.setMapping(a.guild_id, a.kind, a.key, a.discord_id, 'manual');
      return {
        bound: true,
        key: a.key,
        discord_id: a.discord_id,
        released_key: previous && previous.key !== a.key ? previous.key : undefined,
      };
    },
  }),
];
