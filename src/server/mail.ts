import config from './config.js';
import { query, tx } from './db.js';
import { parseRaw, people, textOf } from './ingest.js';
import type {
  AttachmentInfo,
  Contact,
  Counts,
  DomainNode,
  Identities,
  Mailbox,
  MailboxTree,
  MailboxView,
  MessageDetail,
  MessageList,
  MessagePatch,
  MessageSummary,
  Person,
} from '../shared/api.js';

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}

/**
 * Who is asking. Every query in this file is restricted to what the viewer may see: an owner sees
 * all mail, a member only mail that involves one of their domains.
 */
export interface Viewer {
  userId: number;
  owner: boolean;
  /** null = every domain */
  domains: string[] | null;
}

/**
 * SQL condition restricting `column` (a text[] of domains) to the viewer. Appends its parameter.
 *
 * Mail addressed to a reply-<token>@ address is never a member's: it is written by a private
 * mailbox (a reply the relay did not accept, an out-of-office answering a forward) and shows that
 * mailbox's address. Only the owner sees it.
 */
function visible(v: Viewer, params: unknown[], column = 'domains'): string {
  if (v.domains === null) return 'true';
  params.push(v.domains);
  const addresses = column.replace(/domains$/, 'addresses');
  return `(${column} && $${params.length}::text[] and ${addresses}::text !~ '[{,]"?reply-[0-9a-f]{32}@')`;
}

const MAILBOXES: Mailbox[] = ['inbox', 'archive', 'trash', 'junk', 'sent'];
const ADDRESS_RE = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
const DOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

export const isAddress = (s: string) => s.length <= 254 && ADDRESS_RE.test(s);
export const isDomain = (s: string) => s.length <= 253 && DOMAIN_RE.test(s);
export const domainOf = (address: string) => address.slice(address.lastIndexOf('@') + 1);

/** Ids travel as strings (bigint in postgres). Reject anything that is not a plain positive integer. */
export function parseIds(input: unknown): string[] {
  const list = Array.isArray(input) ? input : [input];
  if (list.length === 0 || list.length > 500) throw new HttpError(400, 'ids must contain 1 to 500 entries');
  return list.map((v) => {
    const s = String(v);
    if (!/^[1-9]\d{0,17}$/.test(s)) throw new HttpError(400, 'Invalid message id');
    return s;
  });
}

// ------------------------------------------------------------------------------------------------
// Sidebar
// ------------------------------------------------------------------------------------------------

export async function mailboxTree(v: Viewer): Promise<MailboxTree> {
  const zero = (): Counts => ({ total: 0, unread: 0 });
  const tree: MailboxTree = { inbox: zero(), flagged: zero(), sent: zero(), archive: zero(), junk: zero(), trash: zero(), domains: [] };

  const p1: unknown[] = [];
  const boxes = await query<{ mailbox: Mailbox; total: number; unread: number; flagged: number; flagged_unread: number }>(
    `select mailbox, count(*)::int as total, count(*) filter (where not is_read)::int as unread,
            count(*) filter (where is_flagged)::int as flagged,
            count(*) filter (where is_flagged and not is_read)::int as flagged_unread
       from messages where ${visible(v, p1)} group by mailbox`,
    p1,
  );
  for (const row of boxes.rows) {
    tree[row.mailbox] = { total: row.total, unread: row.unread };
    if (row.mailbox !== 'trash' && row.mailbox !== 'junk') {
      tree.flagged.total += row.flagged;
      tree.flagged.unread += row.flagged_unread;
    }
  }

  const allowed = (domain: string) => v.domains === null || v.domains.includes(domain);
  const domains = new Map<string, DomainNode>();
  // Configured domains are always listed, even while empty.
  for (const d of config.mail.domains) if (allowed(d)) domains.set(d, { domain: d, total: 0, unread: 0, addresses: [] });

  const perDomain = await query<{ domain: string; total: number; unread: number }>(
    `select d as domain, count(*)::int as total, count(*) filter (where not is_read)::int as unread
       from messages, unnest(domains) as d where mailbox = 'inbox' group by d`,
  );
  for (const row of perDomain.rows) {
    if (allowed(row.domain)) domains.set(row.domain, { domain: row.domain, total: row.total, unread: row.unread, addresses: [] });
  }
  // An address is listed only while it has mail in the inbox: delete or archive the last message and it goes away.
  const perAddress = await query<{ address: string; total: number; unread: number }>(
    `select a as address, count(*)::int as total, count(*) filter (where not is_read)::int as unread
       from messages, unnest(addresses) as a where mailbox = 'inbox' group by a order by a`,
  );
  for (const row of perAddress.rows) {
    domains.get(domainOf(row.address))?.addresses.push({ address: row.address, total: row.total, unread: row.unread });
  }
  tree.domains = [...domains.values()].sort((a, b) => {
    // configured order first, then alphabetical
    const ia = config.mail.domains.indexOf(a.domain);
    const ib = config.mail.domains.indexOf(b.domain);
    if (ia !== ib) return (ia < 0 ? 1e9 : ia) - (ib < 0 ? 1e9 : ib);
    return a.domain.localeCompare(b.domain);
  });
  return tree;
}

