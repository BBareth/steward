import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BlueprintService } from '../../src/blueprint/service.js';
import { silentLogger } from '../../src/logger.js';
import { GuildLocks } from '../../src/ops/locks.js';
import { Store } from '../../src/store.js';
import type { MemoryAdapterOptions } from './memory-adapter.js';
import { MemoryDiscordAdapter } from './memory-adapter.js';

export interface TestEnv {
  adapter: MemoryDiscordAdapter;
  store: Store;
  service: BlueprintService;
  locks: GuildLocks;
  guildId: string;
  dbPath: string;
  dir: string;
  cleanup: () => void;
}

export function makeEnv(
  options: MemoryAdapterOptions & { allowDestructive?: boolean; membersIntent?: boolean } = {},
): TestEnv {
  const dir = mkdtempSync(join(tmpdir(), 'steward-test-'));
  const dbPath = join(dir, 'steward.db');
  const adapter = new MemoryDiscordAdapter(options);
  if (options.botRolePosition === undefined) adapter.setBotRolePosition(200);
  const store = new Store(dbPath);
  const locks = new GuildLocks();
  const service = new BlueprintService({
    store,
    adapter,
    logger: silentLogger,
    locks,
    backoffMs: 0,
    config: {
      planTtlMinutes: 30,
      applyWaitSeconds: 30,
      membersIntent: options.membersIntent ?? true,
      allowDestructive: options.allowDestructive ?? true,
    },
  });
  return {
    adapter,
    store,
    service,
    locks,
    guildId: adapter.guildId,
    dbPath,
    dir,
    cleanup: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
