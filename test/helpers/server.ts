import type { AddressInfo } from 'node:net';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { Config, Credential, Scope } from '../../src/config.js';
import { normaliseScopes } from '../../src/config.js';
import { createHttpServer } from '../../src/http/server.js';
import { silentLogger } from '../../src/logger.js';
import type { AppContext } from '../../src/mcp/context.js';
import { createMcp } from '../../src/mcp/server.js';
import { sha256 } from '../../src/util/hash.js';
import type { TestEnv } from './env.js';
import { makeEnv } from './env.js';

export const FULL_TOKEN = 'stw_full_0123456789abcdefghijklmnopqrstuv';
export const READ_TOKEN = 'stw_read_0123456789abcdefghijklmnopqrstuv';
export const WRITE_TOKEN = 'stw_write_0123456789abcdefghijklmnopqrstu';

export interface Running {
  env: TestEnv;
  app: AppContext;
  url: string;
  port: number;
  close: () => Promise<void>;
}

export function credential(
  name: string,
  token: string,
  scopes: Scope[],
  guilds: string[] | null = null,
): Credential {
  return { name, sha256: sha256(token), scopes: normaliseScopes(scopes), guilds };
}

export async function startServer(
  overrides: Partial<Config> = {},
  env: TestEnv = makeEnv(),
): Promise<Running> {
  const config: Config = {
    discordToken: 'not-a-real-token',
    guildIds: [env.guildId],
    membersIntent: true,
    credentials: [
      credential('full', FULL_TOKEN, ['read', 'write', 'destructive']),
      credential('reader', READ_TOKEN, ['read']),
      credential('writer', WRITE_TOKEN, ['write']),
    ],
    allowedHosts: ['localhost', '127.0.0.1'],
    allowedOrigins: [],
    host: '127.0.0.1',
    port: 0,
    readOnly: false,
    allowDestructive: true,
    databasePath: env.dbPath,
    logLevel: 'error',
    planTtlMinutes: 30,
    applyWaitSeconds: 30,
    discordRequestTimeoutMs: 1000,
    ...overrides,
  };
  // The service was built by makeEnv with its own idea of the modes; align it.
  (
    env.service as unknown as { deps: { config: { allowDestructive: boolean } } }
  ).deps.config.allowDestructive = config.allowDestructive && !config.readOnly;
  const app: AppContext = {
    config,
    store: env.store,
    adapter: env.adapter,
    logger: silentLogger,
    locks: env.locks,
    blueprints: env.service,
    startedAt: new Date(),
    backoffMs: 0,
  };
  const mcp = createMcp(app);
  const server = createHttpServer(app, mcp);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  return {
    env,
    app,
    url: `http://127.0.0.1:${port}/mcp`,
    port,
    close: async () => {
      await mcp.close().catch(() => {});
      await new Promise((r) => server.close(() => r(undefined)));
      server.closeAllConnections?.();
      env.cleanup();
    },
  };
}

export async function connect(url: string, token: string | null): Promise<Client> {
  const client = new Client({ name: 'steward-tests', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: token ? { headers: { Authorization: `Bearer ${token}` } } : undefined,
  });
  await client.connect(transport);
  return client;
}

/** Call a tool and parse the JSON text it returns. */
export async function call<T = Record<string, unknown>>(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ isError: boolean; data: T }> {
  const res = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: Array<{ type: string; text?: string }>;
  };
  const text = res.content.find((c) => c.type === 'text')?.text ?? '{}';
  let data: T;
  try {
    data = JSON.parse(text) as T;
  } catch {
    data = { raw: text } as T;
  }
  return { isError: !!res.isError, data };
}
