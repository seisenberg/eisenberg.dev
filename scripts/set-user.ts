// Creates a webmail user or resets its password:
//   npm run user:set -- <username>            (prompts for the password, input hidden)
//   EISENMAIL_PASSWORD=... npm run user:set -- <username>
// Resetting a password also signs the user out everywhere, forgets trusted browsers and switches two-factor off.
import readline from 'node:readline';
import { hashPassword, MIN_PASSWORD_LENGTH } from '../src/server/auth.js';
import { closePool, query } from '../src/server/db.js';

function promptHidden(label: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const out = rl as unknown as { _writeToOutput: (s: string) => void };
    process.stdout.write(label);
    out._writeToOutput = () => {};
    rl.question('', (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

const username = process.argv[2]?.trim().toLowerCase();
if (!username) {
  console.error('usage: npm run user:set -- <username>');
  process.exit(2);
}
let password = process.env.EISENMAIL_PASSWORD ?? '';
if (!password) {
  password = await promptHidden(`New password for ${username}: `);
  if ((await promptHidden('Again: ')) !== password) {
    console.error('Passwords do not match');
    process.exit(1);
  }
}
if (password.length < MIN_PASSWORD_LENGTH) {
  console.error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  process.exit(1);
}
const res = await query<{ id: number }>(
  `insert into webmail_users (email, passhash) values ($1, $2)
   on conflict (email) do update set passhash = excluded.passhash, totp_secret = null, totp_last_step = null
   returning id`,
  [username, await hashPassword(password)],
);
await query('delete from webmail_sessions where user_id = $1', [res.rows[0].id]);
await query('delete from webmail_devices where user_id = $1', [res.rows[0].id]);
console.log(`user "${username}" saved; all of its sessions were signed out`);
await closePool();