// ------------------------------------------------------------------------------------------------
// Lists
// ------------------------------------------------------------------------------------------------

interface SummaryRow {
  id: string;
  direction: 'in' | 'out';
  mailbox: Mailbox;
  addresses: string[];
  from_name: string | null;
  from_addr: string | null;
  to_list: Person[];
  subject: string | null;
  snippet: string | null;
  received_at: Date;
  is_read: boolean;
  is_flagged: boolean;
  is_answered: boolean;
  has_attachments: boolean;
  thread_id: string;
  thread_count: number;
}

/**
 * Columns of a list row. The conversation size counts only messages the viewer may see, so it
 * cannot be used to probe for conversations on other domains. Appends its parameter.
 */
function summaryColumns(v: Viewer, params: unknown[]): string {
  return `m.id::text as id, m.direction, m.mailbox, m.addresses, m.from_name, m.from_addr, m.to_list, m.subject, m.snippet,
  m.received_at, m.is_read, m.is_flagged, m.is_answered, m.has_attachments, coalesce(m.thread_id, m.id)::text as thread_id,
  (select count(*)::int from messages t where t.thread_id = m.thread_id and t.mailbox not in ('trash', 'junk') and ${visible(v, params, 't.domains')}) as thread_count`;
}

function toSummary(row: SummaryRow, v: Viewer): MessageSummary {
  return {
    id: row.id,
    direction: row.direction,
    mailbox: row.mailbox,
    // a member is not shown addresses on domains that are not theirs
    addresses: v.domains === null ? row.addresses : row.addresses.filter((a) => v.domains!.includes(domainOf(a))),
    from: { name: row.from_name ?? '', address: row.from_addr ?? '' },
    to: row.to_list ?? [],
    subject: row.subject ?? '',
    snippet: row.snippet ?? '',
    date: row.received_at.toISOString(),
    isRead: row.is_read,
    isFlagged: row.is_flagged,
    isAnswered: row.is_answered,
    hasAttachments: row.has_attachments,
    threadId: row.thread_id,
    threadCount: Math.max(row.thread_count, 1),
  };
}

export interface ListParams {
  mailbox: MailboxView;
  domain?: string;
  address?: string;
  q?: string;
  cursor?: string;
  limit?: number;
}

const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** The WHERE conditions for a mailbox view, shared by listing and "mark all as read". */
function scopeConditions(v: Viewer, p: Pick<ListParams, 'mailbox' | 'domain' | 'address'>, params: unknown[]): string[] {
  const where: string[] = [visible(v, params, 'm.domains')];
  const add = (sql: string, value: unknown) => {
    params.push(value);
    where.push(sql.replace('?', `$${params.length}`));
  };
  if (p.mailbox === 'flagged') where.push(`m.is_flagged and m.mailbox not in ('trash', 'junk')`);
  else if (MAILBOXES.includes(p.mailbox)) add('m.mailbox = ?', p.mailbox);
  else throw new HttpError(400, 'Unknown mailbox');

  // A member cannot use the folder filters to test for addresses on domains that are not theirs.
  const mine = (domain: string) => v.domains === null || v.domains.includes(domain);
  if (p.address) {
    const address = p.address.trim().toLowerCase();
    if (!isAddress(address)) throw new HttpError(400, 'Invalid address');
    if (!mine(domainOf(address))) where.push('false');
    else add('m.addresses @> array[?]::text[]', address);
  } else if (p.domain) {
    const domain = p.domain.trim().toLowerCase();
    if (!isDomain(domain)) throw new HttpError(400, 'Invalid domain');
    if (!mine(domain)) where.push('false');
    else add('m.domains @> array[?]::text[]', domain);
  }
  return where;
}

