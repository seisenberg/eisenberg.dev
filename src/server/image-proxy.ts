import crypto from 'node:crypto';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import config from './config.js';
import { query } from './db.js';
import { getMessage, HttpError, type Viewer } from './mail.js';

// Remote images in mail are how senders learn that, when and from where a message was opened.
// They are never loaded by the browser. When the reader asks for them, this server fetches them:
// the sender sees one request from an AWS address with a generic user agent, no cookies and no
// referrer, instead of the reader's own IP address and browser.
//
// A proxy that fetches addresses chosen by strangers must not be usable against the inside of
// the network (SSRF). The safeguards, in order:
//   1. a link is only issued for an address that really occurs in a message the viewer can open,
//      and it is signed, so the proxy route cannot be pointed anywhere else;
//   2. only http and https on their standard ports, no credentials in the address;
//   3. the host name is resolved here, every resulting address must be public, and the connection
//      is pinned to the address that was checked (no DNS rebinding between check and use);
//   4. redirects are followed by hand, at most four, each one checked the same way;
//   5. the answer must BE a raster image (decided from its first bytes, not from what the server
//      claims), is size capped, and is served so that it can never run as a document in this origin.

const MAX_URL = 2000;
const MAX_REDIRECTS = 4;
const USER_AGENT = 'Mozilla/5.0 (compatible; ImageProxy)';

// ---- which addresses may be fetched -----------------------------------------------------------------

const blocked = new net.BlockList();
for (const [prefix, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked.addSubnet(prefix, bits, 'ipv4');
for (const [prefix, bits] of [
  ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['100::', 64], ['2001:db8::', 32], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
] as const) blocked.addSubnet(prefix, bits, 'ipv6');

/** True for an address on the public internet. Loopback, private, link-local (cloud metadata), CGNAT, multicast and reserved ranges are not. */
export function isPublicAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) return !blocked.check(address, 'ipv4');
  if (family === 6) {
    // an IPv4 address written as IPv6 is judged as IPv4
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
    if (mapped) return !blocked.check(mapped[1], 'ipv4');
    return !blocked.check(address, 'ipv6');
  }
  return false;
}

