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

test('files page fits a phone', async () => {
  await page.goto(`${e2e.base}/files`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => document.body.innerText.includes('Upload'));
  assert.equal(await overflowsSideways(), false);
});

test('no script errors or Content-Security-Policy violations along the way', () => {
  assert.deepEqual(problems, []);
});