export async function listMessages(v: Viewer, p: ListParams): Promise<MessageList> {
  const params: unknown[] = [];
  const columns = summaryColumns(v, params);
  const where = scopeConditions(v, p, params);

  const q = p.q?.trim().slice(0, 200);
  if (q) {
    params.push(`%${likeEscape(q)}%`);
    const n = `$${params.length}`;
    // Our own addresses are searchable too, but a member only matches addresses on their domains
    // (the envelope may hold addresses on other domains that the member is never shown).
    let ours = `array_to_string(m.addresses, ' ') ilike ${n}`;
    if (v.domains !== null) {
      params.push(v.domains);
      ours = `exists (select 1 from unnest(m.addresses) as a where split_part(a, '@', 2) = any ($${params.length}::text[]) and a ilike ${n})`;
    }
    where.push(`(m.subject ilike ${n} or m.from_name ilike ${n} or m.from_addr ilike ${n} or m.body_text ilike ${n} or m.to_list::text ilike ${n} or ${ours})`);
  }

  if (p.cursor) {
    // cursor = "<epoch micros>.<id>" of the last row already delivered
    const c = /^(\d{1,20})\.(\d{1,18})$/.exec(p.cursor);
    if (!c) throw new HttpError(400, 'Invalid cursor');
    params.push(c[1], c[2]);
    where.push(`(m.received_at, m.id) < (to_timestamp($${params.length - 1}::numeric / 1000000), $${params.length}::bigint)`);
  }

  const limit = Math.min(Math.max(p.limit ?? 50, 1), 200);
  params.push(limit + 1);
  const res = await query<SummaryRow & { cursor_micros: string }>(
    `select ${columns}, (extract(epoch from m.received_at) * 1000000)::bigint::text as cursor_micros
       from messages m
      where ${where.join(' and ')}
      order by m.received_at desc, m.id desc
      limit $${params.length}`,
    params,
  );
  const rows = res.rows.slice(0, limit);
  const last = rows[rows.length - 1];
  return {
    messages: rows.map((r) => toSummary(r, v)),
    nextCursor: res.rows.length > limit && last ? `${last.cursor_micros}.${last.id}` : null,
  };
}

export async function markAllRead(v: Viewer, p: Pick<ListParams, 'mailbox' | 'domain' | 'address'>): Promise<number> {
  const params: unknown[] = [];
  const where = scopeConditions(v, p, params);
  const res = await query(`update messages m set is_read = true where not m.is_read and ${where.join(' and ')}`, params);
  return res.rowCount ?? 0;
}

// ------------------------------------------------------------------------------------------------
// One message
// ------------------------------------------------------------------------------------------------

interface DetailRow extends SummaryRow {
  cc_list: Person[];
  message_id_header: string | null;
  auth: Record<string, string> | null;
  body_text: string | null;
  email_raw: Buffer | null;
}

async function loadWithRaw(v: Viewer, id: string): Promise<DetailRow> {
  const params: unknown[] = [id];
  const res = await query<DetailRow>(
    `select ${summaryColumns(v, params)}, m.cc_list, m.message_id_header, m.auth, m.body_text, r.email_raw
       from messages m join lambda_inbox r on r.message_id = m.raw_id
      where m.id = $1 and ${visible(v, params, 'm.domains')}`,
    params,
  );
  const row = res.rows[0];
  // "not found" also for a message the viewer may not see: its existence is not confirmed
  if (!row) throw new HttpError(404, 'Message not found');
  return row;
}

