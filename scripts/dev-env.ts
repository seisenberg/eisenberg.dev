// Development environment defaults. Imported FIRST by scripts/dev.ts: the server reads its
// configuration when its modules are first imported, so these must be set before that happens.
// This file must not import any server code.
import crypto from 'node:crypto';
import fs from 'node:fs';
import webpush from 'web-push';

export const DEV_DOMAINS = ['eisenberg.dev', 'harborlight.example', 'quartzworks.example'];

process.env.MAIL_TRANSPORT ??= 'mock';
process.env.MAIL_DOMAINS ??= DEV_DOMAINS.join(',');
process.env.DEFAULT_FROM ??= `sam@${DEV_DOMAINS[0]}`;
process.env.FILES_DRIVER ??= 'local';

// Push notifications: a key pair generated once and kept with the other throwaway dev data.
if (!process.env.VAPID_PUBLIC_KEY) {
  const file = '.data/vapid-dev.json';
  let keys: { publicKey: string; privateKey: string };
  try {
    keys = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    keys = webpush.generateVAPIDKeys();
    fs.mkdirSync('.data', { recursive: true });
    fs.writeFileSync(file, JSON.stringify(keys), { mode: 0o600 });
  }
  process.env.VAPID_PUBLIC_KEY = keys.publicKey;
  process.env.VAPID_PRIVATE_KEY = keys.privateKey;
}

// Authenticator: the key that encrypts stored secrets, generated once for the throwaway dev data.
if (!process.env.VAULT_KEY) {
  const file = '.data/vault-dev.key';
  let key: string;
  try {
    key = fs.readFileSync(file, 'utf8').trim();
  } catch {
    key = crypto.randomBytes(32).toString('base64');
    fs.mkdirSync('.data', { recursive: true });
    fs.writeFileSync(file, key, { mode: 0o600 });
  }
  process.env.VAULT_KEY = key;
}
