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

test('hostile mail is rendered inert and remote content is blocked until asked for', async () => {
  await press(page, '[role=option]', 'Totally safe');
  await page.waitForSelector('iframe[title="Message body"]');
  await sleep(500);
  const frame = await page.evaluate(() => {
    const f = document.querySelector<HTMLIFrameElement>('iframe[title="Message body"]')!;
    const d = f.contentDocument!;
    return {
      sandbox: f.getAttribute('sandbox') ?? '',
      active: d.querySelectorAll('script, form, input, iframe, object, embed, meta[http-equiv=refresh], [onerror], [onclick], [onload]').length,
      jsLinks: [...d.querySelectorAll('a')].filter((a) => (a.getAttribute('href') ?? '').trim().toLowerCase().startsWith('javascript:')).length,
      remoteImages: [...d.querySelectorAll('img')].filter((i) => i.getAttribute('src')).length,
      title: document.title,
    };
  });
  assert.ok(!frame.sandbox.includes('allow-scripts'));
  assert.equal(frame.active, 0);
  assert.equal(frame.jsLinks, 0);
  assert.equal(frame.remoteImages, 0);
  assert.notEqual(frame.title, 'pwned');
  assert.match(await bodyText(page), /Remote content was blocked/);

  // the choice to load remote content does not carry over to another message
  await press(page, '[role=option]', 'has shipped');
  await press(page, 'button', 'Load remote content');
  assert.ok(await page.evaluate(() => document.querySelector<HTMLIFrameElement>('iframe[title="Message body"]')!.srcdoc.includes('img-src data: https:')));
  await press(page, '[role=option]', 'Totally safe');
  assert.ok(!(await page.evaluate(() => document.querySelector<HTMLIFrameElement>('iframe[title="Message body"]')!.srcdoc.includes('img-src data: https:'))));
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

test('delivery rules: forward, notify and forward style per address', async () => {
  await press(page, '[data-slot=dropdown-menu-trigger]', 'sam');
  await press(page, '[role=menuitem]', 'Forwarding');
  await page.waitForFunction(() => document.body.innerText.includes('New addresses'));
  await pressLabel(page, 'Forward newsletters@eisenberg.dev');
  await pressLabel(page, 'Forward style for github@eisenberg.dev');
  await sleep(400);
  const rules = await page.evaluate(async () => (await (await fetch('/api/mail/rules')).json()).rules as { address: string; forward: boolean; forwardStyle: string }[]);
  assert.equal(rules.find((r) => r.address === 'newsletters@eisenberg.dev')!.forward, false);
  assert.equal(rules.find((r) => r.address === 'github@eisenberg.dev')!.forwardStyle, 'attach');
  assert.equal(rules.find((r) => r.address === 'bank@eisenberg.dev')!.forwardStyle, 'inline');
  await page.keyboard.press('Escape');
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
