import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadConfig } from '../src/config.mjs';
import { openDatabase, seedCore, uid } from '../src/db.mjs';
import { createBareRepository, repoDiskPath } from '../src/git.mjs';
import { migrateSecrets } from '../src/secrets-vault.mjs';
import {
  cancelRunsForDeletedRefs,
  dispatchForRefChanges,
  dispatchWorkflows,
  DISPATCH_LIMITS,
  readWorkflowFiles,
  refChanges,
  refSnapshot,
} from '../src/workflow-dispatch.mjs';
import { migrateWorkflowLogs, readJobLog } from '../src/workflow-logs.mjs';
import { getRun, listRunJobs, migrateWorkflowRuns } from '../src/workflow-runs.mjs';

const VALID = [
  'name: CI',
  'on:',
  '  push:',
  '    branches: [main]',
  'jobs:',
  '  build:',
  '    runs-on: kukgit-linux',
  '    steps: [{run: echo build}]',
].join('\n');

function setup(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-dispatch-test-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const config = loadConfig({
    dataDir,
    databasePath: path.join(dataDir, 'kukgit.db'),
    repositoriesDir: path.join(dataDir, 'repos'),
    tempDir: path.join(dataDir, 'tmp'),
    nodeEnv: 'test',
    baseUrl: 'http://127.0.0.1:8787',
    adminEmail: 'owner@example.com',
    adminPassword: 'secure-owner-password',
    adminName: 'Owner',
    secretsEncryptionKey: 'kukgit-dispatch-test-key-long-enough-here',
  });
  fs.mkdirSync(config.repositoriesDir, { recursive: true });
  const db = openDatabase(config);
  t.after(() => db.close());
  migrateSecrets(db);
  migrateWorkflowRuns(db);
  migrateWorkflowLogs(db);
  const { userId, orgId } = seedCore(db, config);

  createBareRepository(config, 'kuklabs', 'app');
  const repositoryId = uid('repo');
  db.prepare(`
    INSERT INTO repositories (id, organization_id, slug, name, description, visibility, default_branch, created_by)
    VALUES (?, ?, 'app', 'App', '', 'private', 'main', ?)
  `).run(repositoryId, orgId, userId);

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-dispatch-work-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const gitDir = repoDiskPath(config, 'kuklabs', 'app');
  const run = (args, cwd = work) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
    return result.stdout.trim();
  };
  run(['init', '--quiet', '--initial-branch=main', work], os.tmpdir());
  run(['config', 'user.email', 'test@example.com']);
  run(['config', 'user.name', 'Test']);
  // A throwaway test repository must not inherit whatever signing the developer
  // or CI host has configured globally; an unavailable signer would fail the
  // test for a reason that has nothing to do with dispatch.
  run(['config', 'commit.gpgsign', 'false']);
  run(['config', 'tag.gpgsign', 'false']);

  const commit = (files, message = 'change') => {
    for (const [file, content] of Object.entries(files)) {
      const target = path.join(work, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
    }
    run(['add', '-A']);
    run(['commit', '--quiet', '-m', message]);
    run(['push', '--quiet', '--force', gitDir, 'HEAD:refs/heads/main']);
    return run(['rev-parse', 'HEAD']);
  };

  const repository = { id: repositoryId, orgSlug: 'kuklabs', repoSlug: 'app', organizationId: orgId };
  return { config, db, userId, orgId, repository, work, gitDir, run, commit };
}

test('workflow files are read from the commit being built, not from a branch tip', (t) => {
  const context = setup(t);
  const first = context.commit({ '.kukgit/workflows/ci.yml': VALID, 'README.md': 'one' }, 'add workflow');
  const second = context.commit({ '.kukgit/workflows/ci.yml': VALID.replace('name: CI', 'name: Changed') }, 'rename');

  // Reading from the branch tip would let a change to the workflow file silently
  // rewrite how already-pushed commits are built.
  assert.match(readWorkflowFiles(context.config, context.repository, first)[0].source, /name: CI/);
  assert.match(readWorkflowFiles(context.config, context.repository, second)[0].source, /name: Changed/);

  // Only YAML in the workflow directory counts.
  context.commit({ '.kukgit/workflows/notes.txt': 'ignored', '.kukgit/workflows/second.yaml': VALID });
  const files = readWorkflowFiles(context.config, context.repository, context.run(['rev-parse', 'HEAD']));
  assert.deepEqual(files.map((file) => file.path).sort(), ['.kukgit/workflows/ci.yml', '.kukgit/workflows/second.yaml']);
});

