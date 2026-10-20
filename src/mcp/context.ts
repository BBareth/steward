import type { BlueprintService } from '../blueprint/service.js';
import type { Config, Scope } from '../config.js';
import type { DiscordAdapter } from '../discord/adapter.js';
import type { Logger } from '../logger.js';
import type { GuildLocks } from '../ops/locks.js';
import type { Store } from '../store.js';

/** Long-lived dependencies shared by every request. */
export interface AppContext {
  config: Config;
  store: Store;
  adapter: DiscordAdapter;
  logger: Logger;
  locks: GuildLocks;
  blueprints: BlueprintService;
  startedAt: Date;
  /** Tests set this to 0 so retries do not sleep. */
  backoffMs?: number;
}

/** Who is calling, as established by the bearer token. */
export interface Caller {
  clientId: string;
  scopes: ReadonlySet<Scope>;
  /** null: every configured guild. */
  guilds: readonly string[] | null;
}
