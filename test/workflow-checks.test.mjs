import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { openDatabase, seedCore, uid } from '../src/db.mjs';
import { createBareRepository, createDemoCommit, resolveRef } from '../src/git.mjs';
import { migrateSecrets } from '../src/secrets-vault.mjs';
import {
  listCommitStatuses,
  migrateStatusChecks,
  normalizeRequiredContexts,
  upsertRequiredStatusPolicy,
} from '../src/status-checks.mjs';
import { CHECK_PREFIX, checkContextForWorkflow, publishChecksForCommit, publishRunCheck } from '../src/workflow-checks.mjs';
import { migrateWorkflowLogs } from '../src/workflow-logs.mjs';
import { validateWorkflowFile } from '../src/workflow-schema.mjs';
import {
  cancelRun,
  claimNextJob,
  completeJob,
  createWorkflowRun,
  migrateWorkflowRuns,
  observeRunChanges,
} from '../src/workflow-runs.mjs';

const WORKFLOW = [
  'name: CI',
  'on: push',
  'jobs:',
  '  lint:',
  '    runs-on: kukgit-linux',
  '    steps: [{run: echo lint}]',
  '  test:',
  '    runs-on: kukgit-linux',
  '    steps: [{run: echo test}]',
].join('\n');

async function setup(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-checks-test-'));
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
    secretsEncryptionKey: 'kukgit-checks-test-key-long-enough-here',
  });
  fs.mkdirSync(config.repositoriesDir, { recursive: true });
  const db = openDatabase(config);
  t.after(() => db.close());
  migrateStatusChecks(db);
  migrateSecrets(db);
  migrateWorkflowRuns(db);
  migrateWorkflowLogs(db);
  const { userId, orgId } = seedCore(db, config);

  createBareRepository(config, 'kuklabs', 'app');
  await createDemoCommit(config, 'kuklabs', 'app');
  const sha = resolveRef(config, 'kuklabs', 'app', 'main').toLowerCase();
  const repositoryId = uid('repo');
  db.prepare(`
    INSERT INTO repositories (id, organization_id, slug, name, description, visibility, default_branch, created_by)
    VALUES (?, ?, 'app', 'App', '', 'private', 'main', ?)
  `).run(repositoryId, orgId, userId);

  t.after(() => observeRunChanges(null));
  return { config, db, userId, orgId, repositoryId, sha, repository: { id: repositoryId } };
}

function startRun(context, { workflowPath = '.kukgit/workflows/ci.yml', actorId } = {}) {
  const created = createWorkflowRun(context.db, {
    repository: context.repository,
    workflow: validateWorkflowFile(WORKFLOW, { config: {} }),
    workflowPath,
    event: { name: 'push', ref: 'refs/heads/main', sha: context.sha, paths: [] },
    actorId: actorId === undefined ? context.userId : actorId,
  });
  assert.equal(created.created, true);
  return created.runId;
}

function statusFor(context, contextName) {
  return listCommitStatuses(context.db, context.repositoryId, context.sha)
    .find((status) => status.context === contextName);
}

test('the check context comes from the file path, not from the workflow', () => {
  // A workflow that could name its own context could declare the one a branch
  // rule requires and report success without running anything — the protection
  // defeated by the thing it protects against.
  assert.equal(checkContextForWorkflow('.kukgit/workflows/ci.yml'), 'kukgit/ci');
  assert.equal(checkContextForWorkflow('.kukgit/workflows/release-deploy.yaml'), 'kukgit/release-deploy');
  assert.equal(checkContextForWorkflow('.kukgit/workflows/Build Things.yml'), 'kukgit/Build-Things');
  // The context is a label compared literally, never a path, so traversal in a
  // file name becomes ordinary text rather than reaching anything.
  assert.equal(checkContextForWorkflow('.kukgit/workflows/../escape.yml'), 'kukgit/..-escape');
  assert.equal(checkContextForWorkflow(''), 'kukgit/workflow');
  assert.ok(checkContextForWorkflow('.kukgit/workflows/x.yml').startsWith(CHECK_PREFIX));
});

