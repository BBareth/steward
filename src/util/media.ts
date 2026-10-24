import { lookup as dnsLookup } from 'node:dns';
import type { LookupAddress, LookupOptions } from 'node:dns';
import https from 'node:https';
import { BlockList, isIP } from 'node:net';
import { z } from 'zod';
import { StewardError } from './errors.js';

/**
 * Images and sounds an agent hands steward for Discord: an https URL steward
 * downloads, or a data URI. Content types are sniffed from the bytes, never
 * trusted from the caller or the remote server.
 */

export const mediaInput = z
  .union([
    z.object({ url: z.string().url().max(2048).describe('https URL to download the file from.') }).strict(),
    z
      .object({
        data_uri: z
          .string()
          .max(1_900_000)
          .describe('data:<type>;base64,<bytes>. Requests are capped at 2 MB, so use url for larger files.'),
      })
      .strict(),
  ])
  .describe('The file, as { url } (https) or { data_uri }.');
export type MediaInput = z.infer<typeof mediaInput>;

export type MediaUse =
  | 'emoji'
  | 'sticker'
  | 'sound'
  | 'role_icon'
  | 'server_icon'
  | 'server_banner'
  | 'invite_splash'
  | 'discovery_splash'
  | 'avatar'
  | 'profile_banner'
  | 'event_cover'
  | 'webhook_avatar';

type Format = 'png' | 'jpeg' | 'gif' | 'webp' | 'mp3' | 'ogg';

const CONTENT_TYPES: Record<Format, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
};

const KB = 1024;
const IMAGES: Format[] = ['png', 'jpeg', 'gif', 'webp'];

/** Discord's documented size caps and accepted formats for each use. */
const RULES: Record<MediaUse, { maxBytes: number; formats: Format[] }> = {
  emoji: { maxBytes: 256 * KB, formats: IMAGES },
  role_icon: { maxBytes: 256 * KB, formats: ['png', 'jpeg', 'webp'] },
  sticker: { maxBytes: 512 * KB, formats: ['png', 'gif'] },
  sound: { maxBytes: 512 * KB, formats: ['mp3', 'ogg'] },
  server_icon: { maxBytes: 10_240 * KB, formats: IMAGES },
  server_banner: { maxBytes: 10_240 * KB, formats: IMAGES },
  invite_splash: { maxBytes: 10_240 * KB, formats: ['png', 'jpeg', 'webp'] },
  discovery_splash: { maxBytes: 10_240 * KB, formats: ['png', 'jpeg', 'webp'] },
  avatar: { maxBytes: 10_240 * KB, formats: IMAGES },
  profile_banner: { maxBytes: 10_240 * KB, formats: IMAGES },
  event_cover: { maxBytes: 10_240 * KB, formats: ['png', 'jpeg', 'webp'] },
  webhook_avatar: { maxBytes: 10_240 * KB, formats: IMAGES },
};

export interface Media {
  data: Buffer;
  contentType: string;
  /** For uploads as a filename. */
  extension: string;
  dataUri: string;
}

export function sniffFormat(data: Buffer): Format | null {
  const at = (offset: number, ascii: string) =>
    data.subarray(offset, offset + ascii.length).toString('latin1') === ascii;
  if (data.length >= 8 && data.readUInt32BE(0) === 0x89504e47 && data.readUInt32BE(4) === 0x0d0a1a0a)
    return 'png';
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'jpeg';
  if (at(0, 'GIF87a') || at(0, 'GIF89a')) return 'gif';
  if (at(0, 'RIFF') && at(8, 'WEBP')) return 'webp';
  if (at(0, 'OggS')) return 'ogg';
  if (at(0, 'ID3') || (data.length >= 2 && data[0] === 0xff && (data[1]! & 0xe0) === 0xe0)) return 'mp3';
  return null;
}

function invalid(message: string): never {
  throw new StewardError('invalid_argument', message);
}

function decodeDataUri(uri: string): Buffer {
  const match = /^data:[\w.+/-]*(;[\w-]+=[\w.-]+)*;base64,([A-Za-z0-9+/=\s]+)$/.exec(uri);
  if (!match) invalid('data_uri must be a base64 data URI (data:<type>;base64,...)');
  return Buffer.from(match[2]!.replace(/\s+/g, ''), 'base64');
}

