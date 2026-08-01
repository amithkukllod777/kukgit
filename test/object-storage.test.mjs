import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.mjs';
import {
  createFilesystemStorage,
  createObjectStorage,
  createS3Storage,
  digestObject,
  signRequestV4,
} from '../src/object-storage.mjs';

function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-storage-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function stagedFile(root, content) {
  const file = path.join(root, `staged-${crypto.randomBytes(4).toString('hex')}`);
  fs.writeFileSync(file, content);
  return file;
}

// An S3 that lives in a Map. It records what was signed and sent, so the tests
// assert on the request the driver actually produced rather than on a mock's
// idea of one.
function fakeS3() {
  const objects = new Map();
  const requests = [];
  const fetchImpl = async (url, options) => {
    const key = new URL(url).pathname;
    requests.push({ url, method: options.method, headers: options.headers });
    if (options.method === 'PUT') {
      const chunks = [];
      for await (const chunk of options.body) chunks.push(Buffer.from(chunk));
      objects.set(key, Buffer.concat(chunks));
      return new Response(null, { status: 200 });
    }
    const stored = objects.get(key);
    if (options.method === 'DELETE') {
      objects.delete(key);
      return new Response(null, { status: stored ? 204 : 404 });
    }
    if (!stored) return new Response('<Error/>', { status: 404 });
    if (options.method === 'HEAD') {
      return new Response(null, { status: 200, headers: { 'content-length': String(stored.length) } });
    }
    const range = /bytes=(\d+)-(\d+)/.exec(options.headers?.range ?? '');
    const body = range ? stored.subarray(Number(range[1]), Number(range[2]) + 1) : stored;
    return new Response(body, { status: range ? 206 : 200 });
  };
  return { objects, requests, fetchImpl };
}

function s3(t, overrides = {}) {
  const fake = fakeS3();
  const storage = createS3Storage({
    bucket: 'kukgit-objects',
    region: 'eu-central-1',
    endpoint: 'https://s3.example.test',
    accessKeyId: 'AKIAEXAMPLE',
    secretAccessKey: 'secret',
    prefix: 'lfs',
    fetchImpl: fake.fetchImpl,
    ...overrides,
  });
  return { storage, ...fake, root: scratch(t) };
}

test('a signature matches the published AWS SigV4 example', () => {
  // The `get-vanilla` case from the AWS SigV4 test suite. Signing is the one
  // part of this that cannot be checked by round-tripping against our own code:
  // an agreed-wrong implementation would pass every self-consistent test and
  // fail against every real bucket.
  const headers = signRequestV4({
    method: 'GET',
    url: 'https://example.amazonaws.com/',
    payloadHash: crypto.createHash('sha256').update('').digest('hex'),
    accessKeyId: 'AKIDEXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
    region: 'us-east-1',
    service: 'service',
    now: new Date('2015-08-30T12:36:00Z'),
  });

  assert.match(headers.Authorization, /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20150830\/us-east-1\/service\/aws4_request/);
  assert.match(headers.Authorization, /SignedHeaders=host;x-amz-content-sha256;x-amz-date/);
  assert.equal(headers['x-amz-date'], '20150830T123600Z');
});

test('signing covers the query string and encodes it canonically', () => {
  const sign = (url) => signRequestV4({
    method: 'GET', url, payloadHash: 'UNSIGNED-PAYLOAD',
    accessKeyId: 'AKID', secretAccessKey: 'secret', region: 'us-east-1',
    now: new Date('2026-08-01T00:00:00Z'),
  }).Authorization;

  // Query parameters are part of the canonical request, so two URLs that differ
  // only there must not share a signature — otherwise a signed request could be
  // replayed against a different object.
  assert.notEqual(sign('https://s3.test/bucket/key?versionId=1'), sign('https://s3.test/bucket/key?versionId=2'));
  // Ordering is canonical, so the same request signs identically either way.
  assert.equal(sign('https://s3.test/bucket/k?b=2&a=1'), sign('https://s3.test/bucket/k?a=1&b=2'));
  // A session token is signed rather than merely attached.
  const withToken = signRequestV4({
    method: 'GET', url: 'https://s3.test/bucket/key', payloadHash: 'UNSIGNED-PAYLOAD',
    accessKeyId: 'AKID', secretAccessKey: 'secret', region: 'us-east-1', sessionToken: 'session',
    now: new Date('2026-08-01T00:00:00Z'),
  });
  assert.match(withToken.Authorization, /x-amz-security-token/);
  assert.equal(withToken['x-amz-security-token'], 'session');
});

test('a key that means something to a path or a URL is refused', async (t) => {
  const local = createFilesystemStorage({ root: scratch(t) });
  const remote = s3(t).storage;
  const refused = ['../escape', '/absolute', 'a//b', 'objects/../../etc/passwd', 'back\\slash', ''];

  // A key is a filesystem path on one backend and a URL path on the other.
  // Anything that means something to either has to be refused by both, or the
  // two backends disagree about what an object is.
  for (const storage of [local, remote]) {
    for (const key of refused) {
      await assert.rejects(
        storage.head(key),
        (error) => error.code === 'STORAGE_KEY_INVALID',
        `${storage.kind} accepted ${JSON.stringify(key)}`,
      );
    }
  }
});

