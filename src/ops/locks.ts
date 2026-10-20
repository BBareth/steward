import { StewardError } from '../util/errors.js';

/**
 * One writer per guild at a time. A blueprint apply holds the lock for its
 * whole run; single-resource tools hold it for one call. Waiting is short and
 * bounded: a long apply should be reported, not queued behind.
 */
export class GuildLocks {
  private holders = new Map<string, { owner: string; release: Promise<void> }>();

  holder(guildId: string): string | null {
    return this.holders.get(guildId)?.owner ?? null;
  }

  async acquire(guildId: string, owner: string, waitMs = 10_000): Promise<() => void> {
    const deadline = Date.now() + waitMs;
    while (this.holders.has(guildId)) {
      const current = this.holders.get(guildId)!;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new StewardError(
          'conflict',
          `another change is running in this server (${current.owner}); try again when it finishes`,
        );
      }
      await Promise.race([current.release, new Promise((r) => setTimeout(r, remaining))]);
    }
    let done!: () => void;
    const release = new Promise<void>((r) => (done = r));
    this.holders.set(guildId, { owner, release });
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.holders.delete(guildId);
      done();
    };
  }
}
