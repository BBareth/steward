import { rolesTopDown } from '../discord/permissions.js';
import type { ChannelInfo, ChannelKind, GuildSnapshot, PositionUpdate } from '../discord/types.js';

/**
 * Reordering that leaves unmanaged resources where they are.
 *
 * Take the current list, find the slots held by managed items, and refill
 * just those slots in the desired order. A channel someone added by hand
 * between two managed channels stays between them.
 */
export function slotFill(current: string[], desired: string[]): string[] {
  const wanted = new Set(desired);
  const slots = current.flatMap((id, i) => (wanted.has(id) ? [i] : []));
  const present = desired.filter((id) => current.includes(id));
  const out = [...current];
  slots.forEach((slot, i) => (out[slot] = present[i]!));
  return out;
}

const TEXT_GROUP = new Set<ChannelKind>(['text', 'announcement', 'forum', 'media']);

export function channelGroup(kind: ChannelKind): 'category' | 'text' | 'voice' {
  return kind === 'category' ? 'category' : TEXT_GROUP.has(kind) ? 'text' : 'voice';
}

export function sortChannels(a: ChannelInfo, b: ChannelInfo): number {
  return a.position - b.position || (BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0);
}

export function bucketMembers(
  snapshot: GuildSnapshot,
  parentId: string | null,
  group: 'category' | 'text' | 'voice',
): ChannelInfo[] {
  return snapshot.channels
    .filter(
      (c) =>
        c.kind !== 'other' &&
        channelGroup(c.kind) === group &&
        (group === 'category' || (c.parentId ?? null) === parentId),
    )
    .sort(sortChannels);
}

/** Position updates that put `desiredIds` in order within one sorting bucket. Empty if already in order. */
export function channelPositionUpdates(siblings: ChannelInfo[], desiredIds: string[]): PositionUpdate[] {
  const current = [...siblings].sort(sortChannels);
  const ids = current.map((c) => c.id);
  const next = slotFill(ids, desiredIds);
  if (next.every((id, i) => id === ids[i])) return [];
  const positions = current.map((c) => c.position);
  const unique = positions.every((p, i) => i === 0 || p > positions[i - 1]!);
  const byId = new Map(current.map((c) => [c.id, c]));
  const updates: PositionUpdate[] = [];
  next.forEach((id, i) => {
    const position = unique ? positions[i]! : i;
    if (byId.get(id)!.position !== position) updates.push({ id, position });
  });
  return updates;
}

/** Position updates that put `desiredIds` (top first) in order among the guild's roles. */
export function rolePositionUpdates(snapshot: GuildSnapshot, desiredIds: string[]): PositionUpdate[] {
  const current = rolesTopDown(snapshot).filter((r) => r.id !== snapshot.guild.id);
  const ids = current.map((r) => r.id);
  const next = slotFill(ids, desiredIds);
  if (next.every((id, i) => id === ids[i])) return [];
  // Reuse the slots' own position numbers so roles outside the set never move.
  const positions = current.map((r) => r.position);
  const byId = new Map(current.map((r) => [r.id, r]));
  const updates: PositionUpdate[] = [];
  next.forEach((id, i) => {
    if (byId.get(id)!.position !== positions[i]) updates.push({ id, position: positions[i]! });
  });
  return updates;
}
