import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { McpHttpHandler } from '@modelcontextprotocol/server';
import { hostHeaderValidation, originValidation, toNodeHandler } from '@modelcontextprotocol/node';
import type { AppContext } from '../mcp/context.js';
import { callerToAuth } from '../mcp/server.js';
import { Authenticator } from './auth.js';
import { createDashboard } from './dashboard.js';

const MAX_BODY = 2 * 1024 * 1024;

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
  res.end(text);
}

/** Hostnames without ports, as the SDK guards expect. "[::1]:8787" → "[::1]", "nas.lan:8787" → "nas.lan". */
export function hostnamesOnly(entries: readonly string[]): string[] {
  return entries.map((e) => {
    const v = e.trim().toLowerCase();
    if (v.startsWith('[')) return v.slice(0, v.indexOf(']') + 1);
    return v.split(':')[0]!;
  });
}

export function readiness(app: AppContext): { ready: boolean; body: Record<string, unknown> } {
  const st = app.adapter.status();
  let database = 'ok';
  try {
    app.store.ping();
  } catch {
    database = 'error';
  }
  const ready = st.state === 'ready' && database === 'ok';
  return {
    ready,
    body: {
      status: ready ? 'ready' : 'not_ready',
      discord: { state: st.state, since: st.since, detail: st.detail },
      database,
    },
  };
}

export function createHttpServer(app: AppContext, mcp: McpHttpHandler): Server {
  const auth = new Authenticator(app.config.credentials);
  const dashboard = createDashboard(app, () => readiness(app).body);
  const node = toNodeHandler(mcp, {
    maxRequestBodySize: MAX_BODY,
    onerror: (error) => app.logger.warn('mcp adapter error', { error }),
  });
  // DNS-rebinding protection: the Host must be one we expect, and browsers
  // (the only clients that send Origin) are refused unless explicitly allowed.
  const validateHost = hostHeaderValidation(hostnamesOnly(app.config.allowedHosts));
  const validateOrigin = originValidation(
    hostnamesOnly(app.config.allowedOrigins.map((o) => o.replace(/^[a-z]+:\/\//i, ''))),
  );

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? '/').split('?')[0];
    try {
      if (path === '/healthz' && req.method === 'GET') {
        sendJson(res, 200, {
          status: 'ok',
          uptime_seconds: Math.round((Date.now() - app.startedAt.getTime()) / 1000),
        });
        return;
      }
      if (path === '/readyz' && req.method === 'GET') {
        const r = readiness(app);
        sendJson(res, r.ready ? 200 : 503, r.body);
        return;
      }
      if (path === '/mcp') {
        if (!validateHost(req, res)) return;
        if (!validateOrigin(req, res)) return;
        const address = req.socket.remoteAddress ?? 'unknown';
        if (auth.throttled(address)) {
          sendJson(
            res,
            429,
            { error: 'too many failed authentication attempts; try again later' },
            { 'retry-after': '300' },
          );
          return;
        }
        const caller = auth.verify(req.headers.authorization);
        if (!caller) {
          auth.recordFailure(address);
          app.logger.warn('rejected unauthenticated MCP request', { address });
          sendJson(
            res,
            401,
            { error: 'missing or invalid bearer token' },
            { 'www-authenticate': 'Bearer realm="steward", error="invalid_token"' },
          );
          return;
        }
        (req as IncomingMessage & { auth?: unknown }).auth = callerToAuth(caller);
        await node(req as never, res);
        return;
      }
      if (!validateHost(req, res)) return;
      await dashboard(req, res);
    } catch (error) {
      app.logger.error('http handler failed', { error, path });
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
      else res.end();
    }
  });
  server.requestTimeout = 330_000;
  server.headersTimeout = 30_000;
  server.keepAliveTimeout = 5_000;
  return server;
}
