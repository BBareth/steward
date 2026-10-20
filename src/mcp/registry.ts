import type { McpServer } from '@modelcontextprotocol/server';
import type { z } from 'zod';
import type { Scope } from '../config.js';
import { redactText } from '../logger.js';
import { StewardError, errorPayload } from '../util/errors.js';
import { newId } from '../util/ids.js';
import type { AppContext, Caller } from './context.js';

/**
 * Tool definitions carry the scope they need. A tool is only registered for
 * a caller who holds that scope and only when the server's mode allows it;
 * the handler checks again anyway, so a tool can never run on the strength
 * of being listed.
 */

export type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

export interface ToolDef<S extends z.ZodObject> {
  name: string;
  title: string;
  description: string;
  scope: Scope;
  input: S;
  /** Pulls the guild an invocation targets, for authorisation and history. */
  guildOf?: (args: z.infer<S>) => string | undefined;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
  handler: (args: z.infer<S>, call: CallContext) => Promise<unknown>;
}

export interface CallContext {
  app: AppContext;
  caller: Caller;
  tool: string;
  /** Throws unless the caller may act on this guild. */
  assertGuild: (guildId: string) => void;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyToolDef = ToolDef<any>;

export function defineTool<S extends z.ZodObject>(def: ToolDef<S>): ToolDef<S> {
  return def;
}

export function scopeAllowed(
  app: AppContext,
  caller: Caller,
  scope: Scope,
): { ok: boolean; code?: 'read_only' | 'destructive_disabled' | 'forbidden'; message?: string } {
  if (scope !== 'read' && app.config.readOnly) {
    return { ok: false, code: 'read_only', message: 'steward is running in read-only mode (READ_ONLY=true)' };
  }
  if (scope === 'destructive' && !app.config.allowDestructive) {
    return {
      ok: false,
      code: 'destructive_disabled',
      message: 'destructive tools are disabled on this server (ALLOW_DESTRUCTIVE=false)',
    };
  }
  if (!caller.scopes.has(scope)) {
    return { ok: false, code: 'forbidden', message: `your credential lacks the "${scope}" scope` };
  }
  return { ok: true };
}

export function assertGuildFor(app: AppContext, caller: Caller, guildId: string): void {
  if (!app.config.guildIds.includes(guildId)) {
    throw new StewardError(
      'guild_not_allowed',
      `guild ${guildId} is not in DISCORD_GUILD_IDS; steward will not touch it`,
    );
  }
  if (caller.guilds && !caller.guilds.includes(guildId)) {
    throw new StewardError('guild_not_allowed', `your credential is not allowed to manage guild ${guildId}`);
  }
}

const json = (value: unknown) => JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));

export function okResult(data: unknown): ToolResult {
  return { content: [{ type: 'text', text: json(data) }] };
}

export function errorResult(error: unknown): ToolResult {
  return { isError: true, content: [{ type: 'text', text: json({ error: errorPayload(error) }) }] };
}

export function registerTools(
  server: McpServer,
  app: AppContext,
  caller: Caller,
  tools: AnyToolDef[],
): string[] {
  const registered: string[] = [];
  for (const def of tools) {
    if (!scopeAllowed(app, caller, def.scope).ok) continue;
    registered.push(def.name);
    server.registerTool(
      def.name,
      {
        title: def.title,
        description: def.description,
        inputSchema: def.input,
        annotations: {
          readOnlyHint: def.scope === 'read',
          destructiveHint: def.scope === 'destructive',
          openWorldHint: false,
          ...def.annotations,
        },
      },
      async (args: unknown) => {
        const started = Date.now();
        let guildId: string | null = null;
        let outcome: 'ok' | 'error' | 'denied' = 'ok';
        let errorText: string | null = null;
        try {
          const allowed = scopeAllowed(app, caller, def.scope);
          if (!allowed.ok) {
            outcome = 'denied';
            throw new StewardError(allowed.code!, allowed.message!);
          }
          guildId = def.guildOf?.(args) ?? null;
          if (guildId) assertGuildFor(app, caller, guildId);
          const data = await def.handler(args, {
            app,
            caller,
            tool: def.name,
            assertGuild: (g) => assertGuildFor(app, caller, g),
          });
          return okResult(data);
        } catch (error) {
          if (outcome === 'ok')
            outcome =
              error instanceof StewardError &&
              ['forbidden', 'guild_not_allowed', 'read_only', 'destructive_disabled'].includes(error.code)
                ? 'denied'
                : 'error';
          errorText = errorPayload(error).message;
          if (
            !(error instanceof StewardError) &&
            !(error instanceof Error && error.name === 'DiscordRequestError')
          ) {
            app.logger.error('tool failed', { tool: def.name, client: caller.clientId, error });
          }
          return errorResult(error);
        } finally {
          try {
            app.store.recordToolCall({
              id: newId('call'),
              clientId: caller.clientId,
              tool: def.name,
              guildId,
              outcome,
              error: errorText ? redactText(errorText).slice(0, 500) : null,
              durationMs: Date.now() - started,
              createdAt: new Date().toISOString(),
            });
          } catch (e) {
            app.logger.warn('could not record tool call', { error: e });
          }
          app.logger.info('tool call', {
            tool: def.name,
            client: caller.clientId,
            guildId,
            outcome,
            ms: Date.now() - started,
          });
        }
      },
    );
  }
  return registered;
}
