import fs from 'node:fs';
import Koa from 'koa';
import Router from '@koa/router';
import { bodyParser } from '@koa/bodyparser';
import config from './config.js';
import * as auth from './auth.js';
import { query } from './db.js';
import { ingestPending } from './ingest.js';
import * as mail from './mail.js';
import { HttpError } from './mail.js';
import { sendMail } from './send.js';
import * as rules from './rules.js';
import * as push from './push.js';
import { checkName, deleteMailObjects, disposition, fileStore, localPath, localWrite, visibilityOf } from './files.js';
import type { FileListing, MailboxView } from '../shared/api.js';

export interface AppOptions {
  /** Vite dev middleware needs inline scripts and a websocket. Never set in production. */
  dev?: boolean;
  /** Mounted after the API: static files in production, vite in development. */
  frontend?: Koa.Middleware;
}

function contentSecurityPolicy(dev: boolean): string {
  const connect = ["'self'"];
  const f = config.files;
  if (f.driver === 's3' && f.privateBucket) {
    // Browser uploads go straight to S3 with a presigned URL.
    if (f.privateBucket.includes('.')) connect.push(`https://s3.${f.region}.amazonaws.com`);
    else connect.push(`https://${f.privateBucket}.s3.${f.region}.amazonaws.com`, `https://${f.privateBucket}.s3.amazonaws.com`);
  }
  if (dev) connect.push('ws:', 'wss:');
  return [
    "default-src 'self'",
    dev ? "script-src 'self' 'unsafe-inline'" : "script-src 'self'",
    // Inline styles are needed for rendered mail (which sits in a script-less sandboxed frame).
    "style-src 'self' 'unsafe-inline'",
    // https: so that "load remote images" in a message can work; remote images are stripped unless asked for.
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    `connect-src ${connect.join(' ')}`,
    "frame-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

const SAFE_DOWNLOAD_TYPES = /^(image\/(png|jpeg|gif|webp)|application\/pdf|text\/plain)$/;

function sendDownload(ctx: Koa.Context, d: mail.Download): void {
  // Mail attachments are attacker supplied. Always a download, never rendered in this origin.
  ctx.set('Content-Disposition', disposition(d.filename, false));
  ctx.set('Content-Security-Policy', "sandbox; default-src 'none'");
  ctx.type = SAFE_DOWNLOAD_TYPES.test(d.contentType) ? d.contentType : 'application/octet-stream';
  ctx.body = d.content;
}

export function createApp(options: AppOptions = {}): Koa {
  const app = new Koa();
  const csp = contentSecurityPolicy(!!options.dev);

  // ---- error handling + security headers -------------------------------------------------------
  app.use(async (ctx, next) => {
    ctx.set('Content-Security-Policy', csp);
    ctx.set('X-Content-Type-Options', 'nosniff');
    ctx.set('X-Frame-Options', 'DENY');
    ctx.set('Referrer-Policy', 'no-referrer');
    ctx.set('Cross-Origin-Opener-Policy', 'same-origin');
    ctx.set('Cross-Origin-Resource-Policy', 'same-origin');
    ctx.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()');
    if (config.production) ctx.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
    if (ctx.path.startsWith('/api/')) ctx.set('Cache-Control', 'no-store');
    try {
      await next();
    } catch (err) {
      const e = err as Error & { status?: number; code?: string; expose?: boolean };
      if (e instanceof HttpError) {
        ctx.status = e.status;
        ctx.body = { error: e.message, code: e.code };
      } else if (typeof e.status === 'number' && e.status >= 400 && e.status < 500) {
        // body parser errors (bad json, too large)
        ctx.status = e.status;
        ctx.body = { error: e.status === 413 ? 'Request is too large' : 'Bad request' };
      } else {
        // Never leak internals to the client.
        console.error(`${ctx.method} ${ctx.path} failed:`, e);
        ctx.status = 500;
        ctx.body = { error: 'Something went wrong' };
      }
    }
  });

  const json = bodyParser({ enableTypes: ['json'], jsonLimit: '6mb' });
  app.use((ctx, next) => (ctx.path.startsWith('/api/files/local-upload/') ? next() : json(ctx, next)));

  const router = new Router();

  // Lambda Web Adapter readiness probe: says the process is up, nothing more.
  router.get('/health', (ctx) => {
    ctx.body = 'ok';
  });
  router.get('/api/health', async (ctx) => {
    try {
      await query('select 1');
      ctx.body = { ok: true };
    } catch {
      ctx.status = 503;
      ctx.body = { ok: false };
    }
  });

  // ---- public downloads ------------------------------------------------------------------------
  router.get('/public/:name', async (ctx) => {
    const store = fileStore();
    const name = checkName(ctx.params.name);
    const url = store ? await store.downloadUrl(name, 'public') : null;
    if (!url) throw new HttpError(404, 'Not found');
    ctx.set('Cache-Control', 'no-store');
    if (config.files.driver === 'local') {
      ctx.set('Content-Disposition', disposition(name, false));
      ctx.set('Content-Security-Policy', "sandbox; default-src 'none'");
      ctx.type = 'application/octet-stream';
      ctx.body = fs.createReadStream(localPath(name, 'public'));
    } else {
      ctx.redirect(url);
    }
  });

  // ---- auth ------------------------------------------------------------------------------------
  const api = new Router({ prefix: '/api' });
  api.use(auth.requireSameOrigin);
  api.post('/auth/login', auth.login);

  const priv = new Router();
  priv.use(auth.requireAuth);
  priv.get('/auth/me', auth.me);
  priv.post('/auth/logout', auth.logout);
  priv.get('/auth/sessions', auth.listSessions);
  priv.post('/auth/sessions/revoke-others', auth.revokeOtherSessions);
  priv.post('/auth/password', auth.changePassword);
  priv.post('/auth/totp/setup', auth.totpSetup);
  priv.post('/auth/totp/enable', auth.totpEnable);
  priv.post('/auth/totp/disable', auth.totpDisable);

  // ---- mail ------------------------------------------------------------------------------------
  priv.get('/mail/mailboxes', async (ctx) => {
    await ingestPending().catch((err) => console.error(`ingest failed: ${err.message}`));
    ctx.body = await mail.mailboxTree();
  });
  priv.get('/mail/identities', async (ctx) => {
    ctx.body = await mail.identities();
  });
  priv.get('/mail/messages', async (ctx) => {
    const q = ctx.query;
    const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
    ctx.body = await mail.listMessages({
      mailbox: (one(q.mailbox) ?? 'inbox') as MailboxView,
      domain: one(q.domain),
      address: one(q.address),
      q: one(q.q),
      cursor: one(q.cursor),
      limit: /^\d{1,3}$/.test(one(q.limit) ?? '') ? Number(one(q.limit)) : undefined,
    });
  });
  priv.get('/mail/messages/:id', async (ctx) => {
    ctx.body = await mail.getMessage(ctx.params.id);
  });
  priv.get('/mail/messages/:id/attachments/:index', async (ctx) => {
    sendDownload(ctx, await mail.getAttachment(ctx.params.id, ctx.params.index));
  });
  priv.get('/mail/messages/:id/raw', async (ctx) => {
    const raw = await mail.getRaw(ctx.params.id);
    sendDownload(ctx, { ...raw, contentType: 'application/octet-stream' });
  });
  priv.patch('/mail/messages', async (ctx) => {
    ctx.body = { changed: await mail.patchMessages(ctx.request.body as never) };
  });
  priv.post('/mail/messages/delete', async (ctx) => {
    const { deleted, s3Keys } = await mail.deleteForever((ctx.request.body as { ids?: unknown })?.ids);
    await deleteMailObjects(s3Keys);
    ctx.body = { deleted };
  });
  priv.post('/mail/empty', async (ctx) => {
    const { deleted, s3Keys } = await mail.emptyMailbox((ctx.request.body as { mailbox?: unknown })?.mailbox);
    await deleteMailObjects(s3Keys);
    ctx.body = { deleted };
  });
  priv.post('/mail/send', async (ctx) => {
    ctx.body = await sendMail(ctx.request.body as never);
  });

  // ---- delivery rules (forwarding / notifications per receiving address) -----------------------
  priv.get('/mail/rules', async (ctx) => {
    ctx.body = await rules.getRules();
  });
  priv.post('/mail/rules', async (ctx) => {
    await rules.setRule((ctx.request.body ?? {}) as never);
    ctx.status = 204;
  });
  priv.post('/mail/rules/reset', async (ctx) => {
    await rules.resetRule((ctx.request.body ?? {}) as never);
    ctx.status = 204;
  });
  priv.post('/mail/rules/defaults', async (ctx) => {
    await rules.setDefaults((ctx.request.body ?? {}) as never);
    ctx.status = 204;
  });

  // ---- push notifications ----------------------------------------------------------------------
  const userId = (ctx: Koa.Context) => (ctx.state.auth as auth.AuthState).userId;
  priv.get('/push', async (ctx) => {
    ctx.body = await push.pushStatus(userId(ctx));
  });
  priv.post('/push/subscribe', async (ctx) => {
    await push.subscribe(userId(ctx), ctx.request.body as never, ctx.get('user-agent'));
    ctx.status = 204;
  });
  priv.post('/push/unsubscribe', async (ctx) => {
    await push.unsubscribe(userId(ctx), (ctx.request.body ?? {}) as never);
    ctx.status = 204;
  });
  priv.post('/push/test', async (ctx) => {
    ctx.body = await push.sendToUser(userId(ctx), { title: 'eisenmail', body: 'Notifications are working on this device.', url: '/mail', tag: 'eisenmail-test' });
  });

  // ---- file drop -------------------------------------------------------------------------------
  const store = () => {
    const s = fileStore();
    if (!s) throw new HttpError(503, 'File storage is not configured (set FILES_BUCKET)', 'files_disabled');
    return s;
  };
  priv.get('/files', async (ctx) => {
    const s = fileStore();
    const files = s ? await s.list() : [];
    files.sort((a, b) => b.modified.localeCompare(a.modified));
    ctx.body = { files, maxBytes: config.files.maxBytes, enabled: !!s } satisfies FileListing & { enabled: boolean };
  });
  priv.post('/files/uploads', async (ctx) => {
    const body = (ctx.request.body ?? {}) as Record<string, unknown>;
    const name = checkName(body.name);
    const size = Number(body.size);
    if (!Number.isInteger(size) || size < 0 || size > config.files.maxBytes) {
      throw new HttpError(413, `Files are limited to ${Math.floor(config.files.maxBytes / 1024 / 1024)} MB`);
    }
    const type = typeof body.contentType === 'string' && /^[\w.+-]+\/[\w.+-]+$/.test(body.contentType) ? body.contentType : 'application/octet-stream';
    ctx.body = await store().uploadTicket(name, size, type);
  });
  priv.get('/files/download/:visibility/:name', async (ctx) => {
    const url = await store().downloadUrl(checkName(ctx.params.name), visibilityOf(ctx.params.visibility));
    if (!url) throw new HttpError(404, 'File not found');
    ctx.redirect(url);
  });
  priv.post('/files/visibility', async (ctx) => {
    const body = (ctx.request.body ?? {}) as Record<string, unknown>;
    const makePublic = body.public === true;
    await store().setVisibility(checkName(body.name), makePublic ? 'private' : 'public', makePublic ? 'public' : 'private');
    ctx.status = 204;
  });
  priv.post('/files/delete', async (ctx) => {
    const body = (ctx.request.body ?? {}) as Record<string, unknown>;
    await store().remove(checkName(body.name), visibilityOf(body.visibility));
    ctx.status = 204;
  });
  if (config.files.driver === 'local') {
    priv.put('/files/local-upload/:name', async (ctx) => {
      await localWrite(checkName(ctx.params.name), ctx.req, config.files.maxBytes);
      ctx.status = 204;
    });
    priv.get('/files/local-download/:visibility/:name', async (ctx) => {
      const name = checkName(ctx.params.name);
      const file = localPath(name, visibilityOf(ctx.params.visibility));
      if (!fs.existsSync(file)) throw new HttpError(404, 'File not found');
      ctx.set('Content-Disposition', disposition(name, false));
      ctx.set('Content-Security-Policy', "sandbox; default-src 'none'");
      ctx.type = 'application/octet-stream';
      ctx.body = fs.createReadStream(file);
    });
  }

  api.use(priv.routes());
  // Unknown API paths are a JSON 404, never the app shell.
  api.all('/{*rest}', (ctx) => {
    ctx.status = 404;
    ctx.body = { error: 'Not found' };
  });

  app.use(router.routes());
  app.use(api.routes());
  if (options.frontend) app.use(options.frontend);
  return app;
}
