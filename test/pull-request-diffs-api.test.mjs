import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createApp } from '../src/app.mjs';
import { hashPassword } from '../src/auth.mjs';
import { migrateCollaboration } from '../src/collaboration.mjs';
import { loadConfig } from '../src/config.mjs';
import { openDatabase, seedCore, uid } from '../src/db.mjs';
import { createBareRepository, createDemoCommit, repoDiskPath } from '../src/git.mjs';
import { createPullRequestDiffsApiHandler, migratePullRequestDiffs } from '../src/pull-request-diffs-safe.mjs';
import { migrateRepositoryAccess } from '../src/repository-access.mjs';
import { migrateReviewThreads } from '../src/review-threads.mjs';

function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `git ${args.join(' ')} failed`);
}

function setup(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-pr-diff-api-test-'));
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
  migrateReviewThreads(db);
  migratePullRequestDiffs(db);
  const { userId: ownerId, orgId } = seedCore(db, config);
  const repositoryId = uid('repo');
  createBareRepository(config, 'kuklabs', 'diff-api-demo');
  db.prepare(`
    INSERT INTO repositories
      (id, organization_id, slug, name, description, visibility, default_branch, created_by)
    VALUES (?, ?, 'diff-api-demo', 'Diff API Demo', '', 'private', 'main', ?)
  `).run(repositoryId, orgId, ownerId);
  createDemoCommit(config, 'kuklabs', 'diff-api-demo');

  const work = path.join(dataDir, 'work');
  git(['clone', repoDiskPath(config, 'kuklabs', 'diff-api-demo'), work]);
  git(['config', 'user.name', 'Diff API Test'], work);
  git(['config', 'user.email', 'diff-api@example.com'], work);
  git(['checkout', '-b', 'feature/api-diff'], work);
  fs.appendFileSync(path.join(work, 'README.md'), '\nAPI diff line\n', 'utf8');
  git(['add', 'README.md'], work);
  git(['commit', '-m', 'Add API diff line'], work);
  git(['push', 'origin', 'feature/api-diff'], work);

  db.prepare(`
    INSERT INTO pull_requests
      (id, repository_id, number, title, body, base_branch, head_branch, status, author_id)
    VALUES (?, ?, 1, 'API diff', '', 'main', 'feature/api-diff', 'open', ?)
  `).run(uid('pr'), repositoryId, ownerId);

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

test('diff API permits read access, requires Write for comments and blocks CSRF', async (t) => {
  const context = setup(t);
  const app = createApp({ config: context.config, db: context.db });
  const diffApi = createPullRequestDiffsApiHandler({ config: context.config, db: context.db });
  const server = http.createServer(async (req, res) => {
    if (await diffApi(req, res)) return;
    return app(req, res);
  });
  const origin = await listen(server);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const ownerCookie = await login(origin, 'owner@example.com', 'secure-owner-password');
  const viewerCookie = await login(origin, 'viewer@example.com', 'secure-viewer-password');
  const diffPath = '/api/pull-request-diffs/kuklabs/diff-api-demo/pulls/1';

  const viewerSummary = await fetch(`${origin}${diffPath}`, { headers: { Cookie: viewerCookie } });
  assert.equal(viewerSummary.status, 200);
  const summary = await viewerSummary.json();
  assert.equal(summary.canComment, false);
  assert.equal(summary.totals.files, 1);

  const selectedResponse = await fetch(`${origin}${diffPath}?path=README.md`, { headers: { Cookie: ownerCookie } });
  assert.equal(selectedResponse.status, 200);
  const selected = await selectedResponse.json();
  const line = selected.selectedFile.hunks.flatMap((hunk) => hunk.lines).find((item) => item.type === 'add');
  assert.ok(line?.newLine);

  const threadPath = '/api/review-threads/kuklabs/diff-api-demo/pulls/1/threads';
  const viewerCreate = await fetch(`${origin}${threadPath}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: viewerCookie },
    body: JSON.stringify({ path: 'README.md', side: 'right', lineNumber: line.newLine, body: 'Viewer comment' }),
  });
  assert.equal(viewerCreate.status, 403);

  const invalid = await fetch(`${origin}${threadPath}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify({ path: 'README.md', side: 'right', lineNumber: 9999, body: 'Invalid anchor' }),
  });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error.code, 'DIFF_ANCHOR_NOT_IN_PATCH');

  const valid = await fetch(`${origin}${threadPath}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify({ path: 'README.md', side: 'right', lineNumber: line.newLine, body: 'Valid inline comment' }),
  });
  assert.equal(valid.status, 201);
  assert.equal((await valid.json()).thread.lineNumber, line.newLine);

  const crossOrigin = await fetch(`${origin}${threadPath}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: ownerCookie, Origin: 'https://attacker.example' },
    body: JSON.stringify({ path: 'README.md', side: 'right', lineNumber: line.newLine, body: 'CSRF comment' }),
  });
  assert.equal(crossOrigin.status, 403);
});
