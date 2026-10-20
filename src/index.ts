import { BlueprintService } from './blueprint/service.js';
import { ConfigError, loadConfig } from './config.js';
import { DiscordJsAdapter } from './discord/discordjs-adapter.js';
import { ReactionGuard } from './features/reaction-guard.js';
import { handlePanelButton } from './features/role-panels.js';
import { handleMemberJoin } from './features/welcome.js';
import { createHttpServer, hostnamesOnly } from './http/server.js';
import { createLogger, registerSecret } from './logger.js';
import type { AppContext } from './mcp/context.js';
import { createMcp } from './mcp/server.js';
import { GuildLocks } from './ops/locks.js';
import { Store } from './store.js';
import { VERSION } from './version.js';

async function main(): Promise<void> {
  // Register secrets before anything can log them.
  for (const name of ['DISCORD_TOKEN', 'MCP_AUTH_TOKEN']) registerSecret(process.env[name]);

  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`steward: refusing to start.\n${error.message}\n`);
      process.exit(78); // EX_CONFIG
    }
    throw error;
  }
  registerSecret(config.discordToken);
  // Nothing else in the process needs these, so do not leave them lying around.
  for (const name of ['DISCORD_TOKEN', 'MCP_AUTH_TOKEN']) delete process.env[name];

  const logger = createLogger({ level: config.logLevel, bindings: { service: 'steward' } });
  const store = new Store(config.databasePath);
  const interrupted = store.markInterrupted();
  if (interrupted.operations || interrupted.plans) {
    logger.warn(
      'previous run stopped mid-apply; affected operations are marked uncertain and are checked before the next plan',
      interrupted,
    );
  }
  store.db.prepare("DELETE FROM tool_calls WHERE created_at < datetime('now', '-90 days')").run();

  // The guard writes, so read-only mode leaves it off and does not request its intent.
  const reactionGuardActive = config.reactionGuard && !config.readOnly;
  const adapter = new DiscordJsAdapter({
    token: config.discordToken,
    membersIntent: config.membersIntent,
    reactionIntent: reactionGuardActive,
    requestTimeoutMs: config.discordRequestTimeoutMs,
    allowedGuildIds: config.guildIds,
    logger: logger.child({ component: 'discord' }),
  });
  const locks = new GuildLocks();
  const blueprints = new BlueprintService({
    store,
    adapter,
    logger: logger.child({ component: 'blueprints' }),
    locks,
    config: {
      planTtlMinutes: config.planTtlMinutes,
      applyWaitSeconds: config.applyWaitSeconds,
      membersIntent: config.membersIntent,
      allowDestructive: config.allowDestructive && !config.readOnly,
    },
  });
  const reactionGuard = config.reactionGuard
    ? new ReactionGuard({
        store,
        adapter,
        logger: logger.child({ component: 'reaction-guard' }),
        allowedGuildIds: config.guildIds,
        active: reactionGuardActive,
      })
    : undefined;
  const app: AppContext = {
    config,
    store,
    adapter,
    logger,
    locks,
    blueprints,
    reactionGuard,
    startedAt: new Date(),
  };

  await adapter.start({
    memberJoin:
      config.membersIntent && !config.readOnly
        ? (event) => handleMemberJoin(app, event).then(() => undefined)
        : undefined,
    buttonPress: config.readOnly ? undefined : (event) => handlePanelButton(app, event),
    reactionAdd: reactionGuard?.active ? (event) => reactionGuard.handle(event) : undefined,
  });

  const mcp = createMcp(app);
  const server = createHttpServer(app, mcp);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => resolve());
  });

  logger.info('steward started', {
    version: VERSION,
    listen: `${config.host}:${config.port}`,
    guilds: config.guildIds,
    credentials: config.credentials.map((c) => ({
      name: c.name,
      scopes: [...c.scopes],
      guilds: c.guilds ?? 'all',
    })),
    allowedHosts: config.allowedHosts,
    readOnly: config.readOnly,
    allowDestructive: config.allowDestructive,
    membersIntent: config.membersIntent,
    reactionGuard: reactionGuardActive ? 'active' : config.reactionGuard ? 'off (read-only)' : 'off',
  });
  const localOnly = hostnamesOnly(config.allowedHosts).every((h) =>
    ['localhost', '127.0.0.1', '[::1]'].includes(h),
  );
  if (localOnly) {
    logger.warn(
      'MCP_ALLOWED_HOSTS only allows localhost; clients on your LAN or VPN will get 403 until you add the hostname or IP they connect to',
    );
  }

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) {
      logger.warn('second signal, exiting immediately', { signal });
      process.exit(1);
    }
    stopping = true;
    logger.info('shutting down', { signal });
    server.close();
    await blueprints.shutdown(20_000);
    await mcp.close().catch(() => {});
    await adapter.stop();
    store.close();
    logger.info('stopped');
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (error) => logger.error('unhandled rejection', { error }));
}

main().catch((error) => {
  process.stderr.write(`steward: fatal: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
