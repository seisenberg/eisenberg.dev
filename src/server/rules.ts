import config from './config.js';
import { query } from './db.js';
import { domainOf, HttpError, isAddress, type Viewer } from './mail.js';
import type { DeliveryRules, ForwardStyle } from '../shared/api.js';

// Delivery rules: per receiving address, should mail be forwarded to the private mailbox and
// should it raise a push notification. The python lambda applies them; this is the editor.

const RELAY_SHAPED = /^reply-[0-9a-f]{32}@/;
const MAX_RULES_PER_DOMAIN = 5000;

function checkAddress(v: Viewer, input: unknown): string {
  const address = String(input ?? '').trim().toLowerCase();
  if (!isAddress(address) || RELAY_SHAPED.test(address)) throw new HttpError(400, 'Invalid address');
  const domain = domainOf(address);
  if (config.mail.domains.length && !config.mail.domains.includes(domain)) throw new HttpError(400, `${domain} is not one of your domains`);
  if (v.domains !== null && !v.domains.includes(domain)) throw new HttpError(403, `You do not manage ${domain}`, 'forbidden');
  return address;
}

const styleOf = (v: unknown): ForwardStyle | null => (v === 'inline' || v === 'attach' ? v : null);

export async function getRules(v: Viewer): Promise<DeliveryRules> {
  const d = await query<{ default_forward: boolean; default_notify: boolean; default_forward_style: string }>('select default_forward, default_notify, default_forward_style from mail_settings limit 1');
  const defaults = { forward: d.rows[0]?.default_forward ?? true, notify: d.rows[0]?.default_notify ?? true, forwardStyle: styleOf(d.rows[0]?.default_forward_style) ?? 'inline' };
  // Every address that has a rule or currently holds received mail (junk excluded), with its totals.
  const res = await query<{ address: string; forward: boolean | null; notify: boolean | null; forward_style: string | null; blocked: boolean | null; blocked_count: number | null; note: string | null; total: number | null; last_received: Date | null }>(
    `with seen as (
       select a as address, count(*)::int as total, max(received_at) as last_received
         from messages, unnest(addresses) as a
        where direction = 'in' and mailbox <> 'junk' and a !~ '^reply-[0-9a-f]{32}@'
        group by a
     )
     select coalesce(r.address, s.address) as address, r.forward, r.notify, r.forward_style, r.blocked, r.blocked_count, r.note,
            s.total, s.last_received
       from seen s full outer join address_rules r on r.address = s.address
      where $1::text[] is null or split_part(coalesce(r.address, s.address), '@', 2) = any ($1::text[])
      order by split_part(coalesce(r.address, s.address), '@', 2), coalesce(r.address, s.address)
      limit 20000`,
    [v.domains],
  );
  return {
    defaults,
    rules: res.rows.map((r) => ({
      address: r.address,
      forward: r.forward ?? defaults.forward,
      notify: r.notify ?? defaults.notify,
      forwardStyle: styleOf(r.forward_style) ?? defaults.forwardStyle,
      blocked: r.blocked ?? false,
      blockedCount: r.blocked_count ?? 0,
      note: r.note ?? '',
      total: r.total ?? 0,
      lastReceived: r.last_received?.toISOString() ?? null,
      explicit: r.forward !== null,
    })),
  };
}

export async function setRule(v: Viewer, body: { address?: unknown; forward?: unknown; notify?: unknown; forwardStyle?: unknown; blocked?: unknown; note?: unknown }): Promise<void> {
  const address = checkAddress(v, body?.address);
  const forward = typeof body.forward === 'boolean' ? body.forward : null;
  const notify = typeof body.notify === 'boolean' ? body.notify : null;
  const blocked = typeof body.blocked === 'boolean' ? body.blocked : null;
  const note = typeof body.note === 'string' ? body.note.replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim().slice(0, 200) : null;
  const style = styleOf(body.forwardStyle);
  if (body.forwardStyle !== undefined && style === null) throw new HttpError(400, 'forwardStyle must be "inline" or "attach"');
  if (forward === null && notify === null && style === null && blocked === null && note === null) throw new HttpError(400, 'Nothing to change');
  // Blocking discards mail for everyone and outlives the person who set it: the owner's call.
  if (blocked !== null && !v.owner) throw new HttpError(403, 'Only the owner can block or unblock an address', 'forbidden');
  const existing = await query<{ here: boolean; n: number }>(
    `select bool_or(address = $1) as here, count(*)::int as n from address_rules where split_part(address, '@', 2) = $2`,
    [address, domainOf(address)],
  );
  if (!existing.rows[0]?.here && (existing.rows[0]?.n ?? 0) >= MAX_RULES_PER_DOMAIN) throw new HttpError(400, 'This domain has too many address rules');
  // A new row starts from the defaults for whatever was not given.
  await query(
    `insert into address_rules (address, forward, notify, forward_style, blocked, note)
     select $1, coalesce($2, s.default_forward), coalesce($3, s.default_notify), coalesce($4, s.default_forward_style), coalesce($5, false), coalesce($6, '') from mail_settings s
     on conflict (address) do update
       set forward = coalesce($2, address_rules.forward), notify = coalesce($3, address_rules.notify),
           forward_style = coalesce($4, address_rules.forward_style), blocked = coalesce($5, address_rules.blocked),
           -- unblocking starts the counter again
           blocked_count = case when $5 = false then 0 else address_rules.blocked_count end,
           note = coalesce($6, address_rules.note), updated_at = now()`,
    [address, forward, notify, style, blocked, note],
  );
}

export async function resetRule(v: Viewer, body: { address?: unknown }): Promise<void> {
  await query('delete from address_rules where address = $1', [checkAddress(v, body?.address)]);
}

export async function setDefaults(body: { forward?: unknown; notify?: unknown; forwardStyle?: unknown }): Promise<void> {
  const forward = typeof body?.forward === 'boolean' ? body.forward : null;
  const notify = typeof body?.notify === 'boolean' ? body.notify : null;
  const style = styleOf(body?.forwardStyle);
  if (body?.forwardStyle !== undefined && style === null) throw new HttpError(400, 'forwardStyle must be "inline" or "attach"');
  if (forward === null && notify === null && style === null) throw new HttpError(400, 'Nothing to change');
  await query(
    `insert into mail_settings (id, default_forward, default_notify, default_forward_style) values (true, coalesce($1, true), coalesce($2, true), coalesce($3, 'inline'))
     on conflict (id) do update set default_forward = coalesce($1, mail_settings.default_forward), default_notify = coalesce($2, mail_settings.default_notify),
       default_forward_style = coalesce($3, mail_settings.default_forward_style), updated_at = now()`,
    [forward, notify, style],
  );
}
