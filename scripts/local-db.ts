// A real PostgreSQL started from the embedded-postgres npm package, for development and tests.
// No docker and no system postgres needed.
import fs from 'node:fs';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';

export interface LocalDb {
  pool: pg.Pool;
  stop(): Promise<void>;
}

async function canConnect(port: number, user: string, password: string): Promise<boolean> {
  const client = new pg.Client({ host: '127.0.0.1', port, user, password, database: 'emails', connectionTimeoutMillis: 1500 });
  try {
    await client.connect();
    await client.end();
    return true;
  } catch {
    return false;
  }
}

/**
 * CI: use an existing PostgreSQL (a service container) instead of starting an embedded one.
 * The database is wiped first, so as a guard its name must end in "_test".
 */
async function externalTestDb(dsn: string): Promise<LocalDb> {
  const url = new URL(dsn);
  const database = url.pathname.slice(1);
  if (!database.endsWith('_test')) throw new Error('EISENMAIL_TEST_DSN must point at a database whose name ends in "_test" (it is wiped)');
  Object.assign(process.env, {
    POSTGRES_DB_HOST: url.hostname,
    POSTGRES_DB_PORT: url.port || '5432',
    POSTGRES_DB_USER: decodeURIComponent(url.username),
    POSTGRES_DB_PASSWORD: decodeURIComponent(url.password),
    POSTGRES_DB_NAME: database,
    POSTGRES_DB_SSLMODE: 'disable',
  });
  const pool = new pg.Pool({ connectionString: dsn, max: 5 });
  pool.on('error', () => {});
  await pool.query('drop schema public cascade; create schema public;');
  await pool.query(fs.readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8'));
  return { pool, stop: () => pool.end().catch(() => {}) };
}

export async function startLocalDb(opts: { dir: string; port: number; persistent: boolean }): Promise<LocalDb> {
  if (!opts.persistent && process.env.EISENMAIL_TEST_DSN) return externalTestDb(process.env.EISENMAIL_TEST_DSN);
  const user = 'eisenmail';
  const password = 'local-only';
  const dir = path.resolve(opts.dir);
  const server = new EmbeddedPostgres({ databaseDir: dir, user, password, port: opts.port, persistent: opts.persistent, onLog: () => {}, onError: () => {} });
  const fresh = !fs.existsSync(path.join(dir, 'PG_VERSION'));
  // A previous run that was killed hard can leave its postgres behind: reuse it instead of failing.
  const alreadyUp = !fresh && (await canConnect(opts.port, user, password));
  if (!alreadyUp) {
    if (fresh) await server.initialise();
    await server.start();
    if (fresh) await server.createDatabase('emails');
  }

  // The server code reads its connection settings from the environment.
  Object.assign(process.env, {
    POSTGRES_DB_HOST: '127.0.0.1',
    POSTGRES_DB_PORT: String(opts.port),
    POSTGRES_DB_USER: user,
    POSTGRES_DB_PASSWORD: password,
    POSTGRES_DB_NAME: 'emails',
    POSTGRES_DB_SSLMODE: 'disable',
  });
  const pool = new pg.Pool({ host: '127.0.0.1', port: opts.port, user, password, database: 'emails', max: 5 });
  pool.on('error', () => {});
  await pool.query(fs.readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8'));
  return {
    pool,
    async stop() {
      await pool.end().catch(() => {});
      if (alreadyUp) {
        // not started by this process: stop it through pg_ctl
        const { execFileSync } = await import('node:child_process');
        const pgCtl = path.resolve('node_modules/@embedded-postgres', `${process.platform}-${process.arch}`, 'native/bin/pg_ctl');
        try {
          execFileSync(pgCtl, ['stop', '-D', dir, '-m', 'fast'], { stdio: 'ignore' });
        } catch {
          /* already gone */
        }
      } else await server.stop();
    },
  };
}
