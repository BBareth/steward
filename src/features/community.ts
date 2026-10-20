import type { ChannelKind } from '../discord/types.js';

/**
 * Channel types Discord ties to the Community feature.
 *
 * Discord's developer docs list announcement channels as a Community feature,
 * with the older NEWS feature as the other way to have them, and stage
 * channels as something Community enables. Media channels were rolled out to
 * Community servers (with further eligibility on top, per Discord's own
 * announcements). Forum channels launched for Community servers, but Discord
 * no longer documents that as a requirement, so they are not refused.
 */
export function channelKindNeedsCommunity(features: string[], kind: ChannelKind | string): boolean {
  if (features.includes('COMMUNITY')) return false;
  if (kind === 'announcement') return !features.includes('NEWS');
  return kind === 'stage' || kind === 'media';
}

/** Types that wait for the settings step when a plan turns Community on. */
export const AFTER_COMMUNITY_KINDS: ReadonlySet<string> = new Set([
  'announcement',
  'stage',
  'forum',
  'media',
]);
