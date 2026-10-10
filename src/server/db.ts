import fs from 'node:fs';
import net from 'node:net';
import crypto from 'node:crypto';
import pg from 'pg';
import ssh2 from 'ssh2';
import config from './config.js';

// ------------------------------------------------------------------------------------------------
// Optional SSH tunnel to the database host. The tunnel is a local TCP listener on 127.0.0.1 with a
// random port; every pg connection is piped through an ssh "direct-tcpip" channel. The ssh session
// is (re)established lazily, so a dropped session heals on the next query.
// ------------------------------------------------------------------------------------------------

let sshClient: ssh2.Client | null = null;
let sshConnecting: Promise<ssh2.Client> | null = null;
let warnedHostKey = false;

async function tunnelKey(): Promise<Buffer | string> {
  const t = config.tunnel!;
  if (t.keySsm) return ssmSecret(t.keySsm);
  return fs.readFileSync(t.keyPath!);
}

function hostVerifier(): ((key: Buffer) => boolean) | undefined {
  const pinned = config.tunnel!.hostKey;
  if (!pinned) {
    if (!warnedHostKey) {
      warnedHostKey = true;
      console.warn('SSH_TUNNEL_HOST_KEY is not set: the tunnel host key is NOT verified (vulnerable to interception).');
    }
    return undefined;
  }
  // "ssh-ed25519 AAAA... comment" or just the base64 blob
  const parts = pinned.split(/\s+/);
  const blob = Buffer.from(parts.length > 1 ? parts[1] : parts[0], 'base64');
  return (key: Buffer) => key.length === blob.length && crypto.timingSafeEqual(key, blob);
}

function connectSsh(): Promise<ssh2.Client> {
  if (sshClient) return Promise.resolve(sshClient);
  if (sshConnecting) return sshConnecting;
  sshConnecting = (async () => {
    const t = config.tunnel!;
    const privateKey = await tunnelKey();
    const client = new ssh2.Client();
    await new Promise<void>((resolve, reject) => {
      // readyTimeout covers the handshake; this covers everything, so that a session that never
      // opens cannot hold every later connection attempt (they all wait on this one)
      const limit = setTimeout(() => {
        client.end();
        reject(new Error('ssh tunnel did not open within 12 s'));
      }, 12_000);
      client.once('ready', () => {
        clearTimeout(limit);
        resolve();
      });
      client.once('error', (err) => {
        clearTimeout(limit);
        reject(err);
      });
      client.connect({
        host: t.host,
        port: t.port,
        username: t.user,
        privateKey,
        hostVerifier: hostVerifier(),
        readyTimeout: 8000,
        keepaliveInterval: 20000,
      });
    });
    client.on('error', (err) => console.error(`ssh tunnel error: ${err.message}`));
    client.on('close', () => {
      if (sshClient === client) sshClient = null;
    });
    sshClient = client;
    return client;
  })().finally(() => {
    sshConnecting = null;
  });
  return sshConnecting;
}

function startTunnel(): Promise<number> {
  const server = net.createServer((socket) => {
    socket.on('error', () => socket.destroy());
    connectSsh()
      .then((client) => {
        client.forwardOut('127.0.0.1', socket.localPort ?? 0, '127.0.0.1', config.database.port, (err, stream) => {
          if (err) {
            console.error(`ssh forward failed: ${err.message}`);
            socket.destroy();
            return;
          }
          socket.pipe(stream).pipe(socket);
          stream.on('error', () => socket.destroy());
        });
      })
      .catch((err) => {
        console.error(`ssh tunnel connect failed: ${err.message}`);
        socket.destroy();
      });
  });
  server.unref();
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port));
  });
}

// ------------------------------------------------------------------------------------------------
// Pool
// ------------------------------------------------------------------------------------------------

let poolPromise: Promise<pg.Pool> | null = null;

function sslOption(): pg.PoolConfig['ssl'] {
  if (config.tunnel) return undefined; // traffic is already inside ssh and lands on the db host's loopback
  switch (config.database.sslmode) {
    case 'verify-full':
      return { rejectUnauthorized: true };
    case 'require':
      return { rejectUnauthorized: false };
    default:
      return undefined;
  }
}

/**
 * Secrets are read from SSM Parameter Store at runtime, so none has to sit in the Lambda
 * configuration. Cached for a few minutes: a rotated secret is picked up without a redeploy.
 */
const secretCache = new Map<string, { value: string; at: number }>();

/**
 * One SSM client for the process, with timeouts. Without them a call can wait forever: Lambda
 * freezes the process between requests, and a connection caught in the middle of a call may never
 * answer after the thaw.
 */
let ssm: Promise<import('@aws-sdk/client-ssm').SSMClient> | null = null;
export async function ssmParameter(name: string): Promise<string | undefined> {
  const { SSMClient, GetParameterCommand } = await import('@aws-sdk/client-ssm');
  ssm ??= Promise.resolve(new SSMClient({ maxAttempts: 3, requestHandler: { connectionTimeout: 3_000, requestTimeout: 5_000 } }));
  const res = await (await ssm).send(new GetParameterCommand({ Name: name, WithDecryption: true }));
  return res.Parameter?.Value;
}

async function ssmSecret(name: string): Promise<string> {
  const hit = secretCache.get(name);
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.value;
  const value = await ssmParameter(name);
  if (!value) throw new Error(`SSM parameter ${name} is empty`);
  secretCache.set(name, { value, at: Date.now() });
  return value;
}

async function createPool(): Promise<pg.Pool> {
  let host = config.database.host;
  let port = config.database.port;
  if (config.tunnel) {
    port = await startTunnel();
    host = '127.0.0.1';
  }
  const pool = new pg.Pool({
    host,
    port,
    user: config.database.user,
    // Called for every new connection, so a rotated password is picked up without a redeploy.
    password: config.database.passwordSsm ? () => ssmSecret(config.database.passwordSsm!) : config.database.password,
    database: config.database.database,
    ssl: sslOption(),
    application_name: 'eisenmail',
    max: 5,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 10_000,
    statement_timeout: 30_000,
    query_timeout: 35_000,
    idle_in_transaction_session_timeout: 30_000,
  });
  pool.on('error', (err) => console.error(`pg pool error: ${err.message}`));
  return pool;
}

export function getPool(): Promise<pg.Pool> {
  poolPromise ??= createPool().catch((err) => {
    poolPromise = null;
    throw err;
  });
  return poolPromise;
}

/** Tests and the dev server hand in their own pool (embedded postgres). */
export function setPool(pool: pg.Pool): void {
  poolPromise = Promise.resolve(pool);
}

export type Queryable = Pick<pg.PoolClient, 'query'>;

export async function query<R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params?: unknown[]): Promise<pg.QueryResult<R>> {
  const pool = await getPool();
  return pool.query<R>(text, params as unknown[]);
}

export async function tx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const pool = await getPool();
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  if (!poolPromise) return;
  const pool = await poolPromise.catch(() => null);
  poolPromise = null;
  await pool?.end();
  sshClient?.end();
}

/**
 * Drops the pool and the tunnel, so that the next query builds both again. Used when start-up
 * gets stuck: whatever it was waiting on is abandoned rather than waited for.
 */
export function resetConnections(): void {
  const pool = poolPromise;
  poolPromise = null;
  void pool?.then((p) => p.end()).catch(() => {});
  sshClient?.end();
  sshClient = null;
  sshConnecting = null;
}
