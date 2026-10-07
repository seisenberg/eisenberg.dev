import crypto from 'node:crypto';
import config from './config.js';
import { query } from './db.js';
import { HttpError, type Viewer } from './mail.js';
import { base32Decode, totpCode, type OtpAlgorithm } from './otp.js';
import type { OtpEntry, OtpListing } from '../shared/api.js';

// The authenticator: one-time-code secrets for other services (GitHub, AWS, a bank...).
//
// A secret is the whole second factor, so it is treated like a password vault entry:
//   - encrypted with AES-256-GCM under a key that is NOT in the database (SSM in production), so a
//     database dump or backup alone is useless;
//   - bound to its owner (the user id is authenticated data), so a row copied to another user
//     does not decrypt;
//   - never sent back to the browser: the server computes the codes and returns only those.

const MAX_ENTRIES = 200;

let keyPromise: Promise<Buffer | null> | null = null;
function vaultKey(): Promise<Buffer | null> {
  keyPromise ??= (async () => {
    let encoded = config.vault.key;
    if (!encoded && config.vault.keySsm) {
      try {
        const { SSMClient, GetParameterCommand } = await import('@aws-sdk/client-ssm');
        const res = await new SSMClient({}).send(new GetParameterCommand({ Name: config.vault.keySsm, WithDecryption: true }));
        encoded = res.Parameter?.Value?.trim() ?? null;
      } catch (err) {
        // not created yet: the feature is simply off
        if ((err as { name?: string }).name === 'ParameterNotFound') return null;
        throw err;
      }
    }
    if (!encoded) return null;
    const key = Buffer.from(encoded, 'base64');
    if (key.length !== 32) throw new Error('the vault key must be 32 bytes, base64 encoded');
    return key;
  })().then(
    (key) => {
      // not there yet: look again in a minute, so that creating the parameter needs no redeploy
      if (!key) setTimeout(() => (keyPromise = null), 60_000).unref();
      return key;
    },
    (err) => {
      keyPromise = null;
      throw err;
    },
  );
  return keyPromise;
}

async function requireKey(): Promise<Buffer> {
  const key = await vaultKey();
  if (!key) throw new HttpError(503, 'The authenticator is not set up on this server (vault key missing)', 'vault_disabled');
  return key;
}

function seal(key: Buffer, userId: number, secret: Buffer): Buffer {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(`eisenmail-otp:${userId}`));
  const body = Buffer.concat([cipher.update(secret), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}

function open(key: Buffer, userId: number, sealed: Buffer): Buffer {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, sealed.subarray(0, 12));
  decipher.setAAD(Buffer.from(`eisenmail-otp:${userId}`));
  decipher.setAuthTag(sealed.subarray(12, 28));
  return Buffer.concat([decipher.update(sealed.subarray(28)), decipher.final()]);
}

// ---- reading what other apps produce ------------------------------------------------------------------

export interface ParsedOtp {
  issuer: string;
  account: string;
  secret: Buffer;
  algorithm: OtpAlgorithm;
  digits: number;
  period: number;
}

const label = (s: string, max = 120) => s.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max);
const ALGORITHMS: OtpAlgorithm[] = ['SHA1', 'SHA256', 'SHA512'];

function checked(p: ParsedOtp): ParsedOtp {
  if (p.secret.length < 8 || p.secret.length > 128) throw new HttpError(400, 'That secret is not valid');
  if (!ALGORITHMS.includes(p.algorithm)) throw new HttpError(400, 'Unsupported algorithm');
  if (!Number.isInteger(p.digits) || p.digits < 6 || p.digits > 8) throw new HttpError(400, 'Codes must have 6 to 8 digits');
  if (!Number.isInteger(p.period) || p.period < 10 || p.period > 300) throw new HttpError(400, 'Unsupported period');
  return { ...p, issuer: label(p.issuer), account: label(p.account) };
}

/**
 * Any code the user can give: a setup code (otpauth://, one account) or an export code
 * (otpauth-migration://, several). Each parser checks its own scheme and every account it
 * returns has passed `checked`, so there is no path through here without the checks.
 */
export function parseSetupCode(input: string): ParsedOtp[] {
  const uri = input.trim();
  const scheme = uri.slice(0, uri.indexOf(':') + 1).toLowerCase();
  if (scheme !== 'otpauth:' && scheme !== 'otpauth-migration:') throw new HttpError(400, 'That is not an authenticator setup code');
  const accounts = scheme === 'otpauth-migration:' ? parseMigration(uri) : [parseOtpauth(uri)];
  return accounts.map(checked);
}

