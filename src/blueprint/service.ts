import YAML from 'yaml';
import type { DiscordAdapter } from '../discord/adapter.js';
import { botStanding, has, P } from '../discord/permissions.js';
import type { AutoModRuleInfo, GuildSnapshot } from '../discord/types.js';
import type { Logger } from '../logger.js';
import { reconcileCreate } from '../ops/journal.js';
import type { GuildLocks } from '../ops/locks.js';
import type { ManagedMessage, MappingKind, PlanRecord, RolePanel, Store } from '../store.js';
import { StewardError } from '../util/errors.js';
import { newId, snowflakeTime } from '../util/ids.js';
import type { ApplyResult } from './apply.js';
import { PlanExecutor } from './apply.js';
import { exportBlueprint } from './export.js';
import { computeFingerprints, computePlan, diffFingerprints } from './plan.js';
import type { PlanBody, PlanOptions } from './plan-types.js';
import { DEFAULT_PLAN_OPTIONS } from './plan-types.js';
import type { Blueprint } from './schema.js';
import { validateBlueprint } from './validate.js';
import { messageFingerprint } from '../features/messages.js';

export interface ServiceConfig {
  planTtlMinutes: number;
  applyWaitSeconds: number;
  membersIntent: boolean;
  allowDestructive: boolean;
}

export interface GuildState {
  snapshot: GuildSnapshot;
  automodRules: AutoModRuleInfo[] | null;
  managedMessages: Array<ManagedMessage & { exists: boolean }>;
  panels: Array<RolePanel & { messageExists: boolean }>;
}

interface ActiveRun {
  executor: PlanExecutor;
  done: Promise<ApplyResult>;
}

export class BlueprintService {
  private readonly active = new Map<string, ActiveRun>();
  private stopping = false;

  constructor(
    private readonly deps: {
      store: Store;
      adapter: DiscordAdapter;
      logger: Logger;
      locks: GuildLocks;
      config: ServiceConfig;
      backoffMs?: number;
    },
  ) {}

  // ---- state ------------------------------------------------------------------------

  async gatherState(guildId: string, needAutomod: boolean): Promise<GuildState> {
    const { adapter, store } = this.deps;
    const snapshot = await adapter.fetchSnapshot(guildId);
    const canReadAutomod = has(botStanding(snapshot).permissions, P.ManageGuild);
    const automodRules = needAutomod && canReadAutomod ? await adapter.fetchAutoModRules(guildId) : null;
    const managedMessages = await Promise.all(
      store
        .listManagedMessages(guildId)
        .map(async (m) => ({ ...m, exists: !!(await adapter.fetchMessage(m.channelId, m.messageId)) })),
    );
    const panels = await Promise.all(
      store.listPanels(guildId).map(async (p) => ({
        ...p,
        messageExists: p.messageId ? !!(await adapter.fetchMessage(p.channelId, p.messageId)) : false,
      })),
    );
    return { snapshot, automodRules, managedMessages, panels };
  }

  private localState(guildId: string, state: GuildState) {
    const { store } = this.deps;
    return {
      welcome: store.getWelcome(guildId) ?? null,
      selfRoles: store.listSelfRoles(guildId),
      protectedRoles: store.listProtectedRoles(guildId),
      panels: state.panels.map((p) => [
        p.id,
        p.key,
        p.channelId,
        p.messageId,
        p.messageExists,
        p.options,
        p.title,
        p.description,
        p.mode,
      ]),
      messages: state.managedMessages.map((m) => [m.key, m.channelId, m.messageId, m.payloadHash, m.exists]),
    };
  }

  private fingerprints(guildId: string, state: GuildState) {
    return computeFingerprints({
      snapshot: state.snapshot,
      mappings: this.deps.store.listMappings(guildId),
      automodRules: state.automodRules,
      localState: this.localState(guildId, state),
    });
  }

