import path from 'node:path';
import config from './config.js';
import { createApp } from './app.js';
import { getPool } from './db.js';
import { ensureSchema, setSchemaState } from './schema.js';
import { serveStatic } from './static.js';

// Production entry point. In AWS this runs behind the Lambda Web Adapter, which proxies the
// function's HTTP events to this port.

// Secure cookies, HSTS, database TLS, real mail delivery and configuration validation all hang off
// NODE_ENV=production. Refuse to serve without it rather than quietly run with them off.
if (!config.production && process.env.EISENMAIL_INSECURE_LOCAL !== '1') {
  console.error('Refusing to start: NODE_ENV is not "production". (For a local look at the production build: EISENMAIL_INSECURE_LOCAL=1 npm start)');
  process.exit(1);
}

const app = createApp({ frontend: serveStatic(path.resolve('dist')) });

process.on('unhandledRejection', (error) => console.error('unhandledRejection:', error));
process.on('uncaughtException', (error) => console.error('uncaughtException:', error));

// Connect (through the ssh tunnel when there is one) and bring the schema up to date before taking
// requests. If the database is unreachable the server still starts, so the public page keeps
// working and /api/health reports the problem.
try {
  await getPool();
  const state = await ensureSchema();
  setSchemaState(state);
  if (state === 'applied') console.log('database schema updated');
  // address books for sign-ins that have none yet (first start after the feature, new members)
  const { backfill } = await import('./people.js');
  const books = await backfill();
  if (books) console.log(`address book built for ${books} sign-in(s) from stored mail`);
} catch (err) {
  setSchemaState('failed');
  console.error(`database not ready at start-up: ${(err as Error).message}`);
}

app.listen(config.port, () => console.log(`eisenmail listening on ${config.port}`));
