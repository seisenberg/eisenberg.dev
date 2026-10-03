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
import type { MailboxTree, MessageDetail, MessageList } from '../src/shared/api.js';


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
  assert.equal((await call('POST', '/api/auth/totp/enable', { code: code() })).status, 204);

  const noCode = await call('POST', '/api/auth/login', DEV_USER, { noCookie: true });
  assert.equal(noCode.json.code, 'totp_required');
  // the code used to enable cannot be replayed
  const replay = await call('POST', '/api/auth/login', { ...DEV_USER, code: code() }, { noCookie: true });
  assert.equal(replay.json.code, 'bad_totp');
  const next = totpCode(base32Decode(setup.secret), Math.floor(Date.now() / 30_000) + 1);
  const ok = await call('POST', '/api/auth/login', { ...DEV_USER, code: next }, { noCookie: true });
  assert.equal(ok.status, 200, ok.text);

  assert.equal((await call('POST', '/api/auth/totp/disable', { currentPassword: DEV_USER.password })).status, 204);
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
  for (let i = 0; i < 30; i++) {
    const r = await call('POST', '/api/auth/login', { username: DEV_USER.username, password: `wrong-guess-${i}-xx` }, { noCookie: true, headers: from(`203.0.113.${i + 1}`) });
    assert.equal(r.status, 401);
  }
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
  assert.deepEqual(github(), { address: 'github@eisenberg.dev', forward: true, notify: true, forwardStyle: 'inline', explicit: false });
  assert.ok(!rules.rules.some((r: Json) => r.address.startsWith('reply-')), 'relay addresses are not listed');

  assert.equal((await call('POST', '/api/mail/rules', { address: 'GitHub@Eisenberg.dev', forward: false })).status, 204);
  rules = (await call('GET', '/api/mail/rules')).json;
  assert.deepEqual(github(), { address: 'github@eisenberg.dev', forward: false, notify: true, forwardStyle: 'inline', explicit: true });

  // flipping the defaults changes addresses without a rule, not the ones that have one
  assert.equal((await call('POST', '/api/mail/rules/defaults', { forward: false, notify: false, forwardStyle: 'attach' })).status, 204);
  assert.equal((await call('POST', '/api/mail/rules', { address: 'github@eisenberg.dev', forward: true })).status, 204);
  rules = (await call('GET', '/api/mail/rules')).json;
  assert.deepEqual(rules.defaults, { forward: false, notify: false, forwardStyle: 'attach' });
  assert.deepEqual(github(), { address: 'github@eisenberg.dev', forward: true, notify: true, forwardStyle: 'inline', explicit: true });
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
  assert.deepEqual(rules.rules.find((r: Json) => r.address === 'future@quartzworks.example'), { address: 'future@quartzworks.example', forward: false, notify: true, forwardStyle: 'attach', explicit: true });

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
