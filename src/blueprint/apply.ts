import type { DiscordAdapter } from '../discord/adapter.js';
import type { ChannelWriteBody, GuildSnapshot, GuildWriteBody } from '../discord/types.js';
import { assertSelfAssignable, buildPanelMessage } from '../features/role-panels.js';
import { buildMessageBody, messageFingerprint } from '../features/messages.js';
import type { Logger } from '../logger.js';
import {
  automodPatch,
  automodRuleGone,
  automodWriteBody,
  deleteRuleRequest,
  writeListedRule,
} from '../ops/automod.js';
import type { OpContext, OpOutcome } from '../ops/journal.js';
import { OperationError, runOperation } from '../ops/journal.js';
import { bucketMembers, channelOrderHolds, channelPositionUpdates, roleOrderPlan } from '../ops/ordering.js';
import type { MappingKind, Store } from '../store.js';
import { DiscordRequestError, RefusedChange, StewardError, safeErrorMessage } from '../util/errors.js';
import { newId } from '../util/ids.js';
import type {
  AutoModFields,
  OverwriteRef,
  PanelFields,
  PlanBody,
  PlanStep,
  SettingsFields,
} from './plan-types.js';
import type { RefString } from './refs.js';
import { mustResolve } from './refs.js';

export type StepStatus =
  'succeeded' | 'recovered' | 'noop' | 'failed' | 'uncertain' | 'skipped' | 'blocked' | 'not_started';

export interface StepResult {
  stepId: string;
  action: string;
  summary: string;
  status: StepStatus;
  opIds: string[];
  targetId?: string;
  error?: string;
  note?: string;
}

export type RunStatus = 'running' | 'applied' | 'partial' | 'failed' | 'interrupted';

export interface ApplyResult {
  planId: string;
  guildId: string;
  status: RunStatus;
  startedAt: string;
  finishedAt: string | null;
  counts: Partial<Record<StepStatus, number>>;
  steps: StepResult[];
  notes: string[];
}

export interface ExecutorDeps {
  store: Store;
  adapter: DiscordAdapter;
  logger: Logger;
  backoffMs?: number;
}

const DONE: StepStatus[] = ['succeeded', 'recovered', 'noop'];

/**
 * Runs a stored plan, one step at a time, in order. There is no rollback:
 * Discord offers none. What there is instead is an exact record of what
 * happened to every step, persisted after each one, so a partial run can be
 * understood and a fresh plan can pick up from the real state.
 */
export class PlanExecutor {
  readonly result: ApplyResult;
  private readonly byStep = new Map<string, StepResult>();

  constructor(
    private readonly deps: ExecutorDeps,
    private readonly planId: string,
    private readonly plan: PlanBody,
    private readonly opts: { clientId: string; continueOnError: boolean; shouldStop: () => boolean },
  ) {
    this.result = {
      planId,
      guildId: plan.guildId,
      status: 'running',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      counts: {},
      steps: plan.steps.map((s) => ({
        stepId: s.id,
        action: s.action,
        summary: s.summary,
        status: 'not_started',
        opIds: [],
      })),
      notes: [],
    };
    for (const r of this.result.steps) this.byStep.set(r.stepId, r);
  }

  private get guildId() {
    return this.plan.guildId;
  }

  private lookup = (kind: MappingKind, key: string) =>
    this.deps.store.getMapping(this.guildId, kind, key)?.discordId;

  private resolve(ref: RefString, kind: MappingKind): string {
    return mustResolve(ref, kind, this.guildId, this.lookup);
  }

  private ctx(step: PlanStep): OpContext {
    return {
      store: this.deps.store,
      adapter: this.deps.adapter,
      logger: this.deps.logger,
      guildId: this.guildId,
      planId: this.planId,
      stepId: step.id,
      tool: 'apply_plan',
      clientId: this.opts.clientId,
      backoffMs: this.deps.backoffMs,
    };
  }

  private persist(): void {
    const counts: Partial<Record<StepStatus, number>> = {};
    for (const s of this.result.steps) counts[s.status] = (counts[s.status] ?? 0) + 1;
    this.result.counts = counts;
    this.deps.store.setPlanResult(this.planId, JSON.stringify(this.result));
  }

