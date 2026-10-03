import crypto from 'node:crypto';
import config from './config.js';
import { query } from './db.js';
import { HttpError } from './mail.js';
import type { PushStatus, PushSubscriptionInput } from '../shared/api.js';

// Web Push for the installed web app. The python lambda sends the "new mail" notifications; this
// side stores the subscriptions and can send a test notification so set-up can be verified.

/** Push services we will ever POST to. A subscription endpoint is a URL chosen by the client, so it is never trusted blindly. */
const PUSH_HOSTS = ['push.apple.com', 'fcm.googleapis.com', 'updates.push.services.mozilla.com', 'notify.windows.com'];

export function checkEndpoint(input: unknown): string {
  let url: URL;
  try {
    url = new URL(String(input));
  } catch {
    throw new HttpError(400, 'Invalid push subscription');
  }
  const host = url.hostname.toLowerCase();
  const local = !config.production && config.push.extraHosts.some((h) => host === h || host.endsWith(`.${h}`));
  const known = url.protocol === 'https:' && PUSH_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  if (!(known || local) || url.username || url.password || String(input).length > 2048) {
    throw new HttpError(400, 'This browser\'s push service is not supported');
  }
  return url.toString();
}

const B64URL = /^[A-Za-z0-9_-]+$/;

let privateKey: Promise<string | null> | null = null;
function vapidPrivateKey(): Promise<string | null> {
  privateKey ??= (async () => {
    if (config.push.privateKey) return config.push.privateKey;
    if (!config.push.privateKeySsm) return null;
    const { SSMClient, GetParameterCommand } = await import('@aws-sdk/client-ssm');
    const res = await new SSMClient({}).send(new GetParameterCommand({ Name: config.push.privateKeySsm, WithDecryption: true }));
    return res.Parameter?.Value?.trim() || null;
  })().catch((err) => {
    privateKey = null;
    throw err;
  });
  return privateKey;
}

const deviceId = (endpoint: string) => crypto.createHash('sha256').update(endpoint).digest('hex').slice(0, 16);

export async function pushStatus(userId: number): Promise<PushStatus> {
  // Subscriptions that have failed for a long time are dead weight for the python lambda, which tries each one per message.
  await query(`delete from push_subscriptions where failure_count >= 25 and (last_success_at is null or last_success_at < now() - interval '14 days')`);
  const res = await query<{ endpoint: string; user_agent: string | null; created_at: Date; last_success_at: Date | null }>(
    'select endpoint, user_agent, created_at, last_success_at from push_subscriptions where user_id = $1 order by created_at desc',
    [userId],
  );
  return {
    available: !!config.push.publicKey,
    publicKey: config.push.publicKey,
    // The endpoint itself is a capability URL: the UI only gets a short hash of it.
    devices: res.rows.map((r) => ({ id: deviceId(r.endpoint), userAgent: r.user_agent, createdAt: r.created_at.toISOString(), lastSuccessAt: r.last_success_at?.toISOString() ?? null })),
  };
}

export async function subscribe(userId: number, input: PushSubscriptionInput, userAgent: string): Promise<void> {
  const endpoint = checkEndpoint(input?.endpoint);
  const p256dh = String(input?.keys?.p256dh ?? '');
  const auth = String(input?.keys?.auth ?? '');
  if (!B64URL.test(p256dh) || p256dh.length > 200 || !B64URL.test(auth) || auth.length > 100) throw new HttpError(400, 'Invalid push subscription');
  await query(
    `insert into push_subscriptions (endpoint, p256dh, auth, user_id, user_agent) values ($1, $2, $3, $4, $5)
     on conflict (endpoint) do update set p256dh = excluded.p256dh, auth = excluded.auth, user_id = excluded.user_id, user_agent = excluded.user_agent, failure_count = 0`,
    [endpoint, p256dh, auth, userId, userAgent.slice(0, 300) || null],
  );
  // keep the table small: a person has a handful of devices
  await query(
    `delete from push_subscriptions where user_id = $1 and endpoint not in (select endpoint from push_subscriptions where user_id = $1 order by created_at desc limit 20)`,
    [userId],
  );
}

export async function unsubscribe(userId: number, body: { endpoint?: unknown; id?: unknown }): Promise<void> {
  if (typeof body?.endpoint === 'string') {
    await query('delete from push_subscriptions where user_id = $1 and endpoint = $2', [userId, body.endpoint]);
  } else if (typeof body?.id === 'string' && /^[0-9a-f]{16}$/.test(body.id)) {
    await query(`delete from push_subscriptions where user_id = $1 and left(encode(sha256(convert_to(endpoint, 'UTF8')), 'hex'), 16) = $2`, [userId, body.id]);
  } else throw new HttpError(400, 'Nothing to remove');
}

export interface PushPayload {
  title: string;
  body: string;
  url: string;
  tag?: string;
  address?: string;
}

/** Sends to every device of the user. Returns how many deliveries the push services accepted. */
export async function sendToUser(userId: number, payload: PushPayload): Promise<{ sent: number; failed: number }> {
  const key = await vapidPrivateKey();
  if (!config.push.publicKey || !key) throw new HttpError(503, 'Push notifications are not configured on this server (VAPID keys missing)', 'push_disabled');
  const { default: webpush } = await import('web-push');
  const subs = await query<{ endpoint: string; p256dh: string; auth: string }>('select endpoint, p256dh, auth from push_subscriptions where user_id = $1 limit 20', [userId]);
  let sent = 0;
  let failed = 0;
  for (const sub of subs.rows) {
    try {
      checkEndpoint(sub.endpoint);
      await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, JSON.stringify(payload), {
        vapidDetails: { subject: config.push.subject, publicKey: config.push.publicKey, privateKey: key },
        TTL: 3600,
        timeout: 5000,
      });
      sent++;
      await query('update push_subscriptions set last_success_at = now(), failure_count = 0 where endpoint = $1', [sub.endpoint]);
    } catch (err) {
      failed++;
      const status = (err as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) await query('delete from push_subscriptions where endpoint = $1', [sub.endpoint]);
      else await query('update push_subscriptions set failure_count = failure_count + 1 where endpoint = $1', [sub.endpoint]);
      console.error(`push to ${safeHost(sub.endpoint)} failed: ${status ?? (err as Error).message}`);
    }
  }
  return { sent, failed };
}

function safeHost(endpoint: string): string {
  try {
    return new URL(endpoint).hostname;
  } catch {
    return 'invalid endpoint';
  }
}
