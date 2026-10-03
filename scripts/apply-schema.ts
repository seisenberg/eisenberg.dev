// Applies db/schema.sql (idempotent) to the configured database:  npm run db:schema
import fs from 'node:fs';
import { closePool, query } from '../src/server/db.js';

await query(fs.readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8'));
console.log('schema applied');
await closePool();
