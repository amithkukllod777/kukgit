import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.mjs';
import { hashPassword } from '../src/auth.mjs';
import { migrateBranchGovernance } from '../src/branch-governance.mjs';
import { migrateCollaboration } from '../src/collaboration.mjs';
import { loadConfig } from '../src/config.mjs';
import { openDatabase, seedCore, uid } from '../src/db.mjs';
import { commitFile, createBareRepository, createBranch, createDemoCommit, resolveRef } from '../src/git.mjs';
import { migrateRepositoryAccess } from '../src/repository-access.mjs';
import { migrateReviewThreads } from '../src/review-threads.mjs';
import {
  createStatusCheckMergeGuard,
  createStatusChecksApiHandler,
  migrateStatusChecks,
  publishCommitStatus,
  statusCheckSummary,
  upsertRequiredStatusPolicy,
} from '../src/status-checks.mjs';
import { createPersonalAccessToken } from '../src/tokens.mjs';

function setup(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-status-check-test-'));
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
  });
  const db = openDatabase(config);
  t.after(() => db.close());
  migrateCollaboration(db);
  migrateRepositoryAccess(db);
  migrateBranchGovernance(db);
  migrateReviewThreads(db);
  migrateStatusChecks(db);
  const { userId: ownerId, orgId } = seedCore(db, config);

  const repositoryId = uid('repo');
  createBareRepository(config, 'kuklabs', 'status-demo');
  db.prepare(`
    INSERT INTO repositories
      (id, organization_id, slug, name, description, visibility, default_branch, created_by)
    VALUES (?, ?, 'status-demo', 'Status Demo', '', 'private', 'main', ?)
  `).run(repositoryId, orgId, ownerId);
  createDemoCommit(config, 'kuklabs', 'status-demo');
  createBranch(config, 'kuklabs', 'status-demo', 'feature/status-policy', 'main');
  commitFile(config, 'kuklabs', 'status-demo', {
    branch: 'feature/status-policy',
    filePath: 'status.txt',
    content: 'first version\n',
    message: 'Add status policy feature',
    authorName: 'Repository Owner',
    authorEmail: 'owner@example.com',
  });

  const developerId = uid('usr');
  db.prepare('INSERT INTO users (id, email, password_hash, display_name) VALUES (?, ?, ?, ?)')
    .run(developerId, 'developer@example.com', hashPassword('secure-developer-password'), 'CI Developer');
  db.prepare('INSERT INTO org_members (organization_id, user_id, role) VALUES (?, ?, ?)')
    .run(orgId, developerId, 'developer');

  const viewerId = uid('usr');
  db.prepare('INSERT INTO users (id, email, password_hash, display_name) VALUES (?, ?, ?, ?)')
    .run(viewerId, 'viewer@example.com', hashPassword('secure-viewer-password'), 'Read Only User');
  db.prepare('INSERT INTO org_members (organization_id, user_id, role) VALUES (?, ?, ?)')
    .run(orgId, viewerId, 'viewer');

  const pullId = uid('pr');
  db.prepare(`
    INSERT INTO pull_requests
      (id, repository_id, number, title, body, base_branch, head_branch, author_id)
    VALUES (?, ?, 1, 'Require CI checks', '', 'main', 'feature/status-policy', ?)
  `).run(pullId, repositoryId, developerId);

  const repository = {
    id: repositoryId,
    slug: 'status-demo',
    name: 'Status Demo',
    defaultBranch: 'main',
    organizationId: orgId,
    orgSlug: 'kuklabs',
    orgName: 'Kuklabs Inc.',
  };
  const pull = db.prepare('SELECT * FROM pull_requests WHERE id = ?').get(pullId);
  const owner = db.prepare('SELECT id, email, display_name AS displayName FROM users WHERE id = ?').get(ownerId);
  const developer = db.prepare('SELECT id, email, display_name AS displayName FROM users WHERE id = ?').get(developerId);
  const viewer = db.prepare('SELECT id, email, display_name AS displayName FROM users WHERE id = ?').get(viewerId);
  return { config, db, repository, repositoryId, pull, owner, developer, viewer };
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

function startServer(config, db) {
  const app = createApp({ config, db });
  const guardedApp = createStatusCheckMergeGuard({ config, db, app });
  const statusApi = createStatusChecksApiHandler({ config, db });
  return http.createServer(async (req, res) => {
    if (await statusApi(req, res)) return;
    return guardedApp(req, res);
  });
}

