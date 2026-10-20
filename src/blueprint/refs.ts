import { StewardError } from '../util/errors.js';
import { isSnowflake } from '../util/ids.js';
import type { MappingKind } from '../store.js';

/**
 * References inside a plan. Keys are resolved through the mapping table at
 * execution time, so a step that runs after a create sees the new ID.
 *
 *   "everyone"    the @everyone role
 *   "key:<key>"   a blueprint resource
 *   "id:<id>"     a Discord resource the blueprint names by ID
 *   "member:<id>" a member (overwrite targets only)
 */
export type RefString = string;

export function roleRef(ref: string): RefString {
  if (ref === 'everyone') return 'everyone';
  return isSnowflake(ref) ? `id:${ref}` : `key:${ref}`;
}

export function channelRef(ref: string): RefString {
  return isSnowflake(ref) ? `id:${ref}` : `key:${ref}`;
}

export function refKey(ref: RefString): string | null {
  return ref.startsWith('key:') ? ref.slice(4) : null;
}

export type Lookup = (kind: MappingKind, key: string) => string | undefined;

export function resolveRef(
  ref: RefString,
  kind: MappingKind,
  guildId: string,
  lookup: Lookup,
): string | null {
  if (ref === 'everyone') return guildId;
  if (ref.startsWith('id:')) return ref.slice(3);
  if (ref.startsWith('member:')) return ref.slice(7);
  const key = refKey(ref);
  if (key) return lookup(kind, key) ?? null;
  return null;
}

export function mustResolve(ref: RefString, kind: MappingKind, guildId: string, lookup: Lookup): string {
  const id = resolveRef(ref, kind, guildId, lookup);
  if (!id) {
    throw new StewardError(
      'precondition_failed',
      `${kind} "${refKey(ref) ?? ref}" has no Discord ID yet (the step that creates it did not succeed)`,
    );
  }
  return id;
}

export function describeRef(ref: RefString): string {
  if (ref === 'everyone') return '@everyone';
  return ref
    .replace(/^key:/, '')
    .replace(/^id:/, '#')
    .replace(/^member:/, 'member ');
}
