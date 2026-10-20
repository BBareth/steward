import type { DiscordAdapter, ReactionAddEvent } from '../discord/adapter.js';
import type { Logger } from '../logger.js';
import { OperationError, runOperation } from '../ops/journal.js';
import type { Store } from '../store.js';
import { DiscordRequestError, safeErrorMessage } from '../util/errors.js';

/**
 * Keeps steward's own messages free of reactions from ordinary members.
 *
 * Off unless DISCORD_BOT_REACTION_GUARD=true, and never active in read-only
 * mode. It works from the raw gateway event (Guild Message Reactions, not a
 * privileged intent), so reactions on messages discord.js never cached are
 * seen too; no message content is needed. Only messages written by steward's
 * own bot user are touched: other people's messages, other bots' messages
 * (which may run their own reaction roles) and webhook posts keep every
 * reaction. Self-role panels use buttons, which are unaffected.
 *
 * Discord's role hierarchy does not limit who a bot with Manage Messages can
 * remove reactions from, so the exemptions here are the only safeguard. They
 * are checked before any request, and anything steward cannot establish
 * (who wrote the message, who reacted) keeps the reaction.
 */

/** Members holding a role bound to one of these blueprint keys keep their reactions. */
export const REACTION_GUARD_EXEMPT_KEYS = ['owner', 'admin', 'moderator', 'bot'] as const;

/** Removals waiting or in flight before new ones are dropped. */
const MAX_PENDING = 100;
/** How long a channel is left alone after Discord refuses a removal there. */
const PAUSE_MS = 10 * 60_000;
const AUTHOR_CACHE = 1000;

/**
 * The route segment for an emoji. Discord wants it URL-encoded: unicode emoji
 * whole (a keycap's "#" would otherwise end the path), custom emoji as
 * name:id. null for a custom emoji Discord sent without a name (a deleted
 * one), since the docs do not say what to send for it.
 */
export function reactionEmojiSegment(emoji: { id: string | null; name: string | null }): string | null {
  if (!emoji.name) return null;
  return encodeURIComponent(emoji.id ? `${emoji.name}:${emoji.id}` : emoji.name);
}

export type KeepReason =
  | 'inactive'
  | 'other_guild'
  | 'bot_unknown'
  | 'own_reaction'
  | 'author_unknown'
  | 'not_steward_message'
  | 'guild_owner'
  | 'member_unknown'
  | 'bot'
  | 'exempt_role'
  | 'emoji_unknown';

export type GuardDecision = { remove: true; emoji: string } | { remove: false; reason: KeepReason };

export interface GuardFacts {
  active: boolean;
  allowedGuildIds: readonly string[];
  /** Who wrote the message; null when unknown. */
  authorId: string | null;
  /** The reacting member; null when unknown. */
  member: { roleIds: readonly string[]; isBot: boolean } | null;
  exemptRoleIds: ReadonlySet<string>;
}

/** Whether a reaction goes. Each check that could keep it runs before the next lookup is needed. */
export function decideReaction(event: ReactionAddEvent, facts: GuardFacts): GuardDecision {
  const keep = (reason: KeepReason): GuardDecision => ({ remove: false, reason });
  if (!facts.active) return keep('inactive');
  if (!facts.allowedGuildIds.includes(event.guildId)) return keep('other_guild');
  if (!event.botUserId) return keep('bot_unknown');
  if (event.userId === event.botUserId) return keep('own_reaction');
  if (!facts.authorId) return keep('author_unknown');
  if (facts.authorId !== event.botUserId) return keep('not_steward_message');
  if (event.userId === event.guildOwnerId) return keep('guild_owner');
  if (!facts.member) return keep('member_unknown');
  if (facts.member.isBot) return keep('bot');
  if (facts.member.roleIds.some((id) => facts.exemptRoleIds.has(id))) return keep('exempt_role');
  const emoji = reactionEmojiSegment(event.emoji);
  if (!emoji) return keep('emoji_unknown');
  return { remove: true, emoji };
}

export interface ReactionGuardDeps {
  store: Store;
  adapter: DiscordAdapter;
  logger: Logger;
  allowedGuildIds: readonly string[];
  /** DISCORD_BOT_REACTION_GUARD=true and not read-only. */
  active: boolean;
  backoffMs?: number;
}

export interface ReactionGuardStats {
  removed: number;
  kept: number;
  failed: number;
  dropped: number;
  last_removed_at: string | null;
  last_error: string | null;
}

export class ReactionGuard {
  readonly stats: ReactionGuardStats = {
    removed: 0,
    kept: 0,
    failed: 0,
    dropped: 0,
    last_removed_at: null,
    last_error: null,
  };
  private readonly pending = new Set<string>();
  private readonly authors = new Map<string, string | null>();
  private readonly paused = new Map<string, number>();

  constructor(private readonly deps: ReactionGuardDeps) {}

  get active(): boolean {
    return this.deps.active;
  }

  /** Channels where removals are paused after Discord refused one. */
  pausedChannels(now = Date.now()): string[] {
    return [...this.paused].filter(([, until]) => until > now).map(([id]) => id);
  }

