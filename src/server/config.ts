// All configuration comes from the environment. Nothing secret lives in the source tree.

const env = process.env;

function list(v: string | undefined): string[] {
  return (v ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function int(v: string | undefined, fallback: number): number {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
}

export interface Config {
  production: boolean;
  port: number;
  /** e.g. https://eisenberg.dev. When set, state-changing requests must carry this Origin. */
  publicOrigin: string | null;
  /** How many reverse proxies sit in front (Lambda function URL = 1, CloudFront + function URL = 2). */
  proxyHops: number;
  database: {
    host: string;
    port: number;
    user: string;
    password: string;
    /** SSM SecureString holding the password (preferred over the environment variable) */
    passwordSsm: string | null;
    database: string;
    sslmode: 'disable' | 'require' | 'verify-full';
  };
  tunnel: null | {
    host: string;
    port: number;
    user: string;
    keyPath: string | null;
    keySsm: string | null;
    /** Pinned server key, known_hosts style: "ssh-ed25519 AAAA...". */
    hostKey: string | null;
  };
  mail: {
    /** Domains we receive for and may send from. */
    domains: string[];
    transport: 'ses' | 'mock';
    region: string | undefined;
    /** Bucket + prefix SES writes raw mail to (only used to clean up on permanent delete). */
    bucket: string | null;
    prefix: string;
    defaultFrom: string | null;
    maxAttachmentBytes: number;
  };
  files: {
    driver: 's3' | 'local' | 'none';
    region: string | undefined;
    privateBucket: string | null;
    privatePrefix: string;
    publicBucket: string | null;
    publicPrefix: string;
    localDir: string;
    maxBytes: number;
  };
  vault: {
    /** 32 random bytes, base64: encrypts the authenticator secrets. From SSM in production. */
    key: string | null;
    keySsm: string | null;
  };
  imageProxy: {
    /** Tests only: lets the proxy fetch from loopback. Always false in production. */
    allowPrivate: boolean;
    maxBytes: number;
    timeoutMs: number;
  };
  push: {
    /** VAPID key pair (base64url). Generate with: npm run push:keys */
    publicKey: string | null;
    privateKey: string | null;
    privateKeySsm: string | null;
    subject: string;
    /** extra allowed push service host suffixes (tests only) */
    extraHosts: string[];
  };
  session: {
    ttlHours: number;
    cookieName: string;
    deviceCookieName: string;
  };
}

function load(): Config {
  const production = env.NODE_ENV === 'production';
  const tunnelHost = env.SSH_TUNNEL_HOST?.trim();
  const privateBucket = env.FILES_BUCKET?.trim() || null;
  const filesDriver = (env.FILES_DRIVER?.trim() as Config['files']['driver'] | undefined) ?? (privateBucket ? 's3' : 'none');
  const sslDefault: Config['database']['sslmode'] = tunnelHost || !production ? 'disable' : 'verify-full';

  const config: Config = {
    production,
    port: int(env.PORT, 8080),
    publicOrigin: env.PUBLIC_ORIGIN?.trim().replace(/\/+$/, '') || null,
    proxyHops: int(env.TRUSTED_PROXY_HOPS, 1),
    database: {
      host: env.POSTGRES_DB_HOST ?? '127.0.0.1',
      port: int(env.POSTGRES_DB_PORT, 5432),
      user: env.POSTGRES_DB_USER ?? '',
      password: env.POSTGRES_DB_PASSWORD ?? '',
      passwordSsm: env.POSTGRES_DB_PASSWORD_SSM?.trim() || null,
      database: env.POSTGRES_DB_NAME ?? 'emails',
      sslmode: (env.POSTGRES_DB_SSLMODE as Config['database']['sslmode'] | undefined) ?? sslDefault,
    },
    tunnel: tunnelHost
      ? {
          host: tunnelHost,
          port: int(env.SSH_TUNNEL_PORT, 22),
          user: env.SSH_TUNNEL_USER ?? 'ubuntu',
          keyPath: env.SSH_TUNNEL_KEY_PATH?.trim() || null,
          keySsm: env.SSH_TUNNEL_KEY_SSM?.trim() || null,
          hostKey: env.SSH_TUNNEL_HOST_KEY?.trim() || null,
        }
      : null,
    mail: {
      domains: list(env.MAIL_DOMAINS),
      transport: (env.MAIL_TRANSPORT as 'ses' | 'mock' | undefined) ?? (production ? 'ses' : 'mock'),
      region: env.SES_REGION ?? env.AWS_REGION,
      bucket: env.MAIL_BUCKET?.trim() || null,
      prefix: env.MAIL_PREFIX ?? 'email-inbox/',
      defaultFrom: env.DEFAULT_FROM?.trim().toLowerCase() || null,
      maxAttachmentBytes: int(env.MAX_ATTACHMENT_BYTES, 4 * 1024 * 1024),
    },
    files: {
      driver: filesDriver,
      region: env.FILES_REGION ?? env.AWS_REGION,
      privateBucket,
      privatePrefix: env.FILES_PREFIX ?? 'drop/',
      publicBucket: env.PUBLIC_FILES_BUCKET?.trim() || null,
      publicPrefix: env.PUBLIC_FILES_PREFIX ?? 'public/',
      localDir: env.FILES_LOCAL_DIR ?? '.data/files',
      maxBytes: int(env.FILES_MAX_BYTES, 2 * 1024 * 1024 * 1024),
    },
    vault: {
      key: env.VAULT_KEY?.trim() || null,
      keySsm: env.VAULT_KEY_SSM?.trim() || null,
    },
    imageProxy: {
      allowPrivate: !production && env.IMAGE_PROXY_ALLOW_PRIVATE === '1',
      maxBytes: 4_500_000, // Lambda cannot return more than 6 MB
      timeoutMs: 8_000,
    },
    push: {
      publicKey: env.VAPID_PUBLIC_KEY?.trim() || null,
      privateKey: env.VAPID_PRIVATE_KEY?.trim() || null,
      privateKeySsm: env.VAPID_PRIVATE_KEY_SSM?.trim() || null,
      subject: env.VAPID_SUBJECT?.trim() || `mailto:postmaster@${list(env.MAIL_DOMAINS)[0] ?? 'localhost'}`,
      extraHosts: production ? [] : list(env.PUSH_ENDPOINT_ALLOW),
    },
    session: {
      // Sliding: every day of use extends the session, so a phone that is used stays signed in.
      ttlHours: int(env.SESSION_TTL_HOURS, 24 * 30),
      // The __Host- prefix makes browsers refuse the cookie unless it is Secure, Path=/ and host-only.
      cookieName: production ? '__Host-eisenmail' : 'eisenmail_dev',
      deviceCookieName: production ? '__Host-eisenmail-device' : 'eisenmail_dev_device',
    },
  };

  // Locations must not overlap, or a "public" name could resolve to a private object.
  if (config.files.driver === 's3') {
    const f = config.files;
    const locations = [
      { what: 'FILES_PREFIX', bucket: f.privateBucket, prefix: f.privatePrefix },
      { what: 'PUBLIC_FILES_PREFIX', bucket: f.publicBucket ?? f.privateBucket, prefix: f.publicPrefix },
      ...(config.mail.bucket ? [{ what: 'MAIL_PREFIX', bucket: config.mail.bucket, prefix: config.mail.prefix }] : []),
    ];
    for (const l of locations) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*\/$/.test(l.prefix)) throw new Error(`eisenmail configuration: ${l.what} must be a non-empty prefix ending in "/"`);
    }
    for (const a of locations) {
      for (const b of locations) {
        if (a !== b && a.bucket === b.bucket && a.prefix.startsWith(b.prefix)) {
          throw new Error(`eisenmail configuration: ${a.what} and ${b.what} overlap in bucket ${a.bucket}`);
        }
      }
    }
  }

  if (production) {
    const problems: string[] = [];
    if (!config.database.user || (!config.database.password && !config.database.passwordSsm)) problems.push('POSTGRES_DB_USER and POSTGRES_DB_PASSWORD_SSM (or POSTGRES_DB_PASSWORD) are required');
    if (config.mail.domains.length === 0) problems.push('MAIL_DOMAINS is required (comma separated list of domains mail may be sent from)');
    if (config.mail.transport !== 'ses') problems.push('MAIL_TRANSPORT must be "ses" in production');
    if (config.files.driver === 'local') problems.push('FILES_DRIVER=local is for development only');
    if (config.files.driver === 's3' && !config.files.privateBucket) problems.push('FILES_BUCKET is required when FILES_DRIVER=s3');
    if (config.tunnel && !config.tunnel.keyPath && !config.tunnel.keySsm) problems.push('SSH_TUNNEL_KEY_SSM or SSH_TUNNEL_KEY_PATH is required with SSH_TUNNEL_HOST');
    if (config.tunnel && !config.tunnel.hostKey) problems.push('SSH_TUNNEL_HOST_KEY is required with SSH_TUNNEL_HOST (pin the server key: ssh-keyscan -t ed25519 <host>)');
    if (problems.length) throw new Error(`eisenmail configuration:\n  - ${problems.join('\n  - ')}`);
  }
  return config;
}

const config: Config = load();
export default config;