/** Normalises an image address from a message, or returns null when it is not something we will fetch. */
export function fetchable(input: string): URL | null {
  const raw = input.trim();
  if (!raw || raw.length > MAX_URL) return null;
  let url: URL;
  try {
    url = new URL(raw.startsWith('//') ? `https:${raw}` : raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  if (!config.imageProxy.allowPrivate) {
    if (url.port !== '') return null; // standard ports only
    // a literal IP address is never a legitimate image host in mail
    if (net.isIP(url.hostname.replace(/^\[|\]$/g, ''))) return null;
  }
  return url;
}

/** dns.lookup that refuses any name with a non-public address. The socket connects to exactly what is returned here. */
function guardedLookup(hostname: string, options: dns.LookupOptions | number, callback: (...args: unknown[]) => void): void {
  const opts = typeof options === 'number' ? { family: options } : options;
  dns.lookup(hostname, { all: true, family: opts.family, hints: opts.hints }, (err, addresses) => {
    if (err) return callback(err);
    const list = addresses as dns.LookupAddress[];
    if (list.length === 0 || (!config.imageProxy.allowPrivate && list.some((a) => !isPublicAddress(a.address)))) {
      return callback(Object.assign(new Error('address not allowed'), { code: 'EBLOCKED' }));
    }
    if (opts.all) callback(null, list);
    else callback(null, list[0].address, list[0].family);
  });
}

// ---- signed links ---------------------------------------------------------------------------------------

let secret: Promise<Buffer> | null = null;
function proxySecret(): Promise<Buffer> {
  secret ??= (async () => {
    const res = await query<{ proxy_secret: string }>(
      `update mail_settings set proxy_secret = coalesce(proxy_secret, $1) returning proxy_secret`,
      [crypto.randomBytes(32).toString('base64url')],
    );
    if (!res.rows[0]) throw new Error('mail_settings row is missing');
    return Buffer.from(res.rows[0].proxy_secret, 'base64url');
  })().catch((err) => {
    secret = null;
    throw err;
  });
  return secret;
}

const sign = async (url: string) => crypto.createHmac('sha256', await proxySecret()).update(url).digest().subarray(0, 18).toString('base64url');

/**
 * Proxy links for the images of one message. Only addresses that actually occur in that message's
 * HTML get a link, so the proxy cannot be asked to fetch anything a sender did not put in mail the
 * viewer can already see.
 */
export async function imageLinks(v: Viewer, id: unknown, urlsInput: unknown): Promise<Record<string, string>> {
  if (!Array.isArray(urlsInput) || urlsInput.length > 300) throw new HttpError(400, 'urls must be a list of at most 300 addresses');
  const message = await getMessage(v, id);
  const html = message.html ?? '';
  const out: Record<string, string> = {};
  for (const item of urlsInput) {
    const original = String(item);
    const url = fetchable(original);
    if (!url) continue;
    // as written in the source: verbatim, or with "&" written as an entity
    const present = html.includes(original) || html.includes(original.replace(/&/g, '&amp;'));
    if (!present) continue;
    const href = url.toString();
    out[original] = `/api/mail/image/${await sign(href)}/${Buffer.from(href).toString('base64url')}`;
  }
  return out;
}

// ---- fetching ---------------------------------------------------------------------------------------------

export interface ProxiedImage {
  type: string;
  body: Buffer;
}

/** Decided from the content itself. SVG is deliberately absent: it is a document that can carry script. */
export function sniffImage(b: Buffer): string | null {
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 6 && (b.subarray(0, 6).toString('latin1') === 'GIF87a' || b.subarray(0, 6).toString('latin1') === 'GIF89a')) return 'image/gif';
  if (b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (b.length >= 12 && b.subarray(4, 8).toString('latin1') === 'ftyp' && ['avif', 'avis'].includes(b.subarray(8, 12).toString('latin1'))) return 'image/avif';
  return null;
}

function requestOnce(url: URL, deadline: number): Promise<{ status: number; location: string | null; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const client = url.protocol === 'https:' ? https : http;
    const req = client.request(
      {
        protocol: url.protocol,
        hostname: url.hostname.replace(/^\[|\]$/g, ''),
        port: url.port || undefined,
        path: url.pathname + url.search,
        method: 'GET',
        agent: false,
        lookup: guardedLookup as never,
        // Nothing about the reader: no cookies, no referrer, no language, a generic user agent.
        headers: { 'user-agent': USER_AGENT, accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif,image/*;q=0.8' },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          res.resume();
          return resolve({ status, location: res.headers.location ?? null, body: Buffer.alloc(0) });
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > config.imageProxy.maxBytes) {
            req.destroy(Object.assign(new Error('image too large'), { code: 'ETOOBIG' }));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => resolve({ status, location: null, body: Buffer.concat(chunks) }));
        res.on('error', reject);
      },
    );
    req.setTimeout(Math.max(deadline - Date.now(), 1), () => req.destroy(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    req.end();
  });
}

/** Fetches a signed image address. Throws HttpError for anything that is not a public raster image. */
export async function fetchImage(sig: string, encoded: string): Promise<ProxiedImage> {
  const notFound = new HttpError(404, 'Image not available');
  let href: string;
  try {
    href = Buffer.from(encoded, 'base64url').toString('utf8');
  } catch {
    throw notFound;
  }
  const expected = Buffer.from(await sign(href));
  const given = Buffer.from(String(sig));
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) throw notFound;

  let url = fetchable(href);
  const deadline = Date.now() + config.imageProxy.timeoutMs;
  for (let hop = 0; url && hop <= MAX_REDIRECTS; hop++) {
    let res;
    try {
      res = await requestOnce(url, deadline);
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'ETOOBIG') throw new HttpError(413, 'Image is too large');
      throw new HttpError(502, code === 'EBLOCKED' ? 'Image address is not allowed' : 'Image could not be fetched');
    }
    if (res.location !== null) {
      // every redirect is checked exactly like the first address
      let next: URL | null = null;
      try {
        next = fetchable(new URL(res.location, url).toString());
      } catch {
        next = null;
      }
      url = next;
      continue;
    }
    if (res.status !== 200) throw new HttpError(502, 'Image could not be fetched');
    const type = sniffImage(res.body);
    if (!type) throw new HttpError(415, 'Not an image');
    return { type, body: res.body };
  }
  throw new HttpError(502, 'Image could not be fetched');
}