test('required checks use only the current head SHA and require every context to succeed', (t) => {
  const context = setup(t);
  upsertRequiredStatusPolicy(context.db, {
    repositoryId: context.repositoryId,
    branch: 'main',
    userId: context.owner.id,
    contexts: ['build', 'test'],
  });

  let summary = statusCheckSummary(context.db, context.config, context.repository, context.pull);
  assert.equal(summary.requiredCount, 2);
  assert.equal(summary.missingCount, 2);
  assert.equal(summary.mergeAllowed, false);

  publishCommitStatus(context.db, context.config, {
    repository: context.repository,
    commitSha: summary.headSha,
    context: 'build',
    state: 'pending',
    description: 'Build is running',
    publisher: context.developer,
  });
  summary = statusCheckSummary(context.db, context.config, context.repository, context.pull);
  assert.equal(summary.pendingCount, 1);
  assert.equal(summary.missingCount, 1);
  assert.equal(summary.mergeAllowed, false);

  publishCommitStatus(context.db, context.config, {
    repository: context.repository,
    commitSha: summary.headSha,
    context: 'build',
    state: 'success',
    description: 'Build passed',
    publisher: context.developer,
  });
  publishCommitStatus(context.db, context.config, {
    repository: context.repository,
    commitSha: summary.headSha,
    context: 'test',
    state: 'failure',
    description: 'One test failed',
    publisher: context.developer,
  });
  summary = statusCheckSummary(context.db, context.config, context.repository, context.pull);
  assert.equal(summary.successCount, 1);
  assert.equal(summary.failureCount, 1);
  assert.equal(summary.mergeAllowed, false);

  publishCommitStatus(context.db, context.config, {
    repository: context.repository,
    commitSha: summary.headSha,
    context: 'test',
    state: 'success',
    description: 'All tests passed',
    publisher: context.developer,
  });
  summary = statusCheckSummary(context.db, context.config, context.repository, context.pull);
  assert.equal(summary.successCount, 2);
  assert.equal(summary.mergeAllowed, true);

  commitFile(context.config, 'kuklabs', 'status-demo', {
    branch: 'feature/status-policy',
    filePath: 'status.txt',
    content: 'second version\n',
    message: 'Update status policy feature',
    authorName: 'CI Developer',
    authorEmail: 'developer@example.com',
  });
  const newHead = resolveRef(context.config, 'kuklabs', 'status-demo', 'feature/status-policy');
  summary = statusCheckSummary(context.db, context.config, context.repository, context.pull);
  assert.equal(summary.headSha, newHead);
  assert.equal(summary.missingCount, 2);
  assert.equal(summary.successCount, 0);
  assert.equal(summary.mergeAllowed, false);

  assert.throws(() => publishCommitStatus(context.db, context.config, {
    repository: context.repository,
    commitSha: summary.headSha,
    context: 'bad<context>',
    state: 'success',
    publisher: context.developer,
  }), (error) => error.code === 'STATUS_CONTEXT_INVALID');
});

test('PAT publishers are authorized by scope and repository permission while merge is server-enforced', async (t) => {
  const context = setup(t);
  upsertRequiredStatusPolicy(context.db, {
    repositoryId: context.repositoryId,
    branch: 'main',
    userId: context.owner.id,
    contexts: ['build', 'test'],
  });
  const developerToken = createPersonalAccessToken(context.db, context.developer.id, {
    name: 'CI runner',
    scopes: ['repo:write'],
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
  }).token;
  const viewerToken = createPersonalAccessToken(context.db, context.viewer.id, {
    name: 'Invalid CI runner',
    scopes: ['repo:write'],
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
  }).token;

  const server = startServer(context.config, context.db);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const ownerCookie = await login(origin, 'owner@example.com', 'secure-owner-password');
  const developerCookie = await login(origin, 'developer@example.com', 'secure-developer-password');
  const headSha = resolveRef(context.config, 'kuklabs', 'status-demo', 'feature/status-policy');

  const blockedMerge = await fetch(`${origin}/api/repos/kuklabs/status-demo/pulls/1/merge`, {
    method: 'POST',
    headers: { Cookie: ownerCookie },
  });
  assert.equal(blockedMerge.status, 409);
  assert.equal((await blockedMerge.json()).error.code, 'PULL_REQUEST_STATUS_CHECKS_BLOCKED');

  const forbiddenPolicy = await fetch(`${origin}/api/status-checks/kuklabs/status-demo/policies/main`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: developerCookie },
    body: JSON.stringify({ contexts: ['build'] }),
  });
  assert.equal(forbiddenPolicy.status, 403);

  const crossOriginPolicy = await fetch(`${origin}/api/status-checks/kuklabs/status-demo/policies/main`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: ownerCookie, Origin: 'https://attacker.example' },
    body: JSON.stringify({ contexts: ['build'] }),
  });
  assert.equal(crossOriginPolicy.status, 403);

  const viewerPublish = await fetch(`${origin}/api/status-checks/kuklabs/status-demo/commits/${headSha}/statuses`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${viewerToken}` },
    body: JSON.stringify({ context: 'build', state: 'success' }),
  });
  assert.equal(viewerPublish.status, 403);

  for (const check of [
    { context: 'build', state: 'success', description: 'Build passed' },
    { context: 'test', state: 'success', description: 'Tests passed' },
  ]) {
    const publish = await fetch(`${origin}/api/status-checks/kuklabs/status-demo/commits/${headSha}/statuses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${developerToken}` },
      body: JSON.stringify(check),
    });
    assert.equal(publish.status, 200);
    const payload = await publish.json();
    assert.equal(payload.status.publisherAuthType, 'personal-access-token');
  }

  const read = await fetch(`${origin}/api/status-checks/kuklabs/status-demo`, { headers: { Cookie: ownerCookie } });
  assert.equal(read.status, 200);
  const data = await read.json();
  assert.equal(data.pullRequests[0].statusChecks.mergeAllowed, true);
  assert.equal(data.pullRequests[0].statusChecks.successCount, 2);

  const merge = await fetch(`${origin}/api/repos/kuklabs/status-demo/pulls/1/merge`, {
    method: 'POST',
    headers: { Cookie: ownerCookie },
  });
  assert.equal(merge.status, 200);

  const audits = context.db.prepare(`
    SELECT action, metadata_json AS metadataJson FROM audit_logs
    WHERE action = 'commit_status.published' ORDER BY rowid
  `).all();
  assert.equal(audits.length, 2);
  assert.ok(audits.every((row) => JSON.parse(row.metadataJson).authType === 'personal-access-token'));
});
