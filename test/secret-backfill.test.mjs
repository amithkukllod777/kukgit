import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadConfig } from '../src/config.mjs';
import { openDatabase, seedCore, uid } from '../src/db.mjs';
import { createBareRepository, repoDiskPath } from '../src/git.mjs';
import { listFindings, migrateSecretScanning } from '../src/secret-scanning.mjs';
import { repositoriesToScan, scanCurrentTrees, scanFullHistory } from '../src/secret-backfill.mjs';

const GITHUB_TOKEN = `ghp_${'A'.repeat(30)}0UcpLR`;

function setup(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-backfill-'));
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
  fs.mkdirSync(config.repositoriesDir, { recursive: true });
  const db = openDatabase(config);
  t.after(() => db.close());
  migrateSecretScanning(db);
  const { userId, orgId } = seedCore(db, config);

  const repositoryId = uid('repo');
  createBareRepository(config, 'kuklabs', 'app');
  db.prepare(`
    INSERT INTO repositories (id, organization_id, slug, name, description, visibility, default_branch, created_by)
    VALUES (?, ?, 'app', 'App', '', 'private', 'main', ?)
  `).run(repositoryId, orgId, userId);
  return {
    config, db, userId, orgId,
    repository: { id: repositoryId, orgSlug: 'kuklabs', repoSlug: 'app' },
  };
}

function commit(context, files, { branch = 'main', from = null } = {}) {
  const gitDir = repoDiskPath(context.config, 'kuklabs', 'app');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-backfill-work-'));
  const run = (args) => {
    const result = spawnSync('git', args, { cwd: work, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
    return result.stdout.trim();
  };
  run(['init', '-q', '-b', branch]);
  run(['config', 'user.email', 't@example.com']);
  run(['config', 'user.name', 'T']);
  run(['config', 'commit.gpgsign', 'false']);
  run(['remote', 'add', 'origin', gitDir]);
  for (const source of [branch, from].filter(Boolean)) {
    try { run(['fetch', '-q', 'origin', source]); run(['reset', '-q', '--hard', 'FETCH_HEAD']); break; } catch { /* start empty */ }
  }
  for (const [file, content] of Object.entries(files)) {
    if (content === null) { fs.rmSync(path.join(work, file), { force: true }); continue; }
    fs.mkdirSync(path.dirname(path.join(work, file)), { recursive: true });
    fs.writeFileSync(path.join(work, file), content);
  }
  run(['add', '-A']);
  run(['commit', '-q', '-m', 'change']);
  const sha = run(['rev-parse', 'HEAD']);
  run(['push', '-q', 'origin', `HEAD:refs/heads/${branch}`]);
  fs.rmSync(work, { recursive: true, force: true });
  return sha;
}

test('the current tree of every branch is scanned', (t) => {
  const context = setup(t);
  commit(context, { 'README.md': 'app' });
  commit(context, { 'deploy.sh': `TOKEN=${GITHUB_TOKEN}` });
  commit(context, { 'staging.sh': 'AWS=AKIAIOSFODNN7EXAMPLE' }, { branch: 'release', from: 'main' });

  const summary = scanCurrentTrees(context.config, context.db, { repository: context.repository });
  assert.equal(summary.refs, 2);
  assert.equal(summary.findings, 2, 'one on each branch');

  const findings = listFindings(context.db, context.repository.id);
  assert.deepEqual(findings.map((finding) => finding.path).sort(), ['deploy.sh', 'staging.sh']);
  // The credential is never in the record, here as everywhere.
  assert.equal(JSON.stringify(findings).includes(GITHUB_TOKEN), false);
});

test('a blob shared between branches is read once', (t) => {
  const context = setup(t);
  commit(context, { 'deploy.sh': `TOKEN=${GITHUB_TOKEN}` });
  for (const branch of ['release-1', 'release-2', 'release-3']) {
    commit(context, { [`${branch}.txt`]: branch }, { branch, from: 'main' });
  }

  const summary = scanCurrentTrees(context.config, context.db, { repository: context.repository });
  assert.equal(summary.refs, 4);
  // `deploy.sh` is the same blob on all four branches. On a repository with
  // fifty release branches this is the difference between one scan and fifty.
  assert.equal(summary.findings, 1);
});

test('a credential that was removed is found only by the history scan', (t) => {
  const context = setup(t);
  commit(context, { 'deploy.sh': `TOKEN=${GITHUB_TOKEN}` });
  commit(context, { 'deploy.sh': 'TOKEN=$FROM_ENV' });

  // Gone from the tip, so the fast scan is right to report nothing.
  assert.equal(scanCurrentTrees(context.config, context.db, { repository: context.repository }).findings, 0);
  assert.deepEqual(listFindings(context.db, context.repository.id), []);

  // Still in history, and still needs rotating: the bytes are in every clone
  // anybody took in between.
  const full = scanFullHistory(context.config, context.db, { repository: context.repository });
  assert.equal(full.findings, 1);
  assert.equal(listFindings(context.db, context.repository.id).length, 1);
});

test('a history scan that hit its limit says so', (t) => {
  const context = setup(t);
  for (let index = 0; index < 4; index += 1) commit(context, { 'file.txt': `revision ${index}` });

  const summary = scanFullHistory(context.config, context.db, {
    repository: context.repository, maxCommitsPerRef: 2,
  });
  // A bounded scan reported as complete is worse than no scan, because somebody
  // then believes the part it never reached is clean.
  assert.equal(summary.commits, 2);
  assert.deepEqual(summary.truncated, [{ ref: 'refs/heads/main', limit: 2 }]);
});

test('an empty repository scans cleanly rather than failing', (t) => {
  const context = setup(t);
  const summary = scanCurrentTrees(context.config, context.db, { repository: context.repository });
  assert.equal(summary.refs, 0);
  assert.equal(summary.findings, 0);
});

test('the repository list can be narrowed to one', (t) => {
  const context = setup(t);
  const second = uid('repo');
  createBareRepository(context.config, 'kuklabs', 'other');
  context.db.prepare(`
    INSERT INTO repositories (id, organization_id, slug, name, description, visibility, default_branch, created_by)
    VALUES (?, ?, 'other', 'Other', '', 'private', 'main', ?)
  `).run(second, context.orgId, context.userId);

  assert.equal(repositoriesToScan(context.db).length, 2);
  assert.deepEqual(repositoriesToScan(context.db, { orgSlug: 'kuklabs', repoSlug: 'app' }).map((row) => row.repoSlug), ['app']);

  // A deleted repository is not scanned: its bytes are on their way out, and
  // reporting findings against it would add work nobody can action.
  context.db.prepare("UPDATE repositories SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?").run(second);
  assert.equal(repositoriesToScan(context.db).length, 1);
});
