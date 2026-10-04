import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import type { Page } from 'puppeteer-core';
import { bodyText, newPage, press, pressLabel, search, signIn, sleep, startE2E, type E2E } from './harness.js';
import { tmp } from '../env.js';

let e2e: E2E;
let page: Page;
let problems: string[];

before(async () => {
  e2e = await startE2E();
  ({ page, problems } = await newPage(e2e));
});
after(async () => {
  await e2e?.stop();
});

const sidebar = () => page.evaluate(() => document.querySelector('nav[aria-label=Mailboxes]')!.textContent ?? '');

test('public page, then sign-in is required for the private area', async () => {
  await page.goto(`${e2e.base}/`, { waitUntil: 'networkidle0' });
  assert.match(await bodyText(page), /Sam Eisenberg/);
  assert.ok(await page.$('a[href="https://github.com/seisenberg/eisenberg.dev"]'), 'links to the source');
  await page.goto(`${e2e.base}/mail`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#username');
  assert.equal(await page.evaluate(() => location.pathname), '/login');
  await signIn(page, e2e.base);
});

test('sidebar: all inboxes, a folder per domain, an inbox per address', async () => {
  await page.waitForFunction(() => (document.querySelector('nav[aria-label=Mailboxes]')?.textContent ?? '').includes('cool_stuff'));
  const text = await sidebar();
  for (const expected of ['All Inboxes', 'eisenberg.dev', 'harborlight.example', 'quartzworks.example', 'cool_stuff', 'github', 'Sent', 'Trash']) assert.ok(text.includes(expected), expected);
});

const frameInfo = () =>
  page.evaluate(() => {
    const f = document.querySelector<HTMLIFrameElement>('iframe[title="Message body"]')!;
    const d = f.contentDocument!;
    return {
      sandbox: f.getAttribute('sandbox') ?? '',
      srcdoc: f.srcdoc,
      active: d.querySelectorAll('script, form, input, iframe, object, embed, meta[http-equiv=refresh], [onerror], [onclick], [onload]').length,
      jsLinks: [...d.querySelectorAll('a')].filter((a) => (a.getAttribute('href') ?? '').trim().toLowerCase().startsWith('javascript:')).length,
      images: [...d.querySelectorAll('img')].map((i) => {
        const r = i.getBoundingClientRect();
        return { src: i.getAttribute('src') ?? '', blocked: i.hasAttribute('data-blocked'), width: Math.round(r.width), height: Math.round(r.height), loaded: i.complete && i.naturalWidth > 0 };
      }),
      title: document.title,
    };
  });

test('hostile mail is rendered inert', async () => {
  await press(page, '[role=option]', 'Totally safe');
  await page.waitForSelector('iframe[title="Message body"]');
  await sleep(500);
  const frame = await frameInfo();
  assert.ok(!frame.sandbox.includes('allow-scripts'));
  assert.equal(frame.active, 0);
  assert.equal(frame.jsLinks, 0);
  assert.notEqual(frame.title, 'pwned');
  assert.ok(frame.images.every((i) => i.src === '' || i.src.startsWith('data:')), 'no image address of the sender is left in the document');
  assert.ok(!/https?:\/\/evil\.example\/(pixel|bg|t)/.test(frame.srcdoc.replace(/\\3c [^>]*>/g, '')), 'no remote load survives');
  assert.match(await bodyText(page), /Images are not shown/);
});

test('images stay hidden behind same-size placeholders until asked for, then load through the proxy', async () => {
  await press(page, '[role=option]', 'Pictures behind the proxy');
  await page.waitForSelector('iframe[title="Message body"]');
  await sleep(600);
  assert.match(await bodyText(page), /Images are not shown, so the sender cannot tell that you opened this message/);
  let frame = await frameInfo();
  const [banner, pixel] = frame.images;
  assert.deepEqual([banner.blocked, banner.width, banner.height], [true, 400, 100], 'the placeholder keeps the picture\'s box');
  assert.deepEqual([pixel.blocked, pixel.width, pixel.height], [true, 1, 1], 'a tracking pixel stays a pixel');
  assert.ok(!frame.srcdoc.includes(e2e.images.origin), 'the sender\'s addresses are not in the document');
  assert.equal(e2e.images.requests.length, 0, 'nothing was requested from the sender');

  await press(page, 'button', 'Show images');
  await page.waitForFunction(() => {
    const d = document.querySelector<HTMLIFrameElement>('iframe[title="Message body"]')!.contentDocument!;
    return d.images.length === 2 && [...d.images].every((i) => i.complete && i.naturalWidth > 0 && !i.hasAttribute('data-blocked'));
  });
  frame = await frameInfo();
  assert.ok(frame.images.every((i) => i.src.startsWith('/api/mail/image/')), 'images come from this site, never from the sender directly');
  assert.ok(!frame.srcdoc.includes(e2e.images.origin));
  assert.equal(frame.images[0].width, 400); // (the stand-in picture is square, so only the width is meaningful here)
  assert.match(await bodyText(page), /Images were fetched by this server/);

  // what the sender's server saw: the proxy, not the reader's browser
  assert.deepEqual(e2e.images.requests.map((r) => r.path).sort(), ['/banner.png', '/open.gif?u=8842']);
  for (const r of e2e.images.requests) {
    assert.equal(r.headers['user-agent'], 'Mozilla/5.0 (compatible; ImageProxy)');
    for (const h of ['cookie', 'referer', 'origin', 'accept-language']) assert.equal(r.headers[h], undefined, h);
  }

  // the choice does not carry over: another message, and this one reopened, start hidden again
  await press(page, '[role=option]', 'has shipped');
  await sleep(500);
  assert.match(await bodyText(page), /Images are not shown/);
  assert.ok((await frameInfo()).images.every((i) => i.src === '' || i.src.startsWith('data:')));
});

test('reply defaults to the receiving address; the sender address can be overridden', async () => {
  await press(page, 'nav button', 'travel');
  assert.ok((await search(page)).includes('address=travel%40eisenberg.dev'));
  await press(page, '[role=option]', 'eTicket');
  assert.match(await bodyText(page), /Received on:/);
  await page.keyboard.press('r');
  await page.waitForSelector('#c-from');
  assert.equal(await page.$eval('#c-from', (e) => (e as HTMLInputElement).value), 'travel@eisenberg.dev');
  await page.$eval('#c-from', (e) => (e as HTMLInputElement).select());
  await page.keyboard.type('concierge@quartzworks.example');
  await page.focus('textarea[aria-label=Message]');
  await page.keyboard.type('Thanks, got it.');
  await press(page, 'button', 'Send');
  await page.waitForFunction(() => document.body.innerText.includes('Message sent'));
  await press(page, 'nav button', 'Sent');
  await page.waitForFunction(() => document.body.innerText.includes('from concierge@quartzworks.example'));
});

test('deleting the last message removes the address folder; put back restores it', async () => {
  await press(page, 'nav button', 'travel');
  await press(page, '[role=option]', 'eTicket');
  assert.ok(await page.$('[aria-label=Replied]'), 'answered marker');
  await page.keyboard.press('Backspace');
  await page.waitForFunction(() => !(document.querySelector('nav[aria-label=Mailboxes]')?.textContent ?? '').includes('travel'));
  await press(page, 'nav button', 'Trash');
  await press(page, '[role=option]', 'eTicket');
  await page.keyboard.press('e');
  await page.waitForFunction(() => (document.querySelector('nav[aria-label=Mailboxes]')?.textContent ?? '').includes('travel'));
});

test('search and keyboard navigation', async () => {
  await press(page, 'nav button', 'All Inboxes');
  await page.keyboard.press('/');
  await page.keyboard.type('invoice');
  await page.waitForFunction(() => document.querySelectorAll('[role=option]').length === 1);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.querySelectorAll('[role=option]').length > 5);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('ArrowDown');
  await sleep(300);
  await page.keyboard.press('ArrowDown');
  await sleep(300);
  assert.equal(await page.$$eval('[role=option][aria-selected=true]', (els) => els.length), 1);
  await page.keyboard.press('s');
  await page.waitForSelector('[role=option][aria-selected=true] [aria-label=Flagged]');
  await page.keyboard.press('s');
});

