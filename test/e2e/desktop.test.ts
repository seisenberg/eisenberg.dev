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
      jsLinks: [...d.querySelectorAll('a')].filter((a) => /^(javascript|data|vbscript|file):/i.test((a.getAttribute('href') ?? '').replace(/[\s\u0000-\u001f]/g, ''))).length,
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

  // an address that forwards to a group of outside mailboxes instead of the default one
  e2e.promptAnswers.push('Ann@Partners.example, raj@elsewhere.example');
  await pressLabel(page, 'More for legal@harborlight.example');
  await press(page, '[role=menuitem]', 'Forward to other mailboxes');
  await page.waitForFunction(() => document.body.innerText.includes('Forwards to ann@partners.example, raj@elsewhere.example'));
  await sleep(300);
  const legal = await page.evaluate(async () => ((await (await fetch('/api/mail/rules')).json()).rules as { address: string; forwardTo: string[] }[]).find((r) => r.address === 'legal@harborlight.example')!);
  assert.deepEqual(legal.forwardTo, ['ann@partners.example', 'raj@elsewhere.example']);
  // leaving the prompt empty goes back to the default mailbox
  e2e.promptAnswers.push('');
  await pressLabel(page, 'More for legal@harborlight.example');
  await press(page, '[role=menuitem]', 'Change who it forwards to');
  await page.waitForFunction(() => !document.body.innerText.includes('Forwards to ann@partners.example'));
  await page.keyboard.press('Escape');
});

test('authenticator: add an account from a picture of its QR code', async () => {
  const QRCode = (await import('qrcode')).default;
  const { totpCode, base32Decode } = await import('../../src/server/otp.js');
  const secret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
  const picture = path.join(tmp, 'setup-qr.png');
  await QRCode.toFile(picture, `otpauth://totp/GitHub:sam%40example.org?secret=${secret}&issuer=GitHub`, { width: 600, margin: 4 });

  await page.goto(`${e2e.base}/codes`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => document.body.innerText.includes('No accounts yet'));
  await press(page, 'button', 'Add account');
  const input = await page.waitForSelector('input[aria-label="Choose a picture of a QR code"]');
  await (input as unknown as { uploadFile(p: string): Promise<void> }).uploadFile(picture);
  await page.waitForFunction(() => document.body.innerText.includes('Account added'));
  await page.waitForFunction(() => /GitHub/.test(document.body.innerText) && /\d{3} \d{3}/.test(document.body.innerText));
  const shown = await page.evaluate(() => /(\d{3}) (\d{3})/.exec(document.querySelector('main ul')!.textContent ?? '')!.slice(1).join(''));
  const step = Math.floor(Date.now() / 30_000);
  assert.ok([step - 1, step, step + 1].some((s) => totpCode(base32Decode(secret), s) === shown), `the code shown (${shown}) is the right one`);
  assert.ok(!(await page.content()).includes(secret), 'the secret is not in the page');
});