  /**
   * Resolve operations left `uncertain` by a crash or timeout: find out
   * whether the create happened, and record the answer, before planning
   * anything that might otherwise create it twice.
   */
  async reconcileUncertain(guildId: string): Promise<string[]> {
    const { store, adapter, logger } = this.deps;
    const notes: string[] = [];
    const botUserId = adapter.status().botUserId;
    for (const op of store.uncertainOperations(guildId)) {
      if (!op.matchJson) continue;
      const m = JSON.parse(op.matchJson) as Record<string, unknown> & { kind: string; startedAt: number };
      try {
        if ((m.kind === 'role' || m.kind === 'channel' || m.kind === 'automod') && op.resourceKey) {
          const res = await reconcileCreate(adapter, store, guildId, op.id, m.startedAt, m as never);
          if ('found' in res) {
            store.setMapping(guildId, m.kind as MappingKind, op.resourceKey, res.found, 'recovered');
            store.finishOperation(op.id, 'recovered', {
              targetId: res.found,
              resultJson: JSON.stringify({ id: res.found, via: res.via }),
            });
            notes.push(
              `interrupted create of ${m.kind} "${op.resourceKey}" had succeeded; adopted ${res.found}`,
            );
          } else if ('absent' in res) {
            store.finishOperation(op.id, 'failed', {
              error: 'checked after interruption: Discord had not created it',
            });
            notes.push(
              `interrupted create of ${m.kind} "${op.resourceKey}" had not happened; it will be planned again`,
            );
          } else {
            notes.push(
              `interrupted create of ${m.kind} "${op.resourceKey}" is ambiguous (${res.ambiguous.join(', ')}); bind one with map_resource`,
            );
          }
        } else if ((m.kind === 'message' || m.kind === 'panel') && botUserId) {
          const recent = await adapter.fetchRecentMessages(m.channelId as string, 50);
          const hits = recent.filter(
            (msg) =>
              msg.authorId === botUserId &&
              snowflakeTime(msg.id) >= m.startedAt - 5_000 &&
              messageFingerprint(msg) === m.fingerprint,
          );
          if (hits.length === 1) {
            const messageId = hits[0]!.id;
            if (m.kind === 'message') {
              store.setManagedMessage({
                guildId,
                key: m.key as string,
                channelId: m.channelId as string,
                messageId,
                payloadHash: m.payloadHash as string,
              });
            } else {
              const panel = m.panel as Omit<
                RolePanel,
                'guildId' | 'key' | 'channelId' | 'messageId' | 'createdAt' | 'updatedAt'
              >;
              store.upsertPanel({
                ...panel,
                guildId,
                key: m.key as string,
                channelId: m.channelId as string,
                messageId,
              });
            }
            store.finishOperation(op.id, 'recovered', { targetId: messageId });
            notes.push(`interrupted post of "${m.key}" had succeeded; recorded message ${messageId}`);
          } else if (hits.length === 0) {
            store.finishOperation(op.id, 'failed', {
              error: 'checked after interruption: no such message was posted',
            });
          } else {
            notes.push(
              `interrupted post of "${m.key}" matches ${hits.length} messages; delete the duplicates by hand`,
            );
          }
        }
      } catch (error) {
        logger.warn('could not reconcile uncertain operation', { opId: op.id, error });
        notes.push(`could not check interrupted operation ${op.id} yet: ${(error as Error).message}`);
      }
    }
    return notes;
  }

  // ---- plan ---------------------------------------------------------------------------