test('a repository with no workflow directory dispatches nothing', (t) => {
  const context = setup(t);
  const sha = context.commit({ 'README.md': 'nothing here' });
  assert.deepEqual(readWorkflowFiles(context.config, context.repository, sha), []);

  const result = dispatchWorkflows(context.db, context.config, {
    repository: context.repository,
    event: { name: 'push', ref: 'refs/heads/main', sha, paths: [] },
  });
  assert.deepEqual(result, { started: [], failed: [], skipped: [] });
});

test('a push starts a run for every workflow the event matches', (t) => {
  const context = setup(t);
  const other = [
    'on:',
    '  push:',
    '    branches: [release]',
    'jobs:',
    '  ship:',
    '    runs-on: kukgit-linux',
    '    steps: [{run: echo ship}]',
  ].join('\n');
  const sha = context.commit({ '.kukgit/workflows/ci.yml': VALID, '.kukgit/workflows/release.yml': other });

  const result = dispatchWorkflows(context.db, context.config, {
    repository: context.repository,
    event: { name: 'push', ref: 'refs/heads/main', sha, paths: ['README.md'] },
    actorId: context.userId,
  });

  assert.equal(result.started.length, 1);
  assert.equal(result.started[0].path, '.kukgit/workflows/ci.yml');
  // The other file is skipped with a reason, not silently dropped.
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0].reason, /branches/);
  assert.deepEqual(result.failed, []);

  const jobs = listRunJobs(context.db, result.started[0].runId);
  assert.equal(jobs[0].jobKey, 'build');
  assert.equal(jobs[0].status, 'queued');
});

test('an invalid workflow file becomes a failed run carrying the error', (t) => {
  const context = setup(t);
  const sha = context.commit({
    '.kukgit/workflows/broken.yml': 'on: push\njobs:\n  a:\n    runs-on: x\n    steps: [{run: echo "${{ github.event.issue.title }}"}]',
    '.kukgit/workflows/ci.yml': VALID,
  });

  const result = dispatchWorkflows(context.db, context.config, {
    repository: context.repository,
    event: { name: 'push', ref: 'refs/heads/main', sha, paths: [] },
    actorId: context.userId,
  });

  // One broken file must not disable the working one beside it.
  assert.equal(result.started.length, 1);
  assert.equal(result.started[0].path, '.kukgit/workflows/ci.yml');
  assert.equal(result.failed.length, 1);

  // Skipping would leave the author with no run at all and no way to tell a typo
  // from a filter that legitimately did not match.
  const failedRun = getRun(context.db, result.failed[0].runId);
  assert.equal(failedRun.status, 'failure');
  assert.equal(failedRun.workflowPath, '.kukgit/workflows/broken.yml');

  const job = listRunJobs(context.db, failedRun.id)[0];
  assert.equal(job.status, 'failure');
  const log = readJobLog(context.db, { jobId: job.id });
  assert.match(log.chunks[0].content, /broken\.yml/);
  assert.match(log.chunks[0].content, /may not be interpolated into a run script/);
});

test('an oversized workflow file fails rather than being ignored', (t) => {
  const context = setup(t);
  const sha = context.commit({
    '.kukgit/workflows/huge.yml': `# ${'x'.repeat(DISPATCH_LIMITS.maxFileBytes + 100)}\n${VALID}`,
  });

  const result = dispatchWorkflows(context.db, context.config, {
    repository: context.repository,
    event: { name: 'push', ref: 'refs/heads/main', sha, paths: [] },
  });
  assert.equal(result.failed.length, 1);
  const job = listRunJobs(context.db, result.failed[0].runId)[0];
  assert.match(readJobLog(context.db, { jobId: job.id }).chunks[0].content, /larger than the .* limit/);
});

test('a ref snapshot describes exactly what a push changed', (t) => {
  const context = setup(t);
  const first = context.commit({ '.kukgit/workflows/ci.yml': VALID });
  const before = refSnapshot(context.config, context.repository);
  assert.equal(before.get('refs/heads/main'), first);

  const second = context.commit({ 'README.md': 'updated' });
  context.run(['tag', 'v1.0.0']);
  context.run(['push', '--quiet', context.gitDir, 'v1.0.0']);

  const after = refSnapshot(context.config, context.repository);
  const changes = refChanges(before, after);
  const byRef = new Map(changes.map((change) => [change.ref, change]));

  assert.equal(byRef.get('refs/heads/main').sha, second);
  assert.equal(byRef.get('refs/heads/main').previousSha, first);
  assert.equal(byRef.get('refs/heads/main').type, 'branch');
  assert.equal(byRef.get('refs/tags/v1.0.0').type, 'tag');
  assert.equal(byRef.get('refs/tags/v1.0.0').created, true);

  // An unchanged ref is not a change.
  assert.deepEqual(refChanges(after, after), []);
});

