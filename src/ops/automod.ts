import type { DiscordAdapter } from '../discord/adapter.js';
import type { AutoModAction, AutoModRuleInfo, AutoModWriteBody } from '../discord/types.js';
import { DiscordRequestError, RefusedChange, safeErrorMessage } from '../util/errors.js';
import { stableStringify } from '../util/hash.js';
import { OperationError } from './journal.js';

/**
 * AutoMod updates that change only what was asked.
 *
 * Every field of Modify AutoMod Rule is optional. Discord's docs do not say
 * whether a sent `actions` array or `trigger_metadata` object replaces or
 * merges with the stored one, so steward assumes it replaces: a body rebuilt
 * from what steward models could erase what it does not (newer action types,
 * unknown metadata keys). Plans, the executor and the MCP tools all diff
 * against the live rule here, send only the fields that differ, and carry the
 * rest over.
 */

export const AUTOMOD_TRIGGERS: Record<number, string> = {
  1: 'keyword',
  3: 'spam',
  4: 'keyword_preset',
  5: 'mention_spam',
  6: 'member_profile',
};

/** Whether steward can express this action: block, alert to a channel, or timeout. */
export function isModelledAction(a: AutoModAction): boolean {
  if (a.type === 1) return true;
  if (a.type === 2) return typeof a.metadata?.channel_id === 'string';
  if (a.type === 3) return typeof a.metadata?.duration_seconds === 'number';
  return false;
}

/** Actions steward cannot express; updates keep them as they are. */
export function unmodelledActions(rule: AutoModRuleInfo): AutoModAction[] {
  return rule.actions.filter((a) => !isModelledAction(a));
}

const actionKey = (a: AutoModAction) =>
  stableStringify({
    type: a.type,
    channel_id: a.type === 2 ? a.metadata?.channel_id : undefined,
    duration_seconds: a.type === 3 ? a.metadata?.duration_seconds : undefined,
    custom_message: a.type === 1 ? a.metadata?.custom_message || undefined : undefined,
  });

/** Empty lists, false and absent all mean "not set" to Discord. */
const valueKey = (v: unknown): string | undefined => {
  if (v === undefined || v === null || v === false) return undefined;
  if (Array.isArray(v)) return v.length ? JSON.stringify(v.map(String).sort()) : undefined;
  return JSON.stringify(v);
};

const sameSet = (a: string[], b: string[]) => valueKey(a) === valueKey(b);

/** A rule as plans and tools describe it, with role and channel references still to resolve. */
export interface AutoModSpec {
  name: string;
  enabled: boolean;
  trigger_metadata: Record<string, unknown>;
  actions: Array<{ type: number; channel?: string; duration_seconds?: number; custom_message?: string }>;
  exempt_roles: string[];
  exempt_channels: string[];
}

/** The body Discord receives for `spec` (trigger and event type aside). */
export function automodWriteBody(
  spec: AutoModSpec,
  resolve: (ref: string, kind: 'role' | 'channel') => string,
): AutoModWriteBody {
  return {
    name: spec.name,
    enabled: spec.enabled,
    trigger_metadata: spec.trigger_metadata,
    actions: spec.actions.map((a) =>
      a.type === 1
        ? { type: 1, ...(a.custom_message ? { metadata: { custom_message: a.custom_message } } : {}) }
        : a.type === 2
          ? { type: 2, metadata: { channel_id: resolve(a.channel!, 'channel') } }
          : { type: 3, metadata: { duration_seconds: a.duration_seconds } },
    ),
    exempt_roles: spec.exempt_roles.map((x) => resolve(x, 'role')),
    exempt_channels: spec.exempt_channels.map((x) => resolve(x, 'channel')),
  };
}

export interface AutoModPatch {
  /** Top-level fields that differ; empty when the rule already matches. */
  fields: string[];
  body: AutoModWriteBody;
}

/**
 * The smallest PATCH that turns `live` into `want`. `want` holds only what
 * steward models; a field it leaves out is left alone. When `actions` must be
 * sent, actions steward cannot express are appended unchanged; when
 * `trigger_metadata` must be sent, the wanted keys are laid over the live ones.
 */
export function automodPatch(live: AutoModRuleInfo, want: AutoModWriteBody): AutoModPatch {
  const body: AutoModWriteBody = {};
  const fields: string[] = [];
  if (want.name !== undefined && want.name !== live.name) {
    body.name = want.name;
    fields.push('name');
  }
  if (want.enabled !== undefined && want.enabled !== live.enabled) {
    body.enabled = want.enabled;
    fields.push('enabled');
  }
  if (want.trigger_metadata) {
    const wanted = Object.entries(want.trigger_metadata).filter(([, v]) => v !== undefined);
    if (wanted.some(([k, v]) => valueKey(v) !== valueKey(live.triggerMetadata[k]))) {
      body.trigger_metadata = { ...live.triggerMetadata, ...Object.fromEntries(wanted) };
      fields.push('trigger_metadata');
    }
  }
  if (want.actions) {
    const have = live.actions.filter(isModelledAction).map(actionKey).sort();
    const need = want.actions.map(actionKey).sort();
    if (stableStringify(have) !== stableStringify(need)) {
      body.actions = [...want.actions, ...unmodelledActions(live)];
      fields.push('actions');
    }
  }
  if (want.exempt_roles && !sameSet(want.exempt_roles, live.exemptRoles)) {
    body.exempt_roles = want.exempt_roles;
    fields.push('exempt_roles');
  }
  if (want.exempt_channels && !sameSet(want.exempt_channels, live.exemptChannels)) {
    body.exempt_channels = want.exempt_channels;
    fields.push('exempt_channels');
  }
  return { fields, body };
}