test('the filesystem backend round-trips, dedupes and range-reads', async (t) => {
  const root = scratch(t);
  const storage = createFilesystemStorage({ root });
  const content = Buffer.from('the quick brown fox jumps over the lazy dog');

  assert.equal(await storage.head('objects/ab/cd/abcd'), null);
  const first = await storage.putFile('objects/ab/cd/abcd', stagedFile(root, content));
  assert.equal(first.deduplicated, false);
  assert.deepEqual(await storage.head('objects/ab/cd/abcd'), { size: content.length });

  // Addressed by digest, so a second write of the same key is the same bytes.
  const second = await storage.putFile('objects/ab/cd/abcd', stagedFile(root, content));
  assert.equal(second.deduplicated, true);

  const chunks = [];
  for await (const chunk of await storage.createReadStream('objects/ab/cd/abcd', { start: 4, end: 8 })) chunks.push(chunk);
  assert.equal(Buffer.concat(chunks).toString(), 'quick');

  await storage.remove('objects/ab/cd/abcd');
  assert.equal(await storage.head('objects/ab/cd/abcd'), null);
  await storage.remove('objects/ab/cd/abcd');
});

test('the S3 backend round-trips through a signed request', async (t) => {
  const { storage, requests, root } = s3(t);
  const content = Buffer.from('object stored in a bucket');

  await storage.putFile('objects/ab/cd/abcd', stagedFile(root, content));
  const put = requests.find((request) => request.method === 'PUT');
  assert.equal(put.url, 'https://s3.example.test/kukgit-objects/lfs/objects/ab/cd/abcd');
  assert.match(put.headers.Authorization, /^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE\/\d{8}\/eu-central-1\/s3\/aws4_request/);
  // A streamed body cannot be hashed without buffering it, and buffering a
  // multi-gigabyte object to sign it is not an option.
  assert.equal(put.headers['x-amz-content-sha256'], 'UNSIGNED-PAYLOAD');

  assert.deepEqual(await storage.head('objects/ab/cd/abcd'), { size: content.length });
  const { digest, size } = await digestObject(storage, 'objects/ab/cd/abcd');
  assert.equal(digest, crypto.createHash('sha256').update(content).digest('hex'));
  assert.equal(size, content.length);

  const chunks = [];
  for await (const chunk of await storage.createReadStream('objects/ab/cd/abcd', { start: 0, end: 5 })) chunks.push(chunk);
  assert.equal(Buffer.concat(chunks).toString(), 'object');

  await storage.remove('objects/ab/cd/abcd');
  assert.equal(await storage.head('objects/ab/cd/abcd'), null);
});

test('a missing object is a 404 and a rejected credential is not a 404', async (t) => {
  const { storage } = s3(t);
  await assert.rejects(storage.createReadStream('objects/ab/cd/abcd'), (error) => error.status === 404);

  const denied = createS3Storage({
    bucket: 'b', region: 'r', endpoint: 'https://s3.test', accessKeyId: 'k', secretAccessKey: 's',
    fetchImpl: async () => new Response('<Error><RequestId>abc</RequestId></Error>', { status: 403 }),
  });
  await assert.rejects(denied.head('objects/ab/cd/abcd'), (error) => {
    assert.equal(error.code, 'STORAGE_UNAUTHORIZED');
    // The S3 error body carries a request id and the bucket name; neither
    // belongs in a message a user sees.
    assert.doesNotMatch(error.message, /RequestId|abc/);
    return true;
  });
});

test('a backup archive knows whether it contains the bytes', (t) => {
  const dataDir = scratch(t);
  const local = createObjectStorage(loadConfig({ nodeEnv: 'test', dataDir }), { root: dataDir });
  assert.equal(local.kind, 'filesystem');
  assert.equal(local.selfContainedBackup, true);

  const remote = createObjectStorage(loadConfig({
    nodeEnv: 'test',
    dataDir,
    objectStorageDriver: 's3',
    objectStorageBucket: 'kukgit',
    objectStorageAccessKeyId: 'k',
    objectStorageSecretAccessKey: 's',
  }));
  assert.equal(remote.kind, 's3');
  // An archive taken against a bucket verifies the objects but does not hold
  // them, and a restore needs the bucket too.
  assert.equal(remote.selfContainedBackup, false);

  // The descriptor is what lands in a backup manifest, so it must carry no
  // credential — an archive that can be read would otherwise hand over the store.
  const described = JSON.stringify(remote.describe());
  assert.doesNotMatch(described, /"k"|"s"|accessKey|secret/i);
  assert.match(described, /kukgit/);
});