  async createPlan(args: {
    guildId: string;
    blueprint: unknown;
    options?: Omit<Partial<PlanOptions>, 'prune'> & { prune?: Partial<PlanOptions['prune']> };
    clientId: string;
  }): Promise<{ record: PlanRecord; body: PlanBody; notes: string[] }> {
    const { store, locks, logger } = this.deps;
    const v = validateBlueprint(args.blueprint);
    if (!v.ok)
      throw new StewardError(
        'invalid_argument',
        'the blueprint is not valid; run validate_blueprint for details',
        { errors: v.errors.slice(0, 50) },
      );
    const holder = locks.holder(args.guildId);
    if (holder) throw new StewardError('conflict', `cannot plan while ${holder} is running in this server`);
    const options: PlanOptions = {
      ...DEFAULT_PLAN_OPTIONS,
      ...args.options,
      prune: { ...DEFAULT_PLAN_OPTIONS.prune, ...args.options?.prune },
    };
    const notes = await this.reconcileUncertain(args.guildId);
    const bp = v.blueprint!;
    const state = await this.gatherState(args.guildId, bp.automod.length > 0 || options.prune.automod);
    if (bp.automod.length > 0 && state.automodRules === null) {
      notes.push(
        'the bot lacks Manage Server, so AutoMod rules could not be read; AutoMod steps are blocked',
      );
    }
    const body = computePlan({
      blueprint: bp,
      blueprintHash: v.hash!,
      snapshot: state.snapshot,
      mappings: store.listMappings(args.guildId),
      automodRules: state.automodRules ?? (bp.automod.length > 0 ? [] : null),
      managedMessages: state.managedMessages,
      panels: state.panels,
      welcome: store.getWelcome(args.guildId),
      selfRoles: store.listSelfRoles(args.guildId),
      protectedRoles: store.listProtectedRoles(args.guildId),
      membersIntent: this.deps.config.membersIntent,
      options,
    });
    if (bp.automod.length > 0 && state.automodRules === null) {
      for (const s of body.steps)
        if (s.action === 'create_automod' && !s.blocked) s.blocked = 'AutoMod needs Manage Server';
    }
    const now = new Date();
    const record: PlanRecord = {
      id: newId('pln'),
      guildId: args.guildId,
      blueprintName: bp.name ?? null,
      blueprintHash: v.hash!,
      optionsJson: JSON.stringify(options),
      planJson: JSON.stringify(body),
      fingerprintsJson: JSON.stringify(this.fingerprints(args.guildId, state)),
      status: 'planned',
      createdBy: args.clientId,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.deps.config.planTtlMinutes * 60_000).toISOString(),
      appliedAt: null,
      finishedAt: null,
      resultJson: null,
    };
    store.insertPlan(record);
    logger.info('plan created', {
      planId: record.id,
      guildId: args.guildId,
      steps: body.steps.length,
      blocked: body.summary.blocked,
    });
    return { record, body, notes: [...notes, ...v.warnings.map((w) => `${w.path}: ${w.message}`)] };
  }

  getPlan(planId: string): { record: PlanRecord; body: PlanBody } {
    const record = this.deps.store.getPlan(planId);
    if (!record) throw new StewardError('not_found', `no plan ${planId}`);
    return { record, body: JSON.parse(record.planJson) as PlanBody };
  }

  // ---- apply --------------------------------------------------------------------------

  async apply(args: {
    planId: string;
    guildId: string;
    clientId: string;
    canDestroy: boolean;
    continueOnError: boolean;
    acceptBlocked: boolean;
    waitSeconds?: number;
  }): Promise<ApplyResult & { stale?: string[] }> {
    const { store, locks, logger, config } = this.deps;
    if (this.stopping) throw new StewardError('discord_unavailable', 'steward is shutting down');
    const { record, body } = this.getPlan(args.planId);
    if (record.guildId !== args.guildId) {
      throw new StewardError(
        'invalid_argument',
        `plan ${args.planId} belongs to guild ${record.guildId}, not ${args.guildId}`,
      );
    }
    if (record.status !== 'planned') {
      throw new StewardError(
        'conflict',
        `plan ${args.planId} is ${record.status}; plans run once. Create a new plan from the blueprint to continue from the current state`,
      );
    }
    if (Date.parse(record.expiresAt) < Date.now()) {
      store.transitionPlan(record.id, ['planned'], 'rejected', {
        resultJson: JSON.stringify({ reason: 'expired' }),
      });
      throw new StewardError(
        'stale_plan',
        `plan ${args.planId} expired at ${record.expiresAt}; create a new plan`,
      );
    }
    const destructive = body.steps.filter((s) => s.destructive && !s.blocked);
    if (destructive.length > 0) {
      if (!config.allowDestructive) {
        throw new StewardError(
          'destructive_disabled',
          `the plan deletes or removes ${destructive.length} thing(s), and ALLOW_DESTRUCTIVE is off on this server`,
        );
      }
      if (!args.canDestroy)
        throw new StewardError(
          'forbidden',
          'this plan deletes things; your credential lacks the "destructive" scope',
        );
    }
    const blocked = body.steps.filter((s) => s.blocked);
    if (blocked.length > 0 && !args.acceptBlocked) {
      throw new StewardError(
        'precondition_failed',
        `${blocked.length} step(s) are blocked; fix them and plan again, or pass accept_blocked: true to apply everything else`,
        { blocked: blocked.slice(0, 20).map((s) => ({ step: s.id, summary: s.summary, reason: s.blocked })) },
      );
    }

    const release = await locks.acquire(args.guildId, `apply of ${args.planId}`, 0);
    let started = false;
    try {
      const state = await this.gatherState(args.guildId, body.readsAutomod);
      const before = JSON.parse(record.fingerprintsJson) as Record<string, string>;
      const now = this.fingerprints(args.guildId, state);
      const changed = diffFingerprints(before, now, state.snapshot);
      if (changed.length > 0) {
        store.transitionPlan(record.id, ['planned'], 'rejected', {
          resultJson: JSON.stringify({ reason: 'stale', changed }),
        });
        throw new StewardError(
          'stale_plan',
          `the server changed since plan ${args.planId} was made; create a new plan`,
          {
            changed: changed.slice(0, 30),
            more: Math.max(0, changed.length - 30),
          },
        );
      }
      if (!store.transitionPlan(record.id, ['planned'], 'applying')) {
        throw new StewardError('conflict', `plan ${args.planId} is already being applied`);
      }
      const executor = new PlanExecutor({ ...this.deps }, record.id, body, {
        clientId: args.clientId,
        continueOnError: args.continueOnError,
        shouldStop: () => this.stopping,
      });
      started = true;
      const done = executor
        .run()
        .then((result) => {
          store.transitionPlan(
            record.id,
            ['applying'],
            result.status === 'running' ? 'failed' : result.status,
            {
              resultJson: JSON.stringify(result),
            },
          );
          logger.info('plan finished', { planId: record.id, status: result.status, counts: result.counts });
          return result;
        })
        .catch((error) => {
          logger.error('plan run crashed', { planId: record.id, error });
          store.transitionPlan(record.id, ['applying'], 'failed');
          throw error;
        })
        .finally(() => {
          release();
          this.active.delete(record.id);
        });
      this.active.set(record.id, { executor, done });
      const wait = (args.waitSeconds ?? config.applyWaitSeconds) * 1000;
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([done.catch(() => undefined), new Promise((r) => (timer = setTimeout(r, wait)))]);
      clearTimeout(timer);
      return structuredClone(executor.result);
    } finally {
      if (!started) release();
    }
  }

  applyStatus(planId: string): { record: PlanRecord; result: ApplyResult | null; running: boolean } {
    const active = this.active.get(planId);
    const record = this.getPlan(planId).record;
    if (active) return { record, result: structuredClone(active.executor.result), running: true };
    return {
      record,
      result: record.resultJson ? (JSON.parse(record.resultJson) as ApplyResult) : null,
      running: false,
    };
  }

  /** Stop starting new steps and wait (bounded) for running applies to reach a step boundary. */
  async shutdown(timeoutMs: number): Promise<void> {
    this.stopping = true;
    const runs = [...this.active.values()].map((r) => r.done.catch(() => undefined));
    if (runs.length === 0) return;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([Promise.all(runs), new Promise((r) => (timer = setTimeout(r, timeoutMs)))]);
    clearTimeout(timer);
  }

  // ---- verify / export ----------------------------------------------------------------

  async verify(guildId: string, blueprintInput: unknown): Promise<{ inSync: boolean; body: PlanBody }> {
    const v = validateBlueprint(blueprintInput);
    if (!v.ok)
      throw new StewardError(
        'invalid_argument',
        'the blueprint is not valid; run validate_blueprint for details',
        { errors: v.errors.slice(0, 50) },
      );
    const bp: Blueprint = v.blueprint!;
    const state = await this.gatherState(guildId, bp.automod.length > 0);
    const body = computePlan({
      blueprint: bp,
      blueprintHash: v.hash!,
      snapshot: state.snapshot,
      mappings: this.deps.store.listMappings(guildId),
      automodRules: state.automodRules ?? (bp.automod.length > 0 ? [] : null),
      managedMessages: state.managedMessages,
      panels: state.panels,
      welcome: this.deps.store.getWelcome(guildId),
      selfRoles: this.deps.store.listSelfRoles(guildId),
      protectedRoles: this.deps.store.listProtectedRoles(guildId),
      membersIntent: this.deps.config.membersIntent,
      options: DEFAULT_PLAN_OPTIONS,
    });
    const pending = body.steps.filter((s) => s.action !== 'adopt');
    return { inSync: pending.length === 0 && body.unsupported.length === 0, body };
  }

  async export(args: {
    guildId: string;
    format: 'yaml' | 'json';
    includeIds: boolean;
    recordMappings: boolean;
  }) {
    const { store, adapter } = this.deps;
    const state = await this.gatherState(args.guildId, true);
    const managedMessages = await Promise.all(
      store
        .listManagedMessages(args.guildId)
        .map(async (m) => ({ ...m, message: await adapter.fetchMessage(m.channelId, m.messageId) })),
    );
    const out = exportBlueprint({
      snapshot: state.snapshot,
      mappings: store.listMappings(args.guildId),
      automodRules: state.automodRules,
      managedMessages,
      welcome: store.getWelcome(args.guildId),
      selfRoles: store.listSelfRoles(args.guildId),
      protectedRoles: store.listProtectedRoles(args.guildId),
      panels: store.listPanels(args.guildId),
      includeIds: args.includeIds,
    });
    let recorded = 0;
    if (args.recordMappings) {
      store.transaction(() => {
        for (const k of out.keys) {
          if (!k.isNew) continue;
          store.setMapping(args.guildId, k.kind, k.key, k.id, 'exported');
          recorded++;
        }
      });
    }
    const text =
      args.format === 'json'
        ? JSON.stringify(out.blueprint, null, 2)
        : YAML.stringify(out.blueprint, { lineWidth: 0 });
    return { text, notes: out.notes, recordedMappings: recorded, keys: out.keys.length };
  }
}
