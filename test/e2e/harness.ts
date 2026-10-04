// End-to-end harness: the production build of the UI (strict Content-Security-Policy), the real
// server, a real PostgreSQL with the seeded mock mail, and a real Chrome driven by puppeteer.
//
//   npm run test:e2e        (builds the UI first)
//
// Chrome is found through CHROME_PATH, or the usual install locations.
import { tmp } from '../env.js'; // must stay first: configures the server through the environment
import fs from 'node:fs';
import path from 'node:path';
import http, { type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import { startLocalDb, type LocalDb } from '../../scripts/local-db.js';
import { DEV_USER, seed, seedState } from '../../scripts/seed.js';

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

export interface E2E {
  base: string;
  browser: Browser;
  db: LocalDb;
  /** A stand-in for a sender's image host, and every request it received. */
  images: { origin: string; requests: { path: string; headers: Record<string, unknown> }[] };
  /** Mail the system sent (nothing leaves the machine in tests). */
  outbox: { to: string[]; raw: string }[];
  /** Answers for the next window.prompt() calls, in order (without one, a prompt keeps its default). */
  promptAnswers: string[];
  stop(): Promise<void>;
}

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function startE2E(): Promise<E2E> {
  const chrome = CHROME_CANDIDATES.find((p) => p && fs.existsSync(p));
  if (!chrome) throw new Error('Chrome not found: set CHROME_PATH');
  if (!fs.existsSync('dist/index.html')) throw new Error('dist/ is missing: run "npm run build:ui" first');

  const db = await startLocalDb({ dir: path.join(tmp, 'pg'), port: 54900 + Math.floor(Math.random() * 90), persistent: false });
  const { setPool } = await import('../../src/server/db.js');
  const { ingestPending } = await import('../../src/server/ingest.js');
  const { createApp } = await import('../../src/server/app.js');
  const { serveStatic } = await import('../../src/server/static.js');
  setPool(db.pool);
  await seed(db.pool);

  // A message whose pictures live on a local "sender" server. The proxy normally refuses loopback
  // addresses; the test switches that one safeguard off (impossible in production).
  const { default: config } = await import('../../src/server/config.js');
  config.imageProxy.allowPrivate = true;
  const outbox: E2E['outbox'] = [];
  const { setTransport } = await import('../../src/server/send.js');
  setTransport({
    async send(raw, _from, to) {
      outbox.push({ to, raw: raw.toString('utf8') });
      return `e2e-${outbox.length}`;
    },
  });
  const requests: E2E['images']['requests'] = [];
  const imageHost = http.createServer((req, res) => {
    requests.push({ path: req.url ?? '', headers: req.headers });
    res.writeHead(200, { 'content-type': 'image/png' });
    res.end(PNG);
  });
  await new Promise<void>((resolve) => imageHost.listen(0, '127.0.0.1', resolve));
  const imageOrigin = `http://127.0.0.1:${(imageHost.address() as AddressInfo).port}`;
  const html = `<html><body><p>Our new catalogue is here.</p><img src="${imageOrigin}/banner.png" width="400" height="100" alt="Banner"><p>Thanks for reading.</p><img src="${imageOrigin}/open.gif?u=8842" width="1" height="1" alt=""></body></html>`;
  await db.pool.query(`insert into lambda_inbox (message_id, created_at, event, email_raw) values ('e2e-images', now() + interval '1 minute', $1, $2)`, [
    JSON.stringify({ mail: { timestamp: new Date(Date.now() + 60_000).toISOString() }, receipt: { recipients: ['catalogue@eisenberg.dev'], spfVerdict: { status: 'PASS' } } }),
    Buffer.from(`From: Catalogue <news@catalogue.example>\r\nTo: catalogue@eisenberg.dev\r\nSubject: Pictures behind the proxy\r\nMIME-Version: 1.0\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${html}\r\n`),
  ]);

  await ingestPending({ force: true });
  await seedState(db.pool);

  const server: Server = createApp({ frontend: serveStatic(path.resolve('dist')) }).listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => server.once('listening', resolve).once('error', reject));
  // "localhost", not the IP: passkeys need a domain name as their relying party id
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  let browser: Browser;
  try {
    browser = await launch(chrome);
  } catch (err) {
    // never leave the database running behind a failed start
    server.close();
    imageHost.close();
    await db.stop();
    throw err;
  }
  return finish(base, browser, db, server, imageHost, { origin: imageOrigin, requests }, outbox);
}