/** otpauth://totp/Issuer:account?secret=BASE32&issuer=Issuer&algorithm=SHA1&digits=6&period=30 (what a setup QR code contains) */
export function parseOtpauth(input: string): ParsedOtp {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new HttpError(400, 'That is not an authenticator setup code');
  }
  if (url.protocol !== 'otpauth:') throw new HttpError(400, 'That is not an authenticator setup code');
  // "otpauth://totp/..." : the type is where a host would be
  if (url.hostname.toLowerCase() !== 'totp') throw new HttpError(400, 'Only time-based codes (TOTP) are supported; this one is counter-based');
  let path: string;
  try {
    path = decodeURIComponent(url.pathname.replace(/^\//, ''));
  } catch {
    throw new HttpError(400, 'That is not an authenticator setup code');
  }
  const colon = path.indexOf(':');
  const q = url.searchParams;
  return checked({
    issuer: q.get('issuer') ?? (colon >= 0 ? path.slice(0, colon) : ''),
    account: colon >= 0 ? path.slice(colon + 1) : path,
    secret: base32Decode(q.get('secret') ?? ''),
    algorithm: (q.get('algorithm') ?? 'SHA1').toUpperCase().replace('-', '') as OtpAlgorithm,
    digits: Number(q.get('digits') ?? 6),
    period: Number(q.get('period') ?? 30),
  });
}

/**
 * otpauth-migration://offline?data=... : the "export accounts" QR code of Google Authenticator,
 * which can hold several accounts. The data is a small protocol-buffers message, decoded by hand:
 *   MigrationPayload { repeated OtpParameters otp_parameters = 1; }
 *   OtpParameters { bytes secret = 1; string name = 2; string issuer = 3; enum algorithm = 4; enum digits = 5; enum type = 6; }
 */
export function parseMigration(input: string): ParsedOtp[] {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new HttpError(400, 'That is not an export code');
  }
  if (url.protocol !== 'otpauth-migration:') throw new HttpError(400, 'That is not an export code');
  const data = Buffer.from((url.searchParams.get('data') ?? '').replace(/ /g, '+'), 'base64');

  const fields = (buf: Buffer): { field: number; wire: number; value: Buffer | number }[] => {
    const out: { field: number; wire: number; value: Buffer | number }[] = [];
    let i = 0;
    const varint = () => {
      let result = 0;
      let shift = 0;
      for (;;) {
        // up to ten bytes: a negative int32 (the export's batch id can be one) is written that way
        if (i >= buf.length || shift > 63) throw new HttpError(400, 'That export code is damaged');
        const b = buf[i++];
        if (shift <= 42) result += (b & 0x7f) * 2 ** shift; // the high bits are never needed here
        if ((b & 0x80) === 0) return result;
        shift += 7;
      }
    };
    while (i < buf.length) {
      const key = varint();
      const wire = key & 7;
      if (wire === 0) out.push({ field: key >>> 3, wire, value: varint() });
      else if (wire === 2) {
        const len = varint();
        if (i + len > buf.length) throw new HttpError(400, 'That export code is damaged');
        out.push({ field: key >>> 3, wire, value: buf.subarray(i, i + len) });
        i += len;
      } else throw new HttpError(400, 'That export code is damaged');
    }
    return out;
  };

  const out: ParsedOtp[] = [];
  for (const top of fields(data)) {
    if (top.field !== 1 || top.wire !== 2) continue;
    const f = fields(top.value as Buffer);
    const bytes = (n: number) => (f.find((x) => x.field === n && x.wire === 2)?.value as Buffer | undefined) ?? Buffer.alloc(0);
    const num = (n: number) => (f.find((x) => x.field === n && x.wire === 0)?.value as number | undefined) ?? 0;
    if (num(6) === 1) continue; // HOTP (counter based): not supported, skipped
    const name = bytes(2).toString('utf8');
    const issuer = bytes(3).toString('utf8');
    const colon = name.indexOf(':');
    out.push(
      checked({
        issuer: issuer || (colon >= 0 ? name.slice(0, colon) : ''),
        account: colon >= 0 && (!issuer || name.slice(0, colon) === issuer) ? name.slice(colon + 1) : name,
        secret: Buffer.from(bytes(1)),
        algorithm: ({ 2: 'SHA256', 3: 'SHA512' } as Record<number, OtpAlgorithm>)[num(4)] ?? 'SHA1',
        digits: num(5) === 2 ? 8 : 6,
        period: 30,
      }),
    );
  }
  if (out.length === 0) throw new HttpError(400, 'No time-based accounts were found in that export code');
  return out;
}

