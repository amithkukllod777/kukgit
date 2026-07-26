import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.mjs';
import { migrateCollaboration } from '../src/collaboration.mjs';
import { loadConfig } from '../src/config.mjs';
import { openDatabase, seedCore, uid } from '../src/db.mjs';
import { createBareRepository } from '../src/git.mjs';
import {
  createGitLfsHandler,
  createLfsAuthToken,
  createLfsSshAuthentication,
  lfsObjectPath,
  migrateGitLfs,
  verifyLfsAuthToken,
} from '../src/git-lfs.mjs';
import { migrateRepositoryAccess } from '../src/repository-access.mjs';
import { migrateRepositoryLifecycle } from '../src/repository-lifecycle.mjs';
import { authorizeLfsSshAuthentication, parseLfsSshOriginalCommand } from '../src/ssh-lfs.mjs';
import { createUserSshKey, migrateSshKeys } from '../src/ssh-keys.mjs';

const LFS_MEDIA_TYPE = 'application/vnd.git-lfs+json';

function basic(value) {
  return `Basic ${Buffer.from(`developer:${value}`).toString('base64')}`;
}

function ed25519PublicKey(seed = 1) {
  const type = Buffer.from('ssh-ed25519');
  const key = Buffer.alloc(32, seed);
  const encode = (value) => {
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32BE(value.length);
    return Buffer.concat([prefix, value]);
  };
  return `ssh-ed25519 ${Buffer.concat([encode(type), encode(key)]).toString('base64')}`;
}

function setup(t, overrides = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-lfs-test-'));
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
    adminName: 'Repository Owner',
    gitToken: 'test-development-git-token',
    lfsAuthKey: 'test-lfs-signing-key-that-is-long-enough',
    lfsMaxObjectBytes: 1024 * 1024,
    lfsRepositoryQuotaBytes: 2 * 1024 * 1024,
    lfsInstanceQuotaBytes: 4 * 1024 * 1024,
    lfsUploadExpirySeconds: 3600,
    ...overrides,
  });
  const db = openDatabase(config);
  t.after(() => db.close());
  migrateCollaboration(db);
  migrateRepositoryAccess(db);
  migrateRepositoryLifecycle(db);
  migrateSshKeys(db);
  migrateGitLfs(db);
  const { userId: ownerId, orgId } = seedCore(db, config);

  function repository(slug, visibility = 'private') {
    const id = uid('repo');
    createBareRepository(config, 'kuklabs', slug);
    db.prepare(`
      INSERT INTO repositories
        (id, organization_id, slug, name, description, visibility, default_branch, created_by)
      VALUES (?, ?, ?, ?, '', ?, 'main', ?)
    `).run(id, orgId, slug, slug, visibility, ownerId);
    return { id, slug, orgSlug: 'kuklabs', organizationId: orgId, visibility, archivedAt: null };
  }

  return { config, db, ownerId, orgId, repository };
}