test('a run publishes pending when it starts and success when it finishes', async (t) => {
  const context = await setup(t);
  const runId = startRun(context);

  publishRunCheck(context.db, context.config, runId);
  const queued = statusFor(context, 'kukgit/ci');
  assert.equal(queued.state, 'pending');
  assert.match(queued.description, /2 jobs queued/);
  assert.equal(queued.publisherAuthType, 'workflow');
  assert.match(queued.targetUrl, /\/kuklabs\/app\/runs\//);

  const first = claimNextJob(context.db, { runnerId: 'r', labels: ['kukgit-linux'], organizationId: context.orgId });
  completeJob(context.db, first.jobId, { status: 'success' });
  publishRunCheck(context.db, context.config, runId);
  assert.equal(statusFor(context, 'kukgit/ci').state, 'pending', 'a half-finished run is not green');

  const second = claimNextJob(context.db, { runnerId: 'r', labels: ['kukgit-linux'], organizationId: context.orgId });
  completeJob(context.db, second.jobId, { status: 'success' });
  publishRunCheck(context.db, context.config, runId);

  const finished = statusFor(context, 'kukgit/ci');
  assert.equal(finished.state, 'success');
  assert.match(finished.description, /All 2 jobs succeeded/);
});

test('a failed run publishes failure naming the job', async (t) => {
  const context = await setup(t);
  const runId = startRun(context);
  const claimed = claimNextJob(context.db, { runnerId: 'r', labels: ['kukgit-linux'], organizationId: context.orgId });
  completeJob(context.db, claimed.jobId, { status: 'failure', reason: 'exit code 1' });
  const second = claimNextJob(context.db, { runnerId: 'r', labels: ['kukgit-linux'], organizationId: context.orgId });
  completeJob(context.db, second.jobId, { status: 'success' });

  publishRunCheck(context.db, context.config, runId);
  const status = statusFor(context, 'kukgit/ci');
  assert.equal(status.state, 'failure');
  assert.match(status.description, /lint|test/);
});

test('a cancelled run is an error, not a failure', async (t) => {
  const context = await setup(t);
  const runId = startRun(context);
  cancelRun(context.db, runId, 'superseded by a newer run');

  publishRunCheck(context.db, context.config, runId);
  const status = statusFor(context, 'kukgit/ci');
  // `failure` says the code is wrong. A cancellation says nobody found out —
  // reporting it as a failure sends someone looking for a bug that is not there.
  assert.equal(status.state, 'error');
  assert.match(status.description, /superseded/);
});

test('the observer publishes on every state change without being called by hand', async (t) => {
  const context = await setup(t);
  observeRunChanges((runId) => publishRunCheck(context.db, context.config, runId));

  const runId = startRun(context);
  assert.equal(statusFor(context, 'kukgit/ci').state, 'pending', 'creating the run published it');

  const claimed = claimNextJob(context.db, { runnerId: 'r', labels: ['kukgit-linux'], organizationId: context.orgId });
  completeJob(context.db, claimed.jobId, { status: 'success' });
  const second = claimNextJob(context.db, { runnerId: 'r', labels: ['kukgit-linux'], organizationId: context.orgId });
  completeJob(context.db, second.jobId, { status: 'success' });

  assert.equal(statusFor(context, 'kukgit/ci').state, 'success');
  assert.equal(runId.startsWith('run_'), true);
});

test('an observer that throws does not break scheduling', async (t) => {
  const context = await setup(t);
  observeRunChanges(() => { throw new Error('reporting is down'); });

  // A reporting failure must not be able to stop a build from running.
  const runId = startRun(context);
  const claimed = claimNextJob(context.db, { runnerId: 'r', labels: ['kukgit-linux'], organizationId: context.orgId });
  assert.ok(claimed);
  assert.doesNotThrow(() => completeJob(context.db, claimed.jobId, { status: 'success' }));
  assert.equal(runId.startsWith('run_'), true);
});

test('two workflows on one commit publish two independent checks', async (t) => {
  const context = await setup(t);
  const first = startRun(context, { workflowPath: '.kukgit/workflows/ci.yml' });
  const second = startRun(context, { workflowPath: '.kukgit/workflows/deploy.yml' });

  const published = publishChecksForCommit(context.db, context.config, {
    repositoryId: context.repositoryId, commitSha: context.sha,
  });
  assert.equal(published.length, 2);
  assert.ok(statusFor(context, 'kukgit/ci'));
  assert.ok(statusFor(context, 'kukgit/deploy'));
  assert.notEqual(first, second);
});

test('a run with no resolvable actor publishes nothing rather than borrowing a name', async (t) => {
  const context = await setup(t);
  const runId = startRun(context, { actorId: null });

  assert.equal(publishRunCheck(context.db, context.config, runId), null);
  assert.deepEqual(listCommitStatuses(context.db, context.repositoryId, context.sha), []);
});

test('a workflow check satisfies a branch rule only by actually passing', async (t) => {
  const context = await setup(t);
  // An operator requires the check by name; the workflow cannot grant itself the
  // name, and nothing here decides whether a merge is allowed.
  upsertRequiredStatusPolicy(context.db, {
    repositoryId: context.repositoryId,
    branch: 'main',
    userId: context.userId,
    contexts: normalizeRequiredContexts(['kukgit/ci']),
  });

  const runId = startRun(context);
  publishRunCheck(context.db, context.config, runId);
  assert.equal(statusFor(context, 'kukgit/ci').state, 'pending');

  const first = claimNextJob(context.db, { runnerId: 'r', labels: ['kukgit-linux'], organizationId: context.orgId });
  completeJob(context.db, first.jobId, { status: 'failure', reason: 'tests failed' });
  const second = claimNextJob(context.db, { runnerId: 'r', labels: ['kukgit-linux'], organizationId: context.orgId });
  completeJob(context.db, second.jobId, { status: 'success' });
  publishRunCheck(context.db, context.config, runId);

  // The required context exists and is red. The merge guard reads this; the
  // workflow had no way to write anything other than what actually happened.
  assert.equal(statusFor(context, 'kukgit/ci').state, 'failure');
});

test('a status that cannot be published never destroys the run that produced it', async (t) => {
  const context = await setup(t);
  const runId = startRun(context);
  // A commit that is not in the repository: the status API refuses it.
  context.db.prepare("UPDATE workflow_runs SET commit_sha = ? WHERE id = ?").run('f'.repeat(40), runId);

  assert.equal(publishRunCheck(context.db, context.config, runId), null);
  assert.equal(context.db.prepare('SELECT status FROM workflow_runs WHERE id = ?').get(runId).status, 'queued');
});
