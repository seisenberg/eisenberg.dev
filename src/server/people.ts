import config from './config.js';
import { type Queryable, query, tx } from './db.js';
import { domainOf, HttpError, isAddress, type Viewer } from './mail.js';
import type { Person, PersonDetail, PersonInput, PersonSummary } from '../shared/api.js';

// People: an address book per sign-in, filled from mail as it arrives and is sent, and edited by
// hand. It feeds recipient autocomplete and the "all mail with this person" view.

const MAX_PEOPLE = 20_000;
const MAX_ADDRESSES = 20;
const RELAY_SHAPED = /^reply-[0-9a-f]{32}@/;

const text = (v: unknown, max: number) => String(v ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const looksLikeAddress = (name: string) => /@|https?:/i.test(name);

/** Addresses this system receives for are never contacts: they are us. */
function outside(address: string): boolean {
  return isAddress(address) && !RELAY_SHAPED.test(address) && !config.mail.domains.includes(domainOf(address));
}

function checkAddresses(input: unknown): string[] {
  const list = Array.isArray(input) ? input : typeof input === 'string' ? input.split(/[\s,;]+/) : [];
  const out: string[] = [];
  for (const item of list) {
    const address = String(item ?? '').trim().toLowerCase();
    if (!address) continue;
    if (!isAddress(address) || RELAY_SHAPED.test(address)) throw new HttpError(400, `"${address.slice(0, 80)}" is not a valid email address`);
    if (config.mail.domains.includes(domainOf(address))) throw new HttpError(400, `${address} is one of this system's own addresses`);
    if (!out.includes(address)) out.push(address);
  }
  if (out.length > MAX_ADDRESSES) throw new HttpError(400, `At most ${MAX_ADDRESSES} addresses per person`);
  return out;
}

// ---- recording from mail ------------------------------------------------------------------------

/**
 * Called after a message was indexed. The sender of inbound mail, and every recipient of mail we
 * sent, lands in the book of each sign-in that can see the message: owners, and members of one
 * of the message's domains. A new address makes a new contact named after the display name the
 * other side used; a known one updates its counts and the name last seen.
 */
export async function recordFromMessage(
  db: Queryable,
  m: { direction: 'in' | 'out'; mailbox: string; domains: string[]; from: Person; to: Person[]; cc: Person[]; at: Date },
): Promise<void> {
  if (m.mailbox === 'junk') return;
  const seen: Person[] = m.direction === 'in' ? [m.from] : [...m.to, ...m.cc];
  const people = new Map<string, string>();
  for (const p of seen) {
    const address = (p.address ?? '').trim().toLowerCase();
    if (!outside(address)) continue;
    const name = text(p.name, 200);
    if (!people.has(address) || (!people.get(address) && name)) people.set(address, looksLikeAddress(name) ? '' : name);
  }
  if (people.size === 0) return;
  const users = await db.query<{ id: number }>(`select id from webmail_users where role = 'owner' or domains && $1::text[]`, [m.domains]);
  for (const user of users.rows) {
    for (const [address, name] of people) await record(db, user.id, address, name, m.direction, m.at);
  }
}

async function record(db: Queryable, userId: number, address: string, name: string, direction: 'in' | 'out', at: Date): Promise<void> {
  const known = await db.query<{ contact_id: string }>(
    `update contact_addresses
        set last_seen = greatest(coalesce(last_seen, $4), $4), name_seen = case when $3 <> '' then $3 else name_seen end,
            received = received + $5, sent = sent + $6
      where user_id = $1 and address = $2 returning contact_id`,
    [userId, address, name, at, direction === 'in' ? 1 : 0, direction === 'out' ? 1 : 0],
  );
  if (known.rowCount) {
    // a contact that was made from mail and has no name yet takes the first name seen
    if (name) await db.query(`update contacts set name = $2, updated_at = now() where id = $1 and name = '' and source = 'mail'`, [known.rows[0].contact_id, name]);
    return;
  }
  const count = await db.query<{ n: number }>('select count(*)::int as n from contacts where user_id = $1', [userId]);
  if (count.rows[0].n >= MAX_PEOPLE) return;
  const contact = await db.query<{ id: string }>(`insert into contacts (user_id, name, source) values ($1, $2, 'mail') returning id::text as id`, [userId, name]);
  await db.query(
    `insert into contact_addresses (user_id, address, contact_id, name_seen, first_seen, last_seen, received, sent)
     values ($1, $2, $3, $4, $5, $5, $6, $7) on conflict (user_id, address) do nothing`,
    [userId, address, contact.rows[0].id, name, at, direction === 'in' ? 1 : 0, direction === 'out' ? 1 : 0],
  );
}

/**
 * Builds the book of every sign-in that has none yet from the mail already stored. Runs at
 * start-up (cheap when every book exists) and when a member is created.
 */
export async function backfill(): Promise<number> {
  const empty = await query<{ id: number }>(
    `select u.id from webmail_users u where not exists (select 1 from contacts c where c.user_id = u.id)
        and exists (select 1 from messages m where m.mailbox <> 'junk' and (u.role = 'owner' or u.domains && m.domains))`,
  );
  let made = 0;
  for (const user of empty.rows) {
    await tx(async (client) => {
      const rows = await client.query<{ direction: 'in' | 'out'; mailbox: string; domains: string[]; from_name: string | null; from_addr: string | null; to_list: Person[]; cc_list: Person[]; at: Date }>(
        `select m.direction, m.mailbox, m.domains, m.from_name, m.from_addr, m.to_list, m.cc_list, m.received_at as at
           from messages m, webmail_users u
          where u.id = $1 and m.mailbox <> 'junk' and (u.role = 'owner' or u.domains && m.domains)
          order by m.received_at`,
        [user.id],
      );
      for (const m of rows.rows) {
        const seen: Person[] = m.direction === 'in' ? [{ name: m.from_name ?? '', address: m.from_addr ?? '' }] : [...m.to_list, ...m.cc_list];
        for (const p of seen) {
          const address = (p.address ?? '').trim().toLowerCase();
          if (!outside(address)) continue;
          const name = text(p.name, 200);
          await record(client, user.id, address, looksLikeAddress(name) ? '' : name, m.direction, m.at);
        }
      }
    });
    made += 1;
  }
  return made;
}

// ---- the book ---------------------------------------------------------------------------------------------

export async function listPeople(v: Viewer, qInput: unknown): Promise<PersonSummary[]> {
  const q = text(qInput, 100).toLowerCase();
  const params: unknown[] = [v.userId];
  let match = '';
  if (q) {
    params.push(`%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    match = `and (lower(c.name) like $2 or lower(c.company) like $2 or exists (select 1 from contact_addresses x where x.contact_id = c.id and x.address like $2))`;
  }
  const res = await query<{ id: string; name: string; company: string; hidden: boolean; source: string; addresses: string[]; last_seen: Date | null; messages: number }>(
    `select c.id::text as id, c.name, c.company, c.hidden, c.source,
            coalesce((select array_agg(a.address order by a.last_seen desc nulls last, a.address) from contact_addresses a where a.contact_id = c.id), '{}') as addresses,
            (select max(a.last_seen) from contact_addresses a where a.contact_id = c.id) as last_seen,
            (select coalesce(sum(a.received + a.sent), 0)::int from contact_addresses a where a.contact_id = c.id) as messages
       from contacts c where c.user_id = $1 ${match}
      order by c.hidden, lower(coalesce(nullif(c.name, ''), nullif(c.company, ''), (select min(a.address) from contact_addresses a where a.contact_id = c.id), '')), c.id
      limit 2000`,
    params,
  );
  return res.rows.map((r) => ({ id: r.id, name: r.name, company: r.company, hidden: r.hidden, manual: r.source === 'manual', addresses: r.addresses, lastSeen: r.last_seen?.toISOString() ?? null, messages: r.messages }));
}

export async function getPerson(v: Viewer, idInput: unknown): Promise<PersonDetail> {
  const id = checkId(idInput);
  const res = await query<{ id: string; name: string; company: string; note: string; hidden: boolean; source: string; created_at: Date }>(
    'select id::text as id, name, company, note, hidden, source, created_at from contacts where id = $1 and user_id = $2',
    [id, v.userId],
  );
  if (!res.rows[0]) throw new HttpError(404, 'Not found', 'not_found');
  const addresses = await query<{ address: string; name_seen: string; first_seen: Date; last_seen: Date | null; received: number; sent: number }>(
    'select address, name_seen, first_seen, last_seen, received, sent from contact_addresses where contact_id = $1 order by last_seen desc nulls last, address',
    [id],
  );
  const c = res.rows[0];
  return {
    id: c.id, name: c.name, company: c.company, note: c.note, hidden: c.hidden, manual: c.source === 'manual', createdAt: c.created_at.toISOString(),
    addresses: addresses.rows.map((a) => ({ address: a.address, nameSeen: a.name_seen, firstSeen: a.first_seen.toISOString(), lastSeen: a.last_seen?.toISOString() ?? null, received: a.received, sent: a.sent })),
  };
}

/** The contact an address belongs to, for the link on a sender's name. */
export async function personByAddress(v: Viewer, addressInput: unknown): Promise<{ id: string } | null> {
  const address = text(addressInput, 320).toLowerCase();
  if (!address) return null;
  const res = await query<{ id: string }>('select contact_id::text as id from contact_addresses where user_id = $1 and address = $2', [v.userId, address]);
  return res.rows[0] ?? null;
}

function checkId(input: unknown): string {
  const id = String(input ?? '');
  if (!/^[0-9]{1,18}$/.test(id)) throw new HttpError(400, 'Invalid id');
  return id;
}

function fields(body: PersonInput) {
  return {
    name: body.name === undefined ? null : text(body.name, 200),
    company: body.company === undefined ? null : text(body.company, 200),
    note: body.note === undefined ? null : text(body.note, 2000),
    hidden: typeof body.hidden === 'boolean' ? body.hidden : null,
    addresses: body.addresses === undefined ? null : checkAddresses(body.addresses),
  };
}

export async function createPerson(v: Viewer, body: PersonInput): Promise<{ id: string }> {
  const f = fields(body);
  if (!f.name && !f.company && !(f.addresses?.length)) throw new HttpError(400, 'Give a name, a company or an address');
  return tx(async (client) => {
    const count = await client.query<{ n: number }>('select count(*)::int as n from contacts where user_id = $1', [v.userId]);
    if (count.rows[0].n >= MAX_PEOPLE) throw new HttpError(400, 'The address book is full');
    const res = await client.query<{ id: string }>(
      `insert into contacts (user_id, name, company, note, source, hidden) values ($1, $2, $3, $4, 'manual', $5) returning id::text as id`,
      [v.userId, f.name ?? '', f.company ?? '', f.note ?? '', f.hidden ?? false],
    );
    await setAddresses(client, v.userId, res.rows[0].id, f.addresses ?? []);
    return { id: res.rows[0].id };
  });
}

export async function updatePerson(v: Viewer, body: PersonInput & { id?: unknown }): Promise<void> {
  const id = checkId(body?.id);
  const f = fields(body);
  await tx(async (client) => {
    const res = await client.query(
      `update contacts set name = coalesce($3, name), company = coalesce($4, company), note = coalesce($5, note), hidden = coalesce($6, hidden),
              source = case when $3 is not null or $4 is not null or $5 is not null then 'manual' else source end, updated_at = now()
        where id = $1 and user_id = $2`,
      [id, v.userId, f.name, f.company, f.note, f.hidden],
    );
    if (!res.rowCount) throw new HttpError(404, 'Not found', 'not_found');
    if (f.addresses) await setAddresses(client, v.userId, id, f.addresses);
  });
}

/**
 * Makes `addresses` the contact's addresses. One that belongs to another contact of the book
 * moves over (that is how two contacts are merged); an automatically made contact left with no
 * address disappears. An address taken away from this contact is forgotten with its counts.
 */
async function setAddresses(client: Queryable, userId: number, id: string, addresses: string[]): Promise<void> {
  // (read before the move: RETURNING would show the new owner)
  const orphaned = await client.query<{ id: string }>(
    `select distinct contact_id::text as id from contact_addresses where user_id = $1 and address = any($2::text[]) and contact_id <> $3`,
    [userId, addresses, id],
  );
  await client.query(`update contact_addresses set contact_id = $3 where user_id = $1 and address = any($2::text[]) and contact_id <> $3`, [userId, addresses, id]);
  await client.query(
    `insert into contact_addresses (user_id, address, contact_id) select $1, a, $3 from unnest($2::text[]) as a on conflict (user_id, address) do nothing`,
    [userId, addresses, id],
  );
  await client.query('delete from contact_addresses where user_id = $1 and contact_id = $3 and not (address = any($2::text[]))', [userId, addresses, id]);
  const emptied = orphaned.rows.map((r) => r.id);
  if (emptied.length) {
    await client.query(
      `delete from contacts c where c.user_id = $1 and c.id = any($2::bigint[]) and c.source = 'mail'
          and not exists (select 1 from contact_addresses a where a.contact_id = c.id)`,
      [userId, emptied],
    );
  }
}

export async function deletePerson(v: Viewer, body: { id?: unknown }): Promise<void> {
  const res = await query('delete from contacts where id = $1 and user_id = $2', [checkId(body?.id), v.userId]);
  if (!res.rowCount) throw new HttpError(404, 'Not found', 'not_found');
}

/** The addresses of a contact, for the "all mail with this person" filter. Empty when it is not the viewer's. */
export async function addressesOf(v: Viewer, idInput: unknown): Promise<string[]> {
  const res = await query<{ address: string }>('select address from contact_addresses where user_id = $1 and contact_id = $2', [v.userId, checkId(idInput)]);
  return res.rows.map((r) => r.address);
}

/** Recipient suggestions from the book: name, company or address matches, people written to first. */
export async function suggest(v: Viewer, q: string, limit: number): Promise<{ name: string; address: string; sent: number }[]> {
  const res = await query<{ name: string; address: string; sent: number }>(
    `select c.name, a.address, a.sent
       from contacts c join contact_addresses a on a.contact_id = c.id
      where c.user_id = $1 and not c.hidden
        and (lower(c.name) like $2 or lower(c.company) like $2 or a.address like $2)
      order by (a.sent > 0) desc, (lower(c.name) like $3 or a.address like $3) desc, a.sent desc, a.last_seen desc nulls last
      limit $4`,
    [v.userId, `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`, `${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`, limit],
  );
  return res.rows;
}

/** Addresses of hidden people that match, so that no source suggests them. */
export async function hiddenAddresses(v: Viewer, q: string): Promise<Set<string>> {
  const res = await query<{ address: string }>(
    `select a.address from contacts c join contact_addresses a on a.contact_id = c.id
      where c.user_id = $1 and c.hidden and (a.address like $2 or lower(c.name) like $2 or lower(c.company) like $2)`,
    [v.userId, `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`],
  );
  return new Set(res.rows.map((r) => r.address));
}
