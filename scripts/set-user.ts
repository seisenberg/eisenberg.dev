// Creates a webmail user or resets its password:
//   npm run user:set -- <username> [--email you@private-mailbox.example]   (prompts for the password, input hidden)
//   EISENMAIL_PASSWORD=... npm run user:set -- <username>
// Creates an OWNER (members are added in the web UI). Resetting a password also signs the user out
// everywhere, forgets trusted browsers, removes passkeys and recovery codes, and switches two-factor off.
// The sign-in code by email is set to --email, and switched off when --email is left out: a reset
// is the way back in when that mailbox is gone.
import readline from 'node:readline';
import { hashPassword, MIN_PASSWORD_LENGTH, outsideAddress } from '../src/server/auth.js';
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

const args = process.argv.slice(2);
const emailFlag = args.indexOf('--email');
const email = emailFlag >= 0 ? args.splice(emailFlag, 2)[1]?.trim().toLowerCase() : undefined;
const username = args[0]?.trim().toLowerCase();
if (!username || (emailFlag >= 0 && !email)) {
  console.error('usage: npm run user:set -- <username> [--email you@your-private-mailbox.example]');
  console.error('  --email  where six digit sign-in codes are sent (a mailbox outside this system)');
  process.exit(2);
}
if (email) {
  // the same rule as in the settings: a valid address, and not one this system receives for
  try {
    outsideAddress(email);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(2);
  }
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
   on conflict (email) do update set passhash = excluded.passhash, totp_secret = null, totp_last_step = null, verify_email = $3
   returning id`,
  [username, await hashPassword(password), email ?? null],
);
await query('delete from login_challenges where user_id = $1', [res.rows[0].id]);
await query('delete from webmail_sessions where user_id = $1', [res.rows[0].id]);
await query('delete from webmail_devices where user_id = $1', [res.rows[0].id]);
// a reset is also the way back in after losing every other credential, so those go too
await query('delete from webmail_recovery_codes where user_id = $1', [res.rows[0].id]);
await query('delete from webauthn_credentials where user_id = $1', [res.rows[0].id]);
await query('delete from push_subscriptions where user_id = $1', [res.rows[0].id]);
if (email) {
  await query('update webmail_users set verify_email = $2 where id = $1', [res.rows[0].id, email]);
  console.log(`sign-in codes will be sent to ${email}`);
} else {
  console.log('no sign-in code by email (pass --email <mailbox> to switch it on, or do so in the settings)');
}
console.log(`user "${username}" saved; all of its sessions were signed out`);
await closePool();