// ---- storage ------------------------------------------------------------------------------------------------

export async function listEntries(v: Viewer): Promise<OtpListing> {
  const key = await vaultKey();
  if (!key) return { available: false, entries: [] };
  const res = await query<{ id: string; issuer: string; account: string; secret_enc: Buffer; algorithm: OtpAlgorithm; digits: number; period: number }>(
    'select id::text as id, issuer, account, secret_enc, algorithm, digits, period from totp_entries where user_id = $1 order by lower(issuer), lower(account), id',
    [v.userId],
  );
  const now = Date.now() / 1000;
  const entries: OtpEntry[] = [];
  for (const row of res.rows) {
    try {
      const secret = open(key, v.userId, row.secret_enc);
      const step = Math.floor(now / row.period);
      entries.push({
        id: row.id,
        issuer: row.issuer,
        account: row.account,
        code: totpCode(secret, step, row.algorithm, row.digits),
        next: totpCode(secret, step + 1, row.algorithm, row.digits),
        period: row.period,
        remaining: Math.max(1, Math.ceil((step + 1) * row.period - now)),
      });
    } catch {
      // encrypted under a different key (for example after the key was replaced): show it as unusable rather than fail the list
      entries.push({ id: row.id, issuer: row.issuer, account: row.account, code: '', next: '', period: row.period, remaining: row.period });
    }
  }
  return { available: true, entries };
}

/** Adds every account found in the given setup codes (otpauth://) and export codes (otpauth-migration://). */
export async function addEntries(v: Viewer, body: { uris?: unknown; manual?: unknown }): Promise<{ added: number }> {
  const key = await requireKey();
  const parsed: ParsedOtp[] = [];
  if (Array.isArray(body?.uris)) {
    if (body.uris.length > 50) throw new HttpError(400, 'Too many codes at once');
    for (const item of body.uris) parsed.push(...parseSetupCode(String(item)));
  }
  if (body?.manual && typeof body.manual === 'object') {
    const m = body.manual as Record<string, unknown>;
    parsed.push(checked({ issuer: String(m.issuer ?? ''), account: String(m.account ?? ''), secret: base32Decode(String(m.secret ?? '')), algorithm: 'SHA1', digits: 6, period: 30 }));
  }
  if (parsed.length === 0) throw new HttpError(400, 'Nothing to add');
  const count = await query<{ n: number }>('select count(*)::int as n from totp_entries where user_id = $1', [v.userId]);
  if (count.rows[0].n + parsed.length > MAX_ENTRIES) throw new HttpError(400, `The authenticator holds at most ${MAX_ENTRIES} accounts`);
  for (const p of parsed) {
    await query('insert into totp_entries (user_id, issuer, account, secret_enc, algorithm, digits, period) values ($1, $2, $3, $4, $5, $6, $7)', [
      v.userId,
      p.issuer,
      p.account,
      seal(key, v.userId, p.secret),
      p.algorithm,
      p.digits,
      p.period,
    ]);
  }
  return { added: parsed.length };
}

const entryId = (v: unknown) => {
  const s = String(v ?? '');
  if (!/^[1-9]\d{0,17}$/.test(s)) throw new HttpError(400, 'Invalid entry');
  return s;
};

export async function renameEntry(v: Viewer, body: { id?: unknown; issuer?: unknown; account?: unknown }): Promise<void> {
  const res = await query('update totp_entries set issuer = $3, account = $4 where id = $1 and user_id = $2', [entryId(body?.id), v.userId, label(String(body?.issuer ?? '')), label(String(body?.account ?? ''))]);
  if (!res.rowCount) throw new HttpError(404, 'Entry not found');
}

export async function deleteEntry(v: Viewer, body: { id?: unknown }): Promise<void> {
  await query('delete from totp_entries where id = $1 and user_id = $2', [entryId(body?.id), v.userId]);
}
