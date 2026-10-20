import type { DiscordAdapter } from '../discord/adapter.js';
import type { Logger } from '../logger.js';
import type { MappingKind, Store } from '../store.js';
import { DiscordRequestError, StewardError, safeErrorMessage } from '../util/errors.js';
import { newId, snowflakeTime } from '../util/ids.js';

/**
 * Every Discord mutation goes through `runOperation`. It writes a journal row
 * before the request, records the outcome after, retries what is safe to
 * retry, and refuses to blindly retry what is not.
 *
 * Discord has no transactions and no idempotency keys for creating channels,
 * roles or AutoMod rules. When such a request times out we cannot know
 * whether it happened, so we look: first in the audit log for our operation
 * id (it is in the audit-log reason), then for a resource with the expected
 * name and shape created after the request started. Only if neither finds
 * anything do we try again.
 */

export interface OpContext {
  store: Store;
  adapter: DiscordAdapter;
  logger: Logger;
  guildId: string;
  planId: string | null;
  stepId: string | null;
  tool: string;
  clientId: string | null;
  userReason?: string;
  /** Milliseconds to wait before reconciling or retrying; tests set 0. */
  backoffMs?: number;
}

export interface CreateMatch {
  kind: MappingKind;
  name: string;
  type?: number;
  parentId?: string | null;
}

export interface OpSpec<T> {
  action: string;
  resourceKind: string;
  resourceKey?: string | null;
  targetId?: string | null;
  summary: string;
  /** True when repeating the request cannot do harm (PATCH, PUT, DELETE, nonce'd POST). */
  idempotent: boolean;
  /** For non-idempotent creates: how to recognise the resource if the outcome is uncertain. */
  match?: CreateMatch;
  /**
   * Stored with the journal row so a later run can check whether an
   * interrupted request took effect (used for message posts).
   */
  recordMatch?: Record<string, unknown>;
  /** A 404 means the work is already done (deletes). */
  notFoundIsSuccess?: boolean;
  run: (reason: string, opId: string) => Promise<T>;
  resultId?: (result: T) => string | null;
}

export type OpOutcome<T> =
  | { status: 'succeeded'; opId: string; result: T; attempts: number }
  | { status: 'recovered'; opId: string; recoveredId: string; attempts: number }
  | { status: 'noop'; opId: string; attempts: number };

export class OperationError extends StewardError {
  constructor(
    readonly opId: string,
    readonly outcome: 'failed' | 'uncertain',
    message: string,
    readonly underlying?: unknown,
  ) {
    super(underlying instanceof DiscordRequestError ? 'discord_error' : 'internal', message, {
      opId,
      outcome,
    });
    this.name = 'OperationError';
  }
}

const sleep = (ms: number) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

export function auditReason(
  opId: string,
  ctx: Pick<OpContext, 'planId' | 'userReason'>,
  summary: string,
): string {
  const base = `steward ${opId}${ctx.planId ? ` ${ctx.planId}` : ''}: ${summary}`;
  return ctx.userReason ? `${base} (${ctx.userReason})` : base;
}

const AUDIT_ACTIONS: Record<MappingKind, number> = { channel: 10, role: 30, automod: 140 };

export type ReconcileResult =
  { found: string; via: 'audit_log' | 'heuristic' } | { absent: true } | { ambiguous: string[] };

/** Look for a resource that an uncertain create may have produced. */
export async function reconcileCreate(
  adapter: DiscordAdapter,
  store: Store,
  guildId: string,
  opId: string,
  startedAt: number,
  match: CreateMatch,
): Promise<ReconcileResult> {
  const exists = async (): Promise<
    Array<{ id: string; name: string; type?: number; parentId?: string | null }>
  > => {
    if (match.kind === 'automod')
      return (await adapter.fetchAutoModRules(guildId)).map((r) => ({ id: r.id, name: r.name }));
    const snap = await adapter.fetchSnapshot(guildId);
    return match.kind === 'role'
      ? snap.roles.map((r) => ({ id: r.id, name: r.name }))
      : snap.channels.map((c) => ({ id: c.id, name: c.name, type: c.type, parentId: c.parentId }));
  };
  const items = await exists();
  try {
    const entries = await adapter.fetchAuditLog(guildId, AUDIT_ACTIONS[match.kind], 50);
    const hit = entries.find((e) => e.targetId && e.reason?.includes(opId));
    if (hit && items.some((i) => i.id === hit.targetId)) return { found: hit.targetId!, via: 'audit_log' };
  } catch {
    // No View Audit Log permission, or the audit log is unavailable: fall back.
  }
  const candidates = items.filter(
    (i) =>
      i.name === match.name &&
      (match.type === undefined || i.type === match.type) &&
      (match.parentId === undefined || (i.parentId ?? null) === match.parentId) &&
      snowflakeTime(i.id) >= startedAt - 5_000 &&
      !store.findMappingById(guildId, match.kind, i.id),
  );
  if (candidates.length === 1) return { found: candidates[0]!.id, via: 'heuristic' };
  if (candidates.length === 0) return { absent: true };
  return { ambiguous: candidates.map((c) => c.id) };
}

