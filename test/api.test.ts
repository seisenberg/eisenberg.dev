// Integration tests: the real Koa app against a real (embedded) PostgreSQL.
import { tmp } from './env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { startLocalDb, type LocalDb } from '../scripts/local-db.js';
import { DEV_DOMAINS, DEV_USER, seed, seedState } from '../scripts/seed.js';
import type { DeliveryRules, MailboxTree, MessageDetail, MessageList } from '../src/shared/api.js';


let local: LocalDb;
let server: Server;
let base = '';
let cookie = '';
let trustedDevice = '';
const sent: { from: string; to: string[]; raw: string }[] = [];

type Json = any;
async function call(method: string, url: string, body?: unknown, opts: { headers?: Record<string, string>; noCookie?: boolean; noCsrf?: boolean } = {}) {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (cookie && !opts.noCookie) headers.cookie = cookie;
  if (method !== 'GET' && !opts.noCsrf) headers['x-eisenmail'] = '1';
  if (body !== undefined) headers['content-type'] ??= 'application/json';
  const res = await fetch(base + url, { method, headers, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body), redirect: 'manual' });
  const text = await res.text();
  let json: Json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, headers: res.headers, text, json };
}

before(async () => {
  local = await startLocalDb({ dir: path.join(tmp, 'pg'), port: 54400 + Math.floor(Math.random() * 500), persistent: false });
  const { setPool } = await import('../src/server/db.js');
  const { ingestPending } = await import('../src/server/ingest.js');
  const { createApp } = await import('../src/server/app.js');
  const { setTransport } = await import('../src/server/send.js');
  setPool(local.pool);
  setTransport({
    async send(raw, from, to) {
      sent.push({ from, to, raw: raw.toString('utf8') });
      return `test-${sent.length}`;
    },
  });
  await seed(local.pool);
  await ingestPending({ force: true });
  await seedState(local.pool);
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server?.close();
  await local?.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('security headers are set', async () => {
  const res = await call('GET', '/health');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-security-policy') ?? '', /script-src 'self';/);
  assert.match(res.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
});

test('private api requires a session', async () => {
  for (const url of ['/api/mail/mailboxes', '/api/mail/messages', '/api/mail/messages/1', '/api/files', '/api/auth/me', '/api/mail/messages/1/raw']) {
    const res = await call('GET', url);
    assert.equal(res.status, 401, url);
  }
  assert.equal((await call('POST', '/api/mail/send', { from: 'a@eisenberg.dev', to: ['x@y.example'], subject: 's', text: 't' })).status, 401);
  // unknown paths do not reveal whether they exist to an anonymous caller
  assert.equal((await call('GET', '/api/nope')).status, 401);
});

test('login: csrf header required, wrong password rejected, throttled after repeated failures', async () => {
  assert.equal((await call('POST', '/api/auth/login', DEV_USER, { noCsrf: true })).status, 403);
  assert.equal((await call('POST', '/api/auth/login', DEV_USER, { headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal((await call('POST', '/api/auth/login', DEV_USER, { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);

  const bad = await call('POST', '/api/auth/login', { username: 'nobody', password: 'wrong-password-123' });
  assert.equal(bad.status, 401);
  assert.equal(bad.json.code, 'bad_credentials');

  for (let i = 0; i < 5; i++) {
    const r = await call('POST', '/api/auth/login', { username: 'victim', password: `guess-${i}-xxxxxxxx` });
    assert.equal(r.status, 401);
  }
  const blocked = await call('POST', '/api/auth/login', { username: 'victim', password: 'guess-again-xxxxxxxx' });
  assert.equal(blocked.status, 429);
});

test('login succeeds and sets a hardened cookie', async () => {
  const res = await call('POST', '/api/auth/login', DEV_USER);
  assert.equal(res.status, 200, res.text);
  const set = res.headers.get('set-cookie') ?? '';
  assert.match(set, /HttpOnly/);
  assert.match(set, /SameSite=Strict/);
  assert.match(set, /Path=\//);
  cookie = set.split(';')[0];
  const me = await call('GET', '/api/auth/me');
  assert.equal(me.json.username, DEV_USER.username);
  assert.equal((await call('GET', '/api/nope')).status, 404);
  // the token itself is not stored
  const token = cookie.split('=')[1];
  const rows = await local.pool.query('select token_hash from webmail_sessions');
  assert.ok(rows.rows.every((r) => !r.token_hash.toString('utf8').includes(token)));
  const pw = await local.pool.query('select passhash from webmail_users where email = $1', [DEV_USER.username]);
  assert.match(pw.rows[0].passhash, /^scrypt\$/);
});

test('state changing requests need the csrf header even with a session', async () => {
  const res = await call('PATCH', '/api/mail/messages', { ids: ['1'], set: { isRead: true } }, { noCsrf: true });
  assert.equal(res.status, 403);
});

let tree: MailboxTree;
test('mailbox tree: global inbox, a folder per domain, an inbox per receiving address', async () => {
  tree = (await call('GET', '/api/mail/mailboxes')).json;
  assert.deepEqual(tree.domains.map((d) => d.domain), DEV_DOMAINS);
  const dev = tree.domains[0];
  assert.ok(dev.addresses.some((a) => a.address === 'cool_stuff@eisenberg.dev'));
  assert.equal(dev.addresses.find((a) => a.address === 'cool_stuff@eisenberg.dev')!.total, 2);
  assert.ok(tree.inbox.total >= 15);
  assert.equal(tree.junk.total, 1);
  assert.equal(tree.trash.total, 1);
  assert.equal(tree.sent.total, 2);
  assert.equal(tree.flagged.total, 2);
  // one message addressed to two of our domains counts once globally, once per domain
  const sumDomains = tree.domains.reduce((n, d) => n + d.total, 0);
  assert.equal(sumDomains, tree.inbox.total + 1);
});

test('lists: scoping, search, pagination', async () => {
  const all: MessageList = (await call('GET', '/api/mail/messages?mailbox=inbox&limit=200')).json;
  assert.equal(all.messages.length, tree.inbox.total);
  assert.equal(all.nextCursor, null);
  const dates = all.messages.map((m) => m.date);
  assert.deepEqual(dates, [...dates].sort().reverse());

  const dom: MessageList = (await call('GET', '/api/mail/messages?mailbox=inbox&domain=harborlight.example')).json;
  assert.ok(dom.messages.length >= 3);
  assert.ok(dom.messages.every((m) => m.addresses.some((a) => a.endsWith('@harborlight.example'))));

  const addr: MessageList = (await call('GET', '/api/mail/messages?mailbox=inbox&address=github@eisenberg.dev')).json;
  assert.equal(addr.messages.length, 2);

  const search: MessageList = (await call('GET', '/api/mail/messages?mailbox=inbox&q=turkey')).json;
  assert.equal(search.messages.length, 0); // archived
  const search2: MessageList = (await call('GET', '/api/mail/messages?mailbox=archive&q=turkey')).json;
  assert.equal(search2.messages.length, 1);
  // LIKE wildcards in the query are literal
  assert.equal(((await call('GET', '/api/mail/messages?mailbox=inbox&q=%25')).json as MessageList).messages.length, 0);

  const seen = new Set<string>();
  let cursor: string | null = null;
  do {
    const page: MessageList = (await call('GET', `/api/mail/messages?mailbox=inbox&limit=4${cursor ? `&cursor=${cursor}` : ''}`)).json;
    for (const m of page.messages) {
      assert.ok(!seen.has(m.id));
      seen.add(m.id);
    }
    cursor = page.nextCursor;
  } while (cursor);
  assert.equal(seen.size, tree.inbox.total);

  assert.equal((await call('GET', '/api/mail/messages?mailbox=nope')).status, 400);
  assert.equal((await call('GET', "/api/mail/messages?mailbox=inbox&address=a'%20or%201=1")).status, 400);
  assert.equal((await call('GET', '/api/mail/messages/1%20or%201=1')).status, 400);
});

test('message detail, attachments, raw source', async () => {
  const list: MessageList = (await call('GET', '/api/mail/messages?mailbox=inbox&q=Fractional')).json;
  const detail: MessageDetail = (await call('GET', `/api/mail/messages/${list.messages[0].id}`)).json;
  assert.equal(detail.replyFrom, 'sam@eisenberg.dev');
  assert.equal(detail.attachments.length, 1);
  assert.equal(detail.attachments[0].filename, 'Engagement brief.pdf');
  assert.equal(detail.auth?.dmarc, 'PASS');
  const att = await call('GET', `/api/mail/messages/${detail.id}/attachments/0`);
  assert.equal(att.status, 200);
  assert.match(att.headers.get('content-disposition') ?? '', /^attachment;/);
  assert.match(att.headers.get('content-security-policy') ?? '', /sandbox/);
  assert.ok(att.text.startsWith('%PDF'));
  assert.equal((await call('GET', `/api/mail/messages/${detail.id}/attachments/7`)).status, 404);
  const raw = await call('GET', `/api/mail/messages/${detail.id}/raw`);
  assert.match(raw.text, /^From: /m);
  assert.equal(raw.headers.get('content-type'), 'application/octet-stream');
});

test('reply defaults to the receiving address, any alias on our domains can send, other domains cannot', async () => {
  const list: MessageList = (await call('GET', '/api/mail/messages?mailbox=inbox&address=cool_stuff@eisenberg.dev&q=desk')).json;
  const original = list.messages[0];
  const detail: MessageDetail = (await call('GET', `/api/mail/messages/${original.id}`)).json;
  assert.equal(detail.replyFrom, 'cool_stuff@eisenberg.dev');

  const res = await call('POST', '/api/mail/send', { from: detail.replyFrom, to: [detail.from.address], subject: `Re: ${detail.subject}`, text: 'Yes, still available.', inReplyToId: detail.id });
  assert.equal(res.status, 200, res.text);
  const out = sent.at(-1)!;
  assert.equal(out.from, 'cool_stuff@eisenberg.dev');
  assert.deepEqual(out.to, ['jane.park@northwind.example']);
  assert.match(out.raw, /^In-Reply-To: <desk-1@northwind\.example>/m);
  assert.match(out.raw, /^From: cool_stuff@eisenberg\.dev/m);
  assert.doesNotMatch(out.raw, /x-mailer/i);
  const after: MessageDetail = (await call('GET', `/api/mail/messages/${original.id}`)).json;
  assert.equal(after.isAnswered, true);
  const sentBox: MessageList = (await call('GET', '/api/mail/messages?mailbox=sent')).json;
  assert.equal(sentBox.messages[0].id, res.json.id);
  assert.equal(sentBox.messages[0].isRead, true);

  // a brand new alias that has never received anything
  const fresh = await call('POST', '/api/mail/send', { from: 'Brand.New-Alias@Harborlight.example', fromName: 'Harborlight', to: ['x@y.example'], bcc: ['hidden@z.example'], subject: 'hello', text: 'hi' });
  assert.equal(fresh.status, 200, fresh.text);
  assert.match(sent.at(-1)!.raw, /^From: Harborlight <brand\.new-alias@harborlight\.example>/m);
  assert.doesNotMatch(sent.at(-1)!.raw, /hidden@z\.example/);

  assert.equal((await call('POST', '/api/mail/send', { from: 'ceo@bigbank.example', to: ['x@y.example'], subject: 's', text: 't' })).status, 400);
  assert.equal((await call('POST', '/api/mail/send', { from: 'a@eisenberg.dev', to: [], subject: 's', text: 't' })).status, 400);
  assert.equal((await call('POST', '/api/mail/send', { from: 'a@eisenberg.dev', to: ['not an address'], subject: 's', text: 't' })).status, 400);
  // header injection through subject / display name
  const inj = await call('POST', '/api/mail/send', { from: 'a@eisenberg.dev', fromName: 'X\r\nBcc: evil@evil.example', to: ['x@y.example'], subject: 'hi\r\nBcc: evil@evil.example', text: 't' });
  assert.equal(inj.status, 200);
  assert.doesNotMatch(sent.at(-1)!.raw, /^Bcc:/m);
  assert.deepEqual(sent.at(-1)!.to, ['x@y.example']);
});

test('read, flag, archive, trash, restore, delete forever; empty addresses disappear', async () => {
  const before: MailboxTree = (await call('GET', '/api/mail/mailboxes')).json;
  const list: MessageList = (await call('GET', '/api/mail/messages?mailbox=inbox&address=travel@eisenberg.dev')).json;
  assert.equal(list.messages.length, 1);
  const id = list.messages[0].id;

  assert.equal((await call('PATCH', '/api/mail/messages', { ids: [id], set: { isRead: false, isFlagged: true } })).status, 200);
  let d: MessageDetail = (await call('GET', `/api/mail/messages/${id}`)).json;
  assert.equal(d.isRead, false);
  assert.equal(d.isFlagged, true);

  // cannot delete forever straight from the inbox
  assert.equal((await call('POST', '/api/mail/messages/delete', { ids: [id] })).json.deleted, 0);

  await call('PATCH', '/api/mail/messages', { ids: [id], set: { mailbox: 'trash' } });
  let t: MailboxTree = (await call('GET', '/api/mail/mailboxes')).json;
  assert.ok(!t.domains[0].addresses.some((a) => a.address === 'travel@eisenberg.dev'), 'address with no inbox mail is hidden');
  assert.equal(t.trash.total, before.trash.total + 1);

  await call('PATCH', '/api/mail/messages', { ids: [id], set: { mailbox: 'restore' } });
  d = (await call('GET', `/api/mail/messages/${id}`)).json;
  assert.equal(d.mailbox, 'inbox');

  await call('PATCH', '/api/mail/messages', { ids: [id], set: { mailbox: 'archive' } });
  t = (await call('GET', '/api/mail/mailboxes')).json;
  assert.equal(t.archive.total, before.archive.total + 1);

  await call('PATCH', '/api/mail/messages', { ids: [id], set: { mailbox: 'trash' } });
  assert.equal((await call('POST', '/api/mail/messages/delete', { ids: [id] })).json.deleted, 1);
  assert.equal((await call('GET', `/api/mail/messages/${id}`)).status, 404);
  const rawLeft = await local.pool.query(`select 1 from lambda_inbox where s3_key like '%' and message_id not in (select raw_id from messages)`);
  assert.equal(rawLeft.rowCount, 0, 'raw source is deleted with the message');

  const emptied = await call('POST', '/api/mail/empty', { mailbox: 'trash' });
  assert.equal(emptied.json.deleted, before.trash.total);
  assert.equal((await call('POST', '/api/mail/empty', { mailbox: 'inbox' })).status, 400);

  // sent mail cannot be moved into the inbox
  const sentBox: MessageList = (await call('GET', '/api/mail/messages?mailbox=sent')).json;
  assert.equal((await call('PATCH', '/api/mail/messages', { ids: [sentBox.messages[0].id], set: { mailbox: 'inbox' } })).json.changed, 0);
});

test('file drop: private by default, public only after being marked', async () => {
  const ticket = (await call('POST', '/api/files/uploads', { name: 'notes.txt', size: 5, contentType: 'text/plain' })).json;
  assert.equal(ticket.method, 'PUT');
  const up = await call('PUT', ticket.url, 'hello', { headers: ticket.headers, noCsrf: true }); // the ticket carries the header
  assert.equal(up.status, 204, up.text);

  let listing = (await call('GET', '/api/files')).json;
  assert.deepEqual(listing.files.map((f: Json) => [f.name, f.isPublic, f.publicPath]), [['notes.txt', false, null]]);
  assert.equal((await call('GET', '/public/notes.txt', undefined, { noCookie: true })).status, 404);
  assert.equal((await call('GET', '/api/files/download/private/notes.txt', undefined, { noCookie: true })).status, 401);

  const dl = await call('GET', '/api/files/download/private/notes.txt');
  assert.equal(dl.status, 302);
  const got = await call('GET', dl.headers.get('location')!);
  assert.equal(got.text, 'hello');
  assert.match(got.headers.get('content-disposition') ?? '', /^attachment/);

  assert.equal((await call('POST', '/api/files/visibility', { name: 'notes.txt', public: true })).status, 204);
  const pub = await call('GET', '/public/notes.txt', undefined, { noCookie: true });
  assert.equal(pub.status, 200);
  assert.equal(pub.text, 'hello');
  listing = (await call('GET', '/api/files')).json;
  assert.equal(listing.files[0].publicPath, '/public/notes.txt');

  assert.equal((await call('POST', '/api/files/visibility', { name: 'notes.txt', public: false })).status, 204);
  assert.equal((await call('GET', '/public/notes.txt', undefined, { noCookie: true })).status, 404);

  for (const name of ['../secret', '..%2Fsecret', '.env', 'a/b.txt', 'x\\y', '']) {
    const r = await call('POST', '/api/files/uploads', { name, size: 1, contentType: 'text/plain' });
    assert.equal(r.status, 400, name);
  }
  assert.equal((await call('GET', '/public/..%2F..%2Fprivate%2Fnotes.txt', undefined, { noCookie: true })).status, 400);
  assert.equal((await call('POST', '/api/files/uploads', { name: 'big.bin', size: 1e15, contentType: 'x/y' })).status, 413);

  assert.equal((await call('POST', '/api/files/delete', { name: 'notes.txt', visibility: 'private' })).status, 204);
  assert.equal((await call('GET', '/api/files')).json.files.length, 0);
});

test('two-factor: setup, enable, required at login, replay refused', async () => {
  const { totpCode, base32Decode } = await import('../src/server/auth.js');
  // The assertions below compare codes for "this" and "the next" 30 second step, so do not start
  // close to a step boundary (this is what made the test fail once in a while on a slow runner).
  const into = Date.now() % 30_000;
  if (into > 12_000) await new Promise((r) => setTimeout(r, 30_000 - into + 250));
  assert.equal((await call('POST', '/api/auth/totp/setup', { currentPassword: 'wrong-wrong-wrong' })).status, 403);
  const setup = (await call('POST', '/api/auth/totp/setup', { currentPassword: DEV_USER.password })).json;
  assert.match(setup.uri, /^otpauth:\/\/totp\//);
  assert.equal((await call('POST', '/api/auth/totp/enable', { code: '000000' })).status, 400);
  const code = () => totpCode(base32Decode(setup.secret), Math.floor(Date.now() / 30_000));
  const enabled = await call('POST', '/api/auth/totp/enable', { code: code() });
  assert.equal(enabled.status, 200);
  const recovery: string[] = enabled.json.recoveryCodes;
  assert.equal(recovery.length, 10);
  assert.match(recovery[0], /^[a-z0-9]{4}(-[a-z0-9]{4}){3}$/);
  // only hashes are stored
  const stored = await local.pool.query('select code_hash from webmail_recovery_codes');
  assert.equal(stored.rowCount, 10);
  assert.ok(stored.rows.every((r) => !r.code_hash.toString('utf8').includes(recovery[0].replace(/-/g, ''))));

  const noCode = await call('POST', '/api/auth/login', DEV_USER, { noCookie: true });
  assert.equal(noCode.json.code, 'totp_required');
  // the code used to enable cannot be replayed
  const replay = await call('POST', '/api/auth/login', { ...DEV_USER, code: code() }, { noCookie: true });
  assert.equal(replay.json.code, 'bad_totp');
  const next = totpCode(base32Decode(setup.secret), Math.floor(Date.now() / 30_000) + 1);
  const ok = await call('POST', '/api/auth/login', { ...DEV_USER, code: next }, { noCookie: true });
  assert.equal(ok.status, 200, ok.text);

  // a recovery code replaces the authenticator code, once
  const viaRecovery = await call('POST', '/api/auth/login', { ...DEV_USER, code: recovery[3].toUpperCase() }, { noCookie: true });
  assert.equal(viaRecovery.status, 200, viaRecovery.text);
  assert.equal((await call('POST', '/api/auth/login', { ...DEV_USER, code: recovery[3] }, { noCookie: true })).json.code, 'bad_totp');
  assert.equal((await call('POST', '/api/auth/login', { ...DEV_USER, code: 'aaaa-bbbb-cccc-dddd' }, { noCookie: true })).json.code, 'bad_totp');
  const fresh = await call('POST', '/api/auth/recovery-codes', { currentPassword: DEV_USER.password });
  assert.equal(fresh.json.recoveryCodes.length, 10);
  assert.ok(!fresh.json.recoveryCodes.includes(recovery[0]));

  assert.equal((await call('POST', '/api/auth/totp/disable', { currentPassword: DEV_USER.password })).status, 204);
  assert.equal((await local.pool.query('select 1 from webmail_recovery_codes')).rowCount, 0);
});

test('logout revokes the session server side', async () => {
  const old = cookie;
  assert.equal((await call('POST', '/api/auth/logout')).status, 204);
  cookie = old;
  assert.equal((await call('GET', '/api/auth/me')).status, 401);
});

test('a distributed lockout attempt does not lock out a browser that has signed in before', async () => {
  const from = (ip: string) => ({ 'x-forwarded-for': ip });
  const good = await call('POST', '/api/auth/login', DEV_USER, { noCookie: true, headers: from('198.51.100.1') });
  assert.equal(good.status, 200, good.text);
  const device = good.headers.getSetCookie().map((c) => c.split(';')[0]).find((c) => c.startsWith('eisenmail_dev_device='));
  assert.ok(device, 'device cookie issued');
  trustedDevice = device!;
  assert.match(good.headers.getSetCookie().find((c) => c.includes('device'))!, /HttpOnly; SameSite=Strict/);

  // an attacker spreads wrong guesses over many addresses
  // (earlier tests already left a few failures for this username, so the cap is reached a little early)
  let evaluated = 0;
  for (let i = 0; i < 30; i++) {
    const r = await call('POST', '/api/auth/login', { username: DEV_USER.username, password: `wrong-guess-${i}-xx` }, { noCookie: true, headers: from(`203.0.113.${i + 1}`) });
    assert.ok(r.status === 401 || r.status === 429);
    if (r.status === 401) evaluated++;
  }
  assert.ok(evaluated >= 20 && evaluated <= 30, `${evaluated} guesses were evaluated`);
  // a stranger (no device cookie) is now locked out even with the right password ...
  const stranger = await call('POST', '/api/auth/login', DEV_USER, { noCookie: true, headers: from('198.51.100.77') });
  assert.equal(stranger.status, 429);
  // ... the owner's own browser is not
  const owner = await call('POST', '/api/auth/login', DEV_USER, { noCookie: true, headers: { ...from('198.51.100.78'), cookie: device! } });
  assert.equal(owner.status, 200, owner.text);
  // and a device cookie is useless for another username or with a wrong password
  const wrong = await call('POST', '/api/auth/login', { username: DEV_USER.username, password: 'still-wrong-password' }, { noCookie: true, headers: { ...from('198.51.100.79'), cookie: device! } });
  assert.equal(wrong.status, 401);
});

test('a hostile message cannot stall or slow mail indexing', async () => {
  const { ingestPending, htmlToText, clean } = await import('../src/server/ingest.js');
  const event = (to: string) => JSON.stringify({ mail: { timestamp: new Date().toISOString() }, receipt: { recipients: [to] } });
  const insert = (id: string, to: string, raw: Buffer | string, at: number) =>
    local.pool.query(`insert into lambda_inbox (message_id, created_at, event, email_raw) values ($1, now() + make_interval(secs => $4), $2, $3)`, [id, event(to), Buffer.from(raw), at]);

  // NUL bytes and an unpaired surrogate in headers: postgres rejects both in text and jsonb
  await insert(
    'hostile-nul',
    'nul@eisenberg.dev',
    'From: =?utf-8?Q?Evil=00Name?= <evil@evil.example>\r\nTo: =?utf-8?Q?a=00b?= <nul@eisenberg.dev>\r\nSubject: =?utf-16le?B?ANg=?= lone surrogate\r\nMessage-ID: <a\u0000b@evil.example>\r\nReferences: <r\u0000@evil.example>\r\n\r\nbody\u0000text\r\n',
    1,
  );
  // 2 MB of nested markup: mailparser's html-to-text would need most of a minute for this
  await insert('hostile-nested', 'nested@eisenberg.dev', `From: e@evil.example\r\nTo: nested@eisenberg.dev\r\nSubject: nested\r\nContent-Type: text/html\r\n\r\n${'<div>'.repeat(400_000)}deep`, 2);
  // not mail at all
  await insert('hostile-garbage', 'garbage@eisenberg.dev', Buffer.from([0xff, 0xfe, 0x00, 0x00, 0xd8, 0x00]), 3);
  // an ordinary message queued behind them
  await insert('after-hostile', 'fine@eisenberg.dev', 'From: Friend <f@friend.example>\r\nTo: fine@eisenberg.dev\r\nSubject: still delivered\r\n\r\nhello\r\n', 4);

  const started = Date.now();
  assert.equal(await ingestPending({ force: true }), 4);
  assert.ok(Date.now() - started < 15_000, `indexing took ${Date.now() - started} ms`); // the old converter needed minutes
  const left = await local.pool.query('select count(*)::int as n from lambda_inbox where processed_at is null');
  assert.equal(left.rows[0].n, 0);
  const rows = await local.pool.query(`select raw_id, subject, from_name from messages where raw_id in ('hostile-nul', 'hostile-nested', 'hostile-garbage', 'after-hostile') order by raw_id`);
  assert.equal(rows.rowCount, 4);
  assert.equal(rows.rows.find((r) => r.raw_id === 'after-hostile').subject, 'still delivered');
  assert.equal(rows.rows.find((r) => r.raw_id === 'hostile-nul').from_name, 'EvilName');

  // opening them works too
  // (the previous test left the username locked for strangers; this browser is a known device)
  await call('POST', '/api/auth/login', DEV_USER, { noCookie: true, headers: { 'x-forwarded-for': '198.51.100.200', cookie: trustedDevice } }).then((r) => {
    assert.equal(r.status, 200, r.text);
    cookie = (r.headers.getSetCookie().find((c) => c.startsWith('eisenmail_dev=')) ?? '').split(';')[0];
  });
  const nested: MessageList = (await call('GET', '/api/mail/messages?mailbox=inbox&address=nested@eisenberg.dev')).json;
  const t0 = Date.now();
  const detail = await call('GET', `/api/mail/messages/${nested.messages[0].id}`);
  assert.equal(detail.status, 200);
  assert.ok(Date.now() - t0 < 10_000);
  assert.equal((await call('GET', '/api/mail/messages?mailbox=inbox&limit=abc')).status, 200);

  assert.equal(htmlToText('<style>p{}</style><p>Hello&nbsp;<b>world</b> &amp; &#x263A;</p><script>x</script><div>next</div>'), 'Hello world & \u263a\nnext');
  // tags split by other tags do not reassemble into markup
  assert.ok(!htmlToText('a<scr<b>ipt>alert(1)</scr</b>ipt>b <img src=x onerror=1> c').includes('<'));
  assert.equal(clean('a\u0000b\ud800c'), 'ab\ufffdc');
});

test('client address: never a client-supplied entry; IPv6 bucketed by /64', async () => {
  const { clientIp, ipBucket } = await import('../src/server/auth.js');
  const { default: config } = await import('../src/server/config.js');
  const ctx = (xff: string) => ({ get: (h: string) => (h === 'x-forwarded-for' ? xff : ''), socket: { remoteAddress: '10.1.2.3' } }) as never;
  const hops = config.proxyHops;
  try {
    config.proxyHops = 1;
    assert.equal(clientIp(ctx('6.6.6.6, 203.0.113.9')), '203.0.113.9');
    assert.equal(clientIp(ctx('')), '10.1.2.3');
    config.proxyHops = 2;
    assert.equal(clientIp(ctx('6.6.6.6, 203.0.113.9, 130.176.1.1')), '203.0.113.9');
    // request that skipped the outer proxy: its single entry is client supplied, so it is not used
    assert.equal(clientIp(ctx('6.6.6.6')), '10.1.2.3');
  } finally {
    config.proxyHops = hops;
  }
  assert.equal(ipBucket('2001:db8:1:2:aaaa:bbbb:cccc:dddd'), ipBucket('2001:db8:1:2::1'));
  assert.notEqual(ipBucket('2001:db8:1:2::1'), ipBucket('2001:db8:1:3::1'));
  assert.equal(ipBucket('::ffff:192.0.2.7'), '192.0.2.7');
  assert.equal(ipBucket('192.0.2.7'), '192.0.2.7');
});

test('parallel login guesses cannot exceed the limit', async () => {
  const results = await Promise.all(
    Array.from({ length: 20 }, (_, i) => call('POST', '/api/auth/login', { username: 'burst-target', password: `burst-guess-${i}-xx` }, { noCookie: true, headers: { 'x-forwarded-for': '198.51.100.250' } })),
  );
  const tried = results.filter((r) => r.status === 401).length;
  assert.equal(tried, 5, `expected exactly 5 guesses to be evaluated, got ${tried}`);
  assert.equal(results.filter((r) => r.status === 429).length, 15);
});

test('configuration refuses overlapping file locations', async () => {
  const { spawnSync } = await import('node:child_process');
  const run = (env: Record<string, string>) =>
    spawnSync(process.execPath, ['--import', 'tsx', '-e', "await import('./src/server/config.ts')"], { env: { PATH: process.env.PATH!, FILES_BUCKET: 'b', ...env }, encoding: 'utf8' });
  assert.match(run({ FILES_PREFIX: 'drop', PUBLIC_FILES_PREFIX: 'dro' }).stderr, /must be a non-empty prefix ending in/);
  assert.match(run({ FILES_PREFIX: 'files/', PUBLIC_FILES_PREFIX: 'files/public/' }).stderr, /overlap/);
  assert.match(run({ FILES_PREFIX: 'drop/', PUBLIC_FILES_PREFIX: 'public/', MAIL_BUCKET: 'b', MAIL_PREFIX: 'drop/mail/' }).stderr, /overlap/);
  assert.equal(run({ FILES_PREFIX: 'drop/', PUBLIC_FILES_PREFIX: 'public/' }).status, 0);
  assert.equal(run({ FILES_PREFIX: 'drop/', PUBLIC_FILES_PREFIX: 'drop/', PUBLIC_FILES_BUCKET: 'other' }).status, 0);
});

test('delivery rules: defaults for new addresses, per-address overrides', async () => {
  let rules = (await call('GET', '/api/mail/rules')).json;
  assert.deepEqual(rules.defaults, { forward: true, notify: true, forwardStyle: 'inline' });
  const github = () => rules.rules.find((r: Json) => r.address === 'github@eisenberg.dev');
  const core = (r: Json) => ({ address: r.address, forward: r.forward, notify: r.notify, forwardStyle: r.forwardStyle, explicit: r.explicit });
  assert.deepEqual(core(github()), { address: 'github@eisenberg.dev', forward: true, notify: true, forwardStyle: 'inline', explicit: false });
  assert.equal(github().total, 2);
  assert.ok(github().lastReceived);
  assert.ok(!rules.rules.some((r: Json) => r.address.startsWith('reply-')), 'relay addresses are not listed');

  assert.equal((await call('POST', '/api/mail/rules', { address: 'GitHub@Eisenberg.dev', forward: false })).status, 204);
  rules = (await call('GET', '/api/mail/rules')).json;
  assert.deepEqual(core(github()), { address: 'github@eisenberg.dev', forward: false, notify: true, forwardStyle: 'inline', explicit: true });

  // flipping the defaults changes addresses without a rule, not the ones that have one
  assert.equal((await call('POST', '/api/mail/rules/defaults', { forward: false, notify: false, forwardStyle: 'attach' })).status, 204);
  assert.equal((await call('POST', '/api/mail/rules', { address: 'github@eisenberg.dev', forward: true })).status, 204);
  rules = (await call('GET', '/api/mail/rules')).json;
  assert.deepEqual(rules.defaults, { forward: false, notify: false, forwardStyle: 'attach' });
  assert.deepEqual(core(github()), { address: 'github@eisenberg.dev', forward: true, notify: true, forwardStyle: 'inline', explicit: true });
  const untouched = rules.rules.find((r: Json) => r.address === 'bank@eisenberg.dev');
  assert.deepEqual([untouched.forward, untouched.notify, untouched.forwardStyle, untouched.explicit], [false, false, 'attach', false]);

  // forward style is per address
  assert.equal((await call('POST', '/api/mail/rules', { address: 'github@eisenberg.dev', forwardStyle: 'attach' })).status, 204);
  assert.equal((await call('POST', '/api/mail/rules', { address: 'bank@eisenberg.dev', forwardStyle: 'inline' })).status, 204);
  rules = (await call('GET', '/api/mail/rules')).json;
  assert.equal(github().forwardStyle, 'attach');
  assert.equal(rules.rules.find((r: Json) => r.address === 'bank@eisenberg.dev').forwardStyle, 'inline');
  assert.equal((await call('POST', '/api/mail/rules', { address: 'github@eisenberg.dev', forwardStyle: 'carrier-pigeon' })).status, 400);
  assert.equal((await call('POST', '/api/mail/rules/defaults', { forwardStyle: 'x' })).status, 400);
  await call('POST', '/api/mail/rules/reset', { address: 'bank@eisenberg.dev' });

  // a rule for an address that has not received anything yet
  assert.equal((await call('POST', '/api/mail/rules', { address: 'future@quartzworks.example', notify: true })).status, 204);
  rules = (await call('GET', '/api/mail/rules')).json;
  assert.deepEqual(core(rules.rules.find((r: Json) => r.address === 'future@quartzworks.example')), { address: 'future@quartzworks.example', forward: false, notify: true, forwardStyle: 'attach', explicit: true });

  // an address that forwards to its own mailboxes (a group) instead of the default one
  const targetsOf = async (address: string) => ((await call('GET', '/api/mail/rules')).json as DeliveryRules).rules.find((r) => r.address === address)!.forwardTo;
  assert.deepEqual(await targetsOf('github@eisenberg.dev'), []);
  assert.equal((await call('POST', '/api/mail/rules', { address: 'team@quartzworks.example', forwardTo: ['Ann@Partners.example', 'raj@elsewhere.example', 'ann@partners.example'] })).status, 204);
  assert.deepEqual(await targetsOf('team@quartzworks.example'), ['ann@partners.example', 'raj@elsewhere.example']);
  assert.deepEqual((await local.pool.query(`select forward_to from address_rules where address = 'team@quartzworks.example'`)).rows[0].forward_to, ['ann@partners.example', 'raj@elsewhere.example']);
  // other changes leave the list alone; one string with separators works too; an empty list is "the default again"
  await call('POST', '/api/mail/rules', { address: 'team@quartzworks.example', notify: false });
  assert.deepEqual(await targetsOf('team@quartzworks.example'), ['ann@partners.example', 'raj@elsewhere.example']);
  assert.equal((await call('POST', '/api/mail/rules', { address: 'team@quartzworks.example', forwardTo: 'solo@partners.example; ' })).status, 204);
  assert.deepEqual(await targetsOf('team@quartzworks.example'), ['solo@partners.example']);
  for (const bad of [['loop@eisenberg.dev'], ['x@harborlight.example'], ['not-an-address'], ['a@b.example\r\nBcc: evil@x.example'], ['"quoted name" <a@b.example>'], Array.from({ length: 11 }, (_, i) => `m${i}@partners.example`), 7]) {
    assert.equal((await call('POST', '/api/mail/rules', { address: 'team@quartzworks.example', forwardTo: bad })).status, 400, JSON.stringify(bad));
  }
  assert.deepEqual(await targetsOf('team@quartzworks.example'), ['solo@partners.example']);
  assert.equal((await call('POST', '/api/mail/rules', { address: 'team@quartzworks.example', forwardTo: [] })).status, 204);
  assert.deepEqual(await targetsOf('team@quartzworks.example'), []);
  assert.equal((await local.pool.query(`select forward_to from address_rules where address = 'team@quartzworks.example'`)).rows[0].forward_to, null);
  await call('POST', '/api/mail/rules/reset', { address: 'team@quartzworks.example' });

  // block a leaked address and remember who it was given to
  assert.equal((await call('POST', '/api/mail/rules', { address: 'future@quartzworks.example', blocked: true, note: 'Given to  Acme\r\nnewsletter' })).status, 204);
  rules = (await call('GET', '/api/mail/rules')).json;
  const future = rules.rules.find((r: Json) => r.address === 'future@quartzworks.example');
  assert.deepEqual([future.blocked, future.note, future.blockedCount, future.total], [true, 'Given to Acme newsletter', 0, 0]);
  assert.equal((await call('POST', '/api/mail/rules', { address: 'future@quartzworks.example', blocked: false })).status, 204);

  assert.equal((await call('POST', '/api/mail/rules/reset', { address: 'github@eisenberg.dev' })).status, 204);
  rules = (await call('GET', '/api/mail/rules')).json;
  assert.equal(github().explicit, false);

  for (const address of ['nope', 'a@not-my-domain.example', 'reply-0123456789abcdef0123456789abcdef@eisenberg.dev', "x'--@eisenberg.dev\u0000"]) {
    assert.equal((await call('POST', '/api/mail/rules', { address, forward: true })).status, 400, address);
  }
  assert.equal((await call('POST', '/api/mail/rules', { address: 'a@eisenberg.dev' })).status, 400);
  assert.equal((await call('POST', '/api/mail/rules', { address: 'a@eisenberg.dev', forward: true }, { noCookie: true })).status, 401);
  await call('POST', '/api/mail/rules/defaults', { forward: true, notify: true, forwardStyle: 'inline' });
});

test('push subscriptions: only real push services are accepted, endpoints are never exposed', async () => {
  const keys = { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: 'tBHItJI5svbpez7KI4CCXg' };
  const status = (await call('GET', '/api/push')).json;
  assert.equal(status.available, true);
  assert.match(status.publicKey, /^[A-Za-z0-9_-]{80,}$/);
  assert.deepEqual(status.devices, []);

  for (const endpoint of ['http://169.254.169.254/latest/meta-data/', 'https://evil.example/push', 'https://fcm.googleapis.com.evil.example/x', 'http://fcm.googleapis.com/x', 'https://user:pw@fcm.googleapis.com/x', 'file:///etc/passwd', 'not a url']) {
    assert.equal((await call('POST', '/api/push/subscribe', { endpoint, keys })).status, 400, endpoint);
  }
  assert.equal((await call('POST', '/api/push/subscribe', { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: 'bad key!', auth: 'x' } })).status, 400);
  assert.equal((await call('POST', '/api/push/subscribe', { endpoint: 'https://web.push.apple.com/QOabc123', keys }, { noCookie: true })).status, 401);

  assert.equal((await call('POST', '/api/push/subscribe', { endpoint: 'https://web.push.apple.com/QOabc123', keys })).status, 204);
  assert.equal((await call('POST', '/api/push/subscribe', { endpoint: 'https://web.push.apple.com/QOabc123', keys })).status, 204); // idempotent
  const listed = await call('GET', '/api/push');
  assert.equal(listed.json.devices.length, 1);
  assert.ok(!listed.text.includes('QOabc123') && !listed.text.includes(keys.auth), 'capability URL and keys stay on the server');

  assert.equal((await call('POST', '/api/push/unsubscribe', { id: listed.json.devices[0].id })).status, 204);
  assert.deepEqual((await call('GET', '/api/push')).json.devices, []);
  assert.deepEqual((await call('POST', '/api/push/test')).json, { sent: 0, failed: 0 });
});

test('sessions slide: a session in use is extended, with a fresh cookie', async () => {
  await local.pool.query(`update webmail_sessions set expires_at = now() + interval '2 hours'`);
  const res = await call('GET', '/api/auth/me');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('set-cookie') ?? '', /^eisenmail_dev=[^;]+; Path=\/; HttpOnly; SameSite=Strict; Max-Age=2592000/);
  const { createHash } = await import('node:crypto');
  const mine = createHash('sha256').update(cookie.split('=')[1]).digest();
  const row = await local.pool.query(`select expires_at > now() + interval '29 days' as extended from webmail_sessions where token_hash = $1`, [mine]);
  assert.equal(row.rows[0].extended, true);
  const others = await local.pool.query(`select count(*)::int as n from webmail_sessions where token_hash <> $1 and expires_at > now() + interval '1 day'`, [mine]);
  assert.equal(others.rows[0].n, 0, 'only the session in use is extended');
  // not renewed again on the next request
  assert.equal((await call('GET', '/api/auth/me')).headers.get('set-cookie'), null);
});

test('web app files are served', async () => {
  // the test server has no static frontend; check the files themselves
  const manifest = JSON.parse(fs.readFileSync('public/manifest.webmanifest', 'utf8'));
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.start_url, '/mail');
  for (const icon of manifest.icons) assert.ok(fs.existsSync(path.join('public', icon.src)), icon.src);
  const sw = fs.readFileSync('public/sw.js', 'utf8');
  assert.ok(!/addEventListener\(['"]fetch/.test(sw), 'the service worker must not intercept or cache requests');
  assert.ok(fs.existsSync('public/icons/apple-touch-icon.png'));
});

test('start-up: the API waits for the database preparation, within a limit; a failed start is tried again', async () => {
  const { beginStartup, setSchemaState, setStartupTiming } = await import('../src/server/schema.js');
  try {
    setStartupTiming({ wait: 300, retryAfter: 200 });
    let release!: () => void;
    beginStartup(() => new Promise<void>((resolve) => (release = resolve)));
    // the adapter's readiness probe answers at once
    assert.equal((await fetch(`${base}/health`)).status, 200);
    // an API request waits, then says "starting" instead of running into a timeout
    const started = Date.now();
    const early = await call('GET', '/api/auth/me');
    assert.deepEqual([early.status, early.json.code, early.headers.get('retry-after')], [503, 'starting', '5']);
    assert.ok(Date.now() - started < 2000);
    // a request that is waiting when the preparation finishes goes through
    const waiting = call('GET', '/api/auth/me');
    setTimeout(() => release(), 50);
    assert.equal((await waiting).status, 200);

    // a failed start: requests are not held back, and a later request starts a fresh attempt
    let attempts = 0;
    beginStartup(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('connect ETIMEDOUT');
    });
    assert.equal((await call('GET', '/api/auth/me')).status, 200);
    assert.equal(attempts, 1);
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal((await call('GET', '/api/auth/me')).status, 200);
    assert.equal(attempts, 2, 'tried again after the failure');

    // an attempt that hangs is abandoned at the deadline, its connections are dropped, and a
    // later request starts afresh instead of waiting on it forever
    setStartupTiming({ wait: 200, retryAfter: 100, deadline: 300 });
    let resets = 0;
    let tries = 0;
    beginStartup(
      () => {
        tries += 1;
        return tries === 1 ? new Promise<void>(() => {}) : Promise.resolve();
      },
      () => (resets += 1),
    );
    assert.equal((await call('GET', '/api/auth/me')).json.code, 'starting');
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(resets, 1, 'the stuck attempt was given up and its connections dropped');
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal((await call('GET', '/api/auth/me')).status, 200);
    assert.equal(tries, 2);
  } finally {
    setStartupTiming({});
    beginStartup(async () => {});
    setSchemaState('current');
  }
});

test('the www name redirects to the site, keeping path and query, and nothing else is served there', async () => {
  const http = await import('node:http');
  const { default: config } = await import('../src/server/config.js');
  const target = new URL(base);
  // fetch() does not let a test choose the Host header, so these requests are made by hand
  const ask = (host: string, method: string, path: string) =>
    new Promise<{ status: number; location: string | undefined; hsts: string | undefined; body: string }>((resolve, reject) => {
      const req = http.request({ host: target.hostname, port: target.port, method, path, headers: { host, 'x-eisenmail': '1' } }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode!, location: res.headers.location, hsts: res.headers['x-content-type-options'] as string | undefined, body }));
      });
      req.on('error', reject);
      req.end();
    });
  const before = config.publicOrigin;
  config.publicOrigin = 'https://site.example';
  try {
    const page = await ask('www.site.example', 'GET', '/mail?mailbox=inbox&q=a%20b');
    assert.deepEqual([page.status, page.location, page.body], [301, 'https://site.example/mail?mailbox=inbox&q=a%20b', '']);
    assert.equal(page.hsts, 'nosniff', 'the security headers are on the redirect too');
    assert.equal((await ask('WWW.Site.Example', 'GET', '/')).location, 'https://site.example/');
    // nothing behind it is reachable on the www name: not the API, not a sign-in attempt
    assert.deepEqual([(await ask('www.site.example', 'GET', '/api/health')).status, (await ask('www.site.example', 'GET', '/api/auth/me')).status], [301, 301]);
    const post = await ask('www.site.example', 'POST', '/api/auth/login');
    assert.deepEqual([post.status, post.location], [308, 'https://site.example/api/auth/login']);
    // the target is always this site: a path that looks like another host stays a path here
    for (const path of ['//evil.example/x', '/\\evil.example', 'http://evil.example/x']) {
      const location = (await ask('www.site.example', 'GET', path)).location!;
      assert.equal(new URL(location).origin, 'https://site.example', path);
    }
    // the site itself, and any other name, are served as usual
    assert.equal((await ask('site.example', 'GET', '/api/health')).status, 200);
    assert.equal((await ask('www.other.example', 'GET', '/api/health')).status, 200);
    assert.equal((await ask('wwww.site.example', 'GET', '/api/health')).status, 200);
  } finally {
    config.publicOrigin = before;
  }
  assert.equal((await ask('www.site.example', 'GET', '/api/health')).status, 200, 'no site address configured: no redirect');
});

// ================================================================================================
// conversations, bulk read, contacts, drafts, settings, filters, retention, users, passkeys
// ================================================================================================

const rawMail = (headers: Record<string, string>, body = 'hello\r\n') => Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\r\n') + `\r\n\r\n${body}`;
async function deliver(id: string, to: string, headers: Record<string, string>, body?: string) {
  const { ingestPending } = await import('../src/server/ingest.js');
  const event = { mail: { timestamp: new Date().toISOString() }, receipt: { recipients: [to], spfVerdict: { status: 'PASS' } } };
  await local.pool.query('insert into lambda_inbox (message_id, event, email_raw) values ($1, $2, $3)', [id, JSON.stringify(event), Buffer.from(rawMail({ To: to, ...headers }, body))]);
  await ingestPending({ force: true });
}
const first = async (query: string): Promise<Json> => ((await call('GET', `/api/mail/messages?${query}`)).json as MessageList).messages[0];

test('schema: applied at start-up only when it changed', async () => {
  const { ensureSchema } = await import('../src/server/schema.js');
  assert.ok(['applied', 'current'].includes(await ensureSchema()));
  assert.equal(await ensureSchema(), 'current');
  assert.equal((await Promise.all([ensureSchema(), ensureSchema(), ensureSchema()])).join(), 'current,current,current');
});

test('conversations: a reply joins the thread of the message it answers', async () => {
  const original = await first('mailbox=inbox&q=scope%20question');
  assert.equal(original.threadCount, 2); // the seeded reply from the webmail
  const detail: MessageDetail = (await call('GET', `/api/mail/messages/${original.id}`)).json;
  assert.deepEqual(detail.thread.map((m) => m.direction), ['in', 'out']);
  assert.equal(detail.thread[0].id, original.id);

  await deliver('thread-3', 'hello@quartzworks.example', { From: 'Marcus Lee <marcus.lee@bluepeak.example>', Subject: 'Re: Data warehouse migration: scope question', 'In-Reply-To': detail.thread[1] ? '<unknown@x.example>' : '', References: '<scope-7@bluepeak.example>' }, 'Sounds good.\r\n');
  const again: MessageDetail = (await call('GET', `/api/mail/messages/${original.id}`)).json;
  assert.equal(again.thread.length, 3);
  assert.equal(again.thread[2].snippet, 'Sounds good.');
  // an unrelated message starts its own conversation
  const other = await first('mailbox=inbox&q=Fractional');
  assert.equal(other.threadCount, 1);
  assert.notEqual(other.threadId, original.threadId);
});

test('mark all as read is limited to the mailbox view it was asked for', async () => {
  await deliver('unread-1', 'bulk@quartzworks.example', { From: 'a@a.example', Subject: 'one' });
  await deliver('unread-2', 'bulk@quartzworks.example', { From: 'b@b.example', Subject: 'two' });
  const before: MailboxTree = (await call('GET', '/api/mail/mailboxes')).json;
  const res = await call('POST', '/api/mail/mark-read', { mailbox: 'inbox', address: 'bulk@quartzworks.example' });
  assert.equal(res.json.changed, 2);
  const after: MailboxTree = (await call('GET', '/api/mail/mailboxes')).json;
  assert.equal(after.inbox.unread, before.inbox.unread - 2);
  assert.equal((await call('POST', '/api/mail/mark-read', { mailbox: 'nope' })).status, 400);
});

test('contacts: people written to and from, for recipient autocomplete', async () => {
  const jane = (await call('GET', '/api/mail/contacts?q=jane')).json;
  assert.deepEqual(jane[0], { name: 'Jane Park', address: 'jane.park@northwind.example' });
  const byAddress = (await call('GET', '/api/mail/contacts?q=bluepeak')).json;
  assert.equal(byAddress[0].address, 'marcus.lee@bluepeak.example');
  assert.deepEqual((await call('GET', '/api/mail/contacts?q=%25')).json, []);
  assert.deepEqual((await call('GET', '/api/mail/contacts?q=')).json, []);
});

test('drafts: autosave, list, send removes the draft', async () => {
  const id = '11111111-2222-4333-8444-555555555555';
  const payload = { mode: 'new', from: 'sam@eisenberg.dev', to: 'x@y.example', cc: '', subject: 'Draft subject', text: 'work in progress' };
  assert.equal((await call('POST', '/api/mail/drafts', { id, payload })).status, 204);
  assert.equal((await call('POST', '/api/mail/drafts', { id, payload: { ...payload, text: 'more work', subject: 'Draft\r\nBcc: x@evil.example' } })).status, 204);
  const list = (await call('GET', '/api/mail/drafts')).json;
  assert.equal(list.length, 1);
  assert.equal(list[0].payload.text, 'more work');
  assert.equal(list[0].payload.subject, 'Draft Bcc: x@evil.example'); // one line
  assert.equal((await call('POST', '/api/mail/drafts', { id: 'not-a-uuid', payload })).status, 400);

  const sentNow = await call('POST', '/api/mail/send', { from: 'sam@eisenberg.dev', to: ['x@y.example'], subject: 'Draft subject', text: 'done', draftId: id });
  assert.equal(sentNow.status, 200, sentNow.text);
  assert.deepEqual((await call('GET', '/api/mail/drafts')).json, []);
});

test('settings: signature per user; filters act when mail is indexed', async () => {
  assert.equal((await call('POST', '/api/mail/settings', { signature: 'Sam Eisenberg\r\neisenberg.dev' })).status, 204);
  let settings = (await call('GET', '/api/mail/settings')).json;
  assert.equal(settings.signature, 'Sam Eisenberg\neisenberg.dev');
  assert.equal(settings.purgeAfterDays, 30);

  assert.equal((await call('POST', '/api/mail/filters', { action: 'archive' })).status, 400); // no condition
  assert.equal((await call('POST', '/api/mail/filters', { matchFrom: 'x', action: 'explode' })).status, 400);
  assert.equal((await call('POST', '/api/mail/filters', { matchFrom: 'DMARC Reporter', matchAddress: 'dmarc@', action: 'archive' })).status, 204);
  assert.equal((await call('POST', '/api/mail/filters', { matchSubject: 'invoice', action: 'flag' })).status, 204);
  settings = (await call('GET', '/api/mail/settings')).json;
  assert.equal(settings.filters.length, 2);

  await deliver('filter-1', 'dmarc@eisenberg.dev', { From: 'DMARC Reporter <noreply@reports.example>', Subject: 'Report domain: eisenberg.dev' });
  await deliver('filter-2', 'dmarc@eisenberg.dev', { From: 'Someone Else <x@reports.example>', Subject: 'Your Invoice 77' });
  const archived = await first('mailbox=archive&address=dmarc@eisenberg.dev');
  assert.equal(archived.subject, 'Report domain: eisenberg.dev');
  const flagged = await first('mailbox=inbox&address=dmarc@eisenberg.dev');
  assert.deepEqual([flagged.subject, flagged.isFlagged], ['Your Invoice 77', true]);

  // a disabled filter does nothing
  await call('POST', '/api/mail/filters/update', { id: settings.filters[1].id, enabled: false });
  await deliver('filter-3', 'dmarc@eisenberg.dev', { From: 'x@reports.example', Subject: 'another invoice' });
  assert.equal((await first('mailbox=inbox&address=dmarc@eisenberg.dev&q=another')).isFlagged, false);
  for (const f of settings.filters) await call('POST', '/api/mail/filters/delete', { id: f.id });
  assert.equal((await call('GET', '/api/mail/settings')).json.filters.length, 0);
});

test('retention: Trash and Junk empty themselves after the configured time', async () => {
  await deliver('old-trash', 'retention@quartzworks.example', { From: 'a@a.example', Subject: 'old trash' });
  await deliver('new-trash', 'retention@quartzworks.example', { From: 'a@a.example', Subject: 'new trash' });
  await local.pool.query(`update messages set mailbox = 'trash', prev_mailbox = 'inbox', trashed_at = now() - interval '40 days' where raw_id = 'old-trash'`);
  await local.pool.query(`update messages set mailbox = 'trash', prev_mailbox = 'inbox', trashed_at = now() - interval '2 days' where raw_id = 'new-trash'`);
  await local.pool.query('update mail_settings set last_purge_at = null');
  await call('GET', '/api/mail/mailboxes');
  const left = await local.pool.query(`select message_id from lambda_inbox where message_id in ('old-trash', 'new-trash')`);
  assert.deepEqual(left.rows.map((r) => r.message_id), ['new-trash']);
  // and not again until tomorrow
  await local.pool.query(`update messages set trashed_at = now() - interval '40 days' where raw_id = 'new-trash'`);
  await call('GET', '/api/mail/mailboxes');
  assert.equal((await local.pool.query(`select 1 from lambda_inbox where message_id = 'new-trash'`)).rowCount, 1);
});

test('attachments: only plain images can be shown in place', async () => {
  const logos = await first('mailbox=inbox&q=Logo%20concepts');
  const detail: MessageDetail = (await call('GET', `/api/mail/messages/${logos.id}`)).json;
  assert.equal(detail.attachments[0].previewable, true);
  const img = await call('GET', `/api/mail/messages/${logos.id}/attachments/0?inline=1`);
  assert.match(img.headers.get('content-disposition') ?? '', /^inline/);
  assert.equal(img.headers.get('content-type'), 'image/png');
  assert.match(img.headers.get('content-security-policy') ?? '', /sandbox/);

  const brief = await first('mailbox=inbox&q=Fractional');
  const pdf = await call('GET', `/api/mail/messages/${brief.id}/attachments/0?inline=1`);
  assert.match(pdf.headers.get('content-disposition') ?? '', /^attachment/);
  assert.equal(((await call('GET', `/api/mail/messages/${brief.id}`)).json as MessageDetail).attachments[0].previewable, false);
});

let memberCookie = '';
const asMember = () => ({ noCookie: true, headers: { cookie: memberCookie } });

test('users: a member sees only the mail of their domains', async () => {
  assert.equal((await call('GET', '/api/auth/me')).json.role, 'owner');
  assert.equal((await call('POST', '/api/users', { username: 'pat', password: 'short', domains: ['harborlight.example'] })).status, 400);
  assert.equal((await call('POST', '/api/users', { username: 'pat', password: 'a-long-enough-password', domains: [] })).status, 400);
  assert.equal((await call('POST', '/api/users', { username: 'pat', password: 'a-long-enough-password', domains: ['not-mine.example'] })).status, 400);
  assert.equal((await call('POST', '/api/users', { username: 'Pat', password: 'a-long-enough-password', domains: ['harborlight.example'] })).status, 204);
  assert.equal((await call('POST', '/api/users', { username: 'pat', password: 'a-long-enough-password', domains: ['harborlight.example'] })).status, 409);
  const listed = (await call('GET', '/api/users')).json;
  assert.deepEqual(listed.map((u: Json) => [u.username, u.role, u.domains]), [[DEV_USER.username, 'owner', null], ['pat', 'member', ['harborlight.example']]]);

  const login = await call('POST', '/api/auth/login', { username: 'pat', password: 'a-long-enough-password' }, { noCookie: true, headers: { 'x-forwarded-for': '198.51.100.201' } });
  assert.equal(login.status, 200, login.text);
  assert.deepEqual([login.json.role, login.json.domains], ['member', ['harborlight.example']]);
  memberCookie = login.headers.getSetCookie().find((c) => c.startsWith('eisenmail_dev='))!.split(';')[0];

  const tree: MailboxTree = (await call('GET', '/api/mail/mailboxes', undefined, asMember())).json;
  assert.deepEqual(tree.domains.map((d) => d.domain), ['harborlight.example']);
  const ownerTree: MailboxTree = (await call('GET', '/api/mail/mailboxes')).json;
  assert.ok(tree.inbox.total > 0 && tree.inbox.total < ownerTree.inbox.total);

  const list: MessageList = (await call('GET', '/api/mail/messages?mailbox=inbox&limit=200', undefined, asMember())).json;
  assert.equal(list.messages.length, tree.inbox.total);
  assert.ok(list.messages.every((m) => m.addresses.length > 0 && m.addresses.every((a) => a.endsWith('@harborlight.example'))), 'addresses on other domains are not shown');
  // a message that also went to an address on another domain is visible, without that address
  assert.ok(list.messages.some((m) => m.subject.startsWith('Harborlight LLC: annual report')));

  // where an address forwards to is the owner's business: a member neither sees nor sets it
  assert.equal((await call('POST', '/api/mail/rules', { address: 'billing@harborlight.example', forwardTo: ['books@accountant.example'] })).status, 204);
  const memberRules: DeliveryRules = (await call('GET', '/api/mail/rules', undefined, asMember())).json;
  assert.deepEqual(memberRules.rules.find((r) => r.address === 'billing@harborlight.example')!.forwardTo, []);
  assert.ok(!JSON.stringify(memberRules).includes('accountant.example'));
  assert.equal((await call('POST', '/api/mail/rules', { address: 'billing@harborlight.example', forwardTo: ['pat@private.example'] }, asMember())).status, 403);
  assert.equal((await call('POST', '/api/mail/rules', { address: 'billing@harborlight.example', forwardTo: [] }, asMember())).status, 403);
  // a member's own change to the same rule leaves the owner's list in place
  assert.equal((await call('POST', '/api/mail/rules', { address: 'billing@harborlight.example', notify: false }, asMember())).status, 204);
  assert.deepEqual(((await call('GET', '/api/mail/rules')).json as DeliveryRules).rules.find((r) => r.address === 'billing@harborlight.example')!.forwardTo, ['books@accountant.example']);
  // "Reset to the defaults" by a member puts the switches back but does not remove the owner's list, nor a block
  assert.equal((await call('POST', '/api/mail/rules/reset', { address: 'billing@harborlight.example' }, asMember())).status, 204);
  const afterReset = ((await call('GET', '/api/mail/rules')).json as DeliveryRules).rules.find((r) => r.address === 'billing@harborlight.example')!;
  assert.deepEqual([afterReset.forwardTo, afterReset.notify], [['books@accountant.example'], ((await call('GET', '/api/mail/rules')).json as DeliveryRules).defaults.notify]);
  await call('POST', '/api/mail/rules', { address: 'spam-trap@harborlight.example', blocked: true });
  await call('POST', '/api/mail/rules/reset', { address: 'spam-trap@harborlight.example' }, asMember());
  assert.equal(((await call('GET', '/api/mail/rules')).json as DeliveryRules).rules.find((r) => r.address === 'spam-trap@harborlight.example')!.blocked, true);
  // a rule with neither is removed by a member as before; the owner's reset removes everything
  await call('POST', '/api/mail/rules', { address: 'plain@harborlight.example', notify: false }, asMember());
  await call('POST', '/api/mail/rules/reset', { address: 'plain@harborlight.example' }, asMember());
  assert.equal((await local.pool.query(`select 1 from address_rules where address = 'plain@harborlight.example'`)).rowCount, 0);
  await call('POST', '/api/mail/rules/reset', { address: 'billing@harborlight.example' });
  await call('POST', '/api/mail/rules/reset', { address: 'spam-trap@harborlight.example' });
  assert.equal((await local.pool.query(`select 1 from address_rules where address in ('billing@harborlight.example', 'spam-trap@harborlight.example')`)).rowCount, 0);

  // Mail to a reply-... address is written by a private mailbox (a reply the relay refused). It shows
  // that mailbox's address, so only the owner sees it, also when the address is on the member's domain.
  const relayShaped = 'reply-0123456789abcdef0123456789abcdef@harborlight.example';
  await deliver('refused-reply-1', relayShaped, { From: 'Ann Private <ann@partners.example>', Subject: 'Re: refused relay attempt', 'Message-ID': '<refused-1@partners.example>' });
  const refused = await first('mailbox=inbox&q=refused+relay+attempt');
  assert.ok(refused, 'the owner sees it');
  assert.equal(((await call('GET', '/api/mail/messages?mailbox=inbox&q=refused+relay+attempt', undefined, asMember())).json as MessageList).messages.length, 0);
  assert.equal((await call('GET', `/api/mail/messages/${refused.id}`, undefined, asMember())).status, 404);
  assert.equal((await call('GET', `/api/mail/messages/${refused.id}/raw`, undefined, asMember())).status, 404);
  assert.ok(!JSON.stringify((await call('GET', '/api/mail/messages?mailbox=inbox&limit=200', undefined, asMember())).json).includes('ann@partners.example'));
  await call('POST', '/api/mail/messages/delete', { ids: [refused.id] });
  await call('PATCH', '/api/mail/messages', { ids: [refused.id], set: { mailbox: 'trash' } });
  await call('POST', '/api/mail/messages/delete', { ids: [refused.id] });

  // everything about another domain's mail is "not found" for the member
  const foreign = await first('mailbox=inbox&q=Fractional');
  assert.equal((await call('GET', `/api/mail/messages/${foreign.id}`, undefined, asMember())).status, 404);
  assert.equal((await call('GET', `/api/mail/messages/${foreign.id}/raw`, undefined, asMember())).status, 404);
  assert.equal((await call('GET', `/api/mail/messages/${foreign.id}/attachments/0`, undefined, asMember())).status, 404);
  assert.equal((await call('PATCH', '/api/mail/messages', { ids: [foreign.id], set: { isFlagged: true, mailbox: 'trash' } }, asMember())).json.changed, 0);
  assert.equal(((await call('GET', `/api/mail/messages/${foreign.id}`)).json as MessageDetail).mailbox, 'inbox');
  assert.equal((await call('POST', '/api/mail/messages/delete', { ids: [foreign.id] }, asMember())).json.deleted, 0);
  // asking for another domain's folder only ever returns mail the member may see anyway (here: the one cross-domain message)
  const sneaky: MessageList = (await call('GET', '/api/mail/messages?mailbox=inbox&domain=eisenberg.dev', undefined, asMember())).json;
  assert.ok(sneaky.messages.length <= 1 && sneaky.messages.every((m) => m.addresses.every((a) => a.endsWith('@harborlight.example'))));
  assert.equal(((await call('GET', '/api/mail/messages?mailbox=inbox&address=sam@eisenberg.dev&q=Fractional', undefined, asMember())).json as MessageList).messages.length, 0);
  assert.equal(((await call('GET', '/api/mail/messages?mailbox=inbox&q=Fractional', undefined, asMember())).json as MessageList).messages.length, 0);
  assert.equal((await call('POST', '/api/mail/send', { from: 'sam@eisenberg.dev', to: ['x@y.example'], subject: 's', text: 't' }, asMember())).status, 400);
  assert.equal((await call('POST', '/api/mail/send', { from: 'pat@harborlight.example', to: ['x@y.example'], subject: 's', text: 't', inReplyToId: foreign.id }, asMember())).status, 404);
  assert.equal((await call('POST', '/api/mail/send', { from: 'pat@harborlight.example', to: ['x@y.example'], subject: 's', text: 't' }, asMember())).status, 200);
  assert.deepEqual((await call('GET', '/api/mail/identities', undefined, asMember())).json.domains, ['harborlight.example']);
  assert.deepEqual((await call('GET', '/api/mail/contacts?q=jane', undefined, asMember())).json, []);

  // rules: only their domain; global settings and admin are the owner's
  const rules = (await call('GET', '/api/mail/rules', undefined, asMember())).json;
  assert.ok(rules.rules.length > 0 && rules.rules.every((r: Json) => r.address.endsWith('@harborlight.example')));
  assert.equal((await call('POST', '/api/mail/rules', { address: 'billing@harborlight.example', notify: false }, asMember())).status, 204);
  assert.equal((await call('POST', '/api/mail/rules', { address: 'sam@eisenberg.dev', forward: false }, asMember())).status, 403);
  for (const [method, url, body] of [
    ['POST', '/api/mail/rules/defaults', { forward: false }],
    ['POST', '/api/mail/filters', { matchFrom: 'x', action: 'trash' }],
    ['POST', '/api/mail/settings', { purgeAfterDays: 1 }],
    ['GET', '/api/users', undefined],
    ['POST', '/api/users', { username: 'eve', password: 'a-long-enough-password', domains: ['eisenberg.dev'] }],
    ['GET', '/api/files', undefined],
    ['POST', '/api/files/uploads', { name: 'x.txt', size: 1, contentType: 'text/plain' }],
  ] as const) {
    assert.equal((await call(method, url, body, asMember())).status, 403, `${method} ${url}`);
  }
  // drafts are private to each user
  await call('POST', '/api/mail/drafts', { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', payload: { mode: 'new', from: '', to: '', cc: '', subject: 'owner draft', text: '' } });
  assert.deepEqual((await call('GET', '/api/mail/drafts', undefined, asMember())).json, []);
  assert.equal((await call('POST', '/api/mail/drafts', { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', payload: { mode: 'new', from: '', to: '', cc: '', subject: 'hijack', text: '' } }, asMember())).status, 404);
  assert.equal((await call('GET', '/api/mail/drafts')).json[0].payload.subject, 'owner draft');

  // the owner changes the member's domains, then removes the member
  const pat = listed.find((u: Json) => u.username === 'pat');
  assert.equal((await call('POST', '/api/users/update', { id: pat.id, domains: ['quartzworks.example'] })).status, 204);
  assert.deepEqual(((await call('GET', '/api/mail/mailboxes', undefined, asMember())).json as MailboxTree).domains.map((d) => d.domain), ['quartzworks.example']);
  assert.equal((await call('POST', '/api/users/update', { id: listed[0].id, domains: ['eisenberg.dev'] })).status, 400); // owners are not editable here
  assert.equal((await call('POST', '/api/users/delete', { id: pat.id })).status, 204);
  assert.equal((await call('GET', '/api/auth/me', undefined, asMember())).status, 401);
});

test('passkeys: options are single-use challenges; registration needs the password', async () => {
  const options = await call('POST', '/api/auth/passkey/login-options', {}, { noCookie: true });
  assert.equal(options.status, 200);
  assert.ok(options.json.challenge.length >= 20);
  assert.equal(options.json.userVerification, 'required');
  assert.equal(options.json.allowCredentials, undefined, 'reveals no accounts');
  const challengeCookie = options.headers.getSetCookie().find((c) => c.startsWith('eisenmail_dev_wa='))!;
  assert.match(challengeCookie, /HttpOnly; SameSite=Strict/);
  const waCookie = challengeCookie.split(';')[0];

  const bogus = { id: 'AAAA', rawId: 'AAAA', type: 'public-key', response: { clientDataJSON: 'e30', authenticatorData: 'AA', signature: 'AA' }, clientExtensionResults: {} };
  assert.equal((await call('POST', '/api/auth/passkey/login', { response: bogus }, { noCookie: true, headers: { cookie: waCookie } })).status, 401);
  // the challenge was consumed by that attempt
  assert.equal((await call('POST', '/api/auth/passkey/login', { response: bogus }, { noCookie: true, headers: { cookie: waCookie } })).json.code, 'passkey_expired');
  assert.equal((await call('POST', '/api/auth/passkey/login', { response: bogus }, { noCookie: true })).json.code, 'passkey_expired');

  assert.equal((await call('POST', '/api/auth/passkeys/register-options', { currentPassword: 'wrong-wrong-wrong' })).status, 403);
  const reg = await call('POST', '/api/auth/passkeys/register-options', { currentPassword: DEV_USER.password });
  assert.equal(reg.status, 200);
  assert.equal(reg.json.authenticatorSelection.userVerification, 'required');
  assert.deepEqual((await call('GET', '/api/auth/passkeys')).json, []);
});

test('people: built from mail, edited and merged by hand, searched, and kept apart per sign-in', async () => {
  type Summary = { id: string; name: string; company: string; hidden: boolean; manual: boolean; addresses: string[]; messages: number; lastSeen: string | null };
  const list = async (q = '', opts = {}) => (await call('GET', `/api/people${q ? `?q=${encodeURIComponent(q)}` : ''}`, undefined, opts)).json as Summary[];
  const byName = (people: Summary[], name: string) => people.find((p) => p.name === name)!;

  // every sender of stored mail is in the owner's book; none of our own or relay addresses are
  const people = await list();
  const jane = byName(people, 'Jane Park');
  assert.ok(jane && jane.addresses.includes('jane.park@northwind.example') && !jane.manual && jane.messages >= 1 && jane.lastSeen);
  assert.ok(people.every((p) => p.addresses.every((a) => !/@(eisenberg\.dev|harborlight\.example|quartzworks\.example)$/.test(a) && !/^reply-[0-9a-f]{32}@/.test(a))));
  assert.deepEqual(people.map((p) => (p.name || p.company || p.addresses[0]).toLowerCase()), [...people.map((p) => (p.name || p.company || p.addresses[0]).toLowerCase())].sort(), 'sorted by name');
  // search matches names, companies and addresses
  assert.deepEqual((await list('northwind')).map((p) => p.name).sort(), ['Jane Park', 'Northwind Outfitters']);
  assert.equal((await list('zzz-nobody')).length, 0);

  // a person made by hand, taking over an address that mail had already made an entry for (a merge)
  const made = await call('POST', '/api/people', { name: 'Jane Park', company: 'Northwind', note: 'Bought the standing desk', addresses: 'Jane.Park@northwind.example, jp@home.example' });
  assert.equal(made.status, 200, made.text);
  const id = made.json.id as string;
  const after = await list();
  assert.equal(after.filter((p) => p.name === 'Jane Park').length, 1, 'the automatic entry was merged into the new one');
  const detail = (await call('GET', `/api/people/${id}`)).json;
  assert.deepEqual([detail.name, detail.company, detail.note, detail.manual, detail.hidden], ['Jane Park', 'Northwind', 'Bought the standing desk', true, false]);
  assert.deepEqual(detail.addresses.map((a: Json) => a.address).sort(), ['jane.park@northwind.example', 'jp@home.example']);
  assert.ok(detail.addresses.find((a: Json) => a.address === 'jane.park@northwind.example').received >= 1, 'the counts came along');

  // what is refused
  for (const bad of [{ name: 'X', addresses: ['me@eisenberg.dev'] }, { name: 'X', addresses: ['not-an-address'] }, { name: 'X', addresses: ['reply-0123456789abcdef0123456789abcdef@other.example'] }, { addresses: [] }, { name: 'X', addresses: Array.from({ length: 21 }, (_, i) => `a${i}@x.example`) }]) {
    assert.equal((await call('POST', '/api/people', bad)).status, 400, JSON.stringify(bad));
  }
  assert.equal((await call('GET', '/api/people/999999')).status, 404);
  assert.equal((await call('GET', '/api/people/abc')).status, 400);

  // all mail with the person, newest first, and mail sent to them joins it
  const before = (await call('GET', `/api/mail/messages?person=${id}`)).json as MessageList;
  assert.ok(before.messages.length >= 1);
  assert.ok(before.messages.every((m) => (m.direction === 'in' && m.from.address === 'jane.park@northwind.example') || (m.direction === 'out' && m.to.some((t) => t.address === 'jane.park@northwind.example'))), 'only mail from or to Jane');
  const first = (await call('GET', `/api/mail/messages/${before.messages.find((m) => m.direction === 'in')!.id}`)).json as MessageDetail;
  assert.equal((await call('POST', '/api/mail/send', { from: first.replyFrom, to: ['jp@home.example'], subject: 'Pickup', text: 'Saturday works.' })).status, 200);
  const withSent = (await call('GET', `/api/mail/messages?person=${id}`)).json as MessageList;
  assert.equal(withSent.messages.length, before.messages.length + 1);
  assert.equal(withSent.messages[0].direction, 'out');
  const sentCount = ((await call('GET', `/api/people/${id}`)).json.addresses as Json[]).find((a) => a.address === 'jp@home.example').sent;
  assert.equal(sentCount, 1);
  assert.equal((await call('GET', '/api/mail/messages?person=999999')).json.messages.length, 0);

  // the book comes first in recipient autocomplete, with the name you gave
  await call('POST', '/api/people/update', { id, name: 'Jane Park (desk)' });
  const suggested = (await call('GET', '/api/mail/contacts?q=jane')).json as { name: string; address: string }[];
  assert.equal(suggested[0].name, 'Jane Park (desk)');
  assert.ok(suggested.some((c) => c.address === 'jp@home.example'));
  // hidden: out of the suggestions and marked in the list; shown again on request
  assert.equal((await call('POST', '/api/people/update', { id, hidden: true })).status, 204);
  assert.ok(!((await call('GET', '/api/mail/contacts?q=jane')).json as Json[]).some((c) => c.address === 'jp@home.example'));
  assert.equal((await list()).find((p) => p.id === id)!.hidden, true);
  await call('POST', '/api/people/update', { id, hidden: false });
  // taking an address away forgets it; the automatic entry is not recreated for old mail
  await call('POST', '/api/people/update', { id, addresses: ['jp@home.example'] });
  assert.deepEqual(((await call('GET', `/api/people/${id}`)).json.addresses as Json[]).map((a) => a.address), ['jp@home.example']);

  // a member has a book of their own, built from the mail of their domains only
  await call('POST', '/api/users', { username: 'quinn', password: 'a-long-enough-password', domains: ['harborlight.example'] });
  const quinnLogin = await call('POST', '/api/auth/login', { username: 'quinn', password: 'a-long-enough-password' }, { noCookie: true, headers: { 'x-forwarded-for': '198.51.100.240' } });
  const asQuinn = () => ({ noCookie: true, headers: { cookie: quinnLogin.headers.getSetCookie().find((c) => c.startsWith('eisenmail_dev='))!.split(';')[0] } });
  const mine = await list('', asQuinn());
  assert.ok(mine.length > 0 && mine.length < people.length);
  assert.ok(!mine.some((p) => p.addresses.includes('jane.park@northwind.example')), 'Jane wrote to another domain');
  assert.equal((await call('GET', `/api/people/${id}`, undefined, asQuinn())).status, 404);
  assert.equal((await call('POST', '/api/people/update', { id, name: 'x' }, asQuinn())).status, 404);
  assert.equal(((await call('GET', `/api/mail/messages?person=${id}`, undefined, asQuinn())).json as MessageList).messages.length, 0);
  assert.equal((await call('POST', '/api/people/delete', { id }, asQuinn())).status, 404);

  // the sender's name links to the person; an unknown address is answered with no id
  assert.equal((await call('GET', '/api/people/by-address?address=JP@Home.example')).json.id, id);
  assert.equal((await call('GET', '/api/people/by-address?address=nobody@nowhere.example')).json.id, null);

  assert.equal((await call('POST', '/api/people/delete', { id })).status, 204);
  assert.equal((await call('GET', `/api/people/${id}`)).status, 404);
  const quinn = ((await call('GET', '/api/users')).json as Json[]).find((u) => u.username === 'quinn');
  await call('POST', '/api/users/delete', { id: quinn.id });
});

test('review fixes: what a member can infer, and what a password change invalidates', async () => {
  const keys = { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: 'tBHItJI5svbpez7KI4CCXg' };
  // usernames are unique without regard to case
  assert.equal((await call('POST', '/api/users', { username: DEV_USER.username.toUpperCase(), password: 'a-long-enough-password', domains: ['harborlight.example'] })).status, 409);
  assert.equal((await call('POST', '/api/users', { username: 'kim', password: 'a-long-enough-password', domains: ['harborlight.example'] })).status, 204);
  const login = await call('POST', '/api/auth/login', { username: 'kim', password: 'a-long-enough-password' }, { noCookie: true, headers: { 'x-forwarded-for': '198.51.100.210' } });
  const kim = { noCookie: true, headers: { cookie: login.headers.getSetCookie().find((c) => c.startsWith('eisenmail_dev='))!.split(';')[0] } };

  // a conversation on another domain cannot be sized up through a reply that lands on the member's domain
  const foreign = await first('mailbox=inbox&q=Fractional');
  const foreignDetail: MessageDetail = (await call('GET', `/api/mail/messages/${foreign.id}`)).json;
  await deliver('oracle-1', 'info@harborlight.example', { From: 'x@x.example', Subject: 'Re: probing', 'In-Reply-To': foreignDetail.messageIdHeader ?? '<none@x.example>', 'Message-ID': '<oracle-1@x.example>' });
  const seen = ((await call('GET', '/api/mail/messages?mailbox=inbox&q=probing', undefined, kim)).json as MessageList).messages[0];
  assert.equal(seen.threadCount, 1, 'the member sees only their own message in the thread');
  assert.equal(((await call('GET', `/api/mail/messages/${seen.id}`, undefined, kim)).json as MessageDetail).thread.length, 1);
  assert.equal((await first('mailbox=inbox&q=probing')).threadCount, 2, 'the owner sees the whole conversation');

  // a hidden co-recipient on another domain cannot be found by search or by the folder filters
  await local.pool.query(
    `insert into lambda_inbox (message_id, event, email_raw) values ('hidden-1', $1, $2)`,
    [JSON.stringify({ mail: { timestamp: new Date().toISOString() }, receipt: { recipients: ['info@harborlight.example', 'hidden-alias-7731@eisenberg.dev'] } }), Buffer.from(rawMail({ From: 'y@y.example', To: 'undisclosed-recipients:;', Subject: 'two recipients' }))],
  );
  await (await import('../src/server/ingest.js')).ingestPending({ force: true });
  const count = async (query: string, as?: typeof kim) => ((await call('GET', `/api/mail/messages?mailbox=inbox&${query}`, undefined, as)).json as MessageList).messages.length;
  assert.equal(await count('q=two%20recipients', kim), 1);
  assert.equal(await count('q=hidden-alias-77', kim), 0);
  assert.equal(await count('q=info@harborlight', kim) > 0, true);
  assert.equal(await count('address=hidden-alias-7731@eisenberg.dev', kim), 0);
  assert.equal(await count('domain=eisenberg.dev', kim), 0);
  assert.equal(await count('q=hidden-alias-77'), 1, 'the owner can search it');

  // blocking is the owner's decision
  assert.equal((await call('POST', '/api/mail/rules', { address: 'info@harborlight.example', blocked: true }, kim)).status, 403);
  assert.equal((await call('POST', '/api/mail/rules', { address: 'info@harborlight.example', note: 'front desk' }, kim)).status, 204);

  // autocomplete: a stranger's display name that looks like an address is not shown, and people written to come first
  for (let i = 0; i < 6; i++) await deliver(`poison-${i}`, 'sam@eisenberg.dev', { From: '"jane.park@northwind.example" <jane.park@northwind.example.evil.test>', Subject: `hello ${i}` });
  const suggestions = (await call('GET', '/api/mail/contacts?q=jane')).json;
  assert.equal(suggestions[0].address, 'jane.park@northwind.example', 'the person actually written to ranks first');
  const planted = suggestions.find((c: Json) => c.address.endsWith('.evil.test'));
  assert.ok(!planted || planted.name === '', 'a display name that imitates an address is dropped');

  // an owner's reset of a member removes the member's sessions and notification subscriptions
  assert.equal((await call('POST', '/api/push/subscribe', { endpoint: 'https://web.push.apple.com/kim-phone', keys }, kim)).status, 204);
  const users = (await call('GET', '/api/users')).json;
  const kimId = users.find((u: Json) => u.username === 'kim').id;
  assert.equal((await call('POST', '/api/users/update', { id: kimId, password: 'another-long-password' })).status, 204);
  assert.equal((await call('GET', '/api/auth/me', undefined, kim)).status, 401);
  assert.equal((await local.pool.query('select 1 from push_subscriptions where user_id = $1', [kimId])).rowCount, 0);
  await call('POST', '/api/users/delete', { id: kimId });

  // changing your own password removes passkeys, trusted browsers and notification subscriptions
  const me = (await local.pool.query('select id from webmail_users where email = $1', [DEV_USER.username])).rows[0].id;
  await call('POST', '/api/push/subscribe', { endpoint: 'https://web.push.apple.com/owner-phone', keys });
  await local.pool.query(`insert into webauthn_credentials (credential_id, user_id, public_key) values ('planted-by-intruder', $1, '\\x00')`, [me]);
  assert.equal((await call('POST', '/api/auth/password', { currentPassword: DEV_USER.password, newPassword: 'a-brand-new-password-1' })).status, 200);
  for (const table of ['webauthn_credentials', 'push_subscriptions', 'webmail_devices']) {
    assert.equal((await local.pool.query(`select 1 from ${table} where user_id = $1`, [me])).rowCount, 0, table);
  }
  assert.equal((await call('GET', '/api/auth/me')).status, 200, 'this session stays');
  assert.equal((await call('POST', '/api/auth/password', { currentPassword: 'a-brand-new-password-1', newPassword: DEV_USER.password })).status, 200);

  // signing out takes the device's subscription with it
  await call('POST', '/api/push/subscribe', { endpoint: 'https://web.push.apple.com/owner-phone', keys });
  assert.equal((await call('POST', '/api/auth/logout', { pushEndpoint: 'https://web.push.apple.com/owner-phone' })).status, 204);
  assert.equal((await local.pool.query('select 1 from push_subscriptions where user_id = $1', [me])).rowCount, 0);
});

test('image proxy: only public raster images, only for addresses that are in the message', async () => {
  const http = await import('node:http');
  const { default: config } = await import('../src/server/config.js');
  const { isPublicAddress, fetchable, sniffImage } = await import('../src/server/image-proxy.js');

  // ---- which addresses may ever be fetched
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.9', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:169.254.169.254', '64:ff9b::7f00:1', 'not-an-ip']) {
    assert.equal(isPublicAddress(ip), false, ip);
  }
  for (const ip of ['93.184.216.34', '8.8.8.8', '2606:4700:4700::1111', '::ffff:8.8.8.8']) assert.equal(isPublicAddress(ip), true, ip);
  for (const url of ['http://169.254.169.254/latest/meta-data/', 'http://127.0.0.1:54329/', 'https://[::1]/x.png', 'https://user:pw@cdn.example/x.png', 'https://cdn.example:8443/x.png', 'ftp://cdn.example/x.png', 'file:///etc/passwd', 'javascript:alert(1)', 'data:image/png;base64,AAAA', '', `https://cdn.example/${'a'.repeat(2100)}`]) {
    assert.equal(fetchable(url), null, url);
  }
  assert.equal(fetchable('//cdn.example/a.png')!.toString(), 'https://cdn.example/a.png');
  assert.equal(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')), null);
  assert.equal(sniffImage(Buffer.from('<html><script>alert(1)</script></html>')), null);
  assert.equal(sniffImage(Buffer.from('GIF89a........')), 'image/gif');

  // the previous test signed out; sign in again (clearing the failures earlier tests left on purpose)
  await local.pool.query('delete from webmail_login_attempts');
  const again = await call('POST', '/api/auth/login', DEV_USER, { noCookie: true });
  assert.equal(again.status, 200, again.text);
  cookie = again.headers.getSetCookie().find((c) => c.startsWith('eisenmail_dev='))!.split(';')[0];

  // ---- a server standing in for a sender's image host
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  const seen: { url: string; headers: Record<string, unknown> }[] = [];
  const host = http.createServer((req, res) => {
    seen.push({ url: req.url ?? '', headers: req.headers });
    const send = (status: number, type: string, body: Buffer | string, extra: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': type, ...extra });
      res.end(body);
    };
    const path = new URL(req.url ?? '/', 'http://sender.example').pathname;
    if (path === '/pixel.png') send(200, 'image/png', png);
    else if (path === '/moved') send(302, 'text/plain', '', { location: '/pixel.png' });
    else if (path === '/loop') send(302, 'text/plain', '', { location: '/loop' });
    else if (path === '/to-credentials') send(302, 'text/plain', '', { location: 'http://user:pw@127.0.0.1/pixel.png' });
    else if (path === '/to-file') send(302, 'text/plain', '', { location: 'file:///etc/passwd' });
    else if (path === '/fake.png') send(200, 'image/png', '<html><script>alert(document.domain)</script></html>');
    else if (path === '/evil.svg') send(200, 'image/svg+xml', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    else if (path === '/huge.png') send(200, 'image/png', Buffer.concat([png, Buffer.alloc(config.imageProxy.maxBytes + 10)]));
    else send(404, 'text/plain', 'no');
  });
  await new Promise<void>((r) => host.listen(0, '127.0.0.1', r));
  after(() => void host.close()); // even if an assertion below throws
  const origin = `http://127.0.0.1:${(host.address() as AddressInfo).port}`;
  const paths = ['/pixel.png', '/moved', '/loop', '/to-credentials', '/to-file', '/fake.png', '/evil.svg', '/huge.png', '/missing.png'];
  const body = `<html><body><p>pictures</p>${paths.map((p) => `<img src="${origin}${p}?a=1&amp;b=2" width="300" height="120">`).join('')}<img src="http://localhost/x.png"><img src="http://169.254.169.254/latest/meta-data/iam/"></body></html>`;
  await deliver('proxy-1', 'pics@eisenberg.dev', { From: 'Shop <news@shop.example>', Subject: 'proxy pictures', 'Content-Type': 'text/html; charset=utf-8' }, body);
  const message = await first('mailbox=inbox&q=proxy%20pictures');
  const urlOf = (p: string) => `${origin}${p}?a=1&b=2`; // as the browser sees the attribute

  try {
    // ---- with the production safeguards: nothing on a private address gets a link, or is fetched
    config.imageProxy.allowPrivate = false;
    const locked = (await call('POST', `/api/mail/messages/${message.id}/image-links`, { urls: [...paths.map(urlOf), 'http://localhost/x.png', 'http://169.254.169.254/latest/meta-data/iam/'] })).json.links;
    assert.deepEqual(Object.keys(locked), ['http://localhost/x.png'], 'IP literals and odd ports never get a link');
    const blockedFetch = await call('GET', locked['http://localhost/x.png']);
    assert.equal(blockedFetch.status, 502, 'a name that resolves to loopback is refused at connect time');
    assert.equal(seen.length, 0, 'nothing was requested');

    // ---- with loopback allowed (tests only), the proxy itself can be exercised
    config.imageProxy.allowPrivate = true;
    const res = await call('POST', `/api/mail/messages/${message.id}/image-links`, { urls: [...paths.map(urlOf), 'https://elsewhere.example/not-in-the-message.png'] });
    const links: Record<string, string> = res.json.links;
    assert.equal(links['https://elsewhere.example/not-in-the-message.png'], undefined, 'only addresses that are in the message');
    assert.equal(Object.keys(links).length, paths.length);
    assert.match(links[urlOf('/pixel.png')], /^\/api\/mail\/image\/[A-Za-z0-9_-]{24}\/[A-Za-z0-9_-]+$/);

    const ok = await call('GET', links[urlOf('/pixel.png')]);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('content-type'), 'image/png');
    assert.match(ok.headers.get('content-security-policy') ?? '', /sandbox/);
    assert.equal(ok.headers.get('x-content-type-options'), 'nosniff');
    // what the sender's server learned: nothing about the reader
    const hit = seen.at(-1)!;
    assert.equal(hit.url, '/pixel.png?a=1&b=2');
    assert.equal(hit.headers['user-agent'], 'Mozilla/5.0 (compatible; ImageProxy)');
    for (const h of ['cookie', 'referer', 'origin', 'accept-language', 'x-forwarded-for', 'authorization']) assert.equal(hit.headers[h], undefined, h);

    assert.equal((await call('GET', links[urlOf('/moved')])).status, 200, 'redirects are followed');
    assert.equal((await call('GET', links[urlOf('/loop')])).status, 502, 'but not forever');
    assert.equal((await call('GET', links[urlOf('/to-credentials')])).status, 502);
    assert.equal((await call('GET', links[urlOf('/to-file')])).status, 502);
    assert.equal((await call('GET', links[urlOf('/fake.png')])).status, 415, 'html labelled as png is not served');
    assert.equal((await call('GET', links[urlOf('/evil.svg')])).status, 415, 'svg is not served');
    assert.equal((await call('GET', links[urlOf('/huge.png')])).status, 413);
    assert.equal((await call('GET', links[urlOf('/missing.png')])).status, 502);

    // a link cannot be altered to point somewhere else, and needs a session
    const [, , , , sig, encoded] = links[urlOf('/pixel.png')].split('/');
    const other = Buffer.from(`${origin}/fake.png`).toString('base64url');
    assert.equal((await call('GET', `/api/mail/image/${sig}/${other}`)).status, 404);
    assert.equal((await call('GET', `/api/mail/image/${'A'.repeat(24)}/${encoded}`)).status, 404);
    assert.equal((await call('GET', links[urlOf('/pixel.png')], undefined, { noCookie: true })).status, 401);
    assert.equal((await call('POST', '/api/mail/messages/999999999/image-links', { urls: [urlOf('/pixel.png')] })).status, 404);
    assert.equal((await call('POST', `/api/mail/messages/${message.id}/image-links`, { urls: 'nope' })).status, 400);
  } finally {
    config.imageProxy.allowPrivate = false;
    host.close();
  }
});

test('authenticator: secrets are stored encrypted, only codes come back, each user has their own', async () => {
  const { totpCode, base32Decode } = await import('../src/server/otp.js');
  const { parseOtpauth, parseMigration } = await import('../src/server/vault.js');
  // RFC 6238 test vectors (secret "12345678901234567890", time 59 s)
  assert.equal(totpCode(Buffer.from('12345678901234567890'), 1, 'SHA1', 8), '94287082');
  assert.equal(totpCode(Buffer.from('12345678901234567890123456789012'), 1, 'SHA256', 8), '46119246');

  const secret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
  const uri = `otpauth://totp/GitHub:sam%40example.org?secret=${secret}&issuer=GitHub`;
  assert.deepEqual({ ...parseOtpauth(uri), secret: undefined }, { issuer: 'GitHub', account: 'sam@example.org', secret: undefined, algorithm: 'SHA1', digits: 6, period: 30 });

  assert.deepEqual((await call('GET', '/api/codes')).json, { available: true, entries: [] });
  assert.equal((await call('POST', '/api/codes', { uris: [uri, 'otpauth://totp/AWS:root?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&algorithm=SHA256&digits=8&period=60'] })).json.added, 2);
  const listed = (await call('GET', '/api/codes')).json.entries;
  assert.deepEqual(listed.map((e: Json) => [e.issuer, e.account, e.code.length, e.period]), [['AWS', 'root', 8, 60], ['GitHub', 'sam@example.org', 6, 30]]);
  const github = listed[1];
  const step = Math.floor(Date.now() / 30_000);
  assert.ok([step - 1, step, step + 1].some((s) => totpCode(base32Decode(secret), s) === github.code), 'the code is the right one for now');
  assert.ok(github.remaining >= 1 && github.remaining <= 30);
  assert.ok(!JSON.stringify(listed).includes(secret), 'the secret itself is never returned');
  // at rest: encrypted, and not with something that leaves the plain bytes visible
  const rows = await local.pool.query('select secret_enc from totp_entries');
  assert.ok(rows.rows.every((r) => !r.secret_enc.includes(base32Decode(secret)) && r.secret_enc.length >= 28 + 16));

  // a Google Authenticator export code: two accounts in one protocol-buffers payload
  const field = (n: number, wire: number, body: Buffer | number) => (wire === 2 ? Buffer.concat([Buffer.from([(n << 3) | 2, (body as Buffer).length]), body as Buffer]) : Buffer.from([(n << 3) | 0, body as number]));
  const account = (name: string, issuer: string, type: number) => field(1, 2, Buffer.concat([field(1, 2, Buffer.from('migrated-secret-0001')), field(2, 2, Buffer.from(name)), field(3, 2, Buffer.from(issuer)), field(4, 0, 1), field(5, 0, 1), field(6, 0, type)]));
  const migration = `otpauth-migration://offline?data=${encodeURIComponent(Buffer.concat([account('Dropbox:sam@example.org', 'Dropbox', 2), account('old-hotp', 'Counter', 1), account('sam@work.example', 'Okta', 2)]).toString('base64'))}`;
  assert.deepEqual(parseMigration(migration).map((p) => [p.issuer, p.account]), [['Dropbox', 'sam@example.org'], ['Okta', 'sam@work.example']]);
  // a real export also carries version and batch fields; a negative batch id is a ten byte varint
  const withBatch = `otpauth-migration://offline?data=${encodeURIComponent(Buffer.concat([account('sam@example.org', 'Slack', 2), field(2, 0, 1), field(3, 0, 1), field(4, 0, 0), Buffer.from([(5 << 3) | 0, 0x9c, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01])]).toString('base64'))}`;
  assert.deepEqual(parseMigration(withBatch).map((p) => p.issuer), ['Slack']);
  assert.throws(() => parseMigration(`otpauth-migration://offline?data=${encodeURIComponent(Buffer.from([(5 << 3) | 0, ...Array(11).fill(0xff)]).toString('base64'))}`), /damaged/);
  assert.equal((await call('POST', '/api/codes', { uris: [migration] })).json.added, 2);
  assert.equal((await call('POST', '/api/codes', { manual: { issuer: 'Bank', account: 'sam', secret: 'jbsw y3dp ehpk 3pxp jbsw y3dp ehpk 3pxp' } })).json.added, 1);

  for (const bad of [{ uris: ['https://example.org'] }, { uris: ['otpauth://hotp/X?secret=JBSWY3DPEHPK3PXP&counter=1'] }, { uris: ['otpauth://totp/X?secret=AA'] }, { manual: { secret: 'short' } }, {}, { uris: ['otpauth-migration://offline?data=%%%'] }, { uris: ['otpauth://totp/Acme%ZZ:me?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP'] }, { uris: [''] }, { uris: ['mailto:x@y.example'] }, { uris: ['OTPAUTH-MIGRATION://offline?data=%%%'] }]) {
    assert.equal((await call('POST', '/api/codes', bad)).status, 400, JSON.stringify(bad));
  }

  // another user sees none of it and cannot touch it
  await call('POST', '/api/users', { username: 'lee', password: 'a-long-enough-password', domains: ['harborlight.example'] });
  const login = await call('POST', '/api/auth/login', { username: 'lee', password: 'a-long-enough-password' }, { noCookie: true, headers: { 'x-forwarded-for': '198.51.100.220' } });
  const lee = { noCookie: true, headers: { cookie: login.headers.getSetCookie().find((c) => c.startsWith('eisenmail_dev='))!.split(';')[0] } };
  assert.deepEqual((await call('GET', '/api/codes', undefined, lee)).json.entries, []);
  await call('POST', '/api/codes/delete', { id: github.id }, lee);
  assert.equal((await call('POST', '/api/codes/rename', { id: github.id, issuer: 'x', account: 'y' }, lee)).status, 404);
  assert.equal((await call('GET', '/api/codes')).json.entries.length, 5);
  // a row copied to another user does not decrypt there
  await local.pool.query(`insert into totp_entries (user_id, issuer, account, secret_enc) select (select id from webmail_users where email = 'lee'), 'stolen', '', secret_enc from totp_entries where id = $1`, [github.id]);
  assert.equal((await call('GET', '/api/codes', undefined, lee)).json.entries[0].code, '');
  assert.equal((await call('GET', '/api/codes', undefined, { noCookie: true })).status, 401);

  assert.equal((await call('POST', '/api/codes/rename', { id: github.id, issuer: 'GitHub (work)', account: 'sam' })).status, 204);
  assert.equal((await call('POST', '/api/codes/delete', { id: listed[0].id })).status, 204);
  const after = (await call('GET', '/api/codes')).json.entries;
  assert.equal(after.length, 4);
  assert.ok(after.some((e: Json) => e.issuer === 'GitHub (work)'));
  const users = (await call('GET', '/api/users')).json;
  await call('POST', '/api/users/delete', { id: users.find((u: Json) => u.username === 'lee').id });
  // a removed member's entries go with them
  assert.equal((await local.pool.query(`select 1 from totp_entries where issuer = 'stolen'`)).rowCount, 0);
});

test('sign-in code by email: required after the password, single use, and a fresh sign-in may add a passkey', async () => {
  const codeIn = (m: { raw: string }) => /Code: (\d{6})/.exec(m.raw)![1];
  const mailsTo = (address: string) => sent.filter((m) => m.to.includes(address));

  // the mailbox must be outside this system, and the password is needed to set it
  for (const bad of ['me@eisenberg.dev', 'me', 'me@host', '@host.example', 'me@.example', 'me@host.', 'me@@host.example', 'me x@host.example', `${'a'.repeat(250)}@host.example`, 'me@' + 'b.'.repeat(5000) + 'c']) {
    const started = Date.now();
    assert.equal((await call('POST', '/api/auth/email-check/start', { email: bad, currentPassword: DEV_USER.password })).status, 400, bad.slice(0, 40));
    assert.ok(Date.now() - started < 2000, 'refused at once, however long the input');
  }
  assert.equal((await call('POST', '/api/auth/email-check/start', { email: 'me@private.example', currentPassword: 'wrong-wrong-wrong' })).status, 403);
  const started = await call('POST', '/api/auth/email-check/start', { email: 'Me@Private.example', currentPassword: DEV_USER.password });
  assert.deepEqual(started.json, { sentTo: 'm•••@private.example' });
  const setup = mailsTo('me@private.example').at(-1)!;
  assert.match(setup.from, /^no-reply@/);
  assert.equal((await call('POST', '/api/auth/email-check/confirm', { code: '000000' })).status, 400);
  assert.equal((await call('POST', '/api/auth/email-check/confirm', { code: codeIn(setup) })).status, 200);
  assert.equal((await call('GET', '/api/auth/me')).json.emailCheck, 'm•••@private.example');

  // signing in: the password alone is no longer enough
  await local.pool.query('delete from login_challenges');
  const ip = { 'x-forwarded-for': '198.51.100.230' };
  const first = await call('POST', '/api/auth/login', DEV_USER, { noCookie: true, headers: ip });
  assert.equal(first.status, 401);
  assert.equal(first.json.code, 'email_code_required');
  assert.match(first.json.error, /m•••@private\.example/);
  assert.equal(first.headers.get('set-cookie'), null);
  const mail = mailsTo('me@private.example').at(-1)!;
  assert.match(mail.raw, /Subject: Your sign-in code/);
  assert.doesNotMatch(mail.raw, new RegExp(DEV_USER.password));
  const count = mailsTo('me@private.example').length;
  // asking again within a minute does not send another
  await call('POST', '/api/auth/login', DEV_USER, { noCookie: true, headers: ip });
  assert.equal(mailsTo('me@private.example').length, count);
  // the stored code is a hash
  const stored = await local.pool.query('select code_hash from login_challenges');
  assert.ok(stored.rows.every((r) => !r.code_hash.toString('utf8').includes(codeIn(mail))));

  assert.equal((await call('POST', '/api/auth/login', { ...DEV_USER, code: '123456' === codeIn(mail) ? '654321' : '123456' }, { noCookie: true, headers: ip })).json.code, 'bad_email_code');
  // a wrong password with the right code gets nowhere
  assert.equal((await call('POST', '/api/auth/login', { username: DEV_USER.username, password: 'not-the-password-1', code: codeIn(mail) }, { noCookie: true, headers: ip })).json.code, 'bad_credentials');
  const ok = await call('POST', '/api/auth/login', { ...DEV_USER, code: codeIn(mail) }, { noCookie: true, headers: ip });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json.fresh, true);
  // the code cannot be used twice
  assert.notEqual((await call('POST', '/api/auth/login', { ...DEV_USER, code: codeIn(mail) }, { noCookie: true, headers: ip })).status, 200);

  // five wrong tries kill a code, even if the sixth is right
  await local.pool.query('delete from login_challenges');
  await local.pool.query('delete from webmail_login_attempts');
  await call('POST', '/api/auth/login', DEV_USER, { noCookie: true, headers: ip });
  const second = codeIn(mailsTo('me@private.example').at(-1)!);
  await local.pool.query('update login_challenges set attempts = 5');
  assert.equal((await call('POST', '/api/auth/login', { ...DEV_USER, code: second }, { noCookie: true, headers: ip })).json.code, 'bad_email_code');
  await local.pool.query('delete from webmail_login_attempts');

  // asking for more codes does not buy more tries: only the newest code counts
  await local.pool.query('delete from login_challenges');
  await call('POST', '/api/auth/login', DEV_USER, { noCookie: true, headers: ip });
  const older = codeIn(mailsTo('me@private.example').at(-1)!);
  await local.pool.query(`update login_challenges set created_at = created_at - interval '2 minutes'`);
  await call('POST', '/api/auth/login', DEV_USER, { noCookie: true, headers: ip });
  const newer = codeIn(mailsTo('me@private.example').at(-1)!);
  assert.equal((await local.pool.query('select 1 from login_challenges where expires_at > now()')).rowCount, 1);
  const wrong = ['111111', '222222', '333333', '444444', '555555', '666666', '777777'].filter((c) => c !== older && c !== newer);
  for (const guess of wrong.slice(0, 5)) {
    assert.equal((await call('POST', '/api/auth/login', { ...DEV_USER, code: guess }, { noCookie: true, headers: ip })).json.code, 'bad_email_code');
    await local.pool.query('delete from webmail_login_attempts');
  }
  for (const dead of [older, newer]) {
    assert.equal((await call('POST', '/api/auth/login', { ...DEV_USER, code: dead }, { noCookie: true, headers: ip })).json.code, 'bad_email_code', 'neither the older nor the used-up code works');
    await local.pool.query('delete from webmail_login_attempts');
  }
  assert.equal((await local.pool.query('select max(attempts)::int as n from login_challenges')).rows[0].n, 5);

  // changing the address within the minute: nothing is sent, and the answer says so
  await local.pool.query('delete from login_challenges');
  assert.equal((await call('POST', '/api/auth/email-check/start', { email: 'typo@private.example', currentPassword: DEV_USER.password })).status, 200);
  const corrected = await call('POST', '/api/auth/email-check/start', { email: 'right@private.example', currentPassword: DEV_USER.password });
  assert.equal(corrected.status, 429);
  assert.equal(mailsTo('right@private.example').length, 0);
  // a minute later the new address gets its code, and the code for the first one is dead
  await local.pool.query(`update login_challenges set created_at = created_at - interval '2 minutes'`);
  assert.equal((await call('POST', '/api/auth/email-check/start', { email: 'right@private.example', currentPassword: DEV_USER.password })).status, 200);
  assert.equal((await call('POST', '/api/auth/email-check/confirm', { code: codeIn(mailsTo('typo@private.example').at(-1)!) })).status, 400);
  assert.equal((await call('GET', '/api/auth/me')).json.emailCheck, 'm•••@private.example');
  await local.pool.query('delete from login_challenges');

  // a session that has just signed in with the password may add a passkey without retyping it; an older one may not
  const fresh = { noCookie: true, headers: { cookie: ok.headers.getSetCookie().find((c) => c.startsWith('eisenmail_dev='))!.split(';')[0] } };
  assert.equal((await call('POST', '/api/auth/passkeys/register-options', {}, fresh)).status, 200);
  await local.pool.query(`update webmail_sessions set created_at = now() - interval '11 minutes'`);
  assert.equal((await call('POST', '/api/auth/passkeys/register-options', {}, fresh)).status, 403);
  assert.equal((await call('GET', '/api/auth/me', undefined, fresh)).json.fresh, false);

  // a password change names the mailbox the codes go to
  const changed = await call('POST', '/api/auth/password', { currentPassword: DEV_USER.password, newPassword: DEV_USER.password });
  assert.deepEqual(changed.json, { emailCheck: 'm•••@private.example' });

  assert.equal((await call('POST', '/api/auth/email-check/disable', { currentPassword: DEV_USER.password })).status, 204);
  assert.equal((await call('GET', '/api/auth/me')).json.emailCheck, null);
});
