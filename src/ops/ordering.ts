import { botStanding, compareRoles, rolesTopDown } from '../discord/permissions.js';
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

/** Whether `desiredIds` appear in that relative order within one sorting bucket. */
export function channelOrderHolds(
  snapshot: GuildSnapshot,
  parentId: string | null,
  group: 'category' | 'text' | 'voice',
  desiredIds: string[],
): boolean {
  const present = desiredIds.filter((id) => snapshot.channels.some((c) => c.id === id));
  const actual = bucketMembers(snapshot, parentId, group)
    .map((c) => c.id)
    .filter((id) => present.includes(id));
  return actual.length === present.length && actual.every((id, i) => id === present[i]);
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

export interface RoleOrderPlan {
  /** Whether the requested roles are already in the requested relative order. */
  inOrder: boolean;
  /** Position changes to send; empty when in order or blocked. */
  updates: PositionUpdate[];
  /** Why the order cannot be reached without help, or null. */
  blocker: string | null;
  /** The requested roles in their current order, top first (for reports). */
  currentOrder: string[];
}

/**
 * How to put `desiredIds` (top first) in order among the roles below the bot.
 *
 * Discord lets several roles share a `position` and orders them by id (the
 * lower id ranks higher), so position numbers alone cannot be trusted: a
 * guild where many roles sit at position 1 is common, and "reuse the slots'
 * numbers" then changes nothing. This works in Discord's real order instead.
 *
 * Only roles strictly below the bot's highest role are touched; the bot's own
 * role and everything above it keep their positions. Roles that are not
 * requested keep their slots (`slotFill`), so their relative order holds.
 * When there is no way to express the order in the position numbers available
 * below the bot, the result names the blocker rather than pretending.
 */
export function roleOrderPlan(snapshot: GuildSnapshot, desiredIds: string[]): RoleOrderPlan {
  const top = botStanding(snapshot).highestRole;
  const byId = new Map(snapshot.roles.map((r) => [r.id, r]));
  const wanted = desiredIds.filter((id) => byId.has(id));
  const all = rolesTopDown(snapshot).filter((r) => r.id !== snapshot.guild.id);
  const currentOrder = all.map((r) => r.id).filter((id) => wanted.includes(id));
  const inOrder = currentOrder.every((id, i) => id === wanted[i]);
  const result = (blocker: string | null, updates: PositionUpdate[] = []): RoleOrderPlan => ({
    inOrder,
    updates: blocker ? [] : updates,
    blocker,
    currentOrder,
  });
  if (inOrder) return result(null);
  if (!top) return result('the bot has no role in this server, so it cannot order roles');
  const outOfReach = wanted.map((id) => byId.get(id)!).filter((r) => compareRoles(r, top) >= 0);
  if (outOfReach.length > 0) {
    return result(
      `${outOfReach.map((r) => `"${r.name}"`).join(', ')} ${outOfReach.length === 1 ? 'is' : 'are'} not below the bot's highest role "${top.name}"; move the bot's role above ${outOfReach.length === 1 ? 'it' : 'them'} in Server Settings → Roles`,
    );
  }

  // The roles the bot may renumber, top first, and the order they should end in.
  const region = all.filter((r) => compareRoles(r, top) < 0);
  const current = region.map((r) => r.id);
  const target = slotFill(current, wanted);
  const n = target.length;
  const positions = region.map((r) => r.position);
  let assigned: number[];

  const unique = positions.every((p, i) => i === 0 || p < positions[i - 1]!);
  if (unique && positions[0]! < top.position) {
    // Distinct numbers already: hand the same numbers out in the new order, so
    // the smallest possible set of roles changes.
    assigned = positions;
  } else {
    // Renumber the region below the bot. Room for distinct numbers is
    // 1..(bot position - 1); position 0 belongs to @everyone.
    const room = top.position - 1;
    if (n <= room) {
      assigned = target.map((_, i) => n - i);
    } else {
      // Not enough distinct numbers: reuse a number wherever Discord's id
      // tie-breaker already puts the pair in the wanted order.
      assigned = new Array<number>(n);
      assigned[n - 1] = 1;
      for (let i = n - 2; i >= 0; i--) {
        const tieWorks = BigInt(target[i]!) < BigInt(target[i + 1]!);
        assigned[i] = tieWorks ? assigned[i + 1]! : assigned[i + 1]! + 1;
      }
      if (assigned[0]! > room) {
        const tied = positions.filter((p) => positions.filter((q) => q === p).length > 1).length;
        return result(
          `the order needs ${assigned[0]} distinct positions below the bot's highest role "${top.name}", but it is at position ${top.position}, which leaves ${Math.max(room, 0)}` +
            (tied
              ? ` (Discord currently stores ${tied} of the ${n} roles below it on shared positions)`
              : '') +
            ". steward never moves the bot's own role. Drag the bot's role higher in Server Settings → Roles, then plan again",
        );
      }
    }
  }

  const updates: PositionUpdate[] = [];
  target.forEach((id, i) => {
    if (byId.get(id)!.position !== assigned[i]) updates.push({ id, position: assigned[i]! });
  });
  return result(null, updates);
}

/** The requested roles' order after a change, for checking that Discord actually applied it. */
export function roleOrderHolds(snapshot: GuildSnapshot, desiredIds: string[]): boolean {
  return roleOrderPlan(snapshot, desiredIds).inOrder;
}