/** Turn an agent's media input into checked bytes for one Discord use. */
export async function loadMedia(input: MediaInput, use: MediaUse): Promise<Media> {
  const rule = RULES[use];
  const data =
    'data_uri' in input ? decodeDataUri(input.data_uri) : await fetchHttps(input.url, rule.maxBytes);
  if (data.length === 0) invalid('the file is empty');
  if (data.length > rule.maxBytes)
    invalid(
      `the file is ${Math.ceil(data.length / KB)} KB; Discord accepts at most ${rule.maxBytes / KB} KB here`,
    );
  const format = sniffFormat(data);
  if (!format || !rule.formats.includes(format))
    invalid(`this needs a ${rule.formats.join(', ')} file; got ${format ?? 'an unrecognised format'}`);
  const contentType = CONTENT_TYPES[format];
  return {
    data,
    contentType,
    extension: format === 'jpeg' ? 'jpg' : format,
    dataUri: `data:${contentType};base64,${data.toString('base64')}`,
  };
}

// ---- downloading -----------------------------------------------------------

/** Addresses steward refuses to download from, so a URL cannot reach its own network. */
const PRIVATE = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  PRIVATE.addSubnet(net, prefix, 'ipv4');
for (const [net, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const)
  PRIVATE.addSubnet(net, prefix, 'ipv6');

export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return PRIVATE.check(address, 'ipv4');
  if (family !== 6) return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return PRIVATE.check(mapped[1]!, 'ipv4');
  return PRIVATE.check(address, 'ipv6');
}

type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

function guardedLookup(hostname: string, options: LookupOptions, callback: LookupCallback): void {
  dnsLookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error, '');
    if (addresses.length === 0 || addresses.some((a) => isPrivateAddress(a.address))) {
      const refused: NodeJS.ErrnoException = new Error(`${hostname} resolves to a private address`);
      refused.code = 'EPRIVATE';
      return callback(refused, '');
    }
    if (options.all) return callback(null, addresses);
    return callback(null, addresses[0]!.address, addresses[0]!.family);
  });
}

const REDIRECTS = 3;
const TIMEOUT_MS = 10_000;

export async function fetchHttps(raw: string, maxBytes: number, redirects = REDIRECTS): Promise<Buffer> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    invalid('url is not a valid URL');
  }
  if (url.protocol !== 'https:') invalid('url must use https');
  if (url.username || url.password) invalid('url must not contain credentials');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) && isPrivateAddress(host)) invalid('url points at a private address');

  return new Promise<Buffer>((resolve, reject) => {
    const fail = (message: string) => reject(new StewardError('invalid_argument', message));
    const req = https.get(
      url,
      { lookup: guardedLookup, timeout: TIMEOUT_MS, headers: { 'user-agent': 'steward (media fetch)' } },
      (res) => {
        const status = res.statusCode ?? 0;
        if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
          res.resume();
          if (redirects <= 0) return fail('url redirected too many times');
          return resolve(fetchHttps(new URL(res.headers.location, url).toString(), maxBytes, redirects - 1));
        }
        if (status !== 200) {
          res.resume();
          return fail(`downloading ${url.host} answered HTTP ${status}`);
        }
        const declared = Number(res.headers['content-length'] ?? 0);
        if (declared > maxBytes) {
          req.destroy();
          return fail(`the file is larger than the ${maxBytes / KB} KB Discord accepts here`);
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) {
            req.destroy();
            fail(`the file is larger than the ${maxBytes / KB} KB Discord accepts here`);
          } else chunks.push(chunk);
        });
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', (e) => fail(`downloading ${url.host} failed: ${e.message}`));
      },
    );
    const deadline = setTimeout(() => req.destroy(new Error('timed out')), TIMEOUT_MS * 2);
    req.on('close', () => clearTimeout(deadline));
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', (e) => fail(`downloading ${url.host} failed: ${e.message}`));
  });
}
