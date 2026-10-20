import { P, permissionsFromNames } from '../discord/permissions.js';
import type { ChannelKind } from '../discord/types.js';

/**
 * Channel access presets, expanded into plain permission overwrites. They
 * exist so an agent can say "private to staff" or "read-only announcements"
 * in one line instead of reasoning about bitfields.
 */

export interface AccessPreset {
  private?: boolean;
  /** Who can see a private channel. Role refs. */
  visible_to?: string[];
  read_only?: boolean;
  /** Who can still post in a read-only channel. Role refs. */
  writers?: string[];
}

export interface OverwriteSpec {
  /** A role ref ("everyone", a key, or a raw id) or a member id. */
  target: string;
  type: 'role' | 'member';
  allow: bigint;
  deny: bigint;
}

const VOICE_KINDS = new Set<ChannelKind>(['voice', 'stage']);

export const SEND_BITS =
  P.SendMessages | P.SendMessagesInThreads | P.CreatePublicThreads | P.CreatePrivateThreads;
export const VOICE_SPEAK_BITS = P.Speak | P.Stream;

export function expandAccess(access: AccessPreset, kind: ChannelKind): OverwriteSpec[] {
  const byTarget = new Map<string, OverwriteSpec>();
  const add = (target: string, allow: bigint, deny: bigint) => {
    const cur = byTarget.get(target) ?? { target, type: 'role' as const, allow: 0n, deny: 0n };
    cur.allow |= allow;
    cur.deny |= deny;
    byTarget.set(target, cur);
  };
  const voice = VOICE_KINDS.has(kind);
  if (access.private) {
    add('everyone', 0n, P.ViewChannel);
    for (const role of access.visible_to ?? []) add(role, P.ViewChannel | (voice ? P.Connect : 0n), 0n);
  }
  if (access.read_only) {
    add('everyone', 0n, voice ? VOICE_SPEAK_BITS : SEND_BITS);
    for (const role of access.writers ?? []) {
      add(role, (voice ? VOICE_SPEAK_BITS : SEND_BITS) | (access.private ? P.ViewChannel : 0n), 0n);
    }
  }
  return [...byTarget.values()];
}

/** Combine overwrite lists. Later entries for the same target replace earlier ones. */
export function mergeOverwrites(...lists: OverwriteSpec[][]): OverwriteSpec[] {
  const out = new Map<string, OverwriteSpec>();
  for (const list of lists) for (const o of list) out.set(`${o.type}:${o.target}`, { ...o });
  return [...out.values()];
}

export function overwriteFromNames(
  target: string,
  type: 'role' | 'member',
  allow: readonly string[],
  deny: readonly string[],
): OverwriteSpec {
  return { target, type, allow: permissionsFromNames(allow), deny: permissionsFromNames(deny) };
}
