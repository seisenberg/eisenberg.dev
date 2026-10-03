import type { Context } from 'koa';
import config from './config.js';
import { hashPassword, MIN_PASSWORD_LENGTH, type AuthState } from './auth.js';
import { query, tx } from './db.js';
import { HttpError, isDomain } from './mail.js';
import type { UserInfo } from '../shared/api.js';

// User management, for owners. A member is a second sign-in that sees only the mail of the listed
// domains: for someone who shares one of the companies but should not see everything else.
// Read, flag and folder state of a message is shared by everyone who can see it.

const USERNAME = /^[a-z0-9][a-z0-9._@+-]{1,99}$/;

function checkDomains(input: unknown): string[] {
  if (!Array.isArray(input) || input.length === 0) throw new HttpError(400, 'Choose at least one domain for a member');
  const domains = [...new Set(input.map((d) => String(d).trim().toLowerCase()))];
  for (const d of domains) {
    if (!isDomain(d)) throw new HttpError(400, `"${d.slice(0, 80)}" is not a domain`);
    if (config.mail.domains.length && !config.mail.domains.includes(d)) throw new HttpError(400, `${d} is not one of your domains`);
  }
  return domains;
}

function checkPassword(input: unknown): string {
  const password = typeof input === 'string' ? input : '';
  if (password.length < MIN_PASSWORD_LENGTH || password.length > 1024) throw new HttpError(400, `Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  return password;
}

export async function listUsers(): Promise<UserInfo[]> {
  const res = await query<{ id: number; email: string; role: 'owner' | 'member'; domains: string[] | null; totp: boolean; passkeys: number; created_at: Date }>(
    `select u.id, u.email, u.role, u.domains, u.totp_secret is not null as totp, u.created_at,
            (select count(*)::int from webauthn_credentials c where c.user_id = u.id) as passkeys
       from webmail_users u order by u.role desc, u.email`,
  );
  return res.rows.map((r) => ({ id: r.id, username: r.email, role: r.role, domains: r.role === 'owner' ? null : (r.domains ?? []), totpEnabled: r.totp, passkeys: r.passkeys, createdAt: r.created_at.toISOString() }));
}

export async function createMember(body: { username?: unknown; password?: unknown; domains?: unknown }): Promise<void> {
  const username = String(body?.username ?? '').trim().toLowerCase();
  if (!USERNAME.test(username)) throw new HttpError(400, 'Usernames are 2 to 100 characters: letters, digits and . _ @ + -');
  const domains = checkDomains(body?.domains);
  const passhash = await hashPassword(checkPassword(body?.password));
  // usernames are compared without regard to case everywhere
  const res = await query(
    `insert into webmail_users (email, passhash, role, domains)
     select $1, $2, 'member', $3 where not exists (select 1 from webmail_users where lower(email) = $1)
     on conflict do nothing`,
    [username, passhash, domains],
  );
  if (!res.rowCount) throw new HttpError(409, 'That username is taken');
}

async function memberId(input: unknown): Promise<number> {
  const id = Number(input);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'Invalid user');
  const res = await query<{ role: string }>('select role from webmail_users where id = $1', [id]);
  if (!res.rows[0]) throw new HttpError(404, 'User not found');
  // owners are managed from the command line (npm run user:set), never through the web
  if (res.rows[0].role !== 'member') throw new HttpError(400, 'Owners cannot be changed here');
  return id;
}

/** Everything that keeps a user signed in or lets them sign in without the password. */
async function signOutEverywhere(db: { query: (sql: string, params: unknown[]) => Promise<unknown> }, id: number): Promise<void> {
  await db.query('delete from webmail_sessions where user_id = $1', [id]);
  await db.query('delete from webmail_devices where user_id = $1', [id]);
  await db.query('delete from push_subscriptions where user_id = $1', [id]);
}

export async function updateMember(body: { id?: unknown; password?: unknown; domains?: unknown }): Promise<void> {
  const id = await memberId(body?.id);
  if (body.domains !== undefined) await query('update webmail_users set domains = $2 where id = $1', [id, checkDomains(body.domains)]);
  if (body.password !== undefined) {
    const passhash = await hashPassword(checkPassword(body.password));
    await tx(async (client) => {
      await client.query('update webmail_users set passhash = $2, totp_secret = null, totp_last_step = null where id = $1', [id, passhash]);
      await client.query('delete from webmail_recovery_codes where user_id = $1', [id]);
      await client.query('delete from webauthn_credentials where user_id = $1', [id]);
      await signOutEverywhere(client, id);
    });
  }
}

export async function deleteMember(ctx: Context, body: { id?: unknown }): Promise<void> {
  const id = await memberId(body?.id);
  if (id === (ctx.state.auth as AuthState).userId) throw new HttpError(400, 'You cannot remove yourself');
  await tx(async (client) => {
    await signOutEverywhere(client, id);
    for (const table of ['webmail_recovery_codes', 'webauthn_credentials', 'webauthn_challenges', 'push_subscriptions', 'drafts']) {
      await client.query(`delete from ${table} where user_id = $1`, [id]);
    }
    await client.query('delete from webmail_users where id = $1', [id]);
  });
}
