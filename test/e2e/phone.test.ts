import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { Page } from 'puppeteer-core';
import { bodyText, newPage, press, pressLabel, search, signIn, sleep, startE2E, type E2E } from './harness.js';

let e2e: E2E;
let page: Page;
let problems: string[];

before(async () => {
  e2e = await startE2E();
  ({ page, problems } = await newPage(e2e, { phone: true }));
});
after(async () => {
  await e2e?.stop();
});

const tap = { tap: true };
const overflowsSideways = () => page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);

test('portfolio fits a phone and the site is an installable web app', async () => {
  await page.goto(`${e2e.base}/`, { waitUntil: 'networkidle0' });
  assert.equal(await overflowsSideways(), false);
  const manifest = await page.evaluate(async () => (await fetch(document.querySelector<HTMLLinkElement>('link[rel=manifest]')!.href)).json());
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.start_url, '/mail');
  assert.equal(await page.evaluate(async () => (await fetch('/icons/apple-touch-icon.png')).headers.get('content-type')), 'image/png');
});

test('list, then message, then back', async () => {
  await signIn(page, e2e.base);
  assert.equal(await overflowsSideways(), false);
  assert.match(await bodyText(page), /Add to Home Screen/);
  const worker = await page.evaluate(async () => (await navigator.serviceWorker.getRegistration('/'))?.scope ?? null);
  assert.ok(worker, 'service worker registered');

  await press(page, '[role=option]', 'Fractional CTO', tap);
  await page.waitForSelector('nav[aria-label="Message actions"]');
  assert.equal(await page.$('[role=listbox]'), null, 'the list is a separate screen');
  assert.ok((await search(page)).includes('id='));
  await page.goBack();
  await page.waitForSelector('[role=listbox]');
  assert.ok(!(await search(page)).includes('id='));
});

test('wide html mail is scaled to the screen', async () => {
  await press(page, '[role=option]', 'has shipped', tap);
  await page.waitForSelector('iframe[title="Message body"]');
  await sleep(800);
  const frame = await page.evaluate(() => {
    const f = document.querySelector<HTMLIFrameElement>('iframe[title="Message body"]')!;
    return { shown: f.getBoundingClientRect().width, available: f.parentElement!.clientWidth, natural: f.contentDocument!.documentElement.scrollWidth };
  });
  assert.ok(frame.natural > frame.available, 'the message is wider than the phone');
  assert.ok(frame.shown <= frame.available + 1, 'and is shown scaled down');
});

test('compose is a full-screen sheet with the receiving address as sender', async () => {
  await pressLabel(page, 'Reply, Reply All or Forward', tap);
  await press(page, '[role=menuitem]', 'Reply', tap);
  await page.waitForSelector('#c-from');
  assert.equal(await page.$eval('#c-from', (e) => (e as HTMLInputElement).value), 'shopping@eisenberg.dev');
  const size = await page.evaluate(() => {
    const r = document.querySelector('[role=dialog]')!.getBoundingClientRect();
    return [Math.round(r.width), Math.round(r.height)];
  });
  assert.deepEqual(size, [390, 844]);
  await pressLabel(page, 'Close', tap);
  await pressLabel(page, 'Back to All Inboxes', tap);
});

test('mailboxes screen and swipe to delete', async () => {
  await pressLabel(page, 'Mailboxes', tap);
  assert.match(await bodyText(page), /Domains/);
  await press(page, 'nav button', 'cool_stuff', tap);
  await page.waitForSelector('[role=listbox]');
  assert.ok((await search(page)).includes('address=cool_stuff%40eisenberg.dev'));

  const before = await page.$$eval('[role=option]', (els) => els.length);
  const box = (await (await page.$('[role=option]'))!.boundingBox())!;
  const y = box.y + box.height / 2;
  const cdp = await page.createCDPSession();
  const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', x: number) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
  await touch('touchStart', 330);
  for (const x of [310, 280, 240, 200, 170]) {
    await touch('touchMove', x);
    await sleep(30);
  }
  await touch('touchEnd', 170);
  await page.waitForFunction((n) => document.querySelectorAll('[role=option]').length === n - 1, {}, before);
});

