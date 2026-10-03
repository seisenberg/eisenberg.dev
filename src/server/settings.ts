import { query } from './db.js';
import { HttpError, type Viewer } from './mail.js';
import type { Draft, DraftPayload, FilterAction, MailFilter, MailSettings } from '../shared/api.js';

// Per-user settings (signature), the owner's filters, and autosaved drafts.

const ACTIONS: FilterAction[] = ['archive', 'read', 'flag', 'junk', 'trash'];
const text = (v: unknown, max: number) => String(v ?? '').replace(/\u0000/g, '').toWellFormed().slice(0, max);
const line = (v: unknown, max: number) => text(v, max).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();

export async function getSettings(v: Viewer): Promise<MailSettings> {
  const user = await query<{ signature: string }>('select signature from webmail_users where id = $1', [v.userId]);
  const s = await query<{ purge_after_days: number }>('select purge_after_days from mail_settings limit 1');
  const filters = v.owner
    ? await query<{ id: string; enabled: boolean; match_from: string; match_subject: string; match_address: string; action: FilterAction }>(
        'select id::text as id, enabled, match_from, match_subject, match_address, action from mail_filters order by position, id',
      )
    : { rows: [] };
  return {
    signature: user.rows[0]?.signature ?? '',
    purgeAfterDays: s.rows[0]?.purge_after_days ?? 30,
    filters: filters.rows.map((f): MailFilter => ({ id: f.id, enabled: f.enabled, matchFrom: f.match_from, matchSubject: f.match_subject, matchAddress: f.match_address, action: f.action })),
  };
}

export async function setSettings(v: Viewer, body: { signature?: unknown; purgeAfterDays?: unknown }): Promise<void> {
  if (body?.signature !== undefined) {
    await query('update webmail_users set signature = $2 where id = $1', [v.userId, text(body.signature, 2000).replace(/\r\n/g, '\n')]);
  }
  if (body?.purgeAfterDays !== undefined) {
    if (!v.owner) throw new HttpError(403, 'Only the owner can change retention', 'forbidden');
    const days = Number(body.purgeAfterDays);
    if (!Number.isInteger(days) || days < 0 || days > 3650) throw new HttpError(400, 'Retention must be between 0 (keep forever) and 3650 days');
    await query('update mail_settings set purge_after_days = $1', [days]);
  }
}

export async function addFilter(body: { matchFrom?: unknown; matchSubject?: unknown; matchAddress?: unknown; action?: unknown }): Promise<void> {
  const from = line(body?.matchFrom, 200);
  const subject = line(body?.matchSubject, 200);
  const address = line(body?.matchAddress, 200);
  if (!from && !subject && !address) throw new HttpError(400, 'Give the filter at least one condition');
  if (!ACTIONS.includes(body?.action as FilterAction)) throw new HttpError(400, 'Unknown filter action');
  const count = await query<{ n: number }>('select count(*)::int as n from mail_filters');
  if (count.rows[0].n >= 200) throw new HttpError(400, 'Too many filters');
  await query(
    `insert into mail_filters (position, match_from, match_subject, match_address, action)
     values ((select coalesce(max(position), 0) + 1 from mail_filters), $1, $2, $3, $4)`,
    [from, subject, address, body.action],
  );
}

const filterId = (v: unknown) => {
  const s = String(v ?? '');
  if (!/^[1-9]\d{0,17}$/.test(s)) throw new HttpError(400, 'Invalid filter');
  return s;
};

export async function updateFilter(body: { id?: unknown; enabled?: unknown }): Promise<void> {
  if (typeof body?.enabled !== 'boolean') throw new HttpError(400, 'Nothing to change');
  await query('update mail_filters set enabled = $2 where id = $1', [filterId(body.id), body.enabled]);
}

export async function deleteFilter(body: { id?: unknown }): Promise<void> {
  await query('delete from mail_filters where id = $1', [filterId(body?.id)]);
}

// ---- drafts ------------------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const draftId = (v: unknown) => {
  const s = String(v ?? '');
  if (!UUID.test(s)) throw new HttpError(400, 'Invalid draft id');
  return s.toLowerCase();
};

function cleanDraft(input: unknown): DraftPayload {
  const p = (input ?? {}) as Record<string, unknown>;
  const mode = ['new', 'reply', 'replyAll', 'forward'].includes(p.mode as string) ? (p.mode as DraftPayload['mode']) : 'new';
  const numbers = (v: unknown) => (Array.isArray(v) ? v.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n < 1000).slice(0, 100) : undefined);
  return {
    mode,
    from: line(p.from, 320),
    fromName: line(p.fromName, 100),
    to: line(p.to, 4000),
    cc: line(p.cc, 4000),
    bcc: line(p.bcc, 4000),
    subject: line(p.subject, 998),
    text: text(p.text, 300_000),
    inReplyToId: /^[1-9]\d{0,17}$/.test(String(p.inReplyToId ?? '')) ? String(p.inReplyToId) : undefined,
    forwardAttachments: numbers(p.forwardAttachments),
    forwardedNames: Array.isArray(p.forwardedNames) ? p.forwardedNames.map((n) => line(n, 200)).slice(0, 100) : undefined,
  };
}

export async function listDrafts(v: Viewer): Promise<Draft[]> {
  const res = await query<{ id: string; updated_at: Date; payload: DraftPayload }>('select id::text as id, updated_at, payload from drafts where user_id = $1 order by updated_at desc limit 50', [v.userId]);
  return res.rows.map((r) => ({ id: r.id, updatedAt: r.updated_at.toISOString(), payload: r.payload }));
}

export async function saveDraft(v: Viewer, body: { id?: unknown; payload?: unknown }): Promise<void> {
  const id = draftId(body?.id);
  const payload = cleanDraft(body?.payload);
  const res = await query(
    `insert into drafts (id, user_id, payload) values ($1, $2, $3)
     on conflict (id) do update set payload = excluded.payload, updated_at = now() where drafts.user_id = excluded.user_id`,
    [id, v.userId, JSON.stringify(payload)],
  );
  // the id exists but belongs to someone else
  if (!res.rowCount) throw new HttpError(404, 'Draft not found');
  await query(`delete from drafts where user_id = $1 and id not in (select id from drafts where user_id = $1 order by updated_at desc limit 50)`, [v.userId]);
}

export async function deleteDraft(v: Viewer, body: { id?: unknown }): Promise<void> {
  await query('delete from drafts where id = $1 and user_id = $2', [draftId(body?.id), v.userId]);
}