  async run(): Promise<ApplyResult> {
    let halted = false;
    let interrupted = false;
    let refusedStep: PlanStep | null = null;
    for (const step of this.plan.steps) {
      const r = this.byStep.get(step.id)!;
      if (interrupted || this.opts.shouldStop()) {
        interrupted = true;
        continue;
      }
      if (step.blocked) {
        r.status = 'blocked';
        r.error = step.blocked;
        this.persist();
        continue;
      }
      if (halted) continue;
      const failedDep = step.dependsOn
        .map((d) => this.byStep.get(d))
        .find((d) => d && !DONE.includes(d.status));
      if (failedDep) {
        r.status = 'skipped';
        r.error = `depends on step ${failedDep.stepId}, which ${failedDep.status === 'not_started' ? 'did not run' : `ended as ${failedDep.status}`}`;
        this.persist();
        continue;
      }
      // Plans do not record every way a deletion can rely on an earlier change
      // (an AutoMod rule still alerting to a channel being pruned, say), so
      // after a refusal deletions wait unless continue_on_error was asked for.
      if (refusedStep && step.destructive && !this.opts.continueOnError) {
        r.status = 'skipped';
        r.error = `not run: Discord refused step ${refusedStep.id} ("${refusedStep.summary}") earlier in this run, and deletions wait until a plan applies without refusals (or set continue_on_error)`;
        this.persist();
        continue;
      }
      try {
        await this.execute(step, r);
        if (r.status === 'not_started') r.status = 'succeeded';
      } catch (error) {
        r.status = error instanceof OperationError && error.outcome === 'uncertain' ? 'uncertain' : 'failed';
        r.error = safeErrorMessage(error);
        const opId =
          error instanceof OperationError
            ? error.opId
            : error instanceof RefusedChange
              ? error.opId
              : undefined;
        if (opId && !r.opIds.includes(opId)) r.opIds.push(opId);
        this.deps.logger.warn('plan step failed', {
          planId: this.planId,
          stepId: step.id,
          status: r.status,
          error: r.error,
        });
        // A change Discord definitely refused leaves nothing half-done, so the
        // steps that do not depend on it still run; deletions are held back.
        const refused = error instanceof RefusedChange;
        if (refused) {
          refusedStep ??= step;
          this.result.notes.push(
            `Discord refused "${step.summary}"; steps that do not depend on it still ran${this.opts.continueOnError ? '' : ', except deletions'}`,
          );
        }
        if (!refused && (!this.opts.continueOnError || r.status === 'uncertain')) halted = true;
      }
      this.persist();
    }
    const statuses = this.result.steps.map((s) => s.status);
    const anyDone = statuses.some((s) => DONE.includes(s));
    const allDone = statuses.every((s) => DONE.includes(s));
    this.result.status = interrupted ? 'interrupted' : allDone ? 'applied' : anyDone ? 'partial' : 'failed';
    if (this.plan.steps.length === 0) this.result.status = 'applied';
    this.result.finishedAt = new Date().toISOString();
    this.persist();
    return this.result;
  }

  private track<T>(r: StepResult, outcome: OpOutcome<T>, id?: string | null): OpOutcome<T> {
    r.opIds.push(outcome.opId);
    if (outcome.status === 'recovered') {
      r.status = 'recovered';
      r.note = 'Discord did not confirm the request, but the resource was found afterwards and adopted';
    } else if (outcome.status === 'noop' && r.status === 'not_started') {
      r.status = 'noop';
    }
    if (id) r.targetId = id;
    return outcome;
  }

  private async snapshot(): Promise<GuildSnapshot> {
    return this.deps.adapter.fetchSnapshot(this.guildId);
  }

  /** Fail the step, with what Discord now reports, if the roles did not end up in order. */
  private async confirmRoleOrder(ids: string[]): Promise<void> {
    const after = await this.snapshot();
    const check = roleOrderPlan(after, ids);
    if (check.inOrder) return;
    const names = (list: string[]) =>
      list.map((id) => after.roles.find((x) => x.id === id)?.name ?? id).join(' > ');
    throw new StewardError(
      'precondition_failed',
      `Discord accepted the new role positions, but the roles are still out of order. Wanted ${names(ids)}; Discord now reports ${names(check.currentOrder)}` +
        (check.blocker ? `. ${check.blocker}` : ''),
    );
  }

