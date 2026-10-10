import crypto from 'node:crypto';
import fs from 'node:fs';
import { query, tx } from './db.js';

// db/schema.sql is idempotent and is the only migration mechanism. It is applied at start-up when
// its hash differs from the one recorded in the database, under an advisory lock so that several
// containers starting at once do not run DDL concurrently. A deploy updates the web function
// first and warms it up, so the schema is in place before the inbox function needs it.

const LOCK_KEY = 7_230_114;

/** What the last start-up migration did. The deploy checks /api/health, which reports a failure here. */
export let schemaState: 'unknown' | 'applied' | 'current' | 'failed' = 'unknown';
export function setSchemaState(state: typeof schemaState): void {
  schemaState = state;
}

export async function ensureSchema(file = new URL('../../db/schema.sql', import.meta.url)): Promise<'applied' | 'current'> {
  const sql = fs.readFileSync(file, 'utf8');
  const hash = crypto.createHash('sha256').update(sql).digest('hex');
  const current = async () => {
    try {
      return (await query<{ hash: string }>('select hash from schema_meta limit 1')).rows[0]?.hash ?? null;
    } catch (err) {
      // only "the table does not exist yet"; anything else (no connection) is a real failure, and
      // retrying it here would only add another connection timeout to the start-up
      if ((err as { code?: string }).code === '42P01') return null;
      throw err;
    }
  };
  if ((await current()) === hash) return 'current';
  return tx(async (client) => {
    await client.query('select pg_advisory_xact_lock($1)', [LOCK_KEY]);
    // another container may have applied it while this one waited for the lock
    const exists = (await client.query<{ e: boolean }>(`select to_regclass('public.schema_meta') is not null as e`)).rows[0].e;
    if (exists && (await client.query<{ hash: string }>('select hash from schema_meta limit 1')).rows[0]?.hash === hash) return 'current' as const;
    await client.query(sql);
    await client.query(`insert into schema_meta (id, hash) values (true, $1) on conflict (id) do update set hash = excluded.hash, applied_at = now()`, [hash]);
    return 'applied' as const;
  });
}

// ---- start-up ---------------------------------------------------------------------------------
//
// The server starts listening at once and prepares the database (tunnel, schema, address books)
// in the background. Lambda gives a new instance 10 seconds to start and API Gateway gives a
// request 30, so a slow tunnel or a database host that is restarting must not hold the process
// back: the public pages answer straight away, and an API request waits for the preparation, at
// most STARTUP_WAIT_MS, then gets a quick "starting, try again" instead of a timeout.

let startup: Promise<void> = Promise.resolve();
let task: (() => Promise<void>) | null = null;
let onStuck: () => void = () => {};
let startedAt = 0;
let failedAt = 0;
let attempt = 0;
let waitLimit = 20_000;
let retryAfter = 5_000;
let deadline = 25_000;

function run(): void {
  if (!task) return;
  const fn = task;
  const id = ++attempt;
  startedAt = Date.now();
  let timer: NodeJS.Timeout | undefined;
  // An attempt that takes longer than the deadline is abandoned (its connections are dropped), so
  // that a step that hangs cannot block every request until the instance is recycled. On Lambda
  // the timer may fire late, after the process thaws; that is when it matters most.
  const tooLong = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`preparation took longer than ${deadline / 1000} s`)), deadline);
  });
  startup = Promise.race([fn(), tooLong]).then(
    () => {
      if (id === attempt) failedAt = 0;
    },
    (err) => {
      if (id !== attempt) return;
      failedAt = Date.now();
      setSchemaState('failed');
      console.error(`database not ready: ${(err as Error).message}`);
      onStuck();
    },
  ).finally(() => clearTimeout(timer));
}

/**
 * Starts preparing the database in the background (src/server/main.ts). `reset` drops whatever a
 * failed or stuck attempt left behind (the pool and the tunnel).
 */
export function beginStartup(fn: () => Promise<void>, reset: () => void = () => {}): void {
  task = fn;
  onStuck = reset;
  failedAt = 0;
  run();
}

/**
 * Waits for the database preparation, at most the wait limit. False when it is still running.
 * After a failure, the next request a little later starts a fresh attempt (the database host
 * may have been restarting).
 */
export async function whenStarted(): Promise<boolean> {
  if (failedAt && Date.now() - failedAt > retryAfter) {
    failedAt = 0;
    run();
  }
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), waitLimit);
  });
  try {
    const done = await Promise.race([startup.then(() => true as const), late]);
    if (!done) console.warn(`api request answered 503: database still being prepared after ${Math.round((Date.now() - startedAt) / 1000)} s`);
    return done;
  } finally {
    clearTimeout(timer);
  }
}

/** Tests: shorter waits. */
export function setStartupTiming(t: { wait?: number; retryAfter?: number; deadline?: number }): void {
  waitLimit = t.wait ?? 20_000;
  retryAfter = t.retryAfter ?? 5_000;
  deadline = t.deadline ?? 25_000;
}
