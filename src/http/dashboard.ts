import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import type { AppContext, Caller } from '../mcp/context.js';
import { ALL_TOOLS } from '../mcp/server.js';
import { executeTool, scopeAllowed } from '../mcp/registry.js';
import { VERSION } from '../version.js';
import type { Authenticator } from './auth.js';

const COOKIE = 'steward_session';
const MAX_BODY = 2 * 1024 * 1024;
const SESSION_MS = 8 * 60 * 60_000;
const SECURITY_HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'content-security-policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' https://cdn.discordapp.com; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

function json(res: ServerResponse, status: number, body: unknown, headers = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  if (!req.headers['content-type']?.startsWith('application/json'))
    throw new Error('Expected application/json');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += Buffer.byteLength(chunk);
    if (size > MAX_BODY) throw new Error('Request body exceeds 2 MiB');
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function sameOrigin(req: IncomingMessage): boolean {
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser API clients still need authentication and CSRF
  try {
    const url = new URL(origin);
    return ['http:', 'https:'].includes(url.protocol) && url.host === req.headers.host;
  } catch {
    return false;
  }
}

export function createDashboard(app: AppContext, auth: Authenticator, health: () => unknown) {
  const sessions = new Map<string, { caller: Caller; csrf: string; expires: number }>();
  const assets = new Map<string, { type: string; body: Buffer }>();
  for (const [path, file, type] of [
    ['/', 'index.html', 'text/html; charset=utf-8'],
    ['/assets/app.js', 'app.js', 'text/javascript; charset=utf-8'],
    ['/assets/style.css', 'style.css', 'text/css; charset=utf-8'],
    ['/favicon.svg', 'favicon.svg', 'image/svg+xml'],
  ] as const) {
    assets.set(path, { type, body: readFileSync(new URL(`../web/${file}`, import.meta.url)) });
  }
  const catalog = ALL_TOOLS.map((def) => ({
    name: def.name,
    title: def.title,
    description: def.description,
    scope: def.scope,
    inputSchema: z.toJSONSchema(def.input, { io: 'input', unrepresentable: 'any' }),
  }));

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const path = (req.url ?? '/').split('?')[0]!;
    const asset = assets.get(path);
    if (asset && (req.method === 'GET' || req.method === 'HEAD')) {
      res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': asset.type });
      res.end(req.method === 'HEAD' ? undefined : asset.body);
      return;
    }
    if (!path.startsWith('/api/')) {
      json(res, 404, { error: 'not found' });
      return;
    }
    if (!sameOrigin(req)) {
      json(res, 403, { error: 'dashboard requests must be same-origin' });
      return;
    }
    const address = req.socket.remoteAddress ?? 'unknown';
    const secure = 'encrypted' in req.socket && req.socket.encrypted ? '; Secure' : '';
    const cookie = (value: string, age: number) =>
      `${COOKIE}=${value}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=${age}${secure}`;
    const now = Date.now();
    for (const [key, session] of sessions) if (session.expires <= now) sessions.delete(key);
    if (path === '/api/session' && req.method === 'POST') {
      if (auth.throttled(address)) {
        json(res, 429, { error: 'too many failed authentication attempts' }, { 'retry-after': '300' });
        return;
      }
      const caller = auth.verify(req.headers.authorization);
      if (!caller || !caller.scopes.has('read')) {
        auth.recordFailure(address);
        json(res, 401, { error: 'Enter a valid MCP token with read scope.' });
        return;
      }
      // Bound memory and rotate any previous session rather than keeping both alive.
      const previous = req.headers.cookie
        ?.split(';')
        .map((v) => v.trim())
        .find((v) => v.startsWith(`${COOKIE}=`))
        ?.slice(COOKIE.length + 1);
      if (previous) sessions.delete(previous);
      if (sessions.size >= 1000) sessions.delete(sessions.keys().next().value!);
      const id = randomBytes(32).toString('hex');
      const csrf = randomBytes(32).toString('hex');
      sessions.set(id, { caller, csrf, expires: now + SESSION_MS });
      json(
        res,
        200,
        { csrf, client: caller.clientId, version: VERSION },
        { 'set-cookie': cookie(id, SESSION_MS / 1000) },
      );
      return;
    }
    const id = req.headers.cookie
      ?.split(';')
      .map((v) => v.trim())
      .find((v) => v.startsWith(`${COOKIE}=`))
      ?.slice(COOKIE.length + 1);
    const session = id ? sessions.get(id) : undefined;
    if (!session) {
      json(res, 401, { error: 'Sign in with your MCP token.' });
      return;
    }
    if (req.method !== 'GET') {
      const csrf = req.headers['x-steward-csrf'];
      if (
        typeof csrf !== 'string' ||
        !/^[a-f0-9]{64}$/.test(csrf) ||
        !timingSafeEqual(Buffer.from(csrf), Buffer.from(session.csrf))
      ) {
        json(res, 403, { error: 'invalid CSRF token; refresh and try again' });
        return;
      }
    }
    if (path === '/api/session' && req.method === 'DELETE') {
      sessions.delete(id!);
      json(res, 200, { signed_out: true }, { 'set-cookie': cookie('', 0) });
      return;
    }
    if (path === '/api/session' && req.method === 'GET') {
      json(res, 200, {
        csrf: session.csrf,
        client: session.caller.clientId,
        scopes: [...session.caller.scopes],
        version: VERSION,
        expires_at: new Date(session.expires).toISOString(),
      });
      return;
    }
    if (path === '/api/health' && req.method === 'GET') {
      json(res, 200, health());
      return;
    }
    if (path === '/api/tools' && req.method === 'GET') {
      json(res, 200, { tools: catalog.filter((t) => scopeAllowed(app, session.caller, t.scope).ok) });
      return;
    }
    const name = /^\/api\/tools\/([a-z_]+)$/.exec(path)?.[1];
    if (name && req.method === 'POST') {
      const def = ALL_TOOLS.find((t) => t.name === name);
      if (!def) {
        json(res, 404, { error: 'unknown tool' });
        return;
      }
      let args: unknown;
      try {
        args = await readBody(req);
      } catch {
        json(res, 400, { error: 'Expected a JSON body no larger than 2 MiB.' });
        return;
      }
      if (def.scope !== 'read' && req.headers['x-steward-confirm'] !== def.name) {
        json(res, 409, { error: 'Review and confirm this operation before applying it.' });
        return;
      }
      const result = await executeTool(def, args, app, session.caller);
      const data: unknown = JSON.parse(result.content[0]!.text);
      json(res, result.isError ? 422 : 200, { ok: !result.isError, data });
      return;
    }
    json(res, 404, { error: 'not found' });
  };
}
