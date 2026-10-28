import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import type { AppContext, Caller } from '../mcp/context.js';
import { ALL_TOOLS } from '../mcp/server.js';
import { executeTool, scopeAllowed } from '../mcp/registry.js';
import { VERSION } from '../version.js';

const MAX_BODY = 2 * 1024 * 1024;
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
  if (!origin) return true; // non-browser API clients still need the CSRF header
  try {
    const url = new URL(origin);
    return ['http:', 'https:'].includes(url.protocol) && url.host === req.headers.host;
  } catch {
    return false;
  }
}

/**
 * The dashboard is for whoever can reach the port; it has no sign-in. It acts as
 * an unrestricted local operator, still bound by READ_ONLY, ALLOW_DESTRUCTIVE
 * and DISCORD_GUILD_IDS. MCP bearer tokens are for AI clients on /mcp only.
 */
export const DASHBOARD_CALLER: Caller = {
  clientId: 'dashboard',
  scopes: new Set(['read', 'write', 'destructive']),
  guilds: null,
};

export function createDashboard(app: AppContext, health: () => unknown) {
  // Required on every write so a page on another origin cannot drive the API.
  const csrf = randomBytes(32).toString('hex');
  const caller = DASHBOARD_CALLER;
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
    if (req.method !== 'GET') {
      const presented = req.headers['x-steward-csrf'];
      if (
        typeof presented !== 'string' ||
        !/^[a-f0-9]{64}$/.test(presented) ||
        !timingSafeEqual(Buffer.from(presented), Buffer.from(csrf))
      ) {
        json(res, 403, { error: 'invalid CSRF token; refresh and try again' });
        return;
      }
    }
    if (path === '/api/session' && req.method === 'GET') {
      json(res, 200, {
        csrf,
        scopes: [...caller.scopes].filter((scope) => scopeAllowed(app, caller, scope).ok),
        version: VERSION,
      });
      return;
    }
    if (path === '/api/health' && req.method === 'GET') {
      json(res, 200, health());
      return;
    }
    if (path === '/api/tools' && req.method === 'GET') {
      json(res, 200, { tools: catalog.filter((t) => scopeAllowed(app, caller, t.scope).ok) });
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
      const result = await executeTool(def, args, app, caller);
      const data: unknown = JSON.parse(result.content[0]!.text);
      json(res, result.isError ? 422 : 200, { ok: !result.isError, data });
      return;
    }
    json(res, 404, { error: 'not found' });
  };
}