  private overwriteBody(list: OverwriteRef[]): NonNullable<ChannelWriteBody['permission_overwrites']> {
    return list.map((o) => ({
      id: o.type === 'member' ? o.target.slice('member:'.length) : this.resolve(o.target, 'role'),
      type: o.type === 'member' ? 1 : 0,
      allow: o.allow,
      deny: o.deny,
    }));
  }

  private async execute(step: PlanStep, r: StepResult): Promise<void> {
    const { adapter, store } = this.deps;
    const g = this.guildId;
    const ctx = this.ctx(step);
    switch (step.action) {
      case 'adopt': {
        store.setMapping(g, step.kind, step.key, step.discordId, 'adopted');
        r.targetId = step.discordId;
        return;
      }
      case 'create_role': {
        const out = await runOperation(ctx, {
          action: 'create_role',
          resourceKind: 'role',
          resourceKey: step.key,
          summary: step.summary,
          idempotent: false,
          match: { kind: 'role', name: step.fields.name! },
          run: (reason) => adapter.createRole(g, step.fields, reason),
          resultId: (role) => role.id,
        });
        const id =
          out.status === 'recovered' ? out.recoveredId : out.status === 'succeeded' ? out.result.id : null;
        if (!id) throw new StewardError('internal', 'create returned no id');
        store.setMapping(g, 'role', step.key, id, out.status === 'recovered' ? 'recovered' : 'created');
        this.track(r, out, id);
        return;
      }
      case 'update_role': {
        const out = await runOperation(ctx, {
          action: 'update_role',
          resourceKind: 'role',
          resourceKey: step.key,
          targetId: step.roleId,
          summary: step.summary,
          idempotent: true,
          run: (reason) => adapter.editRole(g, step.roleId, step.fields, reason),
        });
        this.track(r, out, step.roleId);
        return;
      }
      case 'reorder_roles': {
        const snap = await this.snapshot();
        const ids = step.order.map((k) => this.lookup('role', k)).filter((id): id is string => !!id);
        const order = roleOrderPlan(snap, ids);
        if (order.inOrder) {
          r.status = 'noop';
          r.note = 'roles were already in order';
          return;
        }
        if (order.blocker)
          throw new StewardError('precondition_failed', `cannot order the roles: ${order.blocker}`);
        this.track(
          r,
          await runOperation(ctx, {
            action: 'reorder_roles',
            resourceKind: 'role',
            summary: `${step.summary} (${order.updates.length} position change(s))`,
            idempotent: true,
            run: (reason) => adapter.setRolePositions(g, order.updates, reason),
          }),
        );
        // Discord answering 200 is not proof: read the order back.
        await this.confirmRoleOrder(ids);
        return;
      }
      case 'create_channel': {
        const parentId = step.parent ? this.resolve(step.parent, 'channel') : null;
        const body: ChannelWriteBody = { ...step.fields, parent_id: parentId };
        if (step.overwrites.length > 0) body.permission_overwrites = this.overwriteBody(step.overwrites);
        const out = await runOperation(ctx, {
          action: 'create_channel',
          resourceKind: 'channel',
          resourceKey: step.key,
          summary: step.summary,
          idempotent: false,
          match: { kind: 'channel', name: step.fields.name!, type: step.fields.type, parentId },
          run: (reason) => adapter.createChannel(g, body, reason),
          resultId: (c) => c.id,
        }).catch((error: unknown) => this.explainChannelRefusal(error, step.fields.type, r));
        const id =
          out.status === 'recovered' ? out.recoveredId : out.status === 'succeeded' ? out.result.id : null;
        if (!id) throw new StewardError('internal', 'create returned no id');
        store.setMapping(g, 'channel', step.key, id, out.status === 'recovered' ? 'recovered' : 'created');
        this.track(r, out, id);
        if (out.status === 'succeeded' && out.result.name !== step.fields.name) {
          r.note = `Discord stored the name as "${out.result.name}"; use that in the blueprint to keep plans clean`;
        }
        return;
      }
      case 'update_channel': {
        const body: ChannelWriteBody = { ...step.fields };
        if (step.parent !== undefined)
          body.parent_id = step.parent ? this.resolve(step.parent, 'channel') : null;
        this.track(
          r,
          await runOperation(ctx, {
            action: 'update_channel',
            resourceKind: 'channel',
            resourceKey: step.key,
            targetId: step.channelId,
            summary: step.summary,
            idempotent: true,
            run: (reason) => adapter.editChannel(step.channelId, body, reason),
          }),
          step.channelId,
        );
        return;
      }
      case 'set_overwrites': {
        // Restrictions first, so a channel being made private is never briefly
        // more open than either its old or its new state.
        const puts = this.overwriteBody(step.put).sort(
          (a, b) => Number(BigInt(b.deny) !== 0n) - Number(BigInt(a.deny) !== 0n),
        );
        for (const o of puts) {
          this.track(
            r,
            await runOperation(ctx, {
              action: 'put_overwrite',
              resourceKind: 'overwrite',
              resourceKey: step.key,
              targetId: step.channelId,
              summary: `${step.summary}: set overwrite for ${o.type === 1 ? 'member' : 'role'} ${o.id}`,
              idempotent: true,
              run: (reason) =>
                adapter.putOverwrite(
                  step.channelId,
                  {
                    id: o.id,
                    type: o.type === 1 ? 'member' : 'role',
                    allow: BigInt(o.allow),
                    deny: BigInt(o.deny),
                  },
                  reason,
                ),
            }),
            step.channelId,
          );
        }
        for (const targetId of step.remove) {
          this.track(
            r,
            await runOperation(ctx, {
              action: 'delete_overwrite',
              resourceKind: 'overwrite',
              resourceKey: step.key,
              targetId: step.channelId,
              summary: `${step.summary}: remove overwrite for ${targetId}`,
              idempotent: true,
              notFoundIsSuccess: true,
              run: (reason) => adapter.deleteOverwrite(step.channelId, targetId, reason),
            }),
            step.channelId,
          );
        }
        r.status = 'succeeded';
        return;
      }
      case 'reorder_channels': {
        const snap = await this.snapshot();
        const parentId = step.parent ? this.resolve(step.parent, 'channel') : null;
        const siblings = bucketMembers(snap, parentId, step.group);
        const ids = step.order.map((k) => this.lookup('channel', k)).filter((id): id is string => !!id);
        const updates = channelPositionUpdates(siblings, ids);
        if (updates.length === 0) {
          r.status = 'noop';
          r.note = 'channels were already in order';
          return;
        }
        this.track(
          r,
          await runOperation(ctx, {
            action: 'reorder_channels',
            resourceKind: 'channel',
            summary: `${step.summary} (${updates.length} position change(s))`,
            idempotent: true,
            run: (reason) => adapter.setChannelPositions(g, updates, reason),
          }),
        );
        const after = await this.snapshot();
        if (!channelOrderHolds(after, parentId, step.group, ids)) {
          throw new StewardError(
            'precondition_failed',
            `Discord accepted the new channel positions, but the channels are still out of order: ${bucketMembers(
              after,
              parentId,
              step.group,
            )
              .filter((c) => ids.includes(c.id))
              .map((c) => c.name)
              .join(', ')}`,
          );
        }
        return;
      }
      case 'update_settings': {
        const body = await this.settingsBody(step.fields);
        this.track(
          r,
          await runOperation(ctx, {
            action: 'update_settings',
            resourceKind: 'guild',
            targetId: g,
            summary: step.summary,
            idempotent: true,
            run: (reason) => adapter.editGuild(g, body, reason),
          }),
          g,
        );
        return;
      }
      case 'create_automod':
      case 'update_automod': {
        const body = this.automodBody(step.fields);
        if (step.action === 'create_automod') {
          const out = await runOperation(ctx, {
            action: 'create_automod',
            resourceKind: 'automod',
            resourceKey: step.key,
            summary: step.summary,
            idempotent: false,
            match: { kind: 'automod', name: step.fields.name },
            run: (reason) =>
              adapter.createAutoModRule(
                g,
                { ...body, event_type: 1, trigger_type: step.fields.trigger_type },
                reason,
              ),
            resultId: (rule) => rule.id,
          });
          const id =
            out.status === 'recovered' ? out.recoveredId : out.status === 'succeeded' ? out.result.id : null;
          if (!id) throw new StewardError('internal', 'create returned no id');
          store.setMapping(g, 'automod', step.key, id, out.status === 'recovered' ? 'recovered' : 'created');
          this.track(r, out, id);
        } else {
          // Diff against the rule as Discord lists it now, and send only that.
          const live = (await adapter.fetchAutoModRules(g)).find((x) => x.id === step.ruleId);
          if (!live) throw automodRuleGone({ id: step.ruleId, name: step.fields.name });
          const patch = automodPatch(live, body);
          if (patch.fields.length === 0) {
            r.status = 'noop';
            r.note = 'the rule already matches';
            return;
          }
          const write = await writeListedRule(
            adapter,
            g,
            live,
            { verb: 'change', fields: patch.fields },
            () =>
              runOperation(ctx, {
                action: 'update_automod',
                resourceKind: 'automod',
                resourceKey: step.key,
                targetId: step.ruleId,
                summary: `${step.summary} (${patch.fields.join(', ')})`,
                idempotent: true,
                run: (reason) => adapter.editAutoModRule(g, step.ruleId, patch.body, reason),
              }),
          );
          this.track(r, write.out, step.ruleId);
        }
        return;
      }
      case 'post_message': {
        const channelId = this.resolve(step.channel, 'channel');
        const body = buildMessageBody(step.content);
        const out = await runOperation(ctx, {
          action: 'post_message',
          resourceKind: 'message',
          resourceKey: step.key,
          targetId: channelId,
          summary: step.summary,
          // The nonce makes Discord return the first message instead of posting twice.
          idempotent: true,
          recordMatch: {
            kind: 'message',
            key: step.key,
            channelId,
            payloadHash: step.payloadHash,
            fingerprint: messageFingerprint(body),
          },
          run: (_reason, opId) =>
            adapter.sendMessage(channelId, { ...body, nonce: opId.slice(0, 25), enforce_nonce: true }),
          resultId: (m) => m.id,
        });
        if (out.status !== 'succeeded')
          throw new StewardError('internal', 'message post returned no message');
        store.setManagedMessage({
          guildId: g,
          key: step.key,
          channelId,
          messageId: out.result.id,
          payloadHash: step.payloadHash,
        });
        this.track(r, out, out.result.id);
        if (step.replaces) await this.deleteOldMessage(ctx, r, step.replaces, step.key);
        return;
      }
      case 'edit_message': {
        const body = buildMessageBody(step.content);
        const out = await runOperation(ctx, {
          action: 'edit_message',
          resourceKind: 'message',
          resourceKey: step.key,
          targetId: step.messageId,
          summary: step.summary,
          idempotent: true,
          run: () => adapter.editMessage(step.channelId, step.messageId, body),
        });
        store.setManagedMessage({
          guildId: g,
          key: step.key,
          channelId: step.channelId,
          messageId: step.messageId,
          payloadHash: step.payloadHash,
        });
        this.track(r, out, step.messageId);
        return;
      }
      case 'configure_welcome': {
        const channelId = step.channel ? this.resolve(step.channel, 'channel') : null;
        const joinRoleIds = step.joinRoles.map((ref) => this.resolve(ref, 'role'));
        if (joinRoleIds.length > 0) {
          const snap = await this.snapshot();
          const prot = new Set(store.listProtectedRoles(g));
          for (const id of joinRoleIds) assertSelfAssignable(snap, id, prot);
        }
        store.setWelcome({
          guildId: g,
          enabled: step.enabled,
          channelId,
          message: step.message,
          joinRoleIds,
        });
        return;
      }
      case 'set_self_roles': {
        for (const ref of step.protect) store.addProtectedRole(g, this.resolve(ref, 'role'));
        if (step.roles !== null) {
          const ids = step.roles.map((ref) => this.resolve(ref, 'role'));
          const snap = await this.snapshot();
          const prot = new Set(store.listProtectedRoles(g));
          for (const id of ids) assertSelfAssignable(snap, id, prot);
          store.transaction(() => {
            for (const existing of store.listSelfRoles(g))
              if (!ids.includes(existing)) store.removeSelfRole(g, existing);
            for (const id of ids) store.addSelfRole(g, id);
          });
        }
        return;
      }
      case 'post_panel':
      case 'edit_panel': {
        await this.panel(step, r, ctx);
        return;
      }
      case 'delete_automod': {
        // Discord can answer 404 for a rule it keeps itself, so a 404 on a
        // listed rule is not "already gone", and a delete is read back.
        const rule = (await adapter.fetchAutoModRules(g)).find((x) => x.id === step.targetId);
        if (!rule) {
          r.status = 'noop';
          r.note = 'the rule was already gone';
        } else {
          const write = await writeListedRule(adapter, g, rule, { verb: 'delete' }, () =>
            runOperation(ctx, {
              action: step.action,
              resourceKind: 'automod',
              resourceKey: step.key,
              targetId: step.targetId,
              summary: step.summary,
              idempotent: true,
              run: (reason) => deleteRuleRequest(adapter, g, step.targetId, reason),
            }),
          );
          this.track(r, write.out, step.targetId);
          if (write.note) r.note = write.note;
        }
        store.deleteMappingById(g, 'automod', step.targetId);
        if (r.status === 'not_started') r.status = 'succeeded';
        return;
      }
      case 'delete_channel':
      case 'delete_role': {
        const kind: MappingKind = step.action === 'delete_channel' ? 'channel' : 'role';
        this.track(
          r,
          await runOperation(ctx, {
            action: step.action,
            resourceKind: kind,
            resourceKey: step.key,
            targetId: step.targetId,
            summary: step.summary,
            idempotent: true,
            notFoundIsSuccess: true,
            run: (reason) =>
              kind === 'channel'
                ? adapter.deleteChannel(step.targetId, reason)
                : adapter.deleteRole(g, step.targetId, reason),
          }),
          step.targetId,
        );
        store.deleteMappingById(g, kind, step.targetId);
        if (kind === 'role') {
          store.removeSelfRole(g, step.targetId);
          store.removeProtectedRole(g, step.targetId);
        }
        if (r.status === 'not_started') r.status = 'succeeded';
        return;
      }
      case 'delete_message': {
        await this.deleteOldMessage(
          ctx,
          r,
          { channelId: step.channelId, messageId: step.messageId },
          step.key,
        );
        store.deleteManagedMessage(g, step.key);
        if (r.status === 'not_started') r.status = 'succeeded';
        return;
      }
      case 'delete_panel': {
        if (step.messageId)
          await this.deleteOldMessage(
            ctx,
            r,
            { channelId: step.channelId, messageId: step.messageId },
            step.key,
          );
        store.deletePanel(step.panelId);
        if (r.status === 'not_started') r.status = 'succeeded';
        return;
      }
    }
  }