test('conversation view, image preview, mark all as read', async () => {
  await press(page, 'nav button', 'All Inboxes');
  await press(page, '[role=option]', 'scope question');
  await page.waitForFunction(() => document.body.innerText.includes('2 messages in this conversation'));
  // the reply sent from the webmail is part of the conversation; opening it shows its text
  await press(page, 'article section button', 'You (hello@quartzworks.example)');
  await page.waitForFunction(() => document.body.innerText.includes('Redshift workloads are in scope'));

  await press(page, '[role=option]', 'Logo concepts');
  const thumb = await page.waitForSelector('button[aria-label="Preview concept-1.png"] img');
  assert.ok(await thumb!.evaluate((img) => (img as HTMLImageElement).complete && (img as HTMLImageElement).naturalWidth > 0), 'image attachment is shown in place');

  await pressLabel(page, 'Mailbox actions');
  await press(page, '[role=menuitem]', 'Mark all as read');
  await page.waitForFunction(() => document.querySelectorAll('[role=option] [aria-label=Unread]').length === 0);
});

test('drafts are saved while typing and can be continued; recipients autocomplete', async () => {
  await page.keyboard.press('n');
  await page.waitForSelector('#c-to');
  await page.type('#c-to', 'jane');
  await press(page, '#c-to-suggestions [role=option]', 'jane.park@northwind.example');
  assert.equal(await page.$eval('#c-to', (e) => (e as HTMLInputElement).value), 'jane.park@northwind.example, ');
  await page.type('#c-subject', 'Half written');
  await page.waitForFunction(() => document.body.innerText.includes('Draft saved'), { timeout: 8000 });
  await pressLabel(page, 'Close'); // the confirm dialog is accepted: keep the draft
  await press(page, 'nav button', 'Drafts');
  await press(page, '[role=listitem] button', 'Half written');
  await page.waitForSelector('#c-subject');
  assert.equal(await page.$eval('#c-subject', (e) => (e as HTMLInputElement).value), 'Half written');
  await page.focus('textarea[aria-label=Message]');
  await page.keyboard.type('Now finished.');
  await press(page, 'button', 'Send');
  await page.waitForFunction(() => document.body.innerText.includes('Message sent'));
  await page.waitForFunction(() => document.body.innerText.includes('No Drafts'));
});

