import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import config from './config.js';
import { HttpError } from './mail.js';
import type { FileEntry, UploadTicket } from '../shared/api.js';

// The personal file drop. Everything is private unless explicitly made public. Public files live
// under a different bucket (or prefix), and the unauthenticated /public/<name> route can only ever
// reach that location. Neither bucket needs (or should have) a public bucket policy: downloads are
// short-lived presigned URLs minted by this server.

/** Flat namespace, conservative character set, no path separators, no leading dot. */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._ ()+,@=-]{0,199}$/;

export function checkName(input: unknown): string {
  const name = String(input ?? '').normalize('NFC');
  if (!NAME_RE.test(name) || name.includes('..') || name.endsWith('.') || name.endsWith(' ')) {
    throw new HttpError(400, 'File names may use letters, digits, spaces and . _ - ( ) + , @ = and must start with a letter or digit');
  }
  return name;
}

export type Visibility = 'private' | 'public';
export const visibilityOf = (v: unknown): Visibility => (v === 'public' ? 'public' : 'private');

export interface FileStore {
  list(): Promise<FileEntry[]>;
  uploadTicket(name: string, size: number, contentType: string): Promise<UploadTicket>;
  /** A URL the browser can be redirected to, or null when the file does not exist. */
  downloadUrl(name: string, visibility: Visibility): Promise<string | null>;
  setVisibility(name: string, from: Visibility, to: Visibility): Promise<void>;
  remove(name: string, visibility: Visibility): Promise<void>;
}

const publicPath = (name: string) => `/public/${encodeURIComponent(name)}`;

// Types a browser can show without them being able to run script in a meaningful origin.
const INLINE_TYPES = /^(image\/(png|jpeg|gif|webp|avif)|application\/pdf|text\/plain|video\/mp4|audio\/mpeg)$/;

function disposition(name: string, inline: boolean): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

// ------------------------------------------------------------------------------------------------
// S3
// ------------------------------------------------------------------------------------------------

function s3Store(): FileStore {
  const f = config.files;
  const where = (v: Visibility) =>
    v === 'public'
      ? { Bucket: f.publicBucket ?? f.privateBucket!, prefix: f.publicPrefix }
      : { Bucket: f.privateBucket!, prefix: f.privatePrefix };
  // config.ts has already verified that the private, public and mail locations do not overlap.

  const sdk = import('@aws-sdk/client-s3');
  const presigner = import('@aws-sdk/s3-request-presigner');
  const client = sdk.then((m) => new m.S3Client({ region: f.region }));

  async function listOne(v: Visibility): Promise<FileEntry[]> {
    const { ListObjectsV2Command } = await sdk;
    const { Bucket, prefix } = where(v);
    const out: FileEntry[] = [];
    let token: string | undefined;
    do {
      const res = await (await client).send(new ListObjectsV2Command({ Bucket, Prefix: prefix, Delimiter: '/', ContinuationToken: token }));
      for (const o of res.Contents ?? []) {
        const name = (o.Key ?? '').slice(prefix.length);
        if (!NAME_RE.test(name)) continue;
        out.push({ name, size: o.Size ?? 0, modified: (o.LastModified ?? new Date()).toISOString(), isPublic: v === 'public', publicPath: v === 'public' ? publicPath(name) : null });
      }
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);
    return out;
  }

  return {
    async list() {
      const [priv, pub] = await Promise.all([listOne('private'), listOne('public')]);
      return [...priv, ...pub];
    },
    async uploadTicket(name, size, contentType) {
      const { PutObjectCommand } = await sdk;
      const { getSignedUrl } = await presigner;
      const { Bucket, prefix } = where('private');
      // Content-Length and Content-Type are part of the signature: the URL only works for exactly this upload.
      const url = await getSignedUrl(
        await client,
        new PutObjectCommand({ Bucket, Key: prefix + name, ContentLength: size, ContentType: contentType }),
        { expiresIn: 900, signableHeaders: new Set(['content-length', 'content-type']) },
      );
      return { url, method: 'PUT', headers: { 'Content-Type': contentType } };
    },
    async downloadUrl(name, v) {
      const { GetObjectCommand, HeadObjectCommand } = await sdk;
      const { getSignedUrl } = await presigner;
      const { Bucket, prefix } = where(v);
      let type = 'application/octet-stream';
      try {
        const head = await (await client).send(new HeadObjectCommand({ Bucket, Key: prefix + name }));
        type = head.ContentType ?? type;
      } catch {
        return null;
      }
      const inline = v === 'public' && INLINE_TYPES.test(type);
      return getSignedUrl(
        await client,
        new GetObjectCommand({
          Bucket,
          Key: prefix + name,
          ResponseContentDisposition: disposition(name, inline),
          ResponseContentType: inline ? type : 'application/octet-stream',
        }),
        { expiresIn: v === 'public' ? 300 : 60 },
      );
    },
    async setVisibility(name, from, to) {
      if (from === to) return;
      const { CopyObjectCommand, DeleteObjectCommand } = await sdk;
      const src = where(from);
      const dst = where(to);
      await (await client).send(
        new CopyObjectCommand({
          Bucket: dst.Bucket,
          Key: dst.prefix + name,
          CopySource: `${src.Bucket}/${encodeURIComponent(src.prefix + name).replace(/%2F/g, '/')}`,
        }),
      );
      await (await client).send(new DeleteObjectCommand({ Bucket: src.Bucket, Key: src.prefix + name }));
    },
    async remove(name, v) {
      const { DeleteObjectCommand } = await sdk;
      const { Bucket, prefix } = where(v);
      await (await client).send(new DeleteObjectCommand({ Bucket, Key: prefix + name }));
    },
  };
}