test('sign-in code by email, then the offer to add a passkey, then a passkey sign-in', async () => {
  const { DEV_USER } = await import('../../scripts/seed.js');
  const codeFrom = () => /Code: (\d{6})/.exec(e2e.outbox.at(-1)!.raw)![1];
  // a virtual authenticator, so the browser has somewhere to keep a passkey
  const cdp = await page.createCDPSession();
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });

  // switch the email check on in the settings
  await press(page, '[data-slot=dropdown-menu-trigger]', 'sam');
  await press(page, '[role=menuitem]', 'Security');
  await page.waitForSelector('#ec-email');
  await page.type('#ec-email', 'owner@mailbox.example');
  await page.type('#ec-pw', DEV_USER.password);
  await press(page, 'button', 'Send a code to confirm');
  await page.waitForSelector('#ec-code');
  assert.deepEqual(e2e.outbox.at(-1)!.to, ['owner@mailbox.example']);
  await page.type('#ec-code', codeFrom());
  await press(page, 'button', 'Confirm');
  await page.waitForFunction(() => document.body.innerText.includes('A password sign-in also needs the code'));
  await page.keyboard.press('Escape');

  // sign out, sign in with the password: the code from the email is asked for
  await press(page, '[data-slot=dropdown-menu-trigger]', 'sam');
  await press(page, '[role=menuitem]', 'Sign out');
  await page.waitForSelector('#username');
  await e2e.db.pool.query('delete from login_challenges'); // (the one-a-minute limit would hold back the next code)
  const before = e2e.outbox.length;
  await page.type('#username', DEV_USER.username);
  await page.type('#password', DEV_USER.password);
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.body.innerText.includes('Code from your email'));
  assert.equal(await page.evaluate(() => location.pathname), '/login', 'the password alone does not sign in');
  assert.equal(e2e.outbox.length, before + 1);
  await page.type('#code', codeFrom());
  await Promise.all([page.waitForFunction(() => location.pathname === '/mail'), page.keyboard.press('Enter')]);

  // straight after a password sign-in, a passkey is offered and added without retyping the password
  await page.waitForSelector('[role=region][aria-label="Add a passkey"]');
  await press(page, '[role=region][aria-label="Add a passkey"] button', 'Add a passkey');
  await page.waitForFunction(() => document.body.innerText.includes('Passkey added'), { timeout: 10000 });

  // next time: no password, no code
  await press(page, '[data-slot=dropdown-menu-trigger]', 'sam');
  await press(page, '[role=menuitem]', 'Sign out');
  await page.waitForSelector('#username');
  const mails = e2e.outbox.length;
  await press(page, 'button', 'Sign in with a passkey');
  await page.waitForFunction(() => location.pathname === '/mail', { timeout: 10000 });
  await page.waitForSelector('[role=option]');
  assert.equal(e2e.outbox.length, mails, 'a passkey sign-in sends no code');
  assert.equal(await page.$('[role=region][aria-label="Add a passkey"]'), null, 'and the offer is not repeated');
});

test('people: the book, a person\'s mail, editing, and the sender link', async () => {
  await page.goto(`${e2e.base}/mail`, { waitUntil: 'networkidle0' });
  // the tabs: Mail, People, Files, Codes, with words at the default width
  assert.deepEqual(await page.$$eval('aside a[href], [data-panel] a[href]', (as) => as.filter((a) => /^\/(mail|people|files|codes)$/.test(a.getAttribute('href') ?? '')).map((a) => a.textContent?.trim())), ['Mail', 'People', 'Files', 'Codes']);
  await press(page, 'a[href="/people"]', 'People');
  await page.waitForFunction(() => location.pathname === '/people' && document.body.innerText.includes('people'));
  await press(page, '[role=option]', 'Jane Park');
  await page.waitForFunction(() => document.body.innerText.includes('Correspondence'));
  assert.match(await bodyText(page), /jane\.park@northwind\.example/);
  // the person's mail opens in Mail, scoped to them, with a way back
  await press(page, 'main li button', 'Standing desk');
  await page.waitForFunction(() => location.pathname === '/mail' && location.search.includes('person='));
  await page.waitForSelector('[role=option][aria-selected=true]');
  assert.match(await page.$eval('[data-panel] + * + [data-panel], [data-panel]:nth-of-type(2)', (e) => e.textContent ?? ''), /Jane Park/);
  await pressLabel(page, 'Back to People');
  await page.waitForFunction(() => /^\/people\/[0-9]+$/.test(location.pathname));
  // edit: a company and a note
  await press(page, 'button', 'Edit');
  await page.waitForSelector('#p-company');
  await page.type('#p-company', 'Northwind');
  await page.type('#p-note', 'Bought the standing desk');
  await press(page, 'button', 'Save');
  await page.waitForFunction(() => document.body.innerText.includes('Bought the standing desk') && document.body.innerText.includes('Northwind'));
  // the sender's name in a message leads here
  await page.goto(`${e2e.base}/mail`, { waitUntil: 'networkidle0' });
  await press(page, '[role=option]', 'Standing desk');
  await press(page, 'article header a, header a', 'Jane Park');
  await page.waitForFunction(() => /^\/people\/[0-9]+$/.test(location.pathname) && document.body.innerText.includes('Correspondence'));
  // a new person, by hand
  await pressLabel(page, 'New person');
  await page.waitForSelector('#p-name');
  await page.type('#p-name', 'Ann Private');
  await page.type('#p-addresses', 'ann@partners.example');
  await press(page, 'button', 'Save');
  await page.waitForFunction(() => document.body.innerText.includes('No mail with this person yet'));
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