test('people on a phone: list, person, back', async () => {
  await page.goto(`${e2e.base}/mail`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('nav[aria-label=Sections]');
  assert.deepEqual(await page.$$eval('nav[aria-label=Sections] a', (as) => as.map((a) => a.textContent?.trim())), ['Mail', 'People', 'Files', 'Codes']);
  await press(page, 'nav[aria-label=Sections] a', 'People', tap);
  await page.waitForFunction(() => location.pathname === '/people' && !!document.querySelector('input[aria-label="Search people"]'));
  assert.equal(await overflowsSideways(), false);
  await press(page, '[role=option]', 'Priya Raman', tap);
  await page.waitForFunction(() => /^\/people\/[0-9]+$/.test(location.pathname) && document.body.innerText.includes('Correspondence'));
  assert.equal(await overflowsSideways(), false);
  await press(page, 'main li button, li button', 'Fractional CTO', tap);
  await page.waitForFunction(() => location.pathname === '/mail' && location.search.includes('person='));
  await page.goBack();
  await page.waitForFunction(() => /^\/people\/[0-9]+$/.test(location.pathname));
  await press(page, 'button', 'People', tap);
  await page.waitForFunction(() => location.pathname === '/people');
});

test('the tab bar reaches Files and Codes in one tap; Files can take a photo', async () => {
  await page.goto(`${e2e.base}/mail`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('nav[aria-label=Sections]');
  await press(page, 'nav[aria-label=Sections] a', 'Files', tap);
  await page.waitForFunction(() => location.pathname === '/files' && document.body.innerText.includes('Upload'));
  assert.equal(await overflowsSideways(), false);
  // the camera button drives a capture input, which on a phone opens the camera directly
  const capture = await page.$eval('input[aria-label="Take a photo"]', (i) => [(i as HTMLInputElement).accept, i.getAttribute('capture')]);
  assert.deepEqual(capture, ['image/*', 'environment']);
  assert.ok(await page.$('button[aria-label="Take a photo"]'));

  // a "photo" goes straight into the list under a dated name
  const fs = await import('node:fs');
  const os = await import('node:os');
  const shot = `${os.tmpdir()}/image.jpg`;
  fs.writeFileSync(shot, Buffer.from('/9j/4AAQSkZJRgABAQ', 'base64'));
  const input = await page.$('input[aria-label="Take a photo"]');
  await (input as unknown as { uploadFile(p: string): Promise<void> }).uploadFile(shot);
  await page.waitForFunction(() => /Photo \d{4}-\d{2}-\d{2} \d{2}\.\d{2}\.\d{2}\.jpg/.test(document.body.innerText));

  await press(page, 'nav[aria-label=Sections] a', 'Codes', tap);
  await page.waitForFunction(() => location.pathname === '/codes' && document.body.innerText.includes('Add account'));
  assert.equal(await overflowsSideways(), false);
  await press(page, 'button', 'Add account', tap);
  assert.deepEqual(await page.$eval('input[aria-label="Take a picture of a QR code"]', (i) => [(i as HTMLInputElement).accept, i.getAttribute('capture')]), ['image/*', 'environment']);
  await page.keyboard.press('Escape');

  await press(page, 'nav[aria-label=Sections] a', 'Mail', tap);
  await page.waitForFunction(() => location.pathname === '/mail');
  // the account menu is the last tab
  await pressLabel(page, 'Account', tap);
  assert.match(await bodyText(page), /Mail settings/);
  await page.keyboard.press('Escape');
});

test('no script errors or Content-Security-Policy violations along the way', () => {
  assert.deepEqual(problems, []);
});
