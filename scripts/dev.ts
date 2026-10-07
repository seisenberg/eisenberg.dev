// Local development: `npm run dev`
//   - starts a throwaway PostgreSQL (embedded-postgres) in .data/pg and applies db/schema.sql
//   - seeds a dev user and mock mail (scripts/seed.ts)
//   - outgoing mail is logged instead of sent; the file drop uses .data/files
//   - serves the API and the Vite dev server on http://localhost:8080
import './dev-env.js'; // must stay first
import { startLocalDb } from './local-db.js';
import { seed, seedState } from './seed.js';

// DEV_DB_DIR / DEV_DB_PORT / PORT let a second, clean instance run next to the usual one.
const local = await startLocalDb({ dir: process.env.DEV_DB_DIR ?? '.data/pg', port: Number(process.env.DEV_DB_PORT ?? 54329), persistent: true });

// Import after the environment is prepared: config is read at import time.
const { default: config } = await import('../src/server/config.js');
const { setPool } = await import('../src/server/db.js');
const { ingestPending } = await import('../src/server/ingest.js');
const { createApp } = await import('../src/server/app.js');
setPool(local.pool);

if (await seed(local.pool)) {
  await ingestPending({ force: true });
  await seedState(local.pool);
  console.log('seeded mock mail');
}
// address books for sign-ins that have none yet (as src/server/main.ts does at start-up)
await (await import('../src/server/people.js')).backfill();

const { createServer } = await import('vite');
const vite = await createServer({ appType: 'spa', server: { middlewareMode: true } });

const app = createApp({
  dev: true,
  frontend: (ctx) =>
    new Promise<void>((resolve, reject) => {
      ctx.status = 200;
      ctx.respond = false; // vite writes the response itself
      vite.middlewares(ctx.req, ctx.res, (err?: unknown) => {
        if (err) return reject(err);
        ctx.respond = true;
        ctx.status = 404;
        resolve();
      });
      ctx.res.on('close', resolve);
    }),
});

// Loopback only: the development sign-in is published in the repository, so the dev server must
// not be reachable from the network. (DEV_HOST=0.0.0.0 to try it from a phone on a network you trust.)
const server = app.listen(config.port, process.env.DEV_HOST ?? '127.0.0.1', () => {
  console.log(`\n  eisenmail dev: http://localhost:${config.port}`);
  console.log('  sign in with the dev user defined in scripts/seed.ts (DEV_USER)\n');
});

let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    server.close();
    await vite.close();
    await local.stop();
    process.exit(0);
  });
}
