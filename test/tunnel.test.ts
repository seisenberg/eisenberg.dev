// The ssh tunnel against a real ssh server (ssh2's own), in a process of its own: the tunnel is
// configured through the environment, which the server reads at import time.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import ssh2 from 'ssh2';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eisenmail-tunnel-'));
// keys in OpenSSH format, which is what ssh2 reads (and what the deployment stores)
const hostKey = ssh2.utils.generateKeyPairSync('ed25519');
const hostPem = hostKey.private;
const clientKey = ssh2.utils.generateKeyPairSync('ed25519');
fs.writeFileSync(path.join(tmp, 'client'), clientKey.private, { mode: 0o600 });

// The stand-in for PostgreSQL: echoes what it receives.
const echo = net.createServer((s) => s.pipe(s));
// How the ssh server treats direct-tcpip (port forward) requests, test by test.
let forwardMode: 'hang-first' | 'normal' = 'normal';
let forwards = 0;
let sessions = 0;
const sshd = new ssh2.Server({ hostKeys: [hostPem] }, (client) => {
  sessions += 1;
  client.on('authentication', (ctx) => (ctx.method === 'publickey' ? ctx.accept() : ctx.reject(['publickey'])));
  client.on('ready', () => {
    client.on('tcpip', (accept) => {
      forwards += 1;
      if (forwardMode === 'hang-first' && forwards === 1) return; // never answered: a session that looks open and is dead
      const stream = accept();
      const upstream = net.connect((echo.address() as net.AddressInfo).port, '127.0.0.1');
      stream.pipe(upstream).pipe(stream);
      upstream.on('error', () => stream.destroy());
    });
  });
  client.on('error', () => {});
});

let db: typeof import('../src/server/db.js');

before(async () => {
  await new Promise<void>((resolve) => echo.listen(0, '127.0.0.1', resolve));
  await new Promise<void>((resolve) => sshd.listen(0, '127.0.0.1', resolve));
  Object.assign(process.env, {
    NODE_ENV: 'test',
    MAIL_TRANSPORT: 'mock',
    SSH_TUNNEL_HOST: '127.0.0.1',
    SSH_TUNNEL_PORT: String((sshd.address() as net.AddressInfo).port),
    SSH_TUNNEL_USER: 'tunnel',
    SSH_TUNNEL_KEY_PATH: path.join(tmp, 'client'),
    SSH_TUNNEL_HOST_KEY: hostKey.public,
    POSTGRES_DB_PORT: String((echo.address() as net.AddressInfo).port),
  });
  db = await import('../src/server/db.js');
});

after(() => {
  db?.resetConnections();
  sshd.close();
  echo.close();
});

async function roundTrip(port: number, text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(text));
    socket.setTimeout(15_000, () => reject(new Error('no answer through the tunnel')));
    socket.once('data', (data) => {
      socket.destroy();
      resolve(data.toString());
    });
    socket.once('error', reject);
  });
}

test('bytes go through the tunnel to the database port', async () => {
  const port = await db.tunnelForTests.start();
  assert.equal(await roundTrip(port, 'hello'), 'hello');
  assert.equal(sessions, 1);
});

test('a forward that gets no answer reopens the session and goes through', async () => {
  db.resetConnections();
  forwardMode = 'hang-first';
  forwards = 0;
  const before = sessions;
  const port = await db.tunnelForTests.start();
  const started = Date.now();
  assert.equal(await roundTrip(port, 'after a freeze'), 'after a freeze');
  const took = Date.now() - started;
  assert.ok(took >= 3_500 && took < 10_000, `waited for the forward timeout, then succeeded (${took} ms)`);
  assert.equal(forwards, 2);
  assert.equal(sessions - before, 2, 'a fresh session was opened');
});
