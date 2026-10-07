import { simpleParser, type AddressObject, type ParsedMail } from 'mailparser';
import config from './config.js';
import { tx, type Queryable } from './db.js';
import { recordFromMessage } from './people.js';
import type { Person } from '../shared/api.js';

// Turns raw rows in lambda_inbox (written by the python SES lambda, or by send.ts) into rows of the
// "messages" index the webmail reads. Runs lazily from the API, so historical mail is back-filled
// automatically the first time the webmail is opened.

export interface RawRow {
  message_id: string;
  created_at: Date;
  kind: 'inbound' | 'junk' | 'relay_out' | 'sent';
  event: any;
  meta: any;
  email_raw: Buffer | null;
}

const BODY_TEXT_CAP = 100_000;

export function people(field: AddressObject | AddressObject[] | undefined): Person[] {
  if (!field) return [];
  const out: Person[] = [];
  for (const obj of Array.isArray(field) ? field : [field]) {
    const walk = (list: AddressObject['value']) => {
      for (const a of list ?? []) {
        if (a.group) walk(a.group);
        else if (a.address) out.push({ name: (a.name ?? '').trim(), address: a.address.trim() });
      }
    };
    walk(obj.value);
  }
  return out;
}

const lower = (s: string) => s.trim().toLowerCase();
const domainOf = (address: string) => address.slice(address.lastIndexOf('@') + 1);
const uniq = <T>(xs: T[]) => [...new Set(xs)];

/**
 * Every string that goes to postgres passes through here. Postgres text/jsonb cannot hold NUL or
 * unpaired UTF-16 surrogates, and a sender controls all of these strings: one such character must
 * not be able to make an insert fail.
 */
export function clean(s: string | undefined | null, max = 100_000): string {
  return (s ?? '').slice(0, max).toWellFormed().replace(/\u0000/g, '');
}
const cleanPeople = (list: Person[]): Person[] => list.slice(0, 200).map((p) => ({ name: clean(p.name, 300), address: clean(p.address, 320) }));

function snippetOf(text: string): string {
  return text.slice(0, 4000).replace(/\s+/g, ' ').trim().slice(0, 220);
}

const HTML_TEXT_INPUT_CAP = 300_000;
const ENTITIES: Record<string, string> = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" };

/**
 * Plain text from an HTML body for snippets, search and reply quoting. Deliberately simple and
 * bounded: mailparser's own html-to-text is super-linear on deeply nested markup (a 2 MB message of
 * nested divs takes most of a minute), which a sender could use to stall the lambda.
 */
