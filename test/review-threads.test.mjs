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
import { commitFile, createBareRepository, createBranch, createDemoCommit } from '../src/git.mjs';
import { migrateRepositoryAccess } from '../src/repository-access.mjs';
import {
  createReviewThread,
  createReviewThreadsApiHandler,
  migrateReviewThreads,
  replyToReviewThread,
  reviewThreadSummary,
  setReviewThreadResolved,
  upsertReviewThreadPolicy,
} from '../src/review-threads.mjs';

async function setup(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-review-thread-test-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const config = loadConfig({
    dataDir,
    databasePath: path.join(dataDir, 'kukgit.db'),
    repositoriesDir: path.join(dataDir, 'repos'),
    tempDir: path.join(dataDir, 'tmp'),
    baseUrl: 'http://localhost:8787',
    nodeEnv: 'test',
    adminEmail: 'author@example.com',
    adminPassword: 'secure-author-password',
    adminName: 'Pull Author',
  });
  const db = openDatabase(config);
  t.after(() => db.close());
  migrateCollaboration(db);
  migrateRepositoryAccess(db);
  migrateBranchGovernance(db);
  migrateReviewThreads(db);
  const { userId: authorId, orgId } = seedCore(db, config);
  const repositoryId = uid('repo');
  createBareRepository(config, 'kuklabs', 'thread-demo');
  db.prepare(`
    INSERT INTO repositories
      (id, organization_id, slug, name, description, visibility, default_branch, created_by)
    VALUES (?, ?, 'thread-demo', 'Thread Demo', '', 'private', 'main', ?)
  `).run(repositoryId, orgId, authorId);
  await createDemoCommit(config, 'kuklabs', 'thread-demo');
  createBranch(config, 'kuklabs', 'thread-demo', 'feature/thread-review', 'main');
  await commitFile(config, 'kuklabs', 'thread-demo', {
    branch: 'feature/thread-review',
    filePath: 'reviewed.js',
    content: 'export const reviewed = true;\n',
    message: 'Add reviewed module',
    authorName: 'Pull Author',
    authorEmail: 'author@example.com',
  });

  const reviewerId = uid('usr');
  db.prepare('INSERT INTO users (id, email, password_hash, display_name) VALUES (?, ?, ?, ?)')
    .run(reviewerId, 'reviewer@example.com', hashPassword('secure-reviewer-password'), 'Code Reviewer');
  db.prepare('INSERT INTO org_members (organization_id, user_id, role) VALUES (?, ?, ?)')
    .run(orgId, reviewerId, 'developer');

  const viewerId = uid('usr');
  db.prepare('INSERT INTO users (id, email, password_hash, display_name) VALUES (?, ?, ?, ?)')
    .run(viewerId, 'viewer@example.com', hashPassword('secure-viewer-password'), 'Read Viewer');
  db.prepare('INSERT INTO org_members (organization_id, user_id, role) VALUES (?, ?, ?)')
    .run(orgId, viewerId, 'viewer');

  const pullId = uid('pr');
  db.prepare(`
    INSERT INTO pull_requests
      (id, repository_id, number, title, body, base_branch, head_branch, author_id)
    VALUES (?, ?, 1, 'Review threads', '', 'main', 'feature/thread-review', ?)
  `).run(pullId, repositoryId, authorId);

  const repository = {
    id: repositoryId,
    slug: 'thread-demo',
    name: 'Thread Demo',
    defaultBranch: 'main',
    organizationId: orgId,
    orgSlug: 'kuklabs',
    orgName: 'Kuklabs Inc.',
  };
  const pull = db.prepare(`
    SELECT p.*, u.display_name AS authorName, u.email AS authorEmail
    FROM pull_requests p JOIN users u ON u.id = p.author_id WHERE p.id = ?
  `).get(pullId);
  const author = db.prepare('SELECT id, email, display_name AS displayName FROM users WHERE id = ?').get(authorId);
  const reviewer = db.prepare('SELECT id, email, display_name AS displayName FROM users WHERE id = ?').get(reviewerId);
  const viewer = db.prepare('SELECT id, email, display_name AS displayName FROM users WHERE id = ?').get(viewerId);
  return { config, db, repository, repositoryId, pull, author, reviewer, viewer };
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

test('review threads support replies, resolution, reopening and outdated detection', async (t) => {
  const context = await setup(t);
  upsertReviewThreadPolicy(context.db, {
    repositoryId: context.repositoryId,
    branch: 'main',
    userId: context.author.id,
    requireResolvedThreads: true,
  });

  const thread = createReviewThread(context.db, context.config, {
    repository: context.repository,
    pull: context.pull,
    user: context.reviewer,
    body: {
      path: 'reviewed.js',
      side: 'right',
      lineNumber: 1,
      body: 'Should this constant be immutable across environments?',
    },
  });
  assert.equal(thread.path, 'reviewed.js');
  assert.equal(thread.lineNumber, 1);
  assert.equal(thread.comments.length, 1);

  let summary = reviewThreadSummary(context.db, context.config, context.repository, context.pull);
  assert.equal(summary.activeUnresolvedCount, 1);
  assert.equal(summary.mergeAllowed, false);
  assert.match(summary.mergeBlockReason, /must be resolved/i);

  const replied = replyToReviewThread(context.db, context.config, {
    repository: context.repository,
    pull: context.pull,
    threadId: thread.id,
    user: context.author,
    body: 'Yes. The value is part of the public module contract.',
  });
  assert.equal(replied.comments.length, 2);

  const resolved = setReviewThreadResolved(context.db, context.config, {
    repository: context.repository,
    pull: context.pull,
    threadId: thread.id,
    user: context.reviewer,
    resolved: true,
  });
  assert.equal(resolved.resolved, true);
  summary = reviewThreadSummary(context.db, context.config, context.repository, context.pull);
  assert.equal(summary.activeUnresolvedCount, 0);
  assert.equal(summary.mergeAllowed, true);

  setReviewThreadResolved(context.db, context.config, {
    repository: context.repository,
    pull: context.pull,
    threadId: thread.id,
    user: context.reviewer,
    resolved: false,
  });
  summary = reviewThreadSummary(context.db, context.config, context.repository, context.pull);
  assert.equal(summary.mergeAllowed, false);

  await commitFile(context.config, 'kuklabs', 'thread-demo', {
    branch: 'feature/thread-review',
    filePath: 'reviewed.js',
    content: 'export const reviewed = Object.freeze({ enabled: true });\n',
    message: 'Update reviewed module',
    authorName: 'Pull Author',
    authorEmail: 'author@example.com',
  });
  summary = reviewThreadSummary(context.db, context.config, context.repository, context.pull);
  assert.equal(summary.activeUnresolvedCount, 0);
  assert.equal(summary.outdatedCount, 1);
  assert.equal(summary.threads[0].outdated, true);
  assert.equal(summary.mergeAllowed, true);
});

test('review thread anchors must reference changed files and valid lines', async (t) => {
  const context = await setup(t);
  assert.throws(
    () => createReviewThread(context.db, context.config, {
      repository: context.repository,
      pull: context.pull,
      user: context.reviewer,
      body: { path: 'README.md', side: 'right', lineNumber: 1, body: 'Not part of this pull request.' },
    }),
    (error) => error.code === 'REVIEW_PATH_NOT_CHANGED',
  );
  assert.throws(
    () => createReviewThread(context.db, context.config, {
      repository: context.repository,
      pull: context.pull,
      user: context.reviewer,
      body: { path: 'reviewed.js', side: 'right', lineNumber: 99, body: 'Invalid line.' },
    }),
    (error) => error.code === 'REVIEW_THREAD_LINE_OUT_OF_RANGE',
  );
  assert.throws(
    () => createReviewThread(context.db, context.config, {
      repository: context.repository,
      pull: context.pull,
      user: context.reviewer,
      body: { path: 'reviewed.js', side: 'file', lineNumber: 1, body: 'File thread cannot use a line.' },
    }),
    (error) => error.code === 'FILE_THREAD_LINE_INVALID',
  );
});

test('review thread API enforces authentication, origin and repository permission', async (t) => {
  const context = await setup(t);
  const app = createApp({ config: context.config, db: context.db });
  const reviewApi = createReviewThreadsApiHandler({ config: context.config, db: context.db });
  const server = http.createServer(async (req, res) => {
    if (await reviewApi(req, res)) return;
    return app(req, res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;

  const unauthenticated = await fetch(`${origin}/api/review-threads/kuklabs/thread-demo/pulls/1`);
  assert.equal(unauthenticated.status, 401);

  const reviewerCookie = await login(origin, 'reviewer@example.com', 'secure-reviewer-password');
  const viewerCookie = await login(origin, 'viewer@example.com', 'secure-viewer-password');
  const authorCookie = await login(origin, 'author@example.com', 'secure-author-password');

  const viewerCreate = await fetch(`${origin}/api/review-threads/kuklabs/thread-demo/pulls/1/threads`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: viewerCookie },
    body: JSON.stringify({ path: 'reviewed.js', side: 'file', body: 'Viewer cannot create this.' }),
  });
  assert.equal(viewerCreate.status, 403);

  const crossOrigin = await fetch(`${origin}/api/review-threads/kuklabs/thread-demo/pulls/1/threads`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: reviewerCookie, Origin: 'https://attacker.example' },
    body: JSON.stringify({ path: 'reviewed.js', side: 'file', body: 'Blocked by origin policy.' }),
  });
  assert.equal(crossOrigin.status, 403);

  const created = await fetch(`${origin}/api/review-threads/kuklabs/thread-demo/pulls/1/threads`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: reviewerCookie },
    body: JSON.stringify({ path: 'reviewed.js', side: 'right', lineNumber: 1, body: 'API-created thread.' }),
  });
  assert.equal(created.status, 201);
  const createdBody = await created.json();
  assert.equal(createdBody.thread.comments.length, 1);

  const reviewerPolicy = await fetch(`${origin}/api/review-threads/kuklabs/thread-demo/policies/main`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: reviewerCookie },
    body: JSON.stringify({ requireResolvedThreads: true }),
  });
  assert.equal(reviewerPolicy.status, 403);

  const adminPolicy = await fetch(`${origin}/api/review-threads/kuklabs/thread-demo/policies/main`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: authorCookie },
    body: JSON.stringify({ requireResolvedThreads: true }),
  });
  assert.equal(adminPolicy.status, 200);
  const policyBody = await adminPolicy.json();
  assert.equal(policyBody.policy.requireResolvedThreads, true);

  const auditActions = context.db.prepare(`
    SELECT action FROM audit_logs
    WHERE action IN ('review_thread.created','review_thread_policy.updated') ORDER BY rowid
  `).all().map((row) => row.action);
  assert.deepEqual(auditActions, ['review_thread.created', 'review_thread_policy.updated']);
});
