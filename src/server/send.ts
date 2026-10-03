import crypto from 'node:crypto';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import config from './config.js';
import { tx } from './db.js';
import { indexRow, parseRaw } from './ingest.js';
import { HttpError, identities, isAddress, threadingFor } from './mail.js';
import type { SendRequest } from '../shared/api.js';

const MAX_RECIPIENTS = 50;
const MAX_TEXT = 1_000_000;

/** Header values must never contain line breaks or control characters (header injection). */
const headerSafe = (s: string) => s.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();

function addressList(input: unknown, field: string): string[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) throw new HttpError(400, `${field} must be a list of addresses`);
  return input.map((v) => {
    const a = String(v).trim().toLowerCase();
    if (!isAddress(a)) throw new HttpError(400, `"${String(v).slice(0, 80)}" is not a valid email address`);
    return a;
  });
}

export interface Transport {
  send(raw: Buffer, from: string, to: string[], cc: string[], bcc: string[]): Promise<string>;
}

const mockTransport: Transport = {
  async send(raw, from, to) {
    const id = `mock-${crypto.randomUUID()}`;
    console.log(`[mock mail] ${from} -> ${to.join(', ')} (${raw.length} bytes) id=${id}`);
    return id;
  },
};

const sesTransport: Transport = {
  async send(raw, from, to, cc, bcc) {
    const { SESv2Client, SendEmailCommand } = await import('@aws-sdk/client-sesv2');
    const client = new SESv2Client({ region: config.mail.region });
    const res = await client.send(
      new SendEmailCommand({
        FromEmailAddress: from,
        Destination: { ToAddresses: to, CcAddresses: cc, BccAddresses: bcc },
        Content: { Raw: { Data: raw } },
      }),
    );
    if (!res.MessageId) throw new Error('SES returned no message id');
    return res.MessageId;
  },
};

let transport: Transport = config.mail.transport === 'ses' ? sesTransport : mockTransport;
export function setTransport(t: Transport): void {
  transport = t;
}

export async function sendMail(input: SendRequest): Promise<{ id: string }> {
  const req = (input ?? {}) as SendRequest;
  const from = String(req.from ?? '').trim().toLowerCase();
  if (!isAddress(from)) throw new HttpError(400, 'From is not a valid email address');
  const { domains } = await identities();
  const fromDomain = from.slice(from.lastIndexOf('@') + 1);
  if (!domains.includes(fromDomain)) {
    throw new HttpError(400, `Cannot send from ${fromDomain}. Allowed domains: ${domains.join(', ') || '(none configured)'}`);
  }

  const to = addressList(req.to, 'to');
  const cc = addressList(req.cc, 'cc');
  const bcc = addressList(req.bcc, 'bcc');
  const total = to.length + cc.length + bcc.length;
  if (total === 0) throw new HttpError(400, 'Add at least one recipient');
  if (total > MAX_RECIPIENTS) throw new HttpError(400, `Too many recipients (max ${MAX_RECIPIENTS})`);

  const subject = headerSafe(String(req.subject ?? '')).slice(0, 998);
  const text = String(req.text ?? '');
  if (text.length > MAX_TEXT) throw new HttpError(400, 'Message is too long');
  const fromName = headerSafe(String(req.fromName ?? '')).slice(0, 100);

  // Attachments: new uploads, plus attachments carried over when forwarding.
  const attachments: { filename: string; contentType: string; content: Buffer }[] = [];
  let bytes = 0;
  for (const a of Array.isArray(req.attachments) ? req.attachments : []) {
    const content = Buffer.from(String(a?.content ?? ''), 'base64');
    bytes += content.length;
    attachments.push({
      filename: headerSafe(String(a?.filename ?? 'attachment')).replace(/[\\/]/g, '_').slice(0, 200) || 'attachment',
      contentType: /^[\w.+-]+\/[\w.+-]+$/.test(String(a?.contentType)) ? String(a.contentType) : 'application/octet-stream',
      content,
    });
  }

  let inReplyTo: string | undefined;
  let references: string[] | undefined;
  let repliedRawId: string | null = null;
  if (req.inReplyToId !== undefined && req.inReplyToId !== null) {
    const thread = await threadingFor(req.inReplyToId);
    repliedRawId = thread.rawId;
    const forwarding = Array.isArray(req.forwardAttachments);
    if (!forwarding && thread.messageId) {
      inReplyTo = thread.messageId;
      references = [...thread.refs, thread.messageId].slice(-30);
    }
    if (forwarding && req.forwardAttachments!.length && thread.raw) {
      const original = (await parseRaw(thread.raw)).attachments.filter((a) => !a.related);
      for (const index of req.forwardAttachments!) {
        const att = original[Number(index)];
        if (!att) throw new HttpError(400, 'Forwarded attachment not found');
        bytes += att.content.length;
        attachments.push({ filename: att.filename ?? `attachment-${Number(index) + 1}`, contentType: att.contentType ?? 'application/octet-stream', content: att.content });
      }
    }
  }
  if (bytes > config.mail.maxAttachmentBytes) {
    throw new HttpError(413, `Attachments are limited to ${Math.floor(config.mail.maxAttachmentBytes / 1024 / 1024)} MB per message`);
  }

  const messageId = `<${crypto.randomUUID()}@${fromDomain}>`;
  const raw: Buffer = await new MailComposer({
    from: fromName ? { name: fromName, address: from } : from,
    to,
    cc,
    bcc, // used for the envelope only; MailComposer leaves the Bcc header out of the built message
    subject,
    text,
    messageId,
    inReplyTo,
    references,
    date: new Date(),
    attachments,
    // nothing identifying the client or server: no X-Mailer, no user agent
    xMailer: false,
    disableFileAccess: true,
    disableUrlAccess: true,
  } as ConstructorParameters<typeof MailComposer>[0]).compile().build();

  const sesId = await transport.send(raw, from, to, cc, bcc);
  const rawId = `sent-${sesId}`;
  const meta = { from, to, cc, bcc, in_reply_to_raw_id: Array.isArray(req.forwardAttachments) ? null : repliedRawId };

  const id = await tx(async (client) => {
    await client.query(
      `insert into lambda_inbox (message_id, kind, meta, email_raw, processed_at) values ($1, 'sent', $2, $3, current_timestamp)`,
      [rawId, JSON.stringify(meta), raw],
    );
    await indexRow(client, { message_id: rawId, created_at: new Date(), kind: 'sent', event: null, meta, email_raw: raw });
    const res = await client.query<{ id: string }>('select id::text as id from messages where raw_id = $1', [rawId]);
    return res.rows[0].id;
  });
  return { id };
}
