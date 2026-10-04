import crypto from 'node:crypto';
import type { Context } from 'koa';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import config from './config.js';
import { confirmPassword, sessionUser, startSession, type AuthState } from './auth.js';
import { query } from './db.js';
import { HttpError } from './mail.js';
import type { PasskeyInfo } from '../shared/api.js';

// Passkeys (WebAuthn). A passkey signs in on its own: the device verifies the person (Face ID,
// fingerprint, PIN), so it is two factors in one step and cannot be phished to another site.
// The password stays as the fallback. Challenges are single-use rows, because Lambda instances
// share no memory.

const CHALLENGE_COOKIE = config.production ? '__Host-eisenmail-wa' : 'eisenmail_dev_wa';
const CHALLENGE_TTL = 300;

/** The site as the browser sees it. In production this is the configured origin when there is one. */
function relyingParty(ctx: Context): { origin: string; rpID: string } {
  const origin = config.publicOrigin ?? `${config.production ? 'https' : ctx.protocol}://${ctx.host}`;
  return { origin, rpID: new URL(origin).hostname };
}

function cookie(value: string, maxAge: number): string {
  const attrs = [`${CHALLENGE_COOKIE}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAge}`];
  if (config.production) attrs.push('Secure');
  return attrs.join('; ');
}

async function saveChallenge(ctx: Context, challenge: string, kind: 'register' | 'login', userId: number | null): Promise<void> {
  const id = crypto.randomUUID();
  await query(`insert into webauthn_challenges (id, challenge, kind, user_id, expires_at) values ($1, $2, $3, $4, now() + make_interval(secs => $5))`, [id, challenge, kind, userId, CHALLENGE_TTL]);
  await query('delete from webauthn_challenges where expires_at < now()');
  // the sign-in request is unauthenticated: never let it grow the table without bound
  await query('delete from webauthn_challenges where id in (select id from webauthn_challenges order by expires_at desc offset 500)');
  ctx.append('Set-Cookie', cookie(id, CHALLENGE_TTL));
}

/** A challenge can be redeemed exactly once. */
async function takeChallenge(ctx: Context, kind: 'register' | 'login'): Promise<{ challenge: string; userId: number | null }> {
  const header = ctx.get('cookie');
  const id = header.split(';').map((p) => p.trim()).find((p) => p.startsWith(`${CHALLENGE_COOKIE}=`))?.slice(CHALLENGE_COOKIE.length + 1);
  ctx.append('Set-Cookie', cookie('', 0));
  if (!id || !/^[0-9a-f-]{36}$/.test(id)) throw new HttpError(400, 'The passkey request expired. Try again.', 'passkey_expired');
  const res = await query<{ challenge: string; user_id: number | null }>('delete from webauthn_challenges where id = $1 and kind = $2 and expires_at > now() returning challenge, user_id', [id, kind]);
  if (!res.rows[0]) throw new HttpError(400, 'The passkey request expired. Try again.', 'passkey_expired');
  return { challenge: res.rows[0].challenge, userId: res.rows[0].user_id };
}

type ExcludeCredential = NonNullable<NonNullable<Parameters<typeof generateRegistrationOptions>[0]['excludeCredentials']>[number]>;
type Transport = NonNullable<ExcludeCredential['transports']>[number];
const TRANSPORTS = ['ble', 'cable', 'hybrid', 'internal', 'nfc', 'smart-card', 'usb'];
const transportsOf = (v: unknown): Transport[] => (Array.isArray(v) ? (v.filter((t) => TRANSPORTS.includes(t)) as Transport[]) : []);

// ---- registration (signed in, password confirmed) ------------------------------------------------

export async function registerOptions(ctx: Context): Promise<void> {
  const auth = ctx.state.auth as AuthState;
  const body = (ctx.request.body ?? {}) as Record<string, unknown>;
  // Straight after a password sign-in (password and second step, minutes ago) the password is not
  // asked for again. Any later, or in a session started with a passkey, it is.
  if (!(auth.fresh && body.currentPassword === undefined) && !(await confirmPassword(ctx, body.currentPassword))) return;
  const { rpID } = relyingParty(ctx);
  const existing = await query<{ credential_id: string; transports: string[] }>('select credential_id, transports from webauthn_credentials where user_id = $1', [auth.userId]);
  const options = await generateRegistrationOptions({
    rpName: 'eisenmail',
    rpID,
    userName: auth.username,
    userID: new TextEncoder().encode(`eisenmail-user-${auth.userId}`),
    attestationType: 'none',
    excludeCredentials: existing.rows.map((c) => ({ id: c.credential_id, transports: transportsOf(c.transports) })),
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
  });
  await saveChallenge(ctx, options.challenge, 'register', auth.userId);
  ctx.body = options;
}