async function serverFor(t, context) {
  const app = createApp({ config: context.config, db: context.db });
  const lfs = createGitLfsHandler({ config: context.config, db: context.db });
  const server = http.createServer(async (req, res) => {
    if (await lfs(req, res)) return;
    return app(req, res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  context.config.baseUrl = origin;
  return origin;
}

async function batch(origin, repo, operation, objects, authorization = 'test-development-git-token') {
  return fetch(`${origin}/git/kuklabs/${repo}.git/info/lfs/objects/batch`, {
    method: 'POST',
    headers: {
      'Content-Type': LFS_MEDIA_TYPE,
      Accept: LFS_MEDIA_TYPE,
      Authorization: authorization.startsWith('Bearer ') ? authorization : basic(authorization),
    },
    body: JSON.stringify({ operation, transfers: ['basic'], objects }),
  });
}

test('uploads, verifies, downloads and range-reads a SHA-256 addressed LFS object', async (t) => {
  const context = setup(t);
  context.repository('lfs-demo', 'private');
  const origin = await serverFor(t, context);
  const content = Buffer.from('KukGit large file payload\n');
  const oid = crypto.createHash('sha256').update(content).digest('hex');

  const registration = await batch(origin, 'lfs-demo', 'upload', [{ oid, size: content.length }]);
  assert.equal(registration.status, 200);
  const registered = await registration.json();
  assert.equal(registered.objects[0].actions.upload.href.endsWith(`/objects/${oid}`), true);

  const upload = await fetch(registered.objects[0].actions.upload.href, {
    method: 'PUT',
    headers: { Authorization: basic('test-development-git-token'), 'Content-Length': String(content.length) },
    body: content,
  });
  assert.equal(upload.status, 200);
  assert.equal(fs.readFileSync(lfsObjectPath(context.config, oid)).equals(content), true);

  const verify = await fetch(registered.objects[0].actions.verify.href, {
    method: 'POST',
    headers: { Authorization: basic('test-development-git-token'), 'Content-Type': LFS_MEDIA_TYPE },
    body: JSON.stringify({ oid, size: content.length }),
  });
  assert.equal(verify.status, 200);
  assert.equal((await verify.json()).valid, true);

  const downloadBatch = await batch(origin, 'lfs-demo', 'download', [{ oid, size: content.length }]);
  assert.equal(downloadBatch.status, 200);
  const downloadAction = (await downloadBatch.json()).objects[0].actions.download;
  const download = await fetch(downloadAction.href, { headers: { Authorization: basic('test-development-git-token') } });
  assert.equal(download.status, 200);
  assert.equal(Buffer.from(await download.arrayBuffer()).equals(content), true);
  assert.equal(download.headers.get('etag'), `"${oid}"`);

  const range = await fetch(downloadAction.href, {
    headers: { Authorization: basic('test-development-git-token'), Range: 'bytes=0-5' },
  });
  assert.equal(range.status, 206);
  assert.equal(range.headers.get('content-range'), `bytes 0-5/${content.length}`);
  assert.equal(Buffer.from(await range.arrayBuffer()).toString(), content.subarray(0, 6).toString());
});

test('rejects wrong hashes, wrong sizes and repository quota overflow', async (t) => {
  const context = setup(t, { lfsMaxObjectBytes: 100, lfsRepositoryQuotaBytes: 10, lfsInstanceQuotaBytes: 100 });
  context.repository('lfs-limits', 'private');
  const origin = await serverFor(t, context);
  const content = Buffer.from('12345678');
  const oid = crypto.createHash('sha256').update(content).digest('hex');

  const registration = await batch(origin, 'lfs-limits', 'upload', [{ oid, size: content.length }]);
  const action = (await registration.json()).objects[0].actions.upload;
  const wrongSize = await fetch(action.href, {
    method: 'PUT',
    headers: { Authorization: basic('test-development-git-token'), 'Content-Length': '7' },
    body: content.subarray(0, 7),
  });
  assert.equal(wrongSize.status, 422);

  const wrongHashContent = Buffer.from('abcdefgh');
  const wrongHash = await fetch(action.href, {
    method: 'PUT',
    headers: { Authorization: basic('test-development-git-token'), 'Content-Length': String(wrongHashContent.length) },
    body: wrongHashContent,
  });
  assert.equal(wrongHash.status, 422);
  assert.equal((await wrongHash.json()).code, 'LFS_UPLOAD_HASH_MISMATCH');

  const quotaOid = crypto.createHash('sha256').update(Buffer.alloc(11, 1)).digest('hex');
  const quota = await batch(origin, 'lfs-limits', 'upload', [{ oid: quotaOid, size: 11 }]);
  const quotaObject = (await quota.json()).objects[0];
  assert.equal(quotaObject.error.code, 413);
  assert.match(quotaObject.error.message, /quota/i);
});

test('deduplicates one stored object across repositories and protects private downloads', async (t) => {
  const context = setup(t);
  context.repository('first-lfs', 'private');
  context.repository('second-lfs', 'public');
  const origin = await serverFor(t, context);
  const content = Buffer.from('shared LFS object');
  const oid = crypto.createHash('sha256').update(content).digest('hex');

  const firstBatch = await batch(origin, 'first-lfs', 'upload', [{ oid, size: content.length }]);
  const firstAction = (await firstBatch.json()).objects[0].actions.upload;
  assert.equal((await fetch(firstAction.href, { method: 'PUT', headers: { Authorization: basic('test-development-git-token') }, body: content })).status, 200);

  const secondBatch = await batch(origin, 'second-lfs', 'upload', [{ oid, size: content.length }]);
  const secondObject = (await secondBatch.json()).objects[0];
  assert.equal(secondObject.actions, undefined);
  assert.equal(context.db.prepare('SELECT COUNT(*) AS count FROM lfs_objects').get().count, 1);
  assert.equal(context.db.prepare('SELECT COUNT(*) AS count FROM repository_lfs_objects').get().count, 2);

  const privateDownload = await fetch(`${origin}/git/kuklabs/first-lfs.git/info/lfs/objects/${oid}`);
  assert.equal(privateDownload.status, 401);
  const publicDownload = await fetch(`${origin}/git/kuklabs/second-lfs.git/info/lfs/objects/${oid}`);
  assert.equal(publicDownload.status, 200);
  assert.equal(Buffer.from(await publicDownload.arrayBuffer()).equals(content), true);
});

test('issues and verifies short-lived repository-scoped SSH LFS tokens', (t) => {
  const context = setup(t);
  const repository = context.repository('ssh-lfs', 'private');
  const key = createUserSshKey(context.db, context.ownerId, { title: 'Owner laptop', publicKey: ed25519PublicKey(7) });
  const authorization = authorizeLfsSshAuthentication(context.db, {
    keyKind: 'user',
    keyId: key.id,
    originalCommand: "git-lfs-authenticate 'kuklabs/ssh-lfs.git' upload",
  });
  assert.equal(authorization.command.operation, 'upload');
  const payload = createLfsSshAuthentication(context.config, authorization);
  assert.match(payload.header.Authorization, /^Bearer lfs_/);
  const token = payload.header.Authorization.slice(7);
  assert.equal(verifyLfsAuthToken(context.config, token, repository, 'upload').userId, context.ownerId);
  assert.equal(verifyLfsAuthToken(context.config, token, repository, 'download'), null);

  assert.deepEqual(parseLfsSshOriginalCommand('git-lfs-authenticate kuklabs/ssh-lfs.git download'), {
    service: 'git-lfs-authenticate', orgSlug: 'kuklabs', repoSlug: 'ssh-lfs', operation: 'download', write: false,
  });
  assert.throws(
    () => parseLfsSshOriginalCommand("git-lfs-authenticate 'kuklabs/ssh-lfs.git' upload; rm -rf /"),
    (error) => error.code === 'SSH_LFS_COMMAND_REJECTED',
  );
});

test('archived repositories permit LFS download but reject upload registration', async (t) => {
  const context = setup(t);
  const repository = context.repository('archived-lfs', 'private');
  context.db.prepare('UPDATE repositories SET archived_at = CURRENT_TIMESTAMP WHERE id = ?').run(repository.id);
  const origin = await serverFor(t, context);
  const content = Buffer.from('archived data');
  const oid = crypto.createHash('sha256').update(content).digest('hex');
  const upload = await batch(origin, 'archived-lfs', 'upload', [{ oid, size: content.length }]);
  assert.equal(upload.status, 409);
  assert.equal((await upload.json()).code, 'REPOSITORY_ARCHIVED');
});
