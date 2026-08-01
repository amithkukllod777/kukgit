import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { httpError } from './security.mjs';

export const STORAGE_KINDS = ['filesystem', 's3'];

// Keys this module accepts. The caller composes them from content digests, so
// the charset is narrow on purpose: a key is a path on one backend and a URL
// path segment on the other, and anything that means something to either — `..`,
// a leading slash, a backslash — must not survive.
const KEY = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

function assertKey(key) {
  const text = String(key ?? '');
  if (!KEY.test(text) || text.includes('..') || text.includes('//')) {
    throw httpError(400, 'Invalid object storage key.', 'STORAGE_KEY_INVALID');
  }
  return text;
}

/**
 * Content storage on the local volume.
 *
 * The default, and what every existing instance already has. Writes go to a
 * temporary name and are renamed, so a reader never sees a partial object under
 * a key that promises a complete one.
 */
export function createFilesystemStorage({ root }) {
  const resolve = (key) => path.join(root, ...assertKey(key).split('/'));

  return {
    kind: 'filesystem',
    describe: () => ({ kind: 'filesystem', root }),
    selfContainedBackup: true,

    async head(key) {
      const target = resolve(key);
      if (!fs.existsSync(target)) return null;
      const stat = fs.statSync(target);
      return stat.isFile() ? { size: stat.size } : null;
    },

    async putFile(key, sourcePath) {
      const target = resolve(key);
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      // An object is addressed by its digest, so an existing key already holds
      // exactly these bytes. Rewriting it would replace a file a reader may be
      // streaming for no gain.
      if (fs.existsSync(target)) {
        fs.rmSync(sourcePath, { force: true });
        return { size: fs.statSync(target).size, deduplicated: true };
      }
      fs.renameSync(sourcePath, target);
      fs.chmodSync(target, 0o600);
      return { size: fs.statSync(target).size, deduplicated: false };
    },

    async createReadStream(key, { start, end } = {}) {
      const target = resolve(key);
      if (!fs.existsSync(target)) throw httpError(404, 'Stored object is missing.', 'STORAGE_OBJECT_MISSING');
      return fs.createReadStream(target, start === undefined ? {} : { start, end });
    },

    async remove(key) {
      fs.rmSync(resolve(key), { force: true });
    },

    localPath: (key) => resolve(key),
  };
}

const UNRESERVED = /[^A-Za-z0-9\-._~]/g;

function uriEncode(value, encodeSlash = true) {
  return String(value).replace(UNRESERVED, (character) => {
    if (character === '/' && !encodeSlash) return '/';
    return Buffer.from(character, 'utf8').toString('hex').toUpperCase().replace(/(..)/g, '%$1');
  });
}