const describe = (rule: AutoModRuleInfo) =>
  `AutoMod rule "${rule.name}" (${rule.id}, ${AUTOMOD_TRIGGERS[rule.triggerType] ?? `trigger type ${rule.triggerType}`})`;

/** The rule a plan or tool call was made against is gone. Nothing was sent. */
export function automodRuleGone(rule: Pick<AutoModRuleInfo, 'id' | 'name'>, opId?: string): RefusedChange {
  return new RefusedChange(
    `AutoMod rule "${rule.name}" (${rule.id}) is no longer listed by Discord; it was deleted or replaced after the plan was made. Nothing was changed; plan again`,
    { rule_id: rule.id, listed: false },
    opId,
  );
}

/**
 * Explain a 404 from Discord for a rule it listed a moment ago. Re-reads the
 * list and the rule itself so the report says what Discord shows now. It never
 * deletes, recreates or skips the rule: the caller fails the step with this.
 */
export async function explainAutomodNotFound(
  adapter: DiscordAdapter,
  guildId: string,
  rule: AutoModRuleInfo,
  attempt: { verb: 'change' | 'delete'; fields?: string[]; error: DiscordRequestError; opId?: string },
): Promise<RefusedChange> {
  const probe = async <T>(fn: () => Promise<T>): Promise<T | 'unknown'> => {
    try {
      return await fn();
    } catch {
      return 'unknown';
    }
  };
  const list = await probe(() => adapter.fetchAutoModRules(guildId));
  const listed = list === 'unknown' ? null : list.some((r) => r.id === rule.id);
  if (listed === false) return automodRuleGone(rule, attempt.opId);
  const single = await probe(() => adapter.fetchAutoModRule(guildId, rule.id));
  const readable = single === 'unknown' ? null : single !== null;
  const what = attempt.fields?.length ? ` (${attempt.fields.join(', ')})` : '';
  const seen =
    listed === null
      ? 'steward could not re-read the rule list to check whether it still exists.'
      : readable === false
        ? 'Discord still lists it, but answers 404 when the rule is read by its id too, so bots cannot address it.'
        : readable
          ? 'Discord still lists it and returns it when read by its id, but refuses this change.'
          : 'Discord still lists it.';
  return new RefusedChange(
    `Discord answered 404 Not Found when steward tried to ${attempt.verb} ${describe(rule)}${what}. ${seen} ` +
      'Discord appears to manage this rule itself. steward did not delete, recreate or skip it, and nothing was changed. ' +
      (attempt.verb === 'change'
        ? "Change it in the server's AutoMod settings in Discord, make the blueprint match it (export_blueprint shows its current settings), or leave it out of the blueprint"
        : "Disable it in the server's AutoMod settings in Discord instead, or leave it out of the prune"),
    {
      rule_id: rule.id,
      name: rule.name,
      trigger_type: rule.triggerType,
      creator_id: rule.creatorId,
      listed,
      readable_by_id: readable,
      attempted: attempt.verb,
      fields: attempt.fields,
      discord_status: attempt.error.status,
      discord_code: attempt.error.code,
      discord_message: safeErrorMessage(attempt.error),
    },
    attempt.opId,
  );
}

/**
 * The DELETE for a rule. A 404 is taken as "already deleted" only when the
 * rule is no longer listed (a retry after a lost response, or someone else
 * deleting it); while Discord still lists it, the 404 stands, because Discord
 * answers 404 for some rules it keeps itself.
 */
export async function deleteRuleRequest(
  adapter: DiscordAdapter,
  guildId: string,
  ruleId: string,
  reason: string,
): Promise<void> {
  try {
    await adapter.deleteAutoModRule(guildId, ruleId, reason);
  } catch (error) {
    if (!(error instanceof DiscordRequestError && error.isNotFound)) throw error;
    let listed = true;
    try {
      listed = (await adapter.fetchAutoModRules(guildId)).some((r) => r.id === ruleId);
    } catch {
      // Cannot tell; keep the 404.
    }
    if (listed) throw error;
  }
}

/**
 * Run a write against a listed rule. A 404 becomes the diagnosis above rather
 * than a bare failure. A delete is also read back, since Discord can accept a
 * delete for a rule it keeps; if the list cannot be read, the delete stands
 * and the note says it was not confirmed.
 */
export async function writeListedRule<T extends { opId: string }>(
  adapter: DiscordAdapter,
  guildId: string,
  rule: AutoModRuleInfo,
  attempt: { verb: 'change' | 'delete'; fields?: string[] },
  send: () => Promise<T>,
): Promise<{ out: T; note?: string }> {
  let out: T;
  try {
    out = await send();
  } catch (error) {
    const underlying = error instanceof OperationError ? error.underlying : undefined;
    if (!(underlying instanceof DiscordRequestError && underlying.isNotFound)) throw error;
    throw await explainAutomodNotFound(adapter, guildId, rule, {
      ...attempt,
      error: underlying,
      opId: (error as OperationError).opId,
    });
  }
  if (attempt.verb !== 'delete') return { out };
  let still: AutoModRuleInfo | undefined;
  try {
    still = (await adapter.fetchAutoModRules(guildId)).find((r) => r.id === rule.id);
  } catch (error) {
    return {
      out,
      note: `Discord accepted the delete; steward could not list the rules afterwards to confirm it (${safeErrorMessage(error)})`,
    };
  }
  if (!still) return { out };
  throw new RefusedChange(
    `Discord answered the delete of ${describe(rule)} with success, but still lists the rule. Discord appears to keep this rule itself; steward did not recreate or change it. Disable it in the server's AutoMod settings in Discord instead, or leave it out of the prune`,
    {
      rule_id: rule.id,
      name: rule.name,
      trigger_type: rule.triggerType,
      creator_id: rule.creatorId,
      listed: true,
    },
    out.opId,
  );
}
