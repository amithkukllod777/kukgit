import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { openDatabase, seedCore } from '../src/db.mjs';
import { migrateGitLfs } from '../src/git-lfs.mjs';
import { createObjectStorage } from '../src/object-storage.mjs';
import {
  migrateLfsObjectsToBucket,
  planLfsStorageMigration,
  reclaimVolumeAfterMigration,
  verifyBucketHoldsEveryObject,
} from '../src/lfs-storage-migration.mjs';

// A bucket that lives in a Map, installed by replacing global fetch for the
// duration of one test. The migration talks to it through the real S3 driver, so
// the signing and key layout are the ones production uses.
function installBucket(t) {
  const objects = new Map();
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const key = new URL(url).pathname;
    if (options.method === 'PUT') {
      const chunks = [];
      for await (const chunk of options.body) chunks.push(Buffer.from(chunk));
      objects.set(key, Buffer.concat(chunks));
      return new Response(null, { status: 200 });
    }
    const stored = objects.get(key);
    if (options.method === 'DELETE') { objects.delete(key); return new Response(null, { status: 204 }); }
    if (!stored) return new Response('<Error/>', { status: 404 });
    if (options.method === 'HEAD') return new Response(null, { status: 200, headers: { 'content-length': String(stored.length) } });
    return new Response(stored, { status: 200 });
  };
  t.after(() => { globalThis.fetch = original; });
  return objects;
}

function setup(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-lfs-migration-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const config = loadConfig({
    dataDir,
    databasePath: path.join(dataDir, 'kukgit.db'),
    repositoriesDir: path.join(dataDir, 'repos'),
    lfsDir: path.join(dataDir, 'lfs'),
    tempDir: path.join(dataDir, 'tmp'),
    nodeEnv: 'test',
    baseUrl: 'http://127.0.0.1:8787',
    adminEmail: 'owner@example.com',
    adminPassword: 'secure-owner-password',
    adminName: 'Owner',
    objectStorageDriver: 's3',
    objectStorageBucket: 'kukgit-lfs',
    objectStorageRegion: 'eu-central-1',
    objectStorageEndpoint: 'https://s3.example.test',
    objectStorageAccessKeyId: 'AKIAEXAMPLE',
    objectStorageSecretAccessKey: 'secret',
  });
  fs.mkdirSync(config.tempDir, { recursive: true });
  const db = openDatabase(config);
  t.after(() => db.close());
  migrateGitLfs(db);
  seedCore(db, config);
  return { config, db, bucket: installBucket(t) };
}

// Writes an object to the volume exactly as the LFS handler would, and records it.
function seedObject(context, content) {
  const oid = crypto.createHash('sha256').update(content).digest('hex');
  const storagePath = `objects/${oid.slice(0, 2)}/${oid.slice(2, 4)}/${oid}`;
  const filePath = path.join(context.config.lfsDir, ...storagePath.split('/'));
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, content, { mode: 0o600 });
  context.db.prepare('INSERT INTO lfs_objects (oid, size, storage_path) VALUES (?, ?, ?)')
    .run(oid, content.length, storagePath);
  return { oid, storagePath, filePath, size: content.length };
}

test('the plan reports what moves and refuses to hide what is already wrong', async (t) => {
  const context = setup(t);
  const healthy = seedObject(context, Buffer.from('an object that is fine'));
  const gone = seedObject(context, Buffer.from('an object that vanished'));
  const rotted = seedObject(context, Buffer.from('an object that rotted'));
  fs.rmSync(gone.filePath);
  fs.writeFileSync(rotted.filePath, Buffer.from('different bytes entirely'));

  const plan = await planLfsStorageMigration(context.config, context.db);
  assert.equal(plan.total, 3);
  assert.deepEqual(plan.pending.map((object) => object.oid), [healthy.oid].filter(Boolean));

  // Neither of these is caused by the migration. The database says they exist
  // and the volume disagrees, which is true today and would stay true if nobody
  // ever migrated — so it is reported rather than copied over.
  assert.deepEqual(plan.missing.map((object) => object.oid), [gone.oid]);
  assert.deepEqual(plan.corrupt.map((object) => object.oid), [rotted.oid]);
});

test('a corrupt source stops the copy rather than moving the corruption', async (t) => {
  const context = setup(t);
  const rotted = seedObject(context, Buffer.from('rotted'));
  fs.writeFileSync(rotted.filePath, Buffer.from('not what the digest says'));

  await assert.rejects(
    migrateLfsObjectsToBucket(context.config, context.db),
    /do not match their recorded digest/,
  );
  assert.equal(context.bucket.size, 0, 'nothing reached the bucket');
});

