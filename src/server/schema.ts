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
    } catch {
      return null; // table does not exist yet
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