  private async deleteOldMessage(
    ctx: OpContext,
    r: StepResult,
    m: { channelId: string; messageId: string },
    key: string,
  ) {
    this.track(
      r,
      await runOperation(ctx, {
        action: 'delete_message',
        resourceKind: 'message',
        resourceKey: key,
        targetId: m.messageId,
        summary: `delete message ${m.messageId} ("${key}")`,
        idempotent: true,
        notFoundIsSuccess: true,
        run: (reason) => this.deps.adapter.deleteMessage(m.channelId, m.messageId, reason),
      }),
    );
  }

  /**
   * Discord does not say which error it gives when a server may not have a
   * channel type, so a refused create of a type tied to Community says so.
   */
  private async explainChannelRefusal(
    error: unknown,
    type: number | undefined,
    r: StepResult,
  ): Promise<never> {
    const kind = { 5: 'announcement', 13: 'stage', 15: 'forum', 16: 'media' }[type ?? -1];
    const refused =
      error instanceof OperationError &&
      error.outcome === 'failed' &&
      error.underlying instanceof DiscordRequestError &&
      error.underlying.kind === 'http';
    if (!kind || !refused) throw error;
    let features: string[];
    try {
      features = (await this.snapshot()).guild.features;
    } catch {
      throw error; // Discord's own refusal is the better report.
    }
    // A server that already has the feature was refused for another reason.
    const hasFeature =
      features.includes('COMMUNITY') || (kind === 'announcement' && features.includes('NEWS'));
    if (hasFeature && kind !== 'media') throw error;
    r.opIds.push(error.opId);
    throw new StewardError(
      'discord_error',
      `${error.message}. ` +
        (hasFeature
          ? 'Discord documents media channels as still in development; this server may need access Discord grants separately'
          : `Discord may only allow ${kind} channels on servers with the Community feature` +
            (kind === 'announcement' ? ' (or the older NEWS feature)' : '') +
            (kind === 'media'
              ? ', and media channels are still in development and may need extra access'
              : '')) +
        `; this server has: ${features.length ? features.join(', ') : 'no features'}`,
      { opId: error.opId, features },
    );
  }

