import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { hashPassword } from '../src/auth.mjs';
import {
  assertDirectBranchWriteAllowed,
  getPullRequestGovernance,
  installBranchProtectionHook,
  migrateBranchGovernance,
  submitPullRequestReview,
  upsertBranchProtectionRule,
} from '../src/branch-governance.mjs';
import { migrateCollaboration } from '../src/collaboration.mjs';
import { openDatabase, seedCore, uid } from '../src/db.mjs';
import { commitFile, createBareRepository, createBranch, createDemoCommit } from '../src/git.mjs';
import { migrateRepositoryAccess } from '../src/repository-access.mjs';

function setup(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-governance-test-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const config = {
    root: process.cwd(),
    dataDir,
    databasePath: path.join(dataDir, 'kukgit.db'),
    repositoriesDir: path.join(dataDir, 'repos'),
    tempDir: path.join(dataDir, 'tmp'),
    baseUrl: 'http://localhost:8787',
    isProduction: false,
    adminEmail: 'author@example.com',
    adminPassword: 'secure-author-password',
    adminName: 'Pull Author',
  };
  const db = openDatabase(config);
  t.after(() => db.close());
  migrateCollaboration(db);
  migrateRepositoryAccess(db);
  migrateBranchGovernance(db);
  const { userId: authorId, orgId } = seedCore(db, config);
  const repositoryId = uid('repo');
  createBareRepository(config, 'kuklabs', 'governance-demo');
  db.prepare(`
    INSERT INTO repositories
      (id, organization_id, slug, name, description, visibility, default_branch, created_by)
    VALUES (?, ?, 'governance-demo', 'Governance Demo', '', 'private', 'main', ?)
  `).run(repositoryId, orgId, authorId);
  createDemoCommit(config, 'kuklabs', 'governance-demo');
  createBranch(config, 'kuklabs', 'governance-demo', 'feature/review-policy', 'main');
  commitFile(config, 'kuklabs', 'governance-demo', {
    branch: 'feature/review-policy',
    filePath: 'feature.txt',
    content: 'first version\n',
    message: 'Add review policy feature',
    authorName: 'Pull Author',
    authorEmail: 'author@example.com',
  });

  const reviewerId = uid('usr');
  db.prepare('INSERT INTO users (id, email, password_hash, display_name) VALUES (?, ?, ?, ?)')
    .run(reviewerId, 'reviewer@example.com', hashPassword('secure-reviewer-password'), 'Code Reviewer');
  db.prepare('INSERT INTO org_members (organization_id, user_id, role) VALUES (?, ?, ?)')
    .run(orgId, reviewerId, 'developer');

  const pullId = uid('pr');
  db.prepare(`
    INSERT INTO pull_requests
      (id, repository_id, number, title, body, base_branch, head_branch, author_id)
    VALUES (?, ?, 1, 'Protect main', '', 'main', 'feature/review-policy', ?)
  `).run(pullId, repositoryId, authorId);

  const repository = {
    id: repositoryId,
    slug: 'governance-demo',
    name: 'Governance Demo',
    defaultBranch: 'main',
    organizationId: orgId,
    orgSlug: 'kuklabs',
    orgName: 'Kuklabs Inc.',
  };
  const pull = db.prepare('SELECT * FROM pull_requests WHERE id = ?').get(pullId);
  const author = db.prepare('SELECT id, email, display_name AS displayName FROM users WHERE id = ?').get(authorId);
  const reviewer = db.prepare('SELECT id, email, display_name AS displayName FROM users WHERE id = ?').get(reviewerId);
  return { config, db, repository, repositoryId, pull, author, reviewer };
}