/** Attachments a person would recognise as such: everything that is not an inline body image. */
function attachmentList(mail: Awaited<ReturnType<typeof parseRaw>>) {
  return mail.attachments.filter((a) => !a.related);
}

/** Types a browser can display without them being able to do anything (no SVG: it can carry script). */
export const PREVIEW_TYPES = /^image\/(png|jpeg|gif|webp)$/;
/** An html part bigger than this (usually huge inline images) is not sent; the text version is. */
const MAX_HTML = 3_500_000;

export async function getMessage(v: Viewer, idInput: unknown): Promise<MessageDetail> {
  const [id] = parseIds(idInput);
  const row = await loadWithRaw(v, id);
  const summary = toSummary(row, v);
  let html: string | null = null;
  let text = row.body_text ?? '';
  let attachments: AttachmentInfo[] = [];
  let replyTo: Person[] = [];
  if (row.email_raw) {
    try {
      const mail = await parseRaw(row.email_raw);
      html = typeof mail.html === 'string' && mail.html.length <= MAX_HTML ? mail.html : null;
      text = textOf(mail) || text;
      replyTo = people(mail.replyTo);
      attachments = attachmentList(mail).map((a, index) => ({
        index,
        filename: a.filename ?? `attachment-${index + 1}`,
        contentType: a.contentType ?? 'application/octet-stream',
        size: a.size ?? a.content?.length ?? 0,
        previewable: PREVIEW_TYPES.test(a.contentType ?? '') && (a.size ?? 0) <= 4_000_000,
      }));
    } catch (err) {
      console.error(`getMessage: parse failed for ${id}: ${(err as Error).message}`);
    }
  }

  // the conversation: everything in the same thread the viewer may see, oldest first
  const tp: unknown[] = [row.thread_id];
  const thread = await query<SummaryRow>(
    `select ${summaryColumns(v, tp)} from messages m
      where m.thread_id = $1 and ${visible(v, tp, 'm.domains')} and (m.mailbox not in ('trash', 'junk') or m.id = $${tp.push(id)})
      order by m.received_at, m.id limit 200`,
    tp,
  );

  return {
    ...summary,
    cc: row.cc_list ?? [],
    replyTo,
    html,
    text,
    attachments,
    messageIdHeader: row.message_id_header,
    auth: row.auth,
    replyFrom: defaultReplyFrom(summary),
    thread: thread.rows.map((r) => toSummary(r, v)),
  };
}

/** Replies go out from the address that received the mail (or that sent it, for our own messages). */
function defaultReplyFrom(m: MessageSummary): string {
  if (m.direction === 'out') return m.from.address.toLowerCase();
  if (m.addresses.length <= 1) return m.addresses[0] ?? config.mail.defaultFrom ?? '';
  // Several of our addresses got it: prefer one that is visible in the To header.
  const shown = new Set(m.to.map((p) => p.address.toLowerCase()));
  return m.addresses.find((a) => shown.has(a)) ?? m.addresses[0];
}

export interface Download {
  filename: string;
  contentType: string;
  content: Buffer;
}

export async function getAttachment(v: Viewer, idInput: unknown, indexInput: unknown): Promise<Download> {
  const [id] = parseIds(idInput);
  const index = Number(indexInput);
  if (!Number.isInteger(index) || index < 0 || index > 1000) throw new HttpError(400, 'Invalid attachment index');
  const row = await loadWithRaw(v, id);
  if (!row.email_raw) throw new HttpError(404, 'Message has no stored source');
  const mail = await parseRaw(row.email_raw);
  const att = attachmentList(mail)[index];
  if (!att) throw new HttpError(404, 'Attachment not found');
  return { filename: att.filename ?? `attachment-${index + 1}`, contentType: att.contentType ?? 'application/octet-stream', content: att.content };
}

export async function getRaw(v: Viewer, idInput: unknown): Promise<Download> {
  const [id] = parseIds(idInput);
  const row = await loadWithRaw(v, id);
  if (!row.email_raw) throw new HttpError(404, 'Message has no stored source');
  return { filename: `message-${id}.eml`, contentType: 'message/rfc822', content: row.email_raw };
}