test('a deleted ref produces no event and cancels its queued runs', (t) => {
  const context = setup(t);
  const sha = context.commit({ '.kukgit/workflows/ci.yml': VALID.replace('branches: [main]', 'branches: [feature]') });
  context.run(['push', '--quiet', context.gitDir, 'HEAD:refs/heads/feature']);

  const before = refSnapshot(context.config, context.repository);
  const started = dispatchForRefChanges(context.db, context.config, {
    repository: context.repository,
    changes: refChanges(new Map(), before).filter((change) => change.ref === 'refs/heads/feature'),
    actorId: context.userId,
  });
  assert.equal(started[0].started.length, 1);
  const runId = started[0].started[0].runId;
  assert.equal(getRun(context.db, runId).status, 'queued');

  context.run(['push', '--quiet', context.gitDir, '--delete', 'refs/heads/feature']);
  const after = refSnapshot(context.config, context.repository);

  // There is nothing to build at a commit nobody can reach, and running a
  // workflow from a deleted branch would execute code just removed.
  assert.deepEqual(refChanges(before, after).map((change) => change.ref), []);
  const cancelled = cancelRunsForDeletedRefs(context.db, { repository: context.repository, before, after });
  assert.deepEqual(cancelled, [runId]);
  assert.equal(getRun(context.db, runId).status, 'cancelled');
  assert.match(getRun(context.db, runId).conclusionReason, /was deleted/);
  assert.equal(sha.length, 40);
});

test('path filters are evaluated against what the push actually changed', (t) => {
  const context = setup(t);
  const filtered = [
    'on:',
    '  push:',
    '    paths: ["src/**"]',
    'jobs:',
    '  build:',
    '    runs-on: kukgit-linux',
    '    steps: [{run: echo build}]',
  ].join('\n');
  context.commit({ '.kukgit/workflows/ci.yml': filtered, 'src/app.mjs': 'one', 'docs/readme.md': 'one' });

  const before = refSnapshot(context.config, context.repository);
  context.commit({ 'docs/readme.md': 'two' }, 'docs only');
  let changes = refChanges(before, refSnapshot(context.config, context.repository));
  let results = dispatchForRefChanges(context.db, context.config, { repository: context.repository, changes });
  assert.equal(results[0].started.length, 0, 'a docs-only change does not match src/**');
  assert.match(results[0].skipped[0].reason, /paths/);

  const middle = refSnapshot(context.config, context.repository);
  context.commit({ 'src/app.mjs': 'two' }, 'source change');
  changes = refChanges(middle, refSnapshot(context.config, context.repository));
  results = dispatchForRefChanges(context.db, context.config, { repository: context.repository, changes });
  assert.equal(results[0].started.length, 1);
});

test('a tag push dispatches a tag event, not a push event', (t) => {
  const context = setup(t);
  const tagged = [
    'on:',
    '  tag:',
    '    tags: ["v*"]',
    'jobs:',
    '  release:',
    '    runs-on: kukgit-linux',
    '    steps: [{run: echo release}]',
  ].join('\n');
  context.commit({ '.kukgit/workflows/release.yml': tagged });

  const before = refSnapshot(context.config, context.repository);
  context.run(['tag', 'v2.0.0']);
  context.run(['push', '--quiet', context.gitDir, 'v2.0.0']);
  const changes = refChanges(before, refSnapshot(context.config, context.repository));

  const results = dispatchForRefChanges(context.db, context.config, {
    repository: context.repository, changes, actorId: context.userId,
  });
  const tagResult = results.find((result) => result.ref === 'refs/tags/v2.0.0');
  assert.equal(tagResult.started.length, 1);
  assert.equal(getRun(context.db, tagResult.started[0].runId).event, 'tag');
});

test('dispatching records an audit event naming the workflows, not their contents', (t) => {
  const context = setup(t);
  const sha = context.commit({ '.kukgit/workflows/ci.yml': VALID });
  dispatchWorkflows(context.db, context.config, {
    repository: context.repository,
    event: { name: 'push', ref: 'refs/heads/main', sha, paths: [] },
    actorId: context.userId,
  });

  const event = context.db.prepare("SELECT metadata_json AS metadata FROM audit_logs WHERE action = 'workflow.dispatched'").get();
  assert.match(event.metadata, /ci\.yml/);
  assert.match(event.metadata, /refs\/heads\/main/);
  assert.doesNotMatch(event.metadata, /echo build/);
});