export async function runOperation<T>(ctx: OpContext, spec: OpSpec<T>): Promise<OpOutcome<T>> {
  const opId = newId('op');
  const reason = auditReason(opId, ctx, spec.summary);
  const startedAt = Date.now();
  const backoff = ctx.backoffMs ?? 1500;
  ctx.store.startOperation({
    id: opId,
    guildId: ctx.guildId,
    planId: ctx.planId,
    stepId: ctx.stepId,
    tool: ctx.tool,
    clientId: ctx.clientId,
    action: spec.action,
    resourceKind: spec.resourceKind,
    resourceKey: spec.resourceKey ?? null,
    targetId: spec.targetId ?? null,
    summary: spec.summary,
    auditReason: reason,
    matchJson:
      spec.match || spec.recordMatch
        ? JSON.stringify({ ...(spec.match ?? spec.recordMatch), startedAt })
        : null,
  });
  const log = ctx.logger.child({ opId, guildId: ctx.guildId, action: spec.action });
  const maxAttempts = spec.idempotent ? 3 : 2;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    ctx.store.bumpAttempts(opId);
    try {
      const result = await spec.run(reason, opId);
      const id = spec.resultId?.(result) ?? spec.targetId ?? null;
      ctx.store.finishOperation(opId, 'succeeded', {
        targetId: id,
        resultJson: id ? JSON.stringify({ id }) : null,
      });
      log.info('operation succeeded', { attempt, targetId: id });
      return { status: 'succeeded', opId, result, attempts: attempt };
    } catch (error) {
      lastError = error;
      if (!(error instanceof DiscordRequestError)) {
        ctx.store.finishOperation(opId, 'failed', { error: safeErrorMessage(error) });
        throw new OperationError(opId, 'failed', safeErrorMessage(error), error);
      }
      if (error.isNotFound && spec.notFoundIsSuccess) {
        ctx.store.finishOperation(opId, 'succeeded', {
          resultJson: JSON.stringify({ note: 'already gone' }),
        });
        return { status: 'noop', opId, attempts: attempt };
      }
      if (!error.uncertain) {
        ctx.store.finishOperation(opId, 'failed', { error: safeErrorMessage(error) });
        log.warn('operation failed', {
          attempt,
          error: error.message,
          status: error.status,
          code: error.code,
        });
        throw new OperationError(opId, 'failed', safeErrorMessage(error), error);
      }
      log.warn('operation outcome uncertain', { attempt, kind: error.kind });
      if (!spec.idempotent && spec.match) {
        await sleep(backoff);
        let rec: ReconcileResult;
        try {
          rec = await reconcileCreate(ctx.adapter, ctx.store, ctx.guildId, opId, startedAt, spec.match);
        } catch (reconcileError) {
          ctx.store.finishOperation(opId, 'uncertain', {
            error: `request outcome unknown and reconciliation failed: ${safeErrorMessage(reconcileError)}`,
          });
          throw new OperationError(
            opId,
            'uncertain',
            'Discord did not confirm the request and steward could not check whether it happened',
            error,
          );
        }
        if ('found' in rec) {
          ctx.store.finishOperation(opId, 'recovered', {
            targetId: rec.found,
            resultJson: JSON.stringify({ id: rec.found, via: rec.via }),
          });
          log.info('uncertain create reconciled', { targetId: rec.found, via: rec.via });
          return { status: 'recovered', opId, recoveredId: rec.found, attempts: attempt };
        }
        if ('ambiguous' in rec) {
          ctx.store.finishOperation(opId, 'uncertain', {
            error: `request outcome unknown; several matching resources exist: ${rec.ambiguous.join(', ')}`,
          });
          throw new OperationError(
            opId,
            'uncertain',
            `Discord did not confirm the request, and ${rec.ambiguous.length} resources named "${spec.match.name}" now exist (${rec.ambiguous.join(', ')}); bind the right one with map_resource and delete the others`,
            error,
          );
        }
        // Not there: the request did not take effect, so it is safe to send again.
        continue;
      }
      if (!spec.idempotent) break;
      await sleep(backoff * attempt);
    }
  }
  const msg = safeErrorMessage(lastError);
  ctx.store.finishOperation(opId, 'uncertain', { error: msg });
  throw new OperationError(
    opId,
    'uncertain',
    `Discord did not confirm the request after retrying: ${msg}`,
    lastError,
  );
}