/** Threading headers of a message being replied to. */
export async function threadingFor(v: Viewer, idInput: unknown): Promise<{ rawId: string; messageId: string | null; refs: string[]; raw: Buffer | null }> {
  const [id] = parseIds(idInput);
  const params: unknown[] = [id];
  const res = await query<{ raw_id: string; message_id_header: string | null; refs: string[]; email_raw: Buffer | null }>(
    `select m.raw_id, m.message_id_header, m.refs, r.email_raw from messages m join lambda_inbox r on r.message_id = m.raw_id
      where m.id = $1 and ${visible(v, params, 'm.domains')}`,
    params,
  );
  const row = res.rows[0];
  if (!row) throw new HttpError(404, 'Message being replied to was not found');
  return { rawId: row.raw_id, messageId: row.message_id_header, refs: row.refs ?? [], raw: row.email_raw };
}

// ------------------------------------------------------------------------------------------------
// Changes
// ------------------------------------------------------------------------------------------------

export async function patchMessages(v: Viewer, patch: MessagePatch): Promise<number> {
  const ids = parseIds(patch?.ids);
  const set = patch?.set ?? {};
  let changed = 0;
  await tx(async (client) => {
    const base: unknown[] = [ids];
    const mine = `id = any($1::bigint[]) and ${visible(v, base)}`;
    const run = async (sql: string, extra: unknown[] = []) => (await client.query(sql, [...base, ...extra])).rowCount ?? 0;
    const n = base.length;
    if (typeof set.isRead === 'boolean') changed += await run(`update messages set is_read = $${n + 1} where ${mine}`, [set.isRead]);
    if (typeof set.isFlagged === 'boolean') changed += await run(`update messages set is_flagged = $${n + 1} where ${mine}`, [set.isFlagged]);
    if (set.mailbox !== undefined) {
      switch (set.mailbox) {
        case 'restore':
          changed += await run(
            `update messages
                set mailbox = coalesce(prev_mailbox, case when direction = 'out' then 'sent' else 'inbox' end),
                    prev_mailbox = null, trashed_at = null
              where ${mine} and mailbox in ('trash', 'junk')`,
          );
          break;
        case 'trash':
        case 'junk':
          changed += await run(
            `update messages
                set prev_mailbox = case when mailbox in ('trash', 'junk') then prev_mailbox else mailbox end,
                    mailbox = $${n + 1}, trashed_at = now()
              where ${mine} and mailbox <> $${n + 1}`,
            [set.mailbox],
          );
          break;
        case 'inbox':
        case 'archive':
          // Only received mail lives in inbox/archive; our own sent mail stays in Sent.
          changed += await run(
            `update messages set mailbox = $${n + 1}, prev_mailbox = null, trashed_at = null
              where ${mine} and direction = 'in' and mailbox <> $${n + 1}`,
            [set.mailbox],
          );
          break;
        default:
          throw new HttpError(400, 'Unknown mailbox');
      }
    }
  });
  return changed;
}

export interface Deleted {
  deleted: number;
  s3Keys: string[];
}
const deleted = (res: { rowCount: number | null; rows: { s3_key: string | null }[] }): Deleted => ({
  deleted: res.rowCount ?? 0,
  s3Keys: res.rows.map((r) => r.s3_key).filter((k): k is string => !!k),
});

/** Permanent delete. Only possible from Trash or Junk, so it always takes two deliberate steps. */
export async function deleteForever(v: Viewer, idsInput: unknown): Promise<Deleted> {
  const params: unknown[] = [parseIds(idsInput)];
  return deleted(
    await query<{ s3_key: string | null }>(
      `delete from lambda_inbox r using messages m
        where m.raw_id = r.message_id and m.id = any($1::bigint[]) and m.mailbox in ('trash', 'junk') and ${visible(v, params, 'm.domains')}
        returning r.s3_key`,
      params,
    ),
  );
}