export function htmlToText(html: string): string {
  let h = html.slice(0, HTML_TEXT_INPUT_CAP);
  for (const tag of ['style', 'script', 'head', 'title']) {
    // indexOf based, so linear even when a closing tag is missing
    for (let from = 0; ; ) {
      const lowerH = h.toLowerCase();
      const start = lowerH.indexOf(`<${tag}`, from);
      if (start < 0) break;
      const end = lowerH.indexOf(`</${tag}`, start);
      const close = end < 0 ? h.length : (h.indexOf('>', end) + 1 || h.length);
      h = h.slice(0, start) + ' ' + h.slice(close);
      from = start;
    }
  }
  h = h.replace(/<(?:br|\/p|\/div|\/tr|\/li|\/h[1-6]|\/blockquote)\b[^>]*>/gi, '\n');
  // Tags are removed until none is left: one pass would turn "<scr<b>ipt>" into "<script>". The
  // text only ever becomes a snippet, search text or a quote, never markup, but it should not
  // carry tag-shaped fragments either. The input is capped, so this ends quickly.
  for (let previous = ''; previous !== h; ) {
    previous = h;
    h = h.replace(/<[^>]*>/g, '');
  }
  return h
    .replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,6});/gi, (m, e: string) => {
      const key = e.toLowerCase();
      if (key in ENTITIES) return ENTITIES[key];
      if (key.startsWith('#x')) return codePoint(Number.parseInt(key.slice(2), 16));
      if (key.startsWith('#')) return codePoint(Number.parseInt(key.slice(1), 10));
      return m;
    })
    .replace(/[ \t\f\v\u00a0]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function codePoint(n: number): string {
  return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : '';
}

/** The text of a parsed message: its text part, or a bounded conversion of its html part. */
export function textOf(mail: ParsedMail | null): string {
  if (!mail) return '';
  if (typeof mail.text === 'string' && mail.text.trim()) return mail.text;
  return typeof mail.html === 'string' ? htmlToText(mail.html) : '';
}

function ourAddresses(row: RawRow, mail: ParsedMail | null): string[] {
  return ourAddressesRaw(row, mail).map((a) => clean(a, 320)).filter(Boolean).slice(0, 100);
}

function ourAddressesRaw(row: RawRow, mail: ParsedMail | null): string[] {
  if (row.kind === 'relay_out' || row.kind === 'sent') {
    const from = row.meta?.from ?? people(mail?.from)[0]?.address;
    return typeof from === 'string' && from ? [lower(from)] : [];
  }
  const recipients: unknown = row.event?.receipt?.recipients;
  if (Array.isArray(recipients) && recipients.length) {
    return uniq(recipients.filter((r): r is string => typeof r === 'string' && r.includes('@')).map(lower));
  }
  // No SES envelope (should not happen): fall back to header recipients on our domains.
  const header = [...people(mail?.to), ...people(mail?.cc)].map((p) => lower(p.address));
  const ours = header.filter((a) => config.mail.domains.includes(domainOf(a)));
  return uniq(ours.length ? ours : header.slice(0, 1));
}

function verdicts(row: RawRow): Record<string, string> | null {
  const r = row.event?.receipt;
  if (!r) return null;
  const out: Record<string, string> = {};
  for (const [key, name] of [['spfVerdict', 'spf'], ['dkimVerdict', 'dkim'], ['dmarcVerdict', 'dmarc'], ['spamVerdict', 'spam'], ['virusVerdict', 'virus']] as const) {
    const status = r[key]?.status;
    if (typeof status === 'string') out[name] = status;
  }
  return out;
}

/** skipHtmlToText: see htmlToText above. Callers use textOf() for the text. */
export async function parseRaw(raw: Buffer): Promise<ParsedMail> {
  return simpleParser(raw, { skipTextToHtml: true, skipHtmlToText: true });
}

export interface FilterRow {
  match_from: string;
  match_subject: string;
  match_address: string;
  action: 'archive' | 'read' | 'flag' | 'junk' | 'trash';
}

export async function loadFilters(db: Queryable): Promise<FilterRow[]> {
  const res = await db.query<FilterRow>('select match_from, match_subject, match_address, action from mail_filters where enabled order by position, id');
  return res.rows;
}

/** Every non-empty condition must be contained in its field. A filter with no condition matches nothing. */
function filterMatches(f: FilterRow, m: { from: string; subject: string; addresses: string[] }): boolean {
  const from = f.match_from.trim().toLowerCase();
  const subject = f.match_subject.trim().toLowerCase();
  const address = f.match_address.trim().toLowerCase();
  if (!from && !subject && !address) return false;
  return (!from || m.from.includes(from)) && (!subject || m.subject.includes(subject)) && (!address || m.addresses.some((a) => a.includes(address)));
}

/** Index one raw row. The caller marks it processed. */
export async function indexRow(db: Queryable, row: RawRow, filters: FilterRow[] = []): Promise<void> {
  let mail: ParsedMail | null = null;
  try {
    if (row.email_raw) mail = await simpleParser(row.email_raw, { skipTextToHtml: true, skipHtmlToText: true, skipImageLinks: true });
  } catch (err) {
    console.error(`ingest: could not parse ${row.message_id}: ${(err as Error).message}`);
  }

  const outbound = row.kind === 'relay_out' || row.kind === 'sent';
  const addresses = ourAddresses(row, mail);
  const from = people(mail?.from)[0] ?? { name: '', address: '' };
  const text = clean(textOf(mail), BODY_TEXT_CAP);
  const received = row.event?.mail?.timestamp ? new Date(row.event.mail.timestamp) : row.created_at;
  const refs = mail?.references ? (Array.isArray(mail.references) ? mail.references : [mail.references]) : [];
  const realAttachments = (mail?.attachments ?? []).filter((a) => !a.related);

  await db.query(
    `insert into messages
       (raw_id, direction, mailbox, addresses, domains, from_name, from_addr, to_list, cc_list, reply_to,
        subject, snippet, body_text, sent_at, received_at, message_id_header, in_reply_to, refs,
        has_attachments, size_bytes, is_read, auth)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
     on conflict (raw_id) do nothing`,
    [
      row.message_id,
      outbound ? 'out' : 'in',
      outbound ? 'sent' : row.kind === 'junk' ? 'junk' : 'inbox',
      addresses,
      uniq(addresses.map(domainOf)),
      clean(from.name, 300),
      clean(from.address, 320),
      JSON.stringify(cleanPeople(people(mail?.to))),
      JSON.stringify(cleanPeople(people(mail?.cc))),
      clean(people(mail?.replyTo)[0]?.address, 320) || null,
      clean(mail?.subject, 1000) || (mail ? '' : '(unreadable message)'),
      snippetOf(text),
      text,
      mail?.date && !Number.isNaN(mail.date.getTime()) ? mail.date : null,
      Number.isNaN(received.getTime()) ? row.created_at : received,
      clean(mail?.messageId, 1000) || null,
      clean(mail?.inReplyTo, 1000) || null,
      refs.slice(-50).map((r) => clean(r, 1000)),
      realAttachments.length > 0,
      row.email_raw?.length ?? 0,
      outbound,
      // SES verdicts describe received mail only. (A relayed reply's event is the owner's own
      // inbound notification: nothing from it is exposed.)
      JSON.stringify(outbound ? null : verdicts(row)),
    ],
  );
  await recordFromMessage(db, {
    direction: outbound ? 'out' : 'in',
    mailbox: outbound ? 'sent' : row.kind === 'junk' ? 'junk' : 'inbox',
    domains: uniq(addresses.map(domainOf)),
    from: { name: clean(from.name, 300), address: clean(from.address, 320) },
    to: cleanPeople(people(mail?.to)),
    cc: cleanPeople(people(mail?.cc)),
    at: Number.isNaN(received.getTime()) ? row.created_at : received,
  });

  // Conversation: join the thread of the message this one answers, else start a new one.
  await db.query(
    `update messages m
        set thread_id = coalesce(
              (select min(p.thread_id) from messages p
                where p.id <> m.id and p.message_id_header is not null
                  and (p.message_id_header = m.in_reply_to or p.message_id_header = any (m.refs))),
              m.id)
      where m.raw_id = $1 and m.thread_id is null`,
    [row.message_id],
  );

  // Filters apply to ordinary received mail only.
  if (row.kind === 'inbound') {
    const subject = clean(mail?.subject, 1000).toLowerCase();
    const sender = `${clean(from.name, 300)} ${clean(from.address, 320)}`.toLowerCase();
    for (const f of filters) {
      if (!filterMatches(f, { from: sender, subject, addresses })) continue;
      const sql = {
        read: 'is_read = true',
        flag: 'is_flagged = true',
        archive: `mailbox = 'archive'`,
        junk: `prev_mailbox = 'inbox', mailbox = 'junk', trashed_at = now()`,
        trash: `prev_mailbox = 'inbox', mailbox = 'trash', trashed_at = now()`,
      }[f.action];
      await db.query(`update messages set ${sql} where raw_id = $1`, [row.message_id]);
    }
  }

  const repliedTo = row.meta?.in_reply_to_raw_id;
  if (outbound && typeof repliedTo === 'string') {
    await db.query('update messages set is_answered = true where raw_id = $1', [repliedTo]);
  }
}

/** Last resort for a row that cannot be indexed normally: file it so it is visible and never retried forever. */
async function indexPlaceholder(db: Queryable, row: RawRow): Promise<void> {
  const outbound = row.kind === 'relay_out' || row.kind === 'sent';
  await db.query(
    `with new as (
       insert into messages (raw_id, direction, mailbox, subject, snippet, received_at, size_bytes, is_read)
       values ($1, $2, $3, $4, $5, $6, $7, $8) on conflict (raw_id) do nothing returning id
     )
     update messages m set thread_id = m.id from new where m.id = new.id`,
    [
      row.message_id,
      outbound ? 'out' : 'in',
      outbound ? 'sent' : row.kind === 'junk' ? 'junk' : 'inbox',
      '(message could not be indexed)',
      'This message could not be processed. Use "View source" to download the original.',
      row.created_at,
      row.email_raw?.length ?? 0,
      outbound,
    ],
  );
}

let lastRun = 0;
let running: Promise<number> | null = null;
const BATCH = 10;

/**
 * Index everything pending, in small batches, for at most `budgetMs` (the rest is picked up by the
 * next call). Each row is indexed inside its own savepoint: a message that cannot be indexed gets
 * a placeholder and is marked processed, so it can never block the mail behind it.
 */
export async function ingestPending(opts: { force?: boolean; minIntervalMs?: number; budgetMs?: number } = {}): Promise<number> {
  if (running) return running;
  if (!opts.force && Date.now() - lastRun < (opts.minIntervalMs ?? 5_000)) return 0;
  const deadline = Date.now() + (opts.budgetMs ?? 8_000);
  running = (async () => {
    let total = 0;
    for (;;) {
      const n = await tx(async (client) => {
        const res = await client.query<RawRow>(
          `select message_id, created_at, kind, event, meta, email_raw
             from lambda_inbox
            where processed_at is null
            order by created_at
            limit ${BATCH}
            for update skip locked`,
        );
        const filters = res.rows.length ? await loadFilters(client) : [];
        for (const row of res.rows) {
          await client.query('savepoint one_message');
          try {
            await indexRow(client, row, filters);
          } catch (err) {
            console.error(`ingest: ${row.message_id} failed, filing a placeholder: ${(err as Error).message}`);
            await client.query('rollback to savepoint one_message');
            await indexPlaceholder(client, row);
          }
          await client.query('release savepoint one_message');
          await client.query('update lambda_inbox set processed_at = current_timestamp where message_id = $1', [row.message_id]);
        }
        return res.rows.length;
      });
      total += n;
      if (n < BATCH || (!opts.force && Date.now() > deadline)) break;
    }
    return total;
  })().finally(() => {
    lastRun = Date.now();
    running = null;
  });
  return running;
}