  async handle(event: ReactionAddEvent): Promise<void> {
    const facts: GuardFacts = {
      active: this.deps.active,
      allowedGuildIds: this.deps.allowedGuildIds,
      authorId: event.messageAuthorId,
      member:
        event.member && event.member.isBot !== null ? { ...event.member, isBot: event.member.isBot } : null,
      exemptRoleIds: new Set(),
    };
    let decision = decideReaction(event, facts);
    // Look up only what the event left out, and only once the cheaper checks passed.
    if (!decision.remove && decision.reason === 'author_unknown') {
      facts.authorId = await this.authorOf(event);
      decision = decideReaction(event, facts);
    }
    if (!decision.remove && decision.reason === 'member_unknown') {
      facts.member = await this.memberOf(event);
      decision = decideReaction(event, facts);
    }
    if (decision.remove) {
      facts.exemptRoleIds = this.exemptRoleIds(event.guildId);
      decision = decideReaction(event, facts);
    }
    if (!decision.remove) {
      this.stats.kept++;
      this.deps.logger.debug('reaction kept', {
        guildId: event.guildId,
        messageId: event.messageId,
        why: decision.reason,
      });
      return;
    }
    await this.remove(event, decision.emoji);
  }

  private exemptRoleIds(guildId: string): Set<string> {
    const keys = new Set<string>(REACTION_GUARD_EXEMPT_KEYS);
    return new Set(
      this.deps.store
        .listMappings(guildId, 'role')
        .filter((m) => keys.has(m.key))
        .map((m) => m.discordId),
    );
  }

  /** The message's author when the event left it out; cached, and null when it cannot be read. */
  private async authorOf(event: ReactionAddEvent): Promise<string | null> {
    if (this.authors.has(event.messageId)) return this.authors.get(event.messageId)!;
    let author: string | null = null;
    try {
      author = (await this.deps.adapter.fetchMessage(event.channelId, event.messageId))?.authorId ?? null;
    } catch (error) {
      this.deps.logger.debug('could not read the reacted message', { error: safeErrorMessage(error) });
    }
    this.authors.set(event.messageId, author);
    if (this.authors.size > AUTHOR_CACHE) this.authors.delete(this.authors.keys().next().value!);
    return author;
  }

  /** The reacting member when the event left them out. Needs no privileged intent. */
  private async memberOf(event: ReactionAddEvent): Promise<GuardFacts['member']> {
    try {
      const m = await this.deps.adapter.fetchMember(event.guildId, event.userId);
      return m ? { roleIds: m.roleIds, isBot: m.isBot } : null;
    } catch (error) {
      this.deps.logger.debug('could not read the reacting member', { error: safeErrorMessage(error) });
      return null;
    }
  }

  private async remove(event: ReactionAddEvent, emoji: string): Promise<void> {
    const key = `${event.channelId}:${event.messageId}:${event.userId}:${emoji}`;
    // Replayed gateway events and double reactions come through here twice.
    if (this.pending.has(key)) return;
    if ((this.paused.get(event.channelId) ?? 0) > Date.now()) {
      this.stats.kept++;
      return;
    }
    if (this.pending.size >= MAX_PENDING) {
      this.stats.dropped++;
      if (this.stats.dropped % 100 === 1)
        this.deps.logger.warn('reaction guard is behind; dropping removals', { dropped: this.stats.dropped });
      return;
    }
    this.pending.add(key);
    try {
      await runOperation(
        {
          store: this.deps.store,
          adapter: this.deps.adapter,
          logger: this.deps.logger,
          guildId: event.guildId,
          planId: null,
          stepId: null,
          tool: 'reaction_guard',
          clientId: null,
          backoffMs: this.deps.backoffMs,
        },
        {
          action: 'remove_reaction',
          resourceKind: 'reaction',
          targetId: event.messageId,
          summary: `remove a${event.burst ? ' super' : ''} reaction by user ${event.userId} from steward's message ${event.messageId}`,
          idempotent: true,
          notFoundIsSuccess: true,
          run: () =>
            this.deps.adapter.removeUserReaction(event.channelId, event.messageId, emoji, event.userId),
        },
      );
      this.stats.removed++;
      this.stats.last_removed_at = new Date().toISOString();
    } catch (error) {
      this.failed(event, error);
    } finally {
      this.pending.delete(key);
    }
  }

  private failed(event: ReactionAddEvent, error: unknown): void {
    this.stats.failed++;
    this.stats.last_error = safeErrorMessage(error);
    const e = error instanceof OperationError ? error.underlying : error;
    const where = { guildId: event.guildId, channelId: event.channelId, messageId: event.messageId };
    if (e instanceof DiscordRequestError && e.code === 60003) {
      this.deps.logger.warn(
        'reaction guard: Discord requires two-factor authentication on the bot owner account',
        where,
      );
    } else if (e instanceof DiscordRequestError && e.code === 50083) {
      this.deps.logger.info('reaction guard: the thread is archived, leaving the reaction', where);
    } else if (e instanceof DiscordRequestError && e.status === 403) {
      // Repeated 403s count towards Discord's invalid-request limit, so stop
      // trying in this channel for a while instead of logging each one.
      this.paused.set(event.channelId, Date.now() + PAUSE_MS);
      this.deps.logger.warn(
        'reaction guard paused in a channel for 10 minutes: Discord refused the removal (the bot needs Manage Messages there)',
        where,
      );
    } else {
      this.deps.logger.warn('reaction guard could not remove a reaction', {
        ...where,
        error: this.stats.last_error,
      });
    }
  }
}
