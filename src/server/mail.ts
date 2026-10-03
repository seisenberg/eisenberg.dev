import config from './config.js';
import { query, tx } from './db.js';
import { parseRaw, people, textOf } from './ingest.js';
import type {
  AttachmentInfo,
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

const MAILBOXES: Mailbox[] = ['inbox', 'archive', 'trash', 'junk', 'sent'];
const ADDRESS_RE = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
const DOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

export const isAddress = (s: string) => s.length <= 254 && ADDRESS_RE.test(s);

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

export async function mailboxTree(): Promise<MailboxTree> {
  const zero = (): Counts => ({ total: 0, unread: 0 });
  const tree: MailboxTree = { inbox: zero(), flagged: zero(), sent: zero(), archive: zero(), junk: zero(), trash: zero(), domains: [] };

  const boxes = await query<{ mailbox: Mailbox; total: number; unread: number; flagged: number; flagged_unread: number }>(
    `select mailbox, count(*)::int as total, count(*) filter (where not is_read)::int as unread,
            count(*) filter (where is_flagged)::int as flagged,
            count(*) filter (where is_flagged and not is_read)::int as flagged_unread
       from messages group by mailbox`,
  );
  for (const row of boxes.rows) {
    tree[row.mailbox] = { total: row.total, unread: row.unread };
    if (row.mailbox !== 'trash' && row.mailbox !== 'junk') {
      tree.flagged.total += row.flagged;
      tree.flagged.unread += row.flagged_unread;
    }
  }

  const domains = new Map<string, DomainNode>();
  // Configured domains are always listed, even while empty.
  for (const d of config.mail.domains) domains.set(d, { domain: d, total: 0, unread: 0, addresses: [] });

  const perDomain = await query<{ domain: string; total: number; unread: number }>(
    `select d as domain, count(*)::int as total, count(*) filter (where not is_read)::int as unread
       from messages, unnest(domains) as d where mailbox = 'inbox' group by d`,
  );
  for (const row of perDomain.rows) {
    domains.set(row.domain, { domain: row.domain, total: row.total, unread: row.unread, addresses: [] });
  }
  // An address is listed only while it has mail in the inbox: delete or archive the last message and it goes away.
  const perAddress = await query<{ address: string; total: number; unread: number }>(
    `select a as address, count(*)::int as total, count(*) filter (where not is_read)::int as unread
       from messages, unnest(addresses) as a where mailbox = 'inbox' group by a order by a`,
  );
  for (const row of perAddress.rows) {
    const domain = row.address.slice(row.address.lastIndexOf('@') + 1);
    domains.get(domain)?.addresses.push({ address: row.address, total: row.total, unread: row.unread });
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
}

const SUMMARY_COLUMNS = `id::text as id, direction, mailbox, addresses, from_name, from_addr, to_list, subject, snippet,
  received_at, is_read, is_flagged, is_answered, has_attachments`;

function toSummary(row: SummaryRow): MessageSummary {
  return {
    id: row.id,
    direction: row.direction,
    mailbox: row.mailbox,
    addresses: row.addresses,
    from: { name: row.from_name ?? '', address: row.from_addr ?? '' },
    to: row.to_list ?? [],
    subject: row.subject ?? '',
    snippet: row.snippet ?? '',
    date: row.received_at.toISOString(),
    isRead: row.is_read,
    isFlagged: row.is_flagged,
    isAnswered: row.is_answered,
    hasAttachments: row.has_attachments,
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

export async function listMessages(p: ListParams): Promise<MessageList> {
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, value: unknown) => {
    params.push(value);
    where.push(sql.replace('?', `$${params.length}`));
  };

  if (p.mailbox === 'flagged') where.push(`is_flagged and mailbox not in ('trash', 'junk')`);
  else if (MAILBOXES.includes(p.mailbox)) add('mailbox = ?', p.mailbox);
  else throw new HttpError(400, 'Unknown mailbox');

  if (p.address) {
    const address = p.address.trim().toLowerCase();
    if (!isAddress(address)) throw new HttpError(400, 'Invalid address');
    add('addresses @> array[?]::text[]', address);
  } else if (p.domain) {
    const domain = p.domain.trim().toLowerCase();
    if (!DOMAIN_RE.test(domain)) throw new HttpError(400, 'Invalid domain');
    add('domains @> array[?]::text[]', domain);
  }

  const q = p.q?.trim().slice(0, 200);
  if (q) {
    params.push(`%${likeEscape(q)}%`);
    const n = `$${params.length}`;
    where.push(`(subject ilike ${n} or from_name ilike ${n} or from_addr ilike ${n} or body_text ilike ${n} or to_list::text ilike ${n} or array_to_string(addresses, ' ') ilike ${n})`);
  }

  if (p.cursor) {
    // cursor = "<epoch micros>.<id>" of the last row already delivered
    const m = /^(\d{1,20})\.(\d{1,18})$/.exec(p.cursor);
    if (!m) throw new HttpError(400, 'Invalid cursor');
    params.push(m[1], m[2]);
    where.push(`(received_at, id) < (to_timestamp($${params.length - 1}::numeric / 1000000), $${params.length}::bigint)`);
  }

  const limit = Math.min(Math.max(p.limit ?? 50, 1), 200);
  params.push(limit + 1);
  const res = await query<SummaryRow & { cursor_micros: string }>(
    `select ${SUMMARY_COLUMNS}, (extract(epoch from received_at) * 1000000)::bigint::text as cursor_micros
       from messages
      where ${where.join(' and ')}
      order by received_at desc, id desc
      limit $${params.length}`,
    params,
  );
  const rows = res.rows.slice(0, limit);
  const last = rows[rows.length - 1];
  return {
    messages: rows.map(toSummary),
    nextCursor: res.rows.length > limit && last ? `${last.cursor_micros}.${last.id}` : null,
  };
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

async function loadWithRaw(id: string): Promise<DetailRow> {
  const res = await query<DetailRow>(
    `select ${SUMMARY_COLUMNS.replace(/\bid::text as id\b/, 'm.id::text as id')}, cc_list, message_id_header, auth, body_text, r.email_raw
       from messages m join lambda_inbox r on r.message_id = m.raw_id
      where m.id = $1`,
    [id],
  );
  const row = res.rows[0];
  if (!row) throw new HttpError(404, 'Message not found');
  return row;
}

/** Attachments a person would recognise as such: everything that is not an inline body image. */
function attachmentList(mail: Awaited<ReturnType<typeof parseRaw>>) {
  return mail.attachments.filter((a) => !a.related);
}

export async function getMessage(idInput: unknown): Promise<MessageDetail> {
  const [id] = parseIds(idInput);
  const row = await loadWithRaw(id);
  const summary = toSummary(row);
  let html: string | null = null;
  let text = row.body_text ?? '';
  let attachments: AttachmentInfo[] = [];
  let replyTo: Person[] = [];
  if (row.email_raw) {
    try {
      const mail = await parseRaw(row.email_raw);
      html = typeof mail.html === 'string' ? mail.html : null;
      text = textOf(mail) || text;
      replyTo = people(mail.replyTo);
      attachments = attachmentList(mail).map((a, index) => ({
        index,
        filename: a.filename ?? `attachment-${index + 1}`,
        contentType: a.contentType ?? 'application/octet-stream',
        size: a.size ?? a.content?.length ?? 0,
      }));
    } catch (err) {
      console.error(`getMessage: parse failed for ${id}: ${(err as Error).message}`);
    }
  }
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
  };
}

/** Replies go out from the address that received the mail (or that sent it, for our own messages). */
function defaultReplyFrom(m: MessageSummary): string {
  if (m.direction === 'out') return m.from.address.toLowerCase();
  if (m.addresses.length <= 1) return m.addresses[0] ?? config.mail.defaultFrom ?? '';
  // Several of our addresses got it: prefer one that is visible in the To header.
  const visible = new Set(m.to.map((p) => p.address.toLowerCase()));
  return m.addresses.find((a) => visible.has(a)) ?? m.addresses[0];
}

export interface Download {
  filename: string;
  contentType: string;
  content: Buffer;
}

export async function getAttachment(idInput: unknown, indexInput: unknown): Promise<Download> {
  const [id] = parseIds(idInput);
  const index = Number(indexInput);
  if (!Number.isInteger(index) || index < 0 || index > 1000) throw new HttpError(400, 'Invalid attachment index');
  const row = await loadWithRaw(id);
  if (!row.email_raw) throw new HttpError(404, 'Message has no stored source');
  const mail = await parseRaw(row.email_raw);
  const att = attachmentList(mail)[index];
  if (!att) throw new HttpError(404, 'Attachment not found');
  return { filename: att.filename ?? `attachment-${index + 1}`, contentType: att.contentType ?? 'application/octet-stream', content: att.content };
}

export async function getRaw(idInput: unknown): Promise<Download> {
  const [id] = parseIds(idInput);
  const row = await loadWithRaw(id);
  if (!row.email_raw) throw new HttpError(404, 'Message has no stored source');
  return { filename: `message-${id}.eml`, contentType: 'message/rfc822', content: row.email_raw };
}

/** Threading headers of a message being replied to. */
export async function threadingFor(idInput: unknown): Promise<{ rawId: string; messageId: string | null; refs: string[]; raw: Buffer | null }> {
  const [id] = parseIds(idInput);
  const res = await query<{ raw_id: string; message_id_header: string | null; refs: string[]; email_raw: Buffer | null }>(
    `select m.raw_id, m.message_id_header, m.refs, r.email_raw from messages m join lambda_inbox r on r.message_id = m.raw_id where m.id = $1`,
    [id],
  );
  const row = res.rows[0];
  if (!row) throw new HttpError(404, 'Message being replied to was not found');
  return { rawId: row.raw_id, messageId: row.message_id_header, refs: row.refs ?? [], raw: row.email_raw };
}

// ------------------------------------------------------------------------------------------------
// Changes
// ------------------------------------------------------------------------------------------------

export async function patchMessages(patch: MessagePatch): Promise<number> {
  const ids = parseIds(patch?.ids);
  const set = patch?.set ?? {};
  let changed = 0;
  await tx(async (client) => {
    if (typeof set.isRead === 'boolean') {
      changed += (await client.query('update messages set is_read = $2 where id = any($1::bigint[])', [ids, set.isRead])).rowCount ?? 0;
    }
    if (typeof set.isFlagged === 'boolean') {
      changed += (await client.query('update messages set is_flagged = $2 where id = any($1::bigint[])', [ids, set.isFlagged])).rowCount ?? 0;
    }
    if (set.mailbox !== undefined) {
      let res;
      switch (set.mailbox) {
        case 'restore':
          res = await client.query(
            `update messages
                set mailbox = coalesce(prev_mailbox, case when direction = 'out' then 'sent' else 'inbox' end),
                    prev_mailbox = null, trashed_at = null
              where id = any($1::bigint[]) and mailbox in ('trash', 'junk')`,
            [ids],
          );
          break;
        case 'trash':
        case 'junk':
          res = await client.query(
            `update messages
                set prev_mailbox = case when mailbox in ('trash', 'junk') then prev_mailbox else mailbox end,
                    mailbox = $2, trashed_at = now()
              where id = any($1::bigint[]) and mailbox <> $2`,
            [ids, set.mailbox],
          );
          break;
        case 'inbox':
        case 'archive':
          // Only received mail lives in inbox/archive; our own sent mail stays in Sent.
          res = await client.query(
            `update messages set mailbox = $2, prev_mailbox = null, trashed_at = null
              where id = any($1::bigint[]) and direction = 'in' and mailbox <> $2`,
            [ids, set.mailbox],
          );
          break;
        default:
          throw new HttpError(400, 'Unknown mailbox');
      }
      changed += res.rowCount ?? 0;
    }
  });
  return changed;
}

/** Permanent delete. Only possible from Trash or Junk, so it always takes two deliberate steps. */
export async function deleteForever(idsInput: unknown): Promise<{ deleted: number; s3Keys: string[] }> {
  const ids = parseIds(idsInput);
  const res = await query<{ s3_key: string | null }>(
    `delete from lambda_inbox r using messages m
      where m.raw_id = r.message_id and m.id = any($1::bigint[]) and m.mailbox in ('trash', 'junk')
      returning r.s3_key`,
    [ids],
  );
  return { deleted: res.rowCount ?? 0, s3Keys: res.rows.map((r) => r.s3_key).filter((k): k is string => !!k) };
}

export async function emptyMailbox(mailbox: unknown): Promise<{ deleted: number; s3Keys: string[] }> {
  if (mailbox !== 'trash' && mailbox !== 'junk') throw new HttpError(400, 'Only trash and junk can be emptied');
  const res = await query<{ s3_key: string | null }>(
    `delete from lambda_inbox r using messages m where m.raw_id = r.message_id and m.mailbox = $1 returning r.s3_key`,
    [mailbox],
  );
  return { deleted: res.rowCount ?? 0, s3Keys: res.rows.map((r) => r.s3_key).filter((k): k is string => !!k) };
}

// ------------------------------------------------------------------------------------------------
// Identities for the From picker
// ------------------------------------------------------------------------------------------------

export async function identities(): Promise<Identities> {
  const res = await query<{ address: string }>(
    `select a as address from messages, unnest(addresses) as a
      where mailbox not in ('junk', 'trash')
      group by a order by max(received_at) desc limit 500`,
  );
  const seenDomains = await query<{ domain: string }>(`select distinct d as domain from messages, unnest(domains) as d where direction = 'in' and mailbox <> 'junk'`);
  // In production only configured domains may send. In development, domains seen in mail are allowed too.
  const domains = config.mail.domains.length ? config.mail.domains : seenDomains.rows.map((r) => r.domain);
  const addresses = res.rows.map((r) => r.address).filter((a) => domains.includes(a.slice(a.lastIndexOf('@') + 1)));
  return { domains, addresses, defaultFrom: config.mail.defaultFrom ?? addresses[0] ?? null };
}
