import path from 'node:path';
import config from './config.js';
import { createApp } from './app.js';
import { getPool } from './db.js';
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

// Warm the database connection (and ssh tunnel) during init rather than on the first request.
getPool().catch((err) => console.error(`database not reachable at start-up: ${err.message}`));

app.listen(config.port, () => console.log(`eisenmail listening on ${config.port}`));