  private async settingsBody(f: SettingsFields): Promise<GuildWriteBody> {
    const body: GuildWriteBody = {};
    const ref = (v: RefString | null | undefined) =>
      v === undefined ? undefined : v === null ? null : this.resolve(v, 'channel');
    if (f.name !== undefined) body.name = f.name;
    if (f.description !== undefined) body.description = f.description;
    if (f.verification_level !== undefined) body.verification_level = f.verification_level;
    if (f.default_message_notifications !== undefined)
      body.default_message_notifications = f.default_message_notifications;
    if (f.explicit_content_filter !== undefined) body.explicit_content_filter = f.explicit_content_filter;
    if (f.afk_timeout !== undefined) body.afk_timeout = f.afk_timeout;
    if (f.system_channel_flags !== undefined) body.system_channel_flags = f.system_channel_flags;
    if (f.preferred_locale !== undefined) body.preferred_locale = f.preferred_locale;
    if (f.premium_progress_bar_enabled !== undefined)
      body.premium_progress_bar_enabled = f.premium_progress_bar_enabled;
    const afk = ref(f.afk_channel);
    if (afk !== undefined) body.afk_channel_id = afk;
    const sys = ref(f.system_channel);
    if (sys !== undefined) body.system_channel_id = sys;
    const rules = ref(f.rules_channel);
    if (rules !== undefined) body.rules_channel_id = rules;
    const updates = ref(f.public_updates_channel);
    if (updates !== undefined) body.public_updates_channel_id = updates;
    const safety = ref(f.safety_alerts_channel);
    if (safety !== undefined) body.safety_alerts_channel_id = safety;
    if (f.community !== undefined) {
      const snap = await this.snapshot();
      const features = new Set(snap.guild.features);
      if (f.community) features.add('COMMUNITY');
      else features.delete('COMMUNITY');
      body.features = [...features];
    }
    return body;
  }

