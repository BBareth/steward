#!/usr/bin/env node
// Generate an MCP credential for steward.
//
//   node scripts/generate-token.mjs                       # token for MCP_AUTH_TOKEN
//   node scripts/generate-token.mjs --name codex --scopes read,write --guilds 1234...
//                                                         # also prints an MCP_TOKENS_FILE entry
//
// The token is printed once. steward only ever stores its SHA-256.
import { createHash, randomBytes } from 'node:crypto';

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
if (args.includes('--help') || args.includes('-h')) {
  console.log('usage: generate-token.mjs [--name NAME] [--scopes read,write,destructive] [--guilds ID,ID]');
  process.exit(0);
}

const token = `stw_${randomBytes(32).toString('base64url')}`;
const sha256 = createHash('sha256').update(token).digest('hex');
const name = opt('name');

if (!name) {
  console.log(token);
  process.exit(0);
}
const scopes = (opt('scopes') ?? 'read')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const bad = scopes.filter((s) => !['read', 'write', 'destructive'].includes(s));
if (bad.length) {
  console.error(`unknown scope(s): ${bad.join(', ')}`);
  process.exit(2);
}
const guilds = opt('guilds')
  ?.split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const entry = { name, sha256, scopes, ...(guilds?.length ? { guilds } : {}) };
console.log(`token (give this to the client, it is not stored anywhere):\n  ${token}\n`);
console.log(`entry for MCP_TOKENS_FILE ({"tokens": [ ... ]}):\n  ${JSON.stringify(entry)}`);