// ------------------------------------------------------------------------------------------------
// Local disk (development only)
// ------------------------------------------------------------------------------------------------

export function localPath(name: string, v: Visibility): string {
  const dir = path.resolve(config.files.localDir, v);
  const full = path.resolve(dir, name);
  if (path.dirname(full) !== dir) throw new HttpError(400, 'Invalid file name');
  return full;
}

function localStore(): FileStore {
  const dirs = (['private', 'public'] as const).map((v) => path.resolve(config.files.localDir, v));
  for (const d of dirs) fs.mkdirSync(d, { recursive: true });
  return {
    async list() {
      const out: FileEntry[] = [];
      for (const v of ['private', 'public'] as const) {
        for (const name of await fsp.readdir(path.resolve(config.files.localDir, v))) {
          if (!NAME_RE.test(name)) continue;
          const st = await fsp.stat(localPath(name, v));
          if (st.isFile()) out.push({ name, size: st.size, modified: st.mtime.toISOString(), isPublic: v === 'public', publicPath: v === 'public' ? publicPath(name) : null });
        }
      }
      return out;
    },
    async uploadTicket(name, _size, contentType) {
      return { url: `/api/files/local-upload/${encodeURIComponent(name)}`, method: 'PUT', headers: { 'Content-Type': contentType, 'X-Eisenmail': '1' } };
    },
    async downloadUrl(name, v) {
      return fs.existsSync(localPath(name, v)) ? `/api/files/local-download/${v}/${encodeURIComponent(name)}` : null;
    },
    async setVisibility(name, from, to) {
      if (from !== to) await fsp.rename(localPath(name, from), localPath(name, to));
    },
    async remove(name, v) {
      await fsp.rm(localPath(name, v), { force: true });
    },
  };
}

export async function localWrite(name: string, body: Readable, maxBytes: number): Promise<void> {
  const target = localPath(name, 'private');
  const tmp = `${target}.uploading`;
  let seen = 0;
  body.on('data', (chunk: Buffer) => {
    seen += chunk.length;
    if (seen > maxBytes) body.destroy(new HttpError(413, 'File is too large'));
  });
  try {
    await pipeline(body, fs.createWriteStream(tmp));
    await fsp.rename(tmp, target);
  } catch (err) {
    await fsp.rm(tmp, { force: true });
    throw err;
  }
}

export { disposition };

let store: FileStore | null | undefined;
export function fileStore(): FileStore | null {
  if (store === undefined) store = config.files.driver === 's3' ? s3Store() : config.files.driver === 'local' ? localStore() : null;
  return store;
}

/** Best effort removal of the SES raw objects for permanently deleted mail. */
export async function deleteMailObjects(keys: string[]): Promise<void> {
  if (!config.mail.bucket || keys.length === 0) return;
  try {
    const { S3Client, DeleteObjectsCommand } = await import('@aws-sdk/client-s3');
    const client = new S3Client({ region: config.files.region });
    for (let i = 0; i < keys.length; i += 1000) {
      await client.send(new DeleteObjectsCommand({ Bucket: config.mail.bucket, Delete: { Objects: keys.slice(i, i + 1000).map((Key) => ({ Key })), Quiet: true } }));
    }
  } catch (err) {
    console.error(`could not delete raw mail objects from s3: ${(err as Error).message}`);
  }
}
