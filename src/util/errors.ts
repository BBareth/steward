import { redactText } from '../logger.js';

export type ErrorCode =
  | 'invalid_argument'
  | 'unauthorized'
  | 'forbidden'
  | 'guild_not_allowed'
  | 'read_only'
  | 'destructive_disabled'
  | 'not_found'
  | 'conflict'
  | 'stale_plan'
  | 'precondition_failed'
  | 'discord_unavailable'
  | 'discord_error'
  | 'internal';

/** An error whose message is safe to show to an MCP client. */
export class StewardError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'StewardError';
  }
}

/**
 * Discord definitely refused a change, so nothing was applied. An apply run
 * reports the step as failed and carries on with steps that do not depend on it.
 */
export class RefusedChange extends StewardError {
  constructor(message: string, details?: unknown) {
    super('precondition_failed', message, details);
    this.name = 'RefusedChange';
  }
}

/** Kind of failure reported by the Discord adapter. */
export type DiscordFailureKind = 'http' | 'timeout' | 'server' | 'network' | 'rate_limited';

/**
 * A failed Discord request. `uncertain` means the request may have been
 * applied by Discord even though we did not get a successful response
 * (timeouts, connection resets, 5xx). Callers must not blindly retry a
 * non-idempotent request whose outcome is uncertain.
 */
export class DiscordRequestError extends Error {
  constructor(
    readonly kind: DiscordFailureKind,
    message: string,
    readonly status?: number,
    readonly code?: number,
  ) {
    super(message);
    this.name = 'DiscordRequestError';
  }

  get uncertain(): boolean {
    return this.kind === 'timeout' || this.kind === 'server' || this.kind === 'network';
  }

  get isNotFound(): boolean {
    return this.status === 404;
  }

  get isMissingPermissions(): boolean {
    return this.status === 403;
  }
}

/** Discord JSON error codes we treat specially. */
export const DiscordCodes = {
  UnknownChannel: 10003,
  UnknownGuild: 10004,
  UnknownMember: 10007,
  UnknownMessage: 10008,
  UnknownOverwrite: 10009,
  UnknownRole: 10011,
  MissingAccess: 50001,
  MissingPermissions: 50013,
  InvalidFormBody: 50035,
} as const;

export function safeErrorMessage(error: unknown): string {
  if (error instanceof StewardError || error instanceof DiscordRequestError) return redactText(error.message);
  if (error instanceof Error) return redactText(error.message);
  return 'unknown error';
}

export function errorPayload(error: unknown): { code: string; message: string; details?: unknown } {
  if (error instanceof StewardError) {
    return { code: error.code, message: redactText(error.message), details: error.details };
  }
  if (error instanceof DiscordRequestError) {
    return {
      code: 'discord_error',
      message: redactText(error.message),
      details: {
        kind: error.kind,
        status: error.status,
        discordCode: error.code,
        uncertain: error.uncertain,
      },
    };
  }
  return { code: 'internal', message: 'internal error; see server logs' };
}
