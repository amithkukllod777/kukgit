import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { migrateCollaboration } from '../src/collaboration.mjs';
import { loadConfig } from '../src/config.mjs';
import { openDatabase, seedCore, uid } from '../src/db.mjs';
import { createBareRepository, createDemoCommit, repoDiskPath } from '../src/git.mjs';
import {
  createDiffReviewThread,
  getPullRequestFilePatch,
  listPullRequestDiffFiles,
  migratePullRequestDiffs,
  parseUnifiedPatch,
  validateDiffAnchor,
} from '../src/pull-request-diffs-safe.mjs';
import { migrateRepositoryAccess } from '../src/repository-access.mjs';
import { migrateReviewThreads, listReviewThreads } from '../src/review-threads.mjs';

function git(args, cwd, input) {
  const result = spawnSync('git', args, { cwd, input, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `git ${args.join(' ')} failed`);
  return result.stdout.trim();
}

async function setup(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-pr-diff-test-'));
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
  createBareRepository(config, 'kuklabs', 'diff-demo');
  db.prepare(`
    INSERT INTO repositories
      (id, organization_id, slug, name, description, visibility, default_branch, created_by)
    VALUES (?, ?, 'diff-demo', 'Diff Demo', '', 'private', 'main', ?)
  `).run(repositoryId, orgId, ownerId);
  await createDemoCommit(config, 'kuklabs', 'diff-demo');

  const work = path.join(dataDir, 'work');
  git(['clone', repoDiskPath(config, 'kuklabs', 'diff-demo'), work]);
  git(['config', 'user.name', 'Diff Test'], work);
  git(['config', 'user.email', 'diff@example.com'], work);

  fs.writeFileSync(path.join(work, 'rename-me.txt'), 'keep this content\n', 'utf8');
  fs.writeFileSync(path.join(work, 'delete-me.txt'), 'delete this file\n', 'utf8');
  fs.writeFileSync(path.join(work, 'space.txt'), 'hello world\n', 'utf8');
  fs.writeFileSync(path.join(work, 'binary.bin'), Buffer.from([0, 1, 2, 3, 4]));
  git(['add', '.'], work);
  git(['commit', '-m', 'Add base diff fixtures'], work);
  git(['push', 'origin', 'main'], work);
  git(['checkout', '-b', 'feature/review-diff'], work);

  fs.appendFileSync(path.join(work, 'README.md'), '\nFeature documentation line\n', 'utf8');
  fs.mkdirSync(path.join(work, 'src'), { recursive: true });
  fs.writeFileSync(path.join(work, 'src', 'new.js'), 'export function add(a, b) {\n  return a + b;\n}\n', 'utf8');
  git(['mv', 'rename-me.txt', 'renamed.txt'], work);
  fs.rmSync(path.join(work, 'delete-me.txt'));
  fs.writeFileSync(path.join(work, 'space.txt'), 'hello  world\n', 'utf8');
  fs.writeFileSync(path.join(work, 'binary.bin'), Buffer.from([0, 9, 8, 7, 6, 5]));
  git(['add', '-A'], work);
  git(['commit', '-m', 'Build feature diff'], work);
  git(['push', 'origin', 'feature/review-diff'], work);

  git(['checkout', 'main'], work);
  fs.writeFileSync(path.join(work, 'base-only.txt'), 'main moved forward\n', 'utf8');
  git(['add', 'base-only.txt'], work);
  git(['commit', '-m', 'Advance base after branch'], work);
  git(['push', 'origin', 'main'], work);

  const pullId = uid('pr');
  db.prepare(`
    INSERT INTO pull_requests
      (id, repository_id, number, title, body, base_branch, head_branch, status, author_id)
    VALUES (?, ?, 1, 'Feature review diff', '', 'main', 'feature/review-diff', 'open', ?)
  `).run(pullId, repositoryId, ownerId);
  const repository = {
    id: repositoryId,
    slug: 'diff-demo',
    name: 'Diff Demo',
    organizationId: orgId,
    orgSlug: 'kuklabs',
    orgName: 'Kuklabs Inc.',
  };
  const pull = db.prepare('SELECT * FROM pull_requests WHERE id = ?').get(pullId);
  const user = db.prepare('SELECT id, email, display_name AS displayName FROM users WHERE id = ?').get(ownerId);
  return { config, db, repository, pull, user, work };
}

test('lists merge-base PR changes with rename, delete, binary and line statistics', async (t) => {
  const context = await setup(t);
  const summary = listPullRequestDiffFiles(context.config, context.repository, context.pull);
  assert.notEqual(summary.refs.mergeBase, summary.refs.baseTipSha);
  assert.ok(summary.files.some((file) => file.path === 'README.md' && file.status === 'modified'));
  assert.ok(summary.files.some((file) => file.path === 'src/new.js' && file.status === 'added'));
  assert.ok(summary.files.some((file) => file.path === 'delete-me.txt' && file.status === 'deleted'));
  assert.ok(summary.files.some((file) => file.path === 'renamed.txt' && file.previousPath === 'rename-me.txt' && file.status === 'renamed'));
  assert.ok(summary.files.some((file) => file.path === 'binary.bin' && file.binary));
  assert.equal(summary.files.some((file) => file.path === 'base-only.txt'), false);
  assert.ok(summary.additions > 0);
  assert.ok(summary.deletions > 0);
});

test('parses hunk line numbers without inventing phantom trailing lines', async (t) => {
  const context = await setup(t);
  const patch = getPullRequestFilePatch(context.config, context.repository, context.pull, 'src/new.js');
  assert.equal(patch.binary, false);
  assert.equal(patch.tooLarge, false);
  assert.ok(patch.hunks.length > 0);
  for (const hunk of patch.hunks) {
    const oldCount = hunk.lines.filter((line) => line.oldLine !== null).length;
    const newCount = hunk.lines.filter((line) => line.newLine !== null).length;
    assert.equal(oldCount, hunk.oldLines);
    assert.equal(newCount, hunk.newLines);
  }

  const parsed = parseUnifiedPatch('@@ -1,1 +1,1 @@\n-old\n+new\n');
  assert.equal(parsed[0].lines.length, 2);
});

test('validates only actual patch lines and same-hunk ranges', async (t) => {
  const context = await setup(t);
  const patch = getPullRequestFilePatch(context.config, context.repository, context.pull, 'src/new.js');
  const rightLines = patch.hunks[0].lines.filter((line) => line.newLine !== null).map((line) => line.newLine);
  const start = Math.min(...rightLines);
  const end = Math.max(...rightLines);
  const anchor = validateDiffAnchor(context.config, context.repository, context.pull, {
    path: 'src/new.js', side: 'right', startLineNumber: start, lineNumber: end,
  });
  assert.equal(anchor.side, 'right');
  assert.equal(anchor.startLineNumber, start === end ? null : start);

  assert.throws(
    () => validateDiffAnchor(context.config, context.repository, context.pull, { path: 'src/new.js', side: 'left', lineNumber: 1 }),
    (error) => error.code === 'DIFF_ANCHOR_NOT_IN_PATCH',
  );
  assert.throws(
    () => validateDiffAnchor(context.config, context.repository, context.pull, { path: 'src/new.js', side: 'right', lineNumber: 9999 }),
    (error) => error.code === 'DIFF_ANCHOR_NOT_IN_PATCH',
  );
  assert.throws(
    () => validateDiffAnchor(context.config, context.repository, context.pull, { path: 'README.md', side: 'right', startLineNumber: 1, lineNumber: 999 }),
    (error) => ['DIFF_ANCHOR_NOT_IN_PATCH', 'DIFF_RANGE_INVALID'].includes(error.code),
  );
});

test('binary diffs support file-level threads only', async (t) => {
  const context = await setup(t);
  const patch = getPullRequestFilePatch(context.config, context.repository, context.pull, 'binary.bin');
  assert.equal(patch.binary, true);
  const fileAnchor = validateDiffAnchor(context.config, context.repository, context.pull, { path: 'binary.bin', side: 'file' });
  assert.equal(fileAnchor.side, 'file');
  assert.throws(
    () => validateDiffAnchor(context.config, context.repository, context.pull, { path: 'binary.bin', side: 'right', lineNumber: 1 }),
    (error) => error.code === 'BINARY_LINE_THREAD_UNSUPPORTED',
  );
});

test('creates range metadata and marks threads outdated after a new head commit', async (t) => {
  const context = await setup(t);
  const patch = getPullRequestFilePatch(context.config, context.repository, context.pull, 'src/new.js');
  const rightLines = patch.hunks[0].lines.filter((line) => line.newLine !== null).map((line) => line.newLine);
  const start = Math.min(...rightLines);
  const end = Math.max(...rightLines);
  const thread = createDiffReviewThread(context.db, context.config, {
    repository: context.repository,
    pull: context.pull,
    user: context.user,
    body: { path: 'src/new.js', side: 'right', startLineNumber: start, lineNumber: end, body: 'Review this function range.' },
  });
  assert.ok(thread.anchorKey);
  assert.ok(thread.baseSha);
  const stored = context.db.prepare(`
    SELECT start_line_number AS startLineNumber, start_side AS startSide, anchor_key AS anchorKey
    FROM pull_request_review_threads WHERE id = ?
  `).get(thread.id);
  assert.equal(stored.startLineNumber, start === end ? null : start);
  assert.equal(stored.startSide, start === end ? null : 'right');
  assert.match(stored.anchorKey, /^[0-9a-f]{64}$/);

  git(['checkout', 'feature/review-diff'], context.work);
  fs.appendFileSync(path.join(context.work, 'src', 'new.js'), '\nexport const version = 2;\n', 'utf8');
  git(['add', 'src/new.js'], context.work);
  git(['commit', '-m', 'Update review head'], context.work);
  git(['push', 'origin', 'feature/review-diff'], context.work);
  const listed = listReviewThreads(context.db, context.config, context.repository, context.pull);
  assert.equal(listed.find((item) => item.id === thread.id).outdated, true);
});

test('ignore-whitespace mode suppresses whitespace-only patch hunks', async (t) => {
  const context = await setup(t);
  const normal = getPullRequestFilePatch(context.config, context.repository, context.pull, 'space.txt');
  const ignored = getPullRequestFilePatch(context.config, context.repository, context.pull, 'space.txt', { ignoreWhitespace: true });
  assert.ok(normal.hunks.length > 0);
  assert.equal(ignored.hunks.length, 0);
});
