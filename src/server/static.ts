import fs from 'node:fs';
import path from 'node:path';
import type Koa from 'koa';

// Serves the built UI. The set of servable files is read once at start-up into a map, so a request
// path can only ever select one of those files: there is no path handling to get wrong.

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.pdf': 'application/pdf',
  '.webmanifest': 'application/manifest+json',
};

interface Asset {
  body: Buffer;
  type: string;
  immutable: boolean;
}

function scan(root: string): Map<string, Asset> {
  const out = new Map<string, Asset>();
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        const type = TYPES[path.extname(entry.name).toLowerCase()];
        if (!type) continue;
        const url = '/' + path.relative(root, full).split(path.sep).join('/');
        out.set(url, { body: fs.readFileSync(full), type, immutable: url.startsWith('/assets/') });
      }
    }
  };
  walk(root);
  return out;
}

export function serveStatic(root: string): Koa.Middleware {
  const assets = scan(root);
  const index = assets.get('/index.html');
  if (!index) throw new Error(`${root}/index.html not found: run "npm run build" first`);
  return async (ctx, next) => {
    if (ctx.method !== 'GET' && ctx.method !== 'HEAD') return next();
    if (ctx.path.startsWith('/api/') || ctx.path.startsWith('/public/')) return next();
    const asset = ctx.path === '/' ? undefined : assets.get(ctx.path);
    if (asset && asset !== index) {
      ctx.type = asset.type;
      const fresh = ctx.path === '/sw.js' || ctx.path === '/manifest.webmanifest';
      ctx.set('Cache-Control', asset.immutable ? 'public, max-age=31536000, immutable' : fresh ? 'no-cache' : 'public, max-age=3600');
      if (ctx.path === '/sw.js') ctx.set('Service-Worker-Allowed', '/');
      ctx.body = asset.body;
      return;
    }
    // A missing hashed asset must be a 404, not the app shell.
    if (ctx.path.startsWith('/assets/')) return next();
    ctx.type = index.type;
    ctx.set('Cache-Control', 'no-cache');
    ctx.body = index.body;
  };
}
