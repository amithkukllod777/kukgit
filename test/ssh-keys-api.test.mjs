import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.mjs';
import { hashPassword } from '../src/auth.mjs';
import { migrateCollaboration } from '../src/collaboration.mjs';
import { loadConfig } from '../src/config.mjs';
import { openDatabase, seedCore, uid } from '../src/db.mjs';
import { createBareRepository, createDemoCommit } from '../src/git.mjs';
import { migrateRepositoryAccess } from '../src/repository-access.mjs';
import { migrateRepositoryLifecycle } from '../src/repository-lifecycle.mjs';
import { createSshKeysApiHandler, migrateSshKeys } from '../src/ssh-keys.mjs';
import { migrateWebhooks } from '../src/webhooks.mjs';

function sshString(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(buffer.length);
  return Buffer.concat([length, buffer]);
}

function ed25519Key(seed) {
  const blob = Buffer.concat([sshString('ssh-ed25519'), sshString(Buffer.alloc(32, seed))]);
  return `ssh-ed25519 ${blob.toString('base64')} api-test`;
}

function setup(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-ssh-api-test-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const config = loadConfig({
    dataDir,
    databasePath: path.join(dataDir, 'kukgit.db'),
    repositoriesDir: path.join(dataDir, 'repos'),
    tempDir: path.join(dataDir, 'tmp'),
    nodeEnv: 'test',
    adminEmail: 'owner@example.com',
    adminPassword: 'secure-owner-password',
    adminName: 'Repository Owner',
    webhookEncryptionKey: 'ssh-api-test-webhook-key-with-enough-entropy',
  });
  const db = openDatabase(config);
  t.after(() => db.close());
  migrateCollaboration(db);
  migrateRepositoryAccess(db);
  migrateWebhooks(db);
  migrateRepositoryLifecycle(db);
  migrateSshKeys(db);
  const { userId: ownerId, orgId } = seedCore(db, config);
  const repositoryId = uid('repo');
  createBareRepository(config, 'kuklabs', 'ssh-api-demo');
  db.prepare(`
    INSERT INTO repositories
      (id, organization_id, slug, name, description, visibility, default_branch, created_by)
    VALUES (?, ?, 'ssh-api-demo', 'SSH API Demo', '', 'private', 'main', ?)
  `).run(repositoryId, orgId, ownerId);
  createDemoCommit(config, 'kuklabs', 'ssh-api-demo');

  const viewerId = uid('usr');
  db.prepare('INSERT INTO users (id, email, password_hash, display_name) VALUES (?, ?, ?, ?)')
    .run(viewerId, 'viewer@example.com', hashPassword('secure-viewer-password'), 'Viewer');
  db.prepare("INSERT INTO org_members (organization_id, user_id, role) VALUES (?, ?, 'viewer')")
    .run(orgId, viewerId);
  return { config, db };
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

async function login(origin, email, password) {
  const response = await fetch(`${origin}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(response.status, 200);
  return response.headers.get('set-cookie').split(';')[0];
}

test('SSH key API enforces ownership, repository Admin and same-origin writes', async (t) => {
  const context = setup(t);
  const app = createApp({ config: context.config, db: context.db });
  const sshApi = createSshKeysApiHandler({ config: context.config, db: context.db });
  const server = http.createServer(async (req, res) => {
    if (await sshApi(req, res)) return;
    return app(req, res);
  });
  const origin = await listen(server);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const ownerCookie = await login(origin, 'owner@example.com', 'secure-owner-password');
  const viewerCookie = await login(origin, 'viewer@example.com', 'secure-viewer-password');

  const ownerCreate = await fetch(`${origin}/api/ssh-keys`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify({ title: 'Owner laptop', publicKey: ed25519Key(61) }),
  });
  assert.equal(ownerCreate.status, 201);
  const createdKey = (await ownerCreate.json()).key;

  const viewerKeys = await fetch(`${origin}/api/ssh-keys`, { headers: { Cookie: viewerCookie } });
  assert.equal(viewerKeys.status, 200);
  assert.equal((await viewerKeys.json()).keys.length, 0);

  const viewerRevokeOwner = await fetch(`${origin}/api/ssh-keys/${encodeURIComponent(createdKey.id)}`, {
    method: 'DELETE',
    headers: { Cookie: viewerCookie },
  });
  assert.equal(viewerRevokeOwner.status, 404);

  const deployPath = '/api/ssh-keys/kuklabs/ssh-api-demo/deploy-keys';
  const viewerDeployRead = await fetch(`${origin}${deployPath}`, { headers: { Cookie: viewerCookie } });
  assert.equal(viewerDeployRead.status, 403);

  const ownerDeployCreate = await fetch(`${origin}${deployPath}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify({ title: 'CI runner', publicKey: ed25519Key(62), canWrite: false }),
  });
  assert.equal(ownerDeployCreate.status, 201);

  const crossOrigin = await fetch(`${origin}/api/ssh-keys`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: ownerCookie, Origin: 'https://attacker.example' },
    body: JSON.stringify({ title: 'Attacker key', publicKey: ed25519Key(63) }),
  });
  assert.equal(crossOrigin.status, 403);
});