function hmac(key, value) {
  return crypto.createHmac('sha256', key).update(value, 'utf8').digest();
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/**
 * Signs a request with AWS Signature Version 4.
 *
 * Written out rather than taken from an SDK because KukGit ships with no runtime
 * dependencies, and an SDK for this would be the largest dependency in the
 * product for one signing algorithm. SigV4 is a fixed HMAC chain; the parts that
 * are easy to get wrong are canonicalisation and the signed-header list, and
 * both are visible here rather than three layers down.
 */
export function signRequestV4({
  method, url, headers = {}, payloadHash, accessKeyId, secretAccessKey, sessionToken = null, region, service = 's3', now = new Date(),
}) {
  const target = new URL(url);
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const dateStamp = amzDate.slice(0, 8);

  const allHeaders = {
    ...headers,
    host: target.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
    ...(sessionToken ? { 'x-amz-security-token': sessionToken } : {}),
  };
  const canonicalNames = Object.keys(allHeaders).map((name) => name.toLowerCase()).sort();
  const lowered = Object.fromEntries(Object.entries(allHeaders).map(([name, value]) => [name.toLowerCase(), String(value).trim()]));
  const canonicalHeaders = canonicalNames.map((name) => `${name}:${lowered[name]}\n`).join('');
  const signedHeaders = canonicalNames.join(';');

  const canonicalQuery = [...target.searchParams.entries()]
    .map(([name, value]) => [uriEncode(name), uriEncode(value)])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, value]) => `${name}=${value}`)
    .join('&');

  const canonicalRequest = [
    method,
    uriEncode(decodeURIComponent(target.pathname), false),
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');

  const signingKey = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, dateStamp), region), service), 'aws4_request');
  const signature = crypto.createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');

  return {
    ...allHeaders,
    Authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

// Payloads are streamed from a file, so the body hash cannot be computed by
// buffering it. `UNSIGNED-PAYLOAD` is the standard way to say so; the request
// itself is still signed, and TLS is what protects the body in transit.
const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';
const EMPTY_PAYLOAD = sha256Hex('');

/**
 * Content storage in an S3-compatible bucket.
 *
 * Path-style addressing by default, because most S3-compatible services are
 * reached that way and a virtual-host style bucket in a hostname breaks against
 * anything that is not AWS itself.
 */
export function createS3Storage({
  bucket, region, endpoint, accessKeyId, secretAccessKey, sessionToken = null,
  prefix = '', forcePathStyle = true, fetchImpl = fetch,
}) {
  if (!bucket) throw new Error('Object storage requires a bucket name.');
  if (!accessKeyId || !secretAccessKey) throw new Error('Object storage requires credentials.');
  const base = String(endpoint || `https://s3.${region}.amazonaws.com`).replace(/\/$/, '');
  const cleanPrefix = String(prefix || '').replace(/^\/+|\/+$/g, '');

  const objectUrl = (key) => {
    const full = [cleanPrefix, assertKey(key)].filter(Boolean).join('/');
    const encoded = full.split('/').map((segment) => uriEncode(segment)).join('/');
    return forcePathStyle ? `${base}/${bucket}/${encoded}` : `${base.replace('://', `://${bucket}.`)}/${encoded}`;
  };

  const send = async (method, key, { headers = {}, body = null, payloadHash = EMPTY_PAYLOAD } = {}) => {
    const url = objectUrl(key);
    const signed = signRequestV4({
      method, url, headers, payloadHash, accessKeyId, secretAccessKey, sessionToken, region,
    });
    const response = await fetchImpl(url, { method, headers: signed, body, duplex: body ? 'half' : undefined });
    return response;
  };

  const fail = async (response, key, action) => {
    // The body of an S3 error can contain the request id and the bucket name.
    // Neither belongs in a message a user sees, so the status and the action are
    // what surface and the detail goes to the operator's log.
    const detail = await response.text().catch(() => '');
    console.error(`KukGit object storage ${action} ${key}: ${response.status} ${detail.slice(0, 400)}`);
    if (response.status === 403 || response.status === 401) {
      throw httpError(502, 'Object storage rejected the instance credentials.', 'STORAGE_UNAUTHORIZED');
    }
    throw httpError(502, 'Object storage is unavailable.', 'STORAGE_UNAVAILABLE');
  };

  return {
    kind: 's3',
    describe: () => ({ kind: 's3', bucket, region, endpoint: base, prefix: cleanPrefix }),
    // An archive taken against a bucket does not contain the bytes. Whoever
    // restores it needs the bucket too, and the backup format has to say so
    // rather than let somebody discover it during a recovery.
    selfContainedBackup: false,

    async head(key) {
      const response = await send('HEAD', key);
      if (response.status === 404) return null;
      if (!response.ok) return fail(response, key, 'head');
      return { size: Number(response.headers.get('content-length') || 0) };
    },

    async putFile(key, sourcePath) {
      const size = fs.statSync(sourcePath).size;
      const existing = await this.head(key);
      // Addressed by digest, so an existing key already holds these bytes.
      if (existing && existing.size === size) {
        fs.rmSync(sourcePath, { force: true });
        return { size, deduplicated: true };
      }
      const body = Readable.toWeb(fs.createReadStream(sourcePath));
      const response = await send('PUT', key, {
        headers: { 'content-length': String(size), 'content-type': 'application/octet-stream' },
        body,
        payloadHash: UNSIGNED_PAYLOAD,
      });
      if (!response.ok) return fail(response, key, 'put');
      fs.rmSync(sourcePath, { force: true });
      return { size, deduplicated: false };
    },

    async createReadStream(key, { start, end } = {}) {
      const headers = start === undefined ? {} : { range: `bytes=${start}-${end}` };
      const response = await send('GET', key, { headers });
      if (response.status === 404) throw httpError(404, 'Stored object is missing.', 'STORAGE_OBJECT_MISSING');
      if (!response.ok) return fail(response, key, 'get');
      return Readable.fromWeb(response.body);
    },

    async remove(key) {
      const response = await send('DELETE', key);
      // A delete of something already gone is the outcome the caller wanted.
      if (!response.ok && response.status !== 404) return fail(response, key, 'delete');
    },

    localPath: () => null,
  };
}

/**
 * Builds the storage backend an instance is configured for.
 *
 * Filesystem is the default and stays the default. Object storage is opt-in per
 * instance, because switching it on for an instance whose bytes are on a volume
 * would make every existing object unreadable — moving them is a migration, not
 * a configuration change.
 */
export function createObjectStorage(config, { root, prefix = '' } = {}) {
  const settings = config.objectStorage ?? {};
  if (settings.driver !== 's3') {
    return createFilesystemStorage({ root: root ?? config.lfsDir });
  }
  return createS3Storage({
    bucket: settings.bucket,
    region: settings.region,
    endpoint: settings.endpoint,
    accessKeyId: settings.accessKeyId,
    secretAccessKey: settings.secretAccessKey,
    sessionToken: settings.sessionToken,
    forcePathStyle: settings.forcePathStyle,
    prefix: [settings.prefix, prefix].filter(Boolean).join('/'),
  });
}

/**
 * Reads an object through and reports its SHA-256 and size.
 *
 * The verification a backup rehearsal needs when the bytes are not in the
 * archive. Streamed rather than buffered: an LFS object can be gigabytes, and a
 * verification that needs the object in memory is one nobody can run on the
 * objects that most need verifying.
 */
export async function digestObject(storage, key) {
  const hash = crypto.createHash('sha256');
  let size = 0;
  const stream = await storage.createReadStream(key);
  for await (const chunk of stream) {
    size += chunk.length;
    hash.update(chunk);
  }
  return { digest: hash.digest('hex'), size };
}
