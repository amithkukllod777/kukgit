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
import { findRepo, openDatabase, seedCore, uid } from '../src/db.mjs';
import { createBareRepository, createDemoCommit, repoDiskPath } from '../src/git.mjs';
import { migrateRepositoryAccess } from '../src/repository-access.mjs';
import {
  archiveRepository,
  createRepositoryLifecycleApiHandler,
  createRepositoryLifecycleGuard,
  migrateRepositoryLifecycle,
  purgeRepository,
  restoreRepository,
  transferRepository,
  trashRepository,
  unarchiveRepository,
} from '../src/repository-lifecycle.mjs';
import { migrateWebhooks } from '../src/webhooks.mjs';

async function setup(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-lifecycle-test-'));
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
    webhookEncryptionKey: 'lifecycle-test-webhook-key-with-enough-entropy',
  });
  const db = openDatabase(config);
  t.after(() => db.close());
  migrateCollaboration(db);
  migrateRepositoryAccess(db);
  migrateWebhooks(db);
  migrateRepositoryLifecycle(db);
  const { userId: ownerId, orgId } = seedCore(db, config);
  const owner = db.prepare('SELECT id, email, display_name AS displayName FROM users WHERE id = ?').get(ownerId);

  const targetOrgId = uid('org');
  db.prepare("INSERT INTO organizations (id, slug, name, plan) VALUES (?, 'target-org', 'Target Organization', 'team')")
    .run(targetOrgId);
  db.prepare("INSERT INTO org_members (organization_id, user_id, role) VALUES (?, ?, 'owner')")
    .run(targetOrgId, ownerId);

  const repositoryId = uid('repo');
  createBareRepository(config, 'kuklabs', 'lifecycle-demo');
  db.prepare(`
    INSERT INTO repositories
      (id, organization_id, slug, name, description, visibility, default_branch, created_by)
    VALUES (?, ?, 'lifecycle-demo', 'Lifecycle Demo', '', 'private', 'main', ?)
  `).run(repositoryId, orgId, ownerId);
  await createDemoCommit(config, 'kuklabs', 'lifecycle-demo');

  const repository = () => db.prepare(`
    SELECT r.id, r.slug, r.name, r.description, r.visibility,
      r.default_branch AS defaultBranch, r.organization_id AS organizationId,
      r.archived_at AS archivedAt, r.created_at AS createdAt, r.updated_at AS updatedAt,
      o.slug AS orgSlug, o.name AS orgName
    FROM repositories r JOIN organizations o ON o.id = r.organization_id
    WHERE r.id = ? AND r.deleted_at IS NULL
  `).get(repositoryId);

  return { config, db, owner, ownerId, orgId, targetOrgId, repositoryId, repository };
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

test('archived repositories remain readable and block browser and Git writes', async (t) => {
  const context = await setup(t);
  archiveRepository(context.db, context.repository(), context.owner);
  assert.ok(context.repository().archivedAt);

  const next = (_req, res) => {
    res.writeHead(204);
    res.end();
  };
  const guard = createRepositoryLifecycleGuard({ config: context.config, db: context.db, next });
  const server = http.createServer(guard);
  const origin = await listen(server);
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const read = await fetch(`${origin}/api/repos/kuklabs/lifecycle-demo`);
  assert.equal(read.status, 204);

  const browserWrite = await fetch(`${origin}/api/repos/kuklabs/lifecycle-demo/issues`, { method: 'POST' });
  assert.equal(browserWrite.status, 409);
  assert.equal((await browserWrite.json()).error.code, 'REPOSITORY_ARCHIVED');

  const gitPush = await fetch(`${origin}/git/kuklabs/lifecycle-demo.git/git-receive-pack`, { method: 'POST' });
  assert.equal(gitPush.status, 409);

  unarchiveRepository(context.db, context.repository(), context.owner);
  const writeAfter = await fetch(`${origin}/api/repos/kuklabs/lifecycle-demo/issues`, { method: 'POST' });
  assert.equal(writeAfter.status, 204);
});

test('transfer moves Git storage and cleans organization-scoped grants', async (t) => {
  const context = await setup(t);
  const oldOnlyUserId = uid('usr');
  context.db.prepare('INSERT INTO users (id, email, password_hash, display_name) VALUES (?, ?, ?, ?)')
    .run(oldOnlyUserId, 'old-only@example.com', hashPassword('secure-old-password'), 'Old Only User');
  context.db.prepare("INSERT INTO org_members (organization_id, user_id, role) VALUES (?, ?, 'developer')")
    .run(context.orgId, oldOnlyUserId);
  context.db.prepare(`
    INSERT INTO repository_collaborators (repository_id, user_id, permission, added_by)
    VALUES (?, ?, 'write', ?)
  `).run(context.repositoryId, oldOnlyUserId, context.ownerId);

  const teamId = uid('team');
  context.db.prepare(`
    INSERT INTO teams (id, organization_id, slug, name, description, created_by)
    VALUES (?, ?, 'platform', 'Platform', '', ?)
  `).run(teamId, context.orgId, context.ownerId);
  context.db.prepare(`
    INSERT INTO repository_team_grants (repository_id, team_id, permission, added_by)
    VALUES (?, ?, 'write', ?)
  `).run(context.repositoryId, teamId, context.ownerId);

  archiveRepository(context.db, context.repository(), context.owner);
  const transferred = transferRepository(context.db, context.config, context.repository(), context.owner, 'target-org');
  assert.equal(transferred.orgSlug, 'target-org');
  assert.ok(fs.existsSync(repoDiskPath(context.config, 'target-org', 'lifecycle-demo')));
  assert.equal(fs.existsSync(repoDiskPath(context.config, 'kuklabs', 'lifecycle-demo')), false);
  assert.equal(context.db.prepare('SELECT COUNT(*) AS count FROM repository_team_grants WHERE repository_id = ?').get(context.repositoryId).count, 0);
  assert.equal(context.db.prepare('SELECT COUNT(*) AS count FROM repository_collaborators WHERE repository_id = ?').get(context.repositoryId).count, 0);
  assert.equal(findRepo(context.db, 'kuklabs', 'lifecycle-demo'), undefined);
  assert.ok(findRepo(context.db, 'target-org', 'lifecycle-demo'));
});