export async function emptyMailbox(v: Viewer, mailbox: unknown): Promise<Deleted> {
  if (mailbox !== 'trash' && mailbox !== 'junk') throw new HttpError(400, 'Only trash and junk can be emptied');
  const params: unknown[] = [mailbox];
  return deleted(
    await query<{ s3_key: string | null }>(
      `delete from lambda_inbox r using messages m where m.raw_id = r.message_id and m.mailbox = $1 and ${visible(v, params, 'm.domains')} returning r.s3_key`,
      params,
    ),
  );
}

/**
 * Retention: messages that have sat in Trash or Junk longer than mail_settings.purge_after_days
 * are deleted for good. Runs at most once a day, piggybacked on normal use.
 */
export async function purgeExpired(): Promise<Deleted> {
  const due = await query(
    `update mail_settings set last_purge_at = now() where last_purge_at is null or last_purge_at < now() - interval '1 day' returning purge_after_days`,
  );
  if (!due.rowCount) return { deleted: 0, s3Keys: [] };
  return deleted(
    await query<{ s3_key: string | null }>(
      `delete from lambda_inbox r using messages m, mail_settings s
        where m.raw_id = r.message_id and m.mailbox in ('trash', 'junk') and s.purge_after_days > 0
          and coalesce(m.trashed_at, m.received_at) < now() - make_interval(days => s.purge_after_days)
        returning r.s3_key`,
    ),
  );
}

// ------------------------------------------------------------------------------------------------
// Identities and contacts
// ------------------------------------------------------------------------------------------------

export async function identities(v: Viewer): Promise<Identities> {
  const p: unknown[] = [];
  const res = await query<{ address: string }>(
    `select a as address from messages, unnest(addresses) as a
      where mailbox not in ('junk', 'trash') and ${visible(v, p)}
      group by a order by max(received_at) desc limit 500`,
    p,
  );
  const seenDomains = await query<{ domain: string }>(`select distinct d as domain from messages, unnest(domains) as d where direction = 'in' and mailbox <> 'junk'`);
  // In production only configured domains may send. In development, domains seen in mail are allowed too.
  const all = config.mail.domains.length ? config.mail.domains : seenDomains.rows.map((r) => r.domain);
  const domains = v.domains === null ? all : all.filter((d) => v.domains!.includes(d));
  const addresses = res.rows.map((r) => r.address).filter((a) => domains.includes(domainOf(a)));
  const preferred = config.mail.defaultFrom && domains.includes(domainOf(config.mail.defaultFrom)) ? config.mail.defaultFrom : null;
  return { domains, addresses, defaultFrom: preferred ?? addresses[0] ?? null };
}

/**
 * People the viewer has corresponded with, for recipient autocomplete. Anyone can send mail, and
 * a sender chooses their own display name, so two things keep a stranger from planting a
 * convincing suggestion: people you have WRITTEN TO always come first, and a display name that
 * looks like an email address is not shown.
 */
export async function contacts(v: Viewer, qInput: unknown): Promise<Contact[]> {
  const q = String(qInput ?? '').trim().toLowerCase().slice(0, 100);
  if (q.length < 1) return [];
  const params: unknown[] = [`%${likeEscape(q)}%`, `${likeEscape(q)}%`];
  const scope = visible(v, params);
  const res = await query<{ name: string | null; address: string }>(
    `with people as (
       select lower(from_addr) as address, from_name as name, received_at, false as written_to
         from messages where direction = 'in' and mailbox not in ('junk', 'trash') and from_addr <> '' and ${scope}
       union all
       select lower(t ->> 'address'), t ->> 'name', received_at, true
         from messages, jsonb_array_elements(to_list || cc_list) as t where direction = 'out' and ${scope}
     )
     select address, (array_agg(name order by written_to desc, received_at desc) filter (where name <> '' and name not like '%@%'))[1] as name
       from people
      where address like $1 or (lower(name) like $1 and name not like '%@%')
      group by address
      order by bool_or(written_to) desc, bool_or(address like $2 or lower(name) like $2) desc, count(*) filter (where written_to) desc, max(received_at) desc
      limit 8`,
    params,
  );
  return res.rows.filter((r) => isAddress(r.address)).map((r) => ({ name: r.name ?? '', address: r.address }));
}
