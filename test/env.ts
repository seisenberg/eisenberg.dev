// Imported first by every test file: the server reads its configuration at import time.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import webpush from 'web-push';

export const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eisenmail-test-'));
process.env.NODE_ENV = 'test';
process.env.MAIL_TRANSPORT = 'mock';
process.env.MAIL_DOMAINS = 'eisenberg.dev,harborlight.example,quartzworks.example';
process.env.FILES_DRIVER = 'local';
process.env.DEFAULT_FROM = '';
process.env.FILES_LOCAL_DIR = path.join(tmp, 'files');
const vapid = webpush.generateVAPIDKeys();
process.env.VAPID_PUBLIC_KEY = vapid.publicKey;
process.env.VAPID_PRIVATE_KEY = vapid.privateKey;
process.env.VAULT_KEY = crypto.randomBytes(32).toString('base64');