test('protected branch blocks direct writes and requires a fresh approval', (t) => {
  const context = setup(t);
  const rule = upsertBranchProtectionRule(context.db, {
    repositoryId: context.repositoryId,
    branch: 'main',
    userId: context.author.id,
    requirePullRequest: true,
    requiredApprovals: 1,
    dismissStaleApprovals: true,
    blockDirectPushes: true,
  });
  assert.equal(rule.branch, 'main');
  assert.equal(rule.requiredApprovals, 1);

  assert.throws(
    () => assertDirectBranchWriteAllowed(context.db, context.repositoryId, 'main'),
    (error) => error.code === 'PROTECTED_BRANCH_DIRECT_WRITE',
  );
  assert.doesNotThrow(() => assertDirectBranchWriteAllowed(context.db, context.repositoryId, 'feature/review-policy'));

  assert.throws(
    () => submitPullRequestReview(context.db, context.config, {
      repository: context.repository,
      pull: context.pull,
      reviewer: context.author,
      state: 'approved',
    }),
    (error) => error.code === 'SELF_REVIEW_NOT_ALLOWED',
  );

  submitPullRequestReview(context.db, context.config, {
    repository: context.repository,
    pull: context.pull,
    reviewer: context.reviewer,
    state: 'approved',
    body: 'Architecture and tests look good.',
  });
  let governance = getPullRequestGovernance(context.db, context.config, context.repository, context.pull);
  assert.equal(governance.approvalCount, 1);
  assert.equal(governance.mergeAllowed, true);

  commitFile(context.config, 'kuklabs', 'governance-demo', {
    branch: 'feature/review-policy',
    filePath: 'feature.txt',
    content: 'second version\n',
    message: 'Update reviewed feature',
    authorName: 'Pull Author',
    authorEmail: 'author@example.com',
  });
  governance = getPullRequestGovernance(context.db, context.config, context.repository, context.pull);
  assert.equal(governance.approvalCount, 0);
  assert.equal(governance.reviews[0].stale, true);
  assert.equal(governance.mergeAllowed, false);

  submitPullRequestReview(context.db, context.config, {
    repository: context.repository,
    pull: context.pull,
    reviewer: context.reviewer,
    state: 'changes_requested',
    body: 'Please add a migration test.',
  });
  governance = getPullRequestGovernance(context.db, context.config, context.repository, context.pull);
  assert.equal(governance.changeRequestCount, 1);
  assert.equal(governance.mergeAllowed, false);
  assert.match(governance.mergeBlockReasons.join(' '), /change request/i);
});

test('pre-receive hook rejects protected branch pushes and permits other branches', (t) => {
  const context = setup(t);
  upsertBranchProtectionRule(context.db, {
    repositoryId: context.repositoryId,
    branch: 'main',
    userId: context.author.id,
    requirePullRequest: true,
    requiredApprovals: 1,
    dismissStaleApprovals: true,
    blockDirectPushes: true,
  });
  const hook = installBranchProtectionHook(context.config, 'kuklabs', 'governance-demo');
  assert.equal(fs.statSync(hook).mode & 0o111, 0o111);
  const env = {
    ...process.env,
    KUKGIT_DATABASE_PATH: context.config.databasePath,
    KUKGIT_REPOSITORY_ID: context.repositoryId,
  };
  const oldSha = '0'.repeat(40);
  const newSha = '1'.repeat(40);

  const protectedPush = spawnSync(hook, [], {
    input: `${oldSha} ${newSha} refs/heads/main\n`,
    encoding: 'utf8',
    env,
  });
  assert.equal(protectedPush.status, 1);
  assert.match(protectedPush.stderr, /protected branch main/i);

  const featurePush = spawnSync(hook, [], {
    input: `${oldSha} ${newSha} refs/heads/feature/review-policy\n`,
    encoding: 'utf8',
    env,
  });
  assert.equal(featurePush.status, 0);

  const bypass = spawnSync(hook, [], {
    input: `${oldSha} ${newSha} refs/heads/main\n`,
    encoding: 'utf8',
    env: { ...env, KUKGIT_BYPASS_BRANCH_PROTECTION: '1' },
  });
  assert.equal(bypass.status, 0);
});