test('copying verifies in the bucket, deletes nothing, and resumes', async (t) => {
  const context = setup(t);
  const first = seedObject(context, Buffer.from('first object'));
  const second = seedObject(context, Buffer.from('second object'));

  const partial = await migrateLfsObjectsToBucket(context.config, context.db, { limit: 1 });
  assert.equal(partial.copied, 1);
  assert.equal(partial.remaining, 1);
  // A migration that removes its own source has no rollback.
  assert.ok(fs.existsSync(first.filePath) && fs.existsSync(second.filePath));

  const rest = await migrateLfsObjectsToBucket(context.config, context.db);
  assert.equal(rest.copied, 1, 'the second run copies only what is left');
  assert.equal(rest.alreadyPresent, 1);
  assert.equal(rest.remaining, 0);
  assert.equal(context.bucket.size, 2);

  const verified = await verifyBucketHoldsEveryObject(context.config, context.db);
  assert.equal(verified.readyForCutover, true);
  assert.equal(verified.checked, 2);
});

test('an object that arrives wrong in the bucket is removed rather than left in place', async (t) => {
  const context = setup(t);
  seedObject(context, Buffer.from('an object'));

  // A `PUT` that returns 200 is a claim; the digest is the proof. Here the store
  // accepts the write and then serves something else.
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (options.method === 'GET') return new Response(Buffer.from('corrupted in transit'), { status: 200 });
    return original(url, options);
  };
  t.after(() => { globalThis.fetch = original; });

  const result = await migrateLfsObjectsToBucket(context.config, context.db);
  assert.equal(result.copied, 0);
  assert.equal(result.failed.length, 1);
  assert.match(result.failed[0].reason, /does not match its digest/);
  // Removed, so the next run retries cleanly instead of finding a
  // plausible-looking object already in place and skipping it.
  assert.equal(context.bucket.size, 0);
});

test('verification of part of the set cannot clear a cutover', async (t) => {
  const context = setup(t);
  seedObject(context, Buffer.from('one'));
  seedObject(context, Buffer.from('two'));
  await migrateLfsObjectsToBucket(context.config, context.db);

  const partial = await verifyBucketHoldsEveryObject(context.config, context.db, { limit: 1 });
  assert.equal(partial.problems.length, 0);
  assert.equal(partial.complete, false);
  // The objects it skipped are exactly the ones nobody has looked at.
  assert.equal(partial.readyForCutover, false);
});

test('reclaiming re-verifies each object immediately before deleting its local copy', async (t) => {
  const context = setup(t);
  const kept = seedObject(context, Buffer.from('object that will vanish from the bucket'));
  const removed = seedObject(context, Buffer.from('object that stays in the bucket'));
  await migrateLfsObjectsToBucket(context.config, context.db);

  await assert.rejects(reclaimVolumeAfterMigration(context.config, context.db), /Pass confirm/);

  // Something removed it from the bucket after the migration verified it — a
  // lifecycle rule, a policy change, a mistake. Trusting the earlier result
  // would delete the last copy.
  const target = createObjectStorage(context.config, { prefix: 'lfs' });
  await target.remove(kept.storagePath);

  const result = await reclaimVolumeAfterMigration(context.config, context.db, { confirm: true });
  assert.equal(result.removed, 1);
  assert.deepEqual(result.kept.map((object) => object.oid), [kept.oid]);
  assert.equal(fs.existsSync(kept.filePath), true, 'the only remaining copy is kept');
  assert.equal(fs.existsSync(removed.filePath), false);
});

test('migration refuses to run without object storage configured', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-lfs-migration-off-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const config = loadConfig({
    dataDir,
    databasePath: path.join(dataDir, 'kukgit.db'),
    repositoriesDir: path.join(dataDir, 'repos'),
    tempDir: path.join(dataDir, 'tmp'),
    nodeEnv: 'test',
    adminEmail: 'owner@example.com',
    adminPassword: 'secure-owner-password',
    adminName: 'Owner',
  });
  const db = openDatabase(config);
  t.after(() => db.close());
  migrateGitLfs(db);

  await assert.rejects(planLfsStorageMigration(config, db), /Object storage is not configured/);
  await assert.rejects(verifyBucketHoldsEveryObject(config, db), /Object storage is not configured/);
});