export async function register(ctx: Context): Promise<void> {
  const auth = ctx.state.auth as AuthState;
  const body = (ctx.request.body ?? {}) as { response?: unknown; name?: unknown };
  const { challenge, userId } = await takeChallenge(ctx, 'register');
  if (userId !== auth.userId) throw new HttpError(400, 'The passkey request expired. Try again.', 'passkey_expired');
  const { origin, rpID } = relyingParty(ctx);
  let result;
  try {
    result = await verifyRegistrationResponse({ response: body.response as never, expectedChallenge: challenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true });
  } catch (err) {
    throw new HttpError(400, `The passkey could not be verified (${(err as Error).message.slice(0, 120)})`);
  }
  if (!result.verified || !result.registrationInfo) throw new HttpError(400, 'The passkey could not be verified');
  const { credential } = result.registrationInfo;
  const name = String(body.name ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 60) || 'Passkey';
  const count = await query<{ n: number }>('select count(*)::int as n from webauthn_credentials where user_id = $1', [auth.userId]);
  if (count.rows[0].n >= 20) throw new HttpError(400, 'Too many passkeys');
  await query(`insert into webauthn_credentials (credential_id, user_id, public_key, counter, transports, name) values ($1, $2, $3, $4, $5, $6)`, [
    credential.id,
    auth.userId,
    Buffer.from(credential.publicKey),
    credential.counter,
    transportsOf(credential.transports),
    name,
  ]);
  ctx.status = 204;
}

export async function list(ctx: Context): Promise<void> {
  const auth = ctx.state.auth as AuthState;
  const res = await query<{ credential_id: string; name: string; created_at: Date; last_used_at: Date | null }>(
    'select credential_id, name, created_at, last_used_at from webauthn_credentials where user_id = $1 order by created_at',
    [auth.userId],
  );
  ctx.body = res.rows.map((r): PasskeyInfo => ({ id: r.credential_id, name: r.name, createdAt: r.created_at.toISOString(), lastUsedAt: r.last_used_at?.toISOString() ?? null }));
}

export async function remove(ctx: Context): Promise<void> {
  const auth = ctx.state.auth as AuthState;
  const id = String((ctx.request.body as { id?: unknown })?.id ?? '');
  await query('delete from webauthn_credentials where credential_id = $1 and user_id = $2', [id, auth.userId]);
  ctx.status = 204;
}

// ---- sign-in (no session yet) ----------------------------------------------------------------------

export async function loginOptions(ctx: Context): Promise<void> {
  const { rpID } = relyingParty(ctx);
  // no allow-list: the browser offers whichever passkeys it holds for this site, and nothing here
  // reveals which usernames exist
  const options = await generateAuthenticationOptions({ rpID, userVerification: 'required' });
  await saveChallenge(ctx, options.challenge, 'login', null);
  ctx.body = options;
}

export async function login(ctx: Context): Promise<void> {
  const response = (ctx.request.body as { response?: { id?: unknown } })?.response;
  const { challenge } = await takeChallenge(ctx, 'login');
  const denied = new HttpError(401, 'That passkey is not recognised', 'bad_credentials');
  const credentialId = typeof response?.id === 'string' && response.id.length <= 1024 ? response.id : null;
  if (!credentialId) throw denied;
  const res = await query<{ user_id: number; public_key: Buffer; counter: string; transports: string[]; username: string; totp: boolean; role: 'owner' | 'member'; domains: string[] | null; verify_email: string | null }>(
    `select c.user_id, c.public_key, c.counter::text as counter, c.transports, u.email as username, u.totp_secret is not null as totp, u.role, u.domains, u.verify_email
       from webauthn_credentials c join webmail_users u on u.id = c.user_id where c.credential_id = $1`,
    [credentialId],
  );
  const cred = res.rows[0];
  if (!cred) throw denied;
  const { origin, rpID } = relyingParty(ctx);
  let result;
  try {
    result = await verifyAuthenticationResponse({
      response: response as never,
      expectedChallenge: challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: true,
      credential: { id: credentialId, publicKey: new Uint8Array(cred.public_key), counter: Number(cred.counter), transports: transportsOf(cred.transports) },
    });
  } catch {
    throw denied;
  }
  if (!result.verified) throw denied;
  await query('update webauthn_credentials set counter = $2, last_used_at = now() where credential_id = $1', [credentialId, result.authenticationInfo.newCounter]);
  await startSession(ctx, cred.user_id, cred.username, 'passkey');
  ctx.body = sessionUser({ username: cred.username, totpEnabled: cred.totp, role: cred.role, domains: cred.domains, verifyEmail: cred.verify_email });
}