test('addresses: forward, forward style, note and block', async () => {
  await press(page, '[data-slot=dropdown-menu-trigger]', 'sam');
  await press(page, '[role=menuitem]', 'Mail settings');
  await page.waitForFunction(() => document.body.innerText.includes('New addresses'));
  await pressLabel(page, 'Forward newsletters@eisenberg.dev');
  await pressLabel(page, 'Forward style for github@eisenberg.dev');
  await pressLabel(page, 'More for shopping@eisenberg.dev');
  await press(page, '[role=menuitem]', 'Block this address');
  await page.waitForFunction(() => document.body.innerText.includes('Blocked'));
  await sleep(400);
  const rules = await page.evaluate(async () => (await (await fetch('/api/mail/rules')).json()).rules as { address: string; forward: boolean; forwardStyle: string; blocked: boolean }[]);
  assert.equal(rules.find((r) => r.address === 'newsletters@eisenberg.dev')!.forward, false);
  assert.equal(rules.find((r) => r.address === 'github@eisenberg.dev')!.forwardStyle, 'attach');
  assert.equal(rules.find((r) => r.address === 'bank@eisenberg.dev')!.forwardStyle, 'inline');
  assert.equal(rules.find((r) => r.address === 'shopping@eisenberg.dev')!.blocked, true);
  await page.keyboard.press('Escape');
});

test('passkey: register, sign out, sign in without a password', async () => {
  const cdp = await page.createCDPSession();
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  await press(page, '[data-slot=dropdown-menu-trigger]', 'sam');
  await press(page, '[role=menuitem]', 'Security');
  await page.waitForSelector('#pk-pw');
  await page.type('#pk-pw', (await import('../../scripts/seed.js')).DEV_USER.password);
  await press(page, 'button', 'Add passkey');
  await page.waitForFunction(() => document.body.innerText.includes('Passkey added'), { timeout: 10000 });
  await page.keyboard.press('Escape');

  await press(page, '[data-slot=dropdown-menu-trigger]', 'sam');
  await press(page, '[role=menuitem]', 'Sign out');
  await page.waitForSelector('#username');
  await press(page, 'button', 'Sign in with a passkey');
  await page.waitForFunction(() => location.pathname === '/mail', { timeout: 10000 });
  await page.waitForSelector('[role=option]');
  const me = await page.evaluate(async () => (await fetch('/api/auth/me')).json());
  assert.equal(me.username, 'sam');
});

test('file drop: upload, private by default, public link on demand', async () => {
  await page.goto(`${e2e.base}/files`, { waitUntil: 'networkidle0' });
  const file = path.join(tmp, 'Q3 report (draft).txt');
  fs.writeFileSync(file, 'quarterly numbers\n');
  const input = await page.waitForSelector('input[type=file]');
  await (input as unknown as { uploadFile(p: string): Promise<void> }).uploadFile(file);
  await page.waitForFunction(() => document.body.innerText.includes('Q3 report (draft).txt') && !document.querySelector('.animate-spin'));
  const url = `${e2e.base}/public/${encodeURIComponent('Q3 report (draft).txt')}`;
  assert.equal((await fetch(url)).status, 404);
  await page.click('[role=switch]');
  await page.waitForFunction(() => document.body.innerText.includes('Copy link'));
  const res = await fetch(url);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'quarterly numbers\n');
});

test('no script errors or Content-Security-Policy violations along the way', () => {
  assert.deepEqual(problems, []);
});
