import config from './config.js';
import { query } from './db.js';
import { HttpError, isAddress } from './mail.js';
import type { DeliveryRules, ForwardStyle } from '../shared/api.js';

// Delivery rules: per receiving address, should mail be forwarded to the private mailbox and
// should it raise a push notification. The python lambda applies them; this is the editor.

const RELAY_SHAPED = /^reply-[0-9a-f]{32}@/;

function checkAddress(input: unknown): string {
  const address = String(input ?? '').trim().toLowerCase();
  if (!isAddress(address) || RELAY_SHAPED.test(address)) throw new HttpError(400, 'Invalid address');
  const domain = address.slice(address.lastIndexOf('@') + 1);
  if (config.mail.domains.length && !config.mail.domains.includes(domain)) throw new HttpError(400, `${domain} is not one of your domains`);
  return address;
}

const styleOf = (v: unknown): ForwardStyle | null => (v === 'inline' || v === 'attach' ? v : null);

export async function getRules(): Promise<DeliveryRules> {
  const d = await query<{ default_forward: boolean; default_notify: boolean; default_forward_style: string }>('select default_forward, default_notify, default_forward_style from mail_settings limit 1');
  const defaults = { forward: d.rows[0]?.default_forward ?? true, notify: d.rows[0]?.default_notify ?? true, forwardStyle: styleOf(d.rows[0]?.default_forward_style) ?? 'inline' };
  // Every address that has a rule or has ever received mail (junk excluded).
  const res = await query<{ address: string; forward: boolean | null; notify: boolean | null; forward_style: string | null }>(
    `with seen as (
       select distinct a as address from messages, unnest(addresses) as a
        where direction = 'in' and mailbox <> 'junk' and a !~ '^reply-[0-9a-f]{32}@'
     )
     select coalesce(r.address, s.address) as address, r.forward, r.notify, r.forward_style
       from seen s full outer join address_rules r on r.address = s.address
      order by split_part(coalesce(r.address, s.address), '@', 2), coalesce(r.address, s.address)
      limit 2000`,
  );
  return {
    defaults,
    rules: res.rows.map((r) => ({
      address: r.address,
      forward: r.forward ?? defaults.forward,
      notify: r.notify ?? defaults.notify,
      forwardStyle: styleOf(r.forward_style) ?? defaults.forwardStyle,
      explicit: r.forward !== null,
    })),
  };
}

export async function setRule(body: { address?: unknown; forward?: unknown; notify?: unknown; forwardStyle?: unknown }): Promise<void> {
  const address = checkAddress(body?.address);
  const forward = typeof body.forward === 'boolean' ? body.forward : null;
  const notify = typeof body.notify === 'boolean' ? body.notify : null;
  const style = styleOf(body.forwardStyle);
  if (body.forwardStyle !== undefined && style === null) throw new HttpError(400, 'forwardStyle must be "inline" or "attach"');
  if (forward === null && notify === null && style === null) throw new HttpError(400, 'Nothing to change');
  // A new row starts from the defaults for whatever was not given.
  await query(
    `insert into address_rules (address, forward, notify, forward_style)
     select $1, coalesce($2, s.default_forward), coalesce($3, s.default_notify), coalesce($4, s.default_forward_style) from mail_settings s
     on conflict (address) do update
       set forward = coalesce($2, address_rules.forward), notify = coalesce($3, address_rules.notify),
           forward_style = coalesce($4, address_rules.forward_style), updated_at = now()`,
    [address, forward, notify, style],
  );
}

export async function resetRule(body: { address?: unknown }): Promise<void> {
  await query('delete from address_rules where address = $1', [checkAddress(body?.address)]);
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