  private automodBody(f: AutoModFields) {
    return automodWriteBody(f, (ref, kind) => this.resolve(ref, kind));
  }

  private async panel(
    step: Extract<PlanStep, { action: 'post_panel' | 'edit_panel' }>,
    r: StepResult,
    ctx: OpContext,
  ): Promise<void> {
    const { store, adapter } = this.deps;
    const g = this.guildId;
    const f: PanelFields = step.fields;
    const channelId = this.resolve(f.channel, 'channel');
    const options = f.options.map((o) => ({
      roleId: this.resolve(o.role, 'role'),
      label: o.label,
      ...(o.emoji ? { emoji: o.emoji } : {}),
      ...(o.style ? { style: o.style } : {}),
    }));
    const snap = await this.snapshot();
    const prot = new Set(store.listProtectedRoles(g));
    const allow = new Set(store.listSelfRoles(g));
    for (const o of options) {
      if (!allow.has(o.roleId))
        throw new StewardError('forbidden', `role ${o.roleId} is not in the self-role allowlist`);
      assertSelfAssignable(snap, o.roleId, prot);
    }
    const panelId = step.panelId ?? newId('rp');
    const content = { title: f.title, description: f.description, mode: f.mode, options };
    const body = buildPanelMessage(panelId, content);
    let messageId: string;
    if (step.action === 'edit_panel') {
      const out = await runOperation(ctx, {
        action: 'edit_message',
        resourceKind: 'role_panel',
        resourceKey: step.key,
        targetId: step.messageId,
        summary: step.summary,
        idempotent: true,
        run: () => adapter.editMessage(step.channelId, step.messageId, body),
      });
      this.track(r, out, step.messageId);
      messageId = step.messageId;
    } else {
      const out = await runOperation(ctx, {
        action: 'post_message',
        resourceKind: 'role_panel',
        resourceKey: step.key,
        targetId: channelId,
        summary: step.summary,
        idempotent: true,
        recordMatch: {
          kind: 'panel',
          key: step.key,
          channelId,
          fingerprint: messageFingerprint(body),
          panel: { id: panelId, ...content },
        },
        run: (_reason, opId) =>
          adapter.sendMessage(channelId, { ...body, nonce: opId.slice(0, 25), enforce_nonce: true }),
        resultId: (m) => m.id,
      });
      if (out.status !== 'succeeded') throw new StewardError('internal', 'panel post returned no message');
      this.track(r, out, out.result.id);
      messageId = out.result.id;
    }
    store.upsertPanel({ id: panelId, guildId: g, key: step.key, channelId, messageId, ...content });
    if (step.action === 'post_panel' && step.replaces)
      await this.deleteOldMessage(ctx, r, step.replaces, step.key);
  }
}