test('trash hides a repository, restore recovers it, and purge destroys storage', async (t) => {
  const context = await setup(t);
  archiveRepository(context.db, context.repository(), context.owner);
  assert.throws(
    () => trashRepository(context.db, context.repository(), context.owner, 'wrong-confirmation'),
    (error) => error.code === 'REPOSITORY_CONFIRMATION_MISMATCH',
  );

  const deleted = trashRepository(context.db, context.repository(), context.owner, 'kuklabs/lifecycle-demo');
  assert.equal(deleted.originalOrgSlug, 'kuklabs');
  assert.equal(deleted.originalSlug, 'lifecycle-demo');
  assert.equal(findRepo(context.db, 'kuklabs', 'lifecycle-demo'), undefined);

  const restored = restoreRepository(context.db, deleted, context.owner, 'kuklabs/lifecycle-demo');
  assert.equal(restored.orgSlug, 'kuklabs');
  assert.ok(findRepo(context.db, 'kuklabs', 'lifecycle-demo'));

  const deletedAgain = trashRepository(context.db, restored, context.owner, 'kuklabs/lifecycle-demo');
  const purged = purgeRepository(context.db, context.config, deletedAgain, context.owner, 'kuklabs/lifecycle-demo');
  assert.equal(purged.purged, true);
  assert.equal(context.db.prepare('SELECT COUNT(*) AS count FROM repositories WHERE id = ?').get(context.repositoryId).count, 0);
  assert.equal(fs.existsSync(repoDiskPath(context.config, 'kuklabs', 'lifecycle-demo')), false);
});

test('restore detects slug collisions created during trash retention', async (t) => {
  const context = await setup(t);
  archiveRepository(context.db, context.repository(), context.owner);
  const deleted = trashRepository(context.db, context.repository(), context.owner, 'kuklabs/lifecycle-demo');
  context.db.prepare(`
    INSERT INTO repositories
      (id, organization_id, slug, name, description, visibility, default_branch, created_by)
    VALUES (?, ?, 'lifecycle-demo', 'Replacement', '', 'private', 'main', ?)
  `).run(uid('repo'), context.orgId, context.ownerId);
  assert.throws(
    () => restoreRepository(context.db, deleted, context.owner, 'kuklabs/lifecycle-demo'),
    (error) => error.code === 'REPOSITORY_RESTORE_COLLISION',
  );
});

test('lifecycle API requires Admin access and same-origin writes', async (t) => {
  const context = await setup(t);
  const viewerId = uid('usr');
  context.db.prepare('INSERT INTO users (id, email, password_hash, display_name) VALUES (?, ?, ?, ?)')
    .run(viewerId, 'viewer@example.com', hashPassword('secure-viewer-password'), 'Viewer');
  context.db.prepare("INSERT INTO org_members (organization_id, user_id, role) VALUES (?, ?, 'viewer')")
    .run(context.orgId, viewerId);

  const app = createApp({ config: context.config, db: context.db });
  const lifecycleApi = createRepositoryLifecycleApiHandler({ config: context.config, db: context.db });
  const server = http.createServer(async (req, res) => {
    if (await lifecycleApi(req, res)) return;
    return app(req, res);
  });
  const origin = await listen(server);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const ownerCookie = await login(origin, 'owner@example.com', 'secure-owner-password');
  const viewerCookie = await login(origin, 'viewer@example.com', 'secure-viewer-password');
  const base = '/api/repository-lifecycle/kuklabs/lifecycle-demo';

  const viewerRead = await fetch(`${origin}${base}`, { headers: { Cookie: viewerCookie } });
  assert.equal(viewerRead.status, 403);

  const crossOrigin = await fetch(`${origin}${base}/archive`, {
    method: 'POST',
    headers: { Cookie: ownerCookie, Origin: 'https://attacker.example' },
  });
  assert.equal(crossOrigin.status, 403);

  const ownerArchive = await fetch(`${origin}${base}/archive`, { method: 'POST', headers: { Cookie: ownerCookie } });
  assert.equal(ownerArchive.status, 200);
  assert.equal((await ownerArchive.json()).repository.archived, true);
});