function launch(chrome: string): Promise<Browser> {
  return puppeteer.launch({
    executablePath: chrome,
    headless: true,
    // GitHub's runners (and most containers) cannot use Chrome's own sandbox
    args: ['--host-resolver-rules=MAP localhost 127.0.0.1', ...(process.env.CI ? ['--no-sandbox', '--disable-setuid-sandbox'] : [])],
  });
}

function finish(base: string, browser: Browser, db: LocalDb, server: Server, imageHost: Server, images: E2E['images'], outbox: E2E['outbox']): E2E {
  return {
    base,
    browser,
    db,
    images,
    outbox,
    promptAnswers: [],
    async stop() {
      await browser.close().catch(() => {});
      server.close();
      imageHost.close();
      await db.stop();
      fs.rmSync(tmp, { recursive: true, force: true });
    },
  };
}

/** A page that fails the test on any uncaught error or CSP violation. */
export async function newPage(e2e: E2E, opts: { phone?: boolean } = {}): Promise<{ page: Page; problems: string[] }> {
  const page = await e2e.browser.newPage();
  const problems: string[] = [];
  page.on('pageerror', (err) => problems.push(`pageerror: ${(err as Error).message}`));
  page.on('console', (msg) => {
    const text = msg.text();
    // 401 from the "am I signed in" probe is expected; anything else on the error channel is not
    if (msg.type() === 'error' && !text.includes('401') && !text.includes('ERR_NAME_NOT_RESOLVED')) problems.push(text);
  });
  page.on('dialog', (d) => void d.accept(d.type() === 'prompt' ? e2e.promptAnswers.shift() : undefined));
  if (opts.phone) {
    await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1');
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  } else {
    await page.setViewport({ width: 1440, height: 900 });
  }
  return { page, problems };
}

export async function signIn(page: Page, base: string): Promise<void> {
  await page.goto(`${base}/login`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#username');
  await page.type('#username', DEV_USER.username);
  await page.type('#password', DEV_USER.password);
  await Promise.all([page.waitForFunction(() => location.pathname === '/mail'), page.keyboard.press('Enter')]);
  await page.waitForSelector('[role=option]');
}

/** Waits for an element containing the text, then clicks (or taps) it. */
export async function press(page: Page, selector: string, text: string, opts: { tap?: boolean } = {}): Promise<void> {
  await page.waitForFunction((s, t) => [...document.querySelectorAll(s)].some((e) => (e.textContent ?? '').includes(t)), { timeout: 8000 }, selector, text);
  const point = await page.evaluate(
    (s, t) => {
      const el = [...document.querySelectorAll(s)].find((e) => (e.textContent ?? '').includes(t))!;
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      return [r.x + Math.min(r.width / 2, 100), r.y + r.height / 2];
    },
    selector,
    text,
  );
  if (opts.tap) await page.touchscreen.tap(point[0], point[1]);
  else await page.mouse.click(point[0], point[1]);
  await sleep(500);
}

export async function pressLabel(page: Page, label: string, opts: { tap?: boolean } = {}): Promise<void> {
  const el = await page.waitForSelector(`[aria-label^="${label}"]`, { timeout: 8000 });
  if (opts.tap) await el!.tap();
  else await el!.click();
  await sleep(500);
}

export const bodyText = (page: Page) => page.evaluate(() => document.body.innerText);
export const search = (page: Page) => page.evaluate(() => location.search);
