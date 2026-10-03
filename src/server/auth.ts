import crypto from 'node:crypto';
import type { Context, Next } from 'koa';
import config from './config.js';
import { query, tx, type Queryable } from './db.js';
import type { SessionInfo, SessionUser } from '../shared/api.js';

// ------------------------------------------------------------------------------------------------
// Passwords: scrypt with per-password salt, parameters stored alongside the hash.
// ------------------------------------------------------------------------------------------------

const SCRYPT = { N: 1 << 16, r: 8, p: 2, keylen: 32 };
const SCRYPT_MAXMEM = 256 * 1024 * 1024;
export const MIN_PASSWORD_LENGTH = 12;
const MAX_PASSWORD_LENGTH = 1024;

function scrypt(password: string, salt: Buffer, keylen: number, N: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password.normalize('NFKC'), salt, keylen, { N, r, p, maxmem: SCRYPT_MAXMEM }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, SCRYPT.keylen, SCRYPT.N, SCRYPT.r, SCRYPT.p);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), hash.toString('base64')].join('$');
}

export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  const parts = (stored ?? '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [N, r, p] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  if (!Number.isInteger(N) || N < 2 || N > 1 << 20 || !Number.isInteger(r) || r < 1 || r > 16 || !Number.isInteger(p) || p < 1 || p > 8) return false;
  const salt = Buffer.from(parts[4], 'base64');
  const expected = Buffer.from(parts[5], 'base64');
  if (expected.length < 16) return false;
  try {
    const actual = await scrypt(password, salt, expected.length, N, r, p);
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

// Verified against when the user does not exist, so both paths cost the same.
let dummyHash: Promise<string> | null = null;
const getDummyHash = () => (dummyHash ??= hashPassword(crypto.randomBytes(24).toString('hex')));

// ------------------------------------------------------------------------------------------------
// TOTP (RFC 6238, SHA-1, 6 digits, 30 s) with replay protection.
// ------------------------------------------------------------------------------------------------

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[^A-Z2-7]/g, '');
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of clean) {
    value = (value << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function totpCode(secret: Buffer, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = crypto.createHmac('sha1', secret).update(counter).digest();
  const offset = mac[mac.length - 1] & 15;
  const bin = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(bin % 1_000_000).padStart(6, '0');
}

/** Returns the matched time step, or null. Steps at or before lastStep are rejected (no replays). */
export function verifyTotp(secretB32: string, code: string, lastStep: number | null, now = Date.now()): number | null {
  const clean = code.replace(/\s+/g, '');
  if (!/^\d{6}$/.test(clean)) return null;
  const secret = base32Decode(secretB32);
  const current = Math.floor(now / 30_000);
  let matched: number | null = null;
  for (const step of [current - 1, current, current + 1]) {
    const ok = crypto.timingSafeEqual(Buffer.from(totpCode(secret, step)), Buffer.from(clean));
    if (ok && (lastStep === null || step > lastStep)) matched = step;
  }
  return matched;
}

export function totpUri(username: string, secretB32: string, issuer = 'eisenmail'): string {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(username)}?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

// ------------------------------------------------------------------------------------------------
// Request helpers
// ------------------------------------------------------------------------------------------------

/**
 * The client address as seen by the outermost proxy we trust. Each trusted proxy appends one entry
 * to X-Forwarded-For, so the entry we want is `proxyHops` from the right. Anything further left
 * was supplied by the client and is never used. If the chain is shorter than expected (a request
 * that skipped a proxy) the socket address is used instead.
 */
export function clientIp(ctx: Context): string {
  const hops = Math.max(config.proxyHops, 1);
  const parts = ctx.get('x-forwarded-for').split(',').map((s) => s.trim()).filter(Boolean);
  const raw = parts.length >= hops ? parts[parts.length - hops] : (ctx.socket.remoteAddress ?? 'unknown');
  return ipBucket(raw);
}

/** IPv4 as is; IPv6 reduced to its /64, since one host usually controls a whole /64. */
export function ipBucket(ip: string): string {
  const v = ip.slice(0, 60);
  if (!v.includes(':')) return v;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(v);
  if (mapped) return mapped[1];
  const [head, tail = ''] = v.toLowerCase().split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const full = v.includes('::') ? [...left, ...Array(Math.max(8 - left.length - right.length, 0)).fill('0'), ...right] : left;
  return full.slice(0, 4).map((h) => h.replace(/^0+(?=.)/, '')).join(':') + '::/64';
}

function readCookie(ctx: Context, name: string): string | null {
  const header = ctx.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

function cookie(name: string, value: string, maxAgeSeconds: number): string {
  const attrs = [`${name}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAgeSeconds}`];
  if (config.production) attrs.push('Secure');
  return attrs.join('; ');
}
const sessionCookie = (value: string, maxAgeSeconds: number) => cookie(config.session.cookieName, value, maxAgeSeconds);

const hashToken = (token: string) => crypto.createHash('sha256').update(token).digest();

// ------------------------------------------------------------------------------------------------
// Sessions (server side, revocable; the cookie holds a random token, the database only its hash)
// ------------------------------------------------------------------------------------------------

interface SessionRow {
  token_hash: Buffer;
  user_id: number;
  username: string;
  totp_secret: string | null;
  stale: boolean;
}

export interface AuthState {
  userId: number;
  username: string;
  totpEnabled: boolean;
  tokenHash: Buffer;
}

async function createSession(ctx: Context, userId: number): Promise<void> {
  const token = crypto.randomBytes(32).toString('base64url');
  const ttl = config.session.ttlHours * 3600;
  await query(
    `insert into webmail_sessions (token_hash, user_id, expires_at, ip, user_agent)
     values ($1, $2, now() + make_interval(secs => $3), $4, $5)`,
    [hashToken(token), userId, ttl, clientIp(ctx), ctx.get('user-agent').slice(0, 300) || null],
  );
  ctx.append('Set-Cookie', sessionCookie(token, ttl));
}

async function loadSession(ctx: Context): Promise<AuthState | null> {
  const token = readCookie(ctx, config.session.cookieName);
  if (!token || token.length > 100) return null;
  const tokenHash = hashToken(token);
  const ttl = config.session.ttlHours * 3600;
  const res = await query<SessionRow & { renew: boolean }>(
    `select s.token_hash, s.user_id, u.email as username, u.totp_secret,
            s.last_seen_at < now() - interval '1 minute' as stale,
            s.expires_at < now() + make_interval(secs => $2) - interval '1 day' as renew
       from webmail_sessions s join webmail_users u on u.id = s.user_id
      where s.token_hash = $1 and s.expires_at > now()`,
    [tokenHash, ttl],
  );
  const row = res.rows[0];
  if (!row) return null;
  if (row.renew) {
    // Sliding expiry: at most once a day, push the session (and its cookie) out to a full lifetime
    // again. A device that is in use stays signed in; one that is idle for the lifetime is signed out.
    await query('update webmail_sessions set last_seen_at = now(), expires_at = now() + make_interval(secs => $2) where token_hash = $1', [tokenHash, ttl]);
    ctx.append('Set-Cookie', sessionCookie(token, ttl));
  } else if (row.stale) {
    await query('update webmail_sessions set last_seen_at = now() where token_hash = $1', [tokenHash]);
  }
  return { userId: row.user_id, username: row.username, totpEnabled: !!row.totp_secret, tokenHash };
}

export async function requireAuth(ctx: Context, next: Next): Promise<void> {
  const auth = await loadSession(ctx);
  if (!auth) {
    ctx.status = 401;
    ctx.body = { error: 'Not signed in', code: 'unauthenticated' };
    return;
  }
  ctx.state.auth = auth;
  await next();
}

/**
 * CSRF defence for cookie-authenticated, state-changing requests. Three independent layers:
 * SameSite=Strict cookie, a custom header (cannot be sent cross-site without a CORS preflight,
 * and this server never answers preflights), and an Origin / Sec-Fetch-Site check.
 */
export async function requireSameOrigin(ctx: Context, next: Next): Promise<void> {
  if (ctx.method === 'GET' || ctx.method === 'HEAD') return next();
  const deny = (why: string) => {
    ctx.status = 403;
    ctx.body = { error: `Cross-site request refused (${why})`, code: 'csrf' };
  };
  if (ctx.get('x-eisenmail') !== '1') return deny('missing header');
  const site = ctx.get('sec-fetch-site');
  if (site && site !== 'same-origin') return deny('sec-fetch-site');
  const origin = ctx.get('origin');
  if (origin) {
    let ok = false;
    if (config.publicOrigin) ok = origin === config.publicOrigin;
    else {
      try {
        ok = new URL(origin).host === ctx.host;
      } catch {
        ok = false;
      }
    }
    if (!ok) return deny('origin');
  }
  await next();
}

// ------------------------------------------------------------------------------------------------
// Login with throttling
// ------------------------------------------------------------------------------------------------

const WINDOW_MIN = 15;
const MAX_FAILS_PER_USER_IP = 5;
const MAX_FAILS_PER_IP = 20;
const MAX_FAILS_PER_USER = 30;

const DEVICE_TTL_SECONDS = 365 * 24 * 3600;

/** True when this browser has completed a sign-in as this user before. */
async function isKnownDevice(ctx: Context, username: string): Promise<boolean> {
  const token = readCookie(ctx, config.session.deviceCookieName);
  if (!token || token.length > 100) return false;
  const res = await query(
    `update webmail_devices d set last_used_at = now()
       from webmail_users u
      where d.token_hash = $1 and u.id = d.user_id and lower(u.email) = $2`,
    [hashToken(token), username],
  );
  return (res.rowCount ?? 0) > 0;
}

async function rememberDevice(ctx: Context, userId: number): Promise<void> {
  const token = crypto.randomBytes(32).toString('base64url');
  await query('insert into webmail_devices (token_hash, user_id) values ($1, $2)', [hashToken(token), userId]);
  await query(`delete from webmail_devices where last_used_at < now() - interval '1 year'`);
  ctx.append('Set-Cookie', cookie(config.session.deviceCookieName, token, DEVICE_TTL_SECONDS));
}

/**
 * Failed-attempt limits. The per-username limit stops a distributed guessing attack, but on its own
 * it would let anyone who knows the username lock the owner out. A browser that has signed in
 * before (device cookie) is therefore exempt from it; the per-address limits still apply to it.
 */
async function throttled(db: Queryable, username: string, ip: string, knownDevice: boolean): Promise<boolean> {
  const res = await db.query<{ user_ip: number; ip: number; username: number }>(
    `select count(*) filter (where username = $1 and ip = $2)::int as user_ip,
            count(*) filter (where ip = $2)::int as ip,
            count(*) filter (where username = $1)::int as username
       from webmail_login_attempts
      where not success and at > now() - make_interval(mins => $3)`,
    [username, ip, WINDOW_MIN],
  );
  const c = res.rows[0];
  return c.user_ip >= MAX_FAILS_PER_USER_IP || c.ip >= MAX_FAILS_PER_IP || (!knownDevice && c.username >= MAX_FAILS_PER_USER);
}

/**
 * Reserves one attempt: checks the limits and records the attempt as a failure in one step,
 * serialised per username and per address with advisory locks. Recording before the password is
 * checked means a burst of parallel guesses cannot all slip in under the limit. Returns the
 * attempt id, or null when throttled.
 */
async function beginAttempt(username: string, ip: string, knownDevice: boolean): Promise<string | null> {
  return tx(async (client) => {
    await client.query('select pg_advisory_xact_lock(1, hashtext($1)), pg_advisory_xact_lock(2, hashtext($2))', [username, ip]);
    if (await throttled(client, username, ip, knownDevice)) return null;
    const res = await client.query<{ id: string }>('insert into webmail_login_attempts (username, ip, success) values ($1, $2, false) returning id::text as id', [username, ip]);
    return res.rows[0].id;
  });
}

/** The attempt turned out to be good: stop counting it, clear this client's streak, and prune. */
async function attemptSucceeded(attemptId: string, username: string, ip: string): Promise<void> {
  await query('update webmail_login_attempts set success = true where id = $1', [attemptId]);
  await query(`delete from webmail_login_attempts where (username = $1 and ip = $2 and not success) or at < now() - interval '7 days'`, [username, ip]);
  await query('delete from webmail_sessions where expires_at < now()');
}

function fail(ctx: Context, status: number, error: string, code?: string): void {
  ctx.status = status;
  ctx.body = { error, code };
}

export async function login(ctx: Context): Promise<void> {
  const body = (ctx.request.body ?? {}) as Record<string, unknown>;
  const username = typeof body.username === 'string' ? body.username.trim().toLowerCase() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  const code = typeof body.code === 'string' ? body.code : '';
  if (!username || !password || username.length > 200 || password.length > MAX_PASSWORD_LENGTH) {
    return fail(ctx, 400, 'Username and password are required');
  }
  const ip = clientIp(ctx);
  const knownDevice = await isKnownDevice(ctx, username);
  const attempt = await beginAttempt(username, ip, knownDevice);
  if (attempt === null) {
    ctx.set('Retry-After', String(WINDOW_MIN * 60));
    return fail(ctx, 429, 'Too many failed sign-in attempts. Try again later.', 'throttled');
  }

  const res = await query<{ id: number; passhash: string | null; totp_secret: string | null; totp_last_step: string | null }>(
    'select id, passhash, totp_secret, totp_last_step from webmail_users where lower(email) = $1',
    [username],
  );
  const user = res.rows[0];
  const passwordOk = await verifyPassword(password, user?.passhash ?? (await getDummyHash()));
  if (!user || !passwordOk) return fail(ctx, 401, 'Username or password not recognised', 'bad_credentials');

  if (user.totp_secret) {
    if (!code) {
      // Right password, code not asked for yet: not a failed guess.
      await query('delete from webmail_login_attempts where id = $1', [attempt]);
      return fail(ctx, 401, 'Enter the 6 digit code from your authenticator app', 'totp_required');
    }
    const step = verifyTotp(user.totp_secret, code, user.totp_last_step === null ? null : Number(user.totp_last_step));
    // The conditional update makes a code single-use even when two requests race with it.
    const claimed =
      step !== null &&
      ((await query('update webmail_users set totp_last_step = $2 where id = $1 and (totp_last_step is null or totp_last_step < $2)', [user.id, step])).rowCount ?? 0) > 0;
    if (!claimed) return fail(ctx, 401, 'That code is not valid', 'bad_totp');
  }

  await attemptSucceeded(attempt, username, ip);
  await createSession(ctx, user.id);
  if (!knownDevice) await rememberDevice(ctx, user.id);
  ctx.body = { username, totpEnabled: !!user.totp_secret } satisfies SessionUser;
}

export async function logout(ctx: Context): Promise<void> {
  const auth = ctx.state.auth as AuthState;
  await query('delete from webmail_sessions where token_hash = $1', [auth.tokenHash]);
  ctx.append('Set-Cookie', sessionCookie('', 0));
  ctx.status = 204;
}

export async function me(ctx: Context): Promise<void> {
  const auth = ctx.state.auth as AuthState;
  ctx.body = { username: auth.username, totpEnabled: auth.totpEnabled } satisfies SessionUser;
}

export async function listSessions(ctx: Context): Promise<void> {
  const auth = ctx.state.auth as AuthState;
  const res = await query<{ token_hash: Buffer; created_at: Date; last_seen_at: Date; ip: string | null; user_agent: string | null }>(
    'select token_hash, created_at, last_seen_at, ip, user_agent from webmail_sessions where user_id = $1 and expires_at > now() order by last_seen_at desc',
    [auth.userId],
  );
  ctx.body = res.rows.map(
    (r): SessionInfo => ({
      // A short, non-reversible handle; never the token or its full hash.
      id: r.token_hash.subarray(0, 8).toString('hex'),
      current: r.token_hash.equals(auth.tokenHash),
      createdAt: r.created_at.toISOString(),
      lastSeenAt: r.last_seen_at.toISOString(),
      ip: r.ip,
      userAgent: r.user_agent,
    }),
  );
}

export async function revokeOtherSessions(ctx: Context): Promise<void> {
  const auth = ctx.state.auth as AuthState;
  await query('delete from webmail_sessions where user_id = $1 and token_hash <> $2', [auth.userId, auth.tokenHash]);
  ctx.status = 204;
}

/** Re-authentication inside a live session (password change, two-factor). Throttled per address only. */
async function confirmPassword(ctx: Context, password: unknown): Promise<boolean> {
  const auth = ctx.state.auth as AuthState;
  const ip = clientIp(ctx);
  const attempt = await beginAttempt(auth.username, ip, true);
  if (attempt === null) {
    fail(ctx, 429, 'Too many failed attempts. Try again later.', 'throttled');
    return false;
  }
  const res = await query<{ passhash: string | null }>('select passhash from webmail_users where id = $1', [auth.userId]);
  const ok = typeof password === 'string' && password.length <= MAX_PASSWORD_LENGTH && (await verifyPassword(password, res.rows[0]?.passhash));
  if (ok) await query('delete from webmail_login_attempts where id = $1', [attempt]);
  else fail(ctx, 403, 'Current password is not correct', 'bad_credentials');
  return ok;
}

export async function changePassword(ctx: Context): Promise<void> {
  const auth = ctx.state.auth as AuthState;
  const body = (ctx.request.body ?? {}) as Record<string, unknown>;
  const next = typeof body.newPassword === 'string' ? body.newPassword : '';
  if (next.length < MIN_PASSWORD_LENGTH || next.length > MAX_PASSWORD_LENGTH) {
    return fail(ctx, 400, `New password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  if (!(await confirmPassword(ctx, body.currentPassword))) return;
  await query('update webmail_users set passhash = $2 where id = $1', [auth.userId, await hashPassword(next)]);
  await query('delete from webmail_sessions where user_id = $1 and token_hash <> $2', [auth.userId, auth.tokenHash]);
  ctx.status = 204;
}

export async function totpSetup(ctx: Context): Promise<void> {
  const auth = ctx.state.auth as AuthState;
  const body = (ctx.request.body ?? {}) as Record<string, unknown>;
  if (!(await confirmPassword(ctx, body.currentPassword))) return;
  const secret = base32Encode(crypto.randomBytes(20));
  await query(`update webmail_users set settings = settings || jsonb_build_object('pendingTotp', $2::text) where id = $1`, [auth.userId, secret]);
  ctx.body = { secret, uri: totpUri(auth.username, secret) };
}

export async function totpEnable(ctx: Context): Promise<void> {
  const auth = ctx.state.auth as AuthState;
  const body = (ctx.request.body ?? {}) as Record<string, unknown>;
  const res = await query<{ pending: string | null }>(`select settings->>'pendingTotp' as pending from webmail_users where id = $1`, [auth.userId]);
  const pending = res.rows[0]?.pending;
  const step = pending && typeof body.code === 'string' ? verifyTotp(pending, body.code, null) : null;
  if (!pending || step === null) return fail(ctx, 400, 'That code is not valid', 'bad_totp');
  await query(`update webmail_users set totp_secret = $2, totp_last_step = $3, settings = settings - 'pendingTotp' where id = $1`, [auth.userId, pending, step]);
  await query('delete from webmail_sessions where user_id = $1 and token_hash <> $2', [auth.userId, auth.tokenHash]);
  ctx.status = 204;
}

export async function totpDisable(ctx: Context): Promise<void> {
  const auth = ctx.state.auth as AuthState;
  const body = (ctx.request.body ?? {}) as Record<string, unknown>;
  if (!(await confirmPassword(ctx, body.currentPassword))) return;
  await query(`update webmail_users set totp_secret = null, totp_last_step = null, settings = settings - 'pendingTotp' where id = $1`, [auth.userId]);
  ctx.status = 204;
}
