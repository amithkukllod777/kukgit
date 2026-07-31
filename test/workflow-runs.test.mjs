import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { openDatabase, seedCore, uid } from '../src/db.mjs';
import { migrateSecrets, putSecret } from '../src/secrets-vault.mjs';
import { validateWorkflowFile } from '../src/workflow-schema.mjs';
import {
  authorizeJobToken,
  cancelRun,
  claimNextJob,
  completeJob,
  createWorkflowRun,
  getRun,
  jobPermissionAtLeast,
  listRunJobs,
  matchesPattern,
  migrateWorkflowRuns,
  resolveJobPermissions,
  RUN_LIMITS,
  secretsForJob,
  workflowMatchesEvent,
} from '../src/workflow-runs.mjs';

function setup(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-runs-test-'));
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
    secretsEncryptionKey: 'kukgit-workflow-runs-test-key-long-enough',
  });
  const db = openDatabase(config);
  t.after(() => db.close());
  migrateSecrets(db);
  migrateWorkflowRuns(db);
  const { userId, orgId } = seedCore(db, config);

  const repositoryId = uid('repo');
  db.prepare(`
    INSERT INTO repositories (id, organization_id, slug, name, description, visibility, default_branch, created_by)
    VALUES (?, ?, 'app', 'App', '', 'private', 'main', ?)
  `).run(repositoryId, orgId, userId);

  return { config, db, userId, orgId, repository: { id: repositoryId } };
}

const WORKFLOW = [
  'name: CI',
  'on:',
  '  push:',
  '    branches: [main]',
  'jobs:',
  '  lint:',
  '    runs-on: kukgit-linux',
  '    steps: [{run: echo lint}]',
  '  test:',
  '    runs-on: kukgit-linux',
  '    steps: [{run: echo test}]',
  '  deploy:',
  '    needs: [lint, test]',
  '    runs-on: kukgit-linux',
  '    steps: [{run: echo deploy}]',
].join('\n');

function workflowFrom(source = WORKFLOW) {
  return validateWorkflowFile(source, { config: {} });
}

function pushEvent(overrides = {}) {
  return { name: 'push', ref: 'refs/heads/main', sha: 'a'.repeat(40), paths: [], ...overrides };
}

function run(context, { source = WORKFLOW, event = pushEvent(), fork = false } = {}) {
  const created = createWorkflowRun(context.db, {
    repository: context.repository,
    workflow: workflowFrom(source),
    workflowPath: '.kukgit/workflows/ci.yml',
    event,
    actorId: context.userId,
    fork,
  });
  assert.equal(created.created, true, `expected a run, got: ${created.reason}`);
  return created;
}

test('glob matching handles the shapes a branch filter actually uses', () => {
  assert.equal(matchesPattern('main', 'main'), true);
  assert.equal(matchesPattern('main', 'maintenance'), false);
  assert.equal(matchesPattern('release/*', 'release/1.0'), true);
  assert.equal(matchesPattern('release/*', 'release/1.0/hotfix'), true);
  assert.equal(matchesPattern('*', 'anything'), true);
  assert.equal(matchesPattern('v?.0', 'v1.0'), true);
  assert.equal(matchesPattern('v?.0', 'v10.0'), false);
  assert.equal(matchesPattern('src/**/*.js', 'src/a/b/c.js'), true);
  assert.equal(matchesPattern('a*b*c', 'axxbyyc'), true);
  assert.equal(matchesPattern('a*b*c', 'axxbyy'), false);
});

test('an event matches a workflow only when every filter agrees', () => {
  const workflow = workflowFrom([
    'on:',
    '  push:',
    '    branches: [main, "release/*"]',
    '    branches-ignore: ["release/legacy"]',
    '    paths: ["src/**"]',
    '    paths-ignore: ["src/docs/**"]',
    'jobs:',
    '  a:',
    '    runs-on: x',
    '    steps: [{run: echo}]',
  ].join('\n'));

  assert.equal(workflowMatchesEvent(workflow, pushEvent({ paths: ['src/app.mjs'] })).matched, true);
  assert.equal(workflowMatchesEvent(workflow, pushEvent({ ref: 'refs/heads/release/2.0', paths: ['src/a'] })).matched, true);
  assert.equal(workflowMatchesEvent(workflow, pushEvent({ ref: 'refs/heads/other', paths: ['src/a'] })).matched, false);
  assert.equal(workflowMatchesEvent(workflow, pushEvent({ paths: ['README.md'] })).matched, false);

  // An explicit exclusion is the stronger statement and wins over an inclusion.
  assert.equal(workflowMatchesEvent(workflow, pushEvent({ ref: 'refs/heads/release/legacy', paths: ['src/a'] })).matched, false);
  assert.equal(workflowMatchesEvent(workflow, pushEvent({ paths: ['src/docs/a.md'] })).matched, false);
  // A change touching both an excluded and an included path is not excluded.
  assert.equal(workflowMatchesEvent(workflow, pushEvent({ paths: ['src/docs/a.md', 'src/app.mjs'] })).matched, true);

  // Missing path metadata must not silently drop a build.
  assert.equal(workflowMatchesEvent(workflow, pushEvent({ paths: [] })).matched, true);

  assert.equal(workflowMatchesEvent(workflow, { name: 'pull_request', ref: 'refs/heads/main' }).matched, false);
});

test('a fork pull request can never receive a writable token', () => {
  // The "pwn request" class: code written by someone with no write access to
  // this repository must not be handed a token that can write to it.
  const requested = { contents: 'write', 'pull-requests': 'write', statuses: 'write' };
  const fork = resolveJobPermissions(requested, { event: 'pull_request', fork: true });
  for (const scope of Object.keys(fork)) {
    assert.notEqual(fork[scope], 'write', `${scope} must not be writable for a fork`);
  }

  // A same-repository pull request may write statuses but not contents.
  const internal = resolveJobPermissions(requested, { event: 'pull_request', fork: false });
  assert.equal(internal.contents, 'read');
  assert.equal(internal.statuses, 'write');

  // A push from the repository itself may write.
  assert.equal(resolveJobPermissions(requested, { event: 'push', fork: false }).contents, 'write');

  // A workflow can only ever narrow what it receives.
  const narrowed = resolveJobPermissions({ contents: 'read', issues: 'none' }, { event: 'push', fork: false });
  assert.equal(narrowed.contents, 'read');
  assert.equal(narrowed.issues, 'none');

  // Omitting permissions gives read, not the ceiling — otherwise every workflow
  // would be maximally privileged by saying nothing.
  const defaulted = resolveJobPermissions(null, { event: 'push', fork: false });
  assert.equal(defaulted.contents, 'read');
  assert.equal(defaulted.packages, 'read');
});

test('a run queues independent jobs and holds dependants until they succeed', (t) => {
  const context = setup(t);
  const { runId } = run(context);

  let jobs = listRunJobs(context.db, runId);
  assert.deepEqual(jobs.map((job) => job.status), ['queued', 'queued', 'pending']);
  assert.equal(getRun(context.db, runId).status, 'queued');

  const lint = claimNextJob(context.db, { runnerId: 'runner-1', labels: ['kukgit-linux'], organizationId: context.orgId });
  assert.ok(lint.token);
  assert.equal(getRun(context.db, runId).status, 'running');
  completeJob(context.db, lint.jobId, { status: 'success' });

  // One dependency done is not enough.
  jobs = listRunJobs(context.db, runId);
  assert.equal(jobs.find((job) => job.jobKey === 'deploy').status, 'pending');

  const second = claimNextJob(context.db, { runnerId: 'runner-1', labels: ['kukgit-linux'], organizationId: context.orgId });
  completeJob(context.db, second.jobId, { status: 'success' });
  assert.equal(listRunJobs(context.db, runId).find((job) => job.jobKey === 'deploy').status, 'queued');

  const deploy = claimNextJob(context.db, { runnerId: 'runner-1', labels: ['kukgit-linux'], organizationId: context.orgId });
  const finished = completeJob(context.db, deploy.jobId, { status: 'success' });
  assert.equal(finished.status, 'success');
  assert.ok(finished.completedAt);
  assert.equal(claimNextJob(context.db, { runnerId: 'runner-1', labels: ['kukgit-linux'], organizationId: context.orgId }), null);
});

test('a job whose dependency failed is skipped, not failed', (t) => {
  const context = setup(t);
  const { runId } = run(context);

  const first = claimNextJob(context.db, { runnerId: 'r', labels: ['kukgit-linux'], organizationId: context.orgId });
  completeJob(context.db, first.jobId, { status: 'failure', reason: 'exit code 1' });
  const second = claimNextJob(context.db, { runnerId: 'r', labels: ['kukgit-linux'], organizationId: context.orgId });
  completeJob(context.db, second.jobId, { status: 'success' });

  const jobs = listRunJobs(context.db, runId);
  const deploy = jobs.find((job) => job.jobKey === 'deploy');
  // It never ran; reporting it as failed would put a defect where there was
  // only an unmet precondition.
  assert.equal(deploy.status, 'skipped');
  assert.match(deploy.conclusionReason, /did not succeed/);
  assert.equal(getRun(context.db, runId).status, 'failure');
});

test('a runner only receives jobs matching a label it declared', (t) => {
  const context = setup(t);
  run(context);
  assert.equal(claimNextJob(context.db, { runnerId: 'r', labels: ['kukgit-windows'], organizationId: context.orgId }), null);
  assert.ok(claimNextJob(context.db, { runnerId: 'r', labels: ['kukgit-windows', 'kukgit-linux'], organizationId: context.orgId }));
  assert.throws(() => claimNextJob(context.db, { runnerId: '', labels: ['x'], organizationId: context.orgId }), (error) => error.code === 'RUNNER_ID_REQUIRED');
  assert.throws(() => claimNextJob(context.db, { runnerId: 'r', labels: [], organizationId: context.orgId }), (error) => error.code === 'RUNNER_LABELS_REQUIRED');
});

test('a job is handed to exactly one runner', (t) => {
  const context = setup(t);
  run(context);
  const claimed = new Set();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const job = claimNextJob(context.db, { runnerId: `runner-${attempt}`, labels: ['kukgit-linux'], organizationId: context.orgId });
    if (!job) break;
    assert.equal(claimed.has(job.jobId), false, 'a job must not be claimed twice');
    claimed.add(job.jobId);
  }
  assert.equal(claimed.size, 2, 'only the two independent jobs are runnable');
});

test('the job token is stored only as a hash and expires', (t) => {
  const context = setup(t);
  run(context);
  const claimed = claimNextJob(context.db, { runnerId: 'r', labels: ['kukgit-linux'], organizationId: context.orgId });

  const row = context.db.prepare('SELECT token_hash AS hash FROM workflow_jobs WHERE id = ?').get(claimed.jobId);
  assert.ok(row.hash);
  assert.notEqual(row.hash, claimed.token, 'the plaintext token must never be stored');

  const authorized = authorizeJobToken(context.db, claimed.token);
  assert.equal(authorized.jobId, claimed.jobId);
  assert.equal(authorized.repositoryId, context.repository.id);
  assert.equal(jobPermissionAtLeast(authorized.permissions, 'contents', 'read'), true);

  assert.throws(() => authorizeJobToken(context.db, 'not-a-token'), (error) => error.code === 'JOB_TOKEN_INVALID');

  // Expiry is enforced at use, not by a sweep, so a token that outlived its
  // window is refused even if nothing has cleaned it up.
  context.db.prepare("UPDATE workflow_jobs SET token_expires_at = datetime('now', '-1 hour') WHERE id = ?").run(claimed.jobId);
  assert.throws(() => authorizeJobToken(context.db, claimed.token), (error) => error.code === 'JOB_TOKEN_EXPIRED');
  assert.ok(RUN_LIMITS.jobTokenTtlSeconds > 0);
});

test('finishing or cancelling a job destroys its token immediately', (t) => {
  const context = setup(t);
  const { runId } = run(context);

  const finished = claimNextJob(context.db, { runnerId: 'r', labels: ['kukgit-linux'], organizationId: context.orgId });
  completeJob(context.db, finished.jobId, { status: 'success' });
  assert.throws(() => authorizeJobToken(context.db, finished.token), (error) => error.code === 'JOB_TOKEN_INVALID');
  assert.throws(() => completeJob(context.db, finished.jobId, { status: 'failure' }), (error) => error.code === 'WORKFLOW_JOB_ALREADY_COMPLETE');

  const running = claimNextJob(context.db, { runnerId: 'r', labels: ['kukgit-linux'], organizationId: context.orgId });
  cancelRun(context.db, runId, 'cancelled by an operator');
  // A runner that has not noticed the cancellation cannot keep acting.
  assert.throws(() => authorizeJobToken(context.db, running.token), (error) => error.code === 'JOB_TOKEN_INVALID');

  const cancelled = getRun(context.db, runId);
  assert.equal(cancelled.status, 'cancelled');
  const afterCancel = listRunJobs(context.db, runId);
  // Cancelling stops what had not finished; it does not rewrite the outcome of
  // a job that already succeeded.
  assert.equal(afterCancel.find((job) => job.id === finished.jobId).status, 'success');
  assert.ok(afterCancel.every((job) => ['success', 'cancelled'].includes(job.status)));
  assert.throws(() => cancelRun(context.db, runId), (error) => error.code === 'WORKFLOW_RUN_ALREADY_COMPLETE');
});

test('a concurrency group cancels the run it supersedes', (t) => {
  const context = setup(t);
  const source = [
    'on: push',
    'concurrency:',
    '  group: ci-${{ github.ref }}',
    '  cancel-in-progress: true',
    'jobs:',
    '  a:',
    '    runs-on: kukgit-linux',
    '    steps: [{run: echo}]',
  ].join('\n');

  const first = run(context, { source });
  assert.equal(first.concurrencyGroup, 'ci-refs/heads/main');

  const second = run(context, { source });
  assert.deepEqual(second.cancelledRuns, [first.runId]);
  assert.equal(getRun(context.db, first.runId).status, 'cancelled');
  assert.equal(getRun(context.db, second.runId).status, 'queued');

  // A different ref is a different group and is left alone.
  const other = run(context, { source, event: pushEvent({ ref: 'refs/heads/release/1' }) });
  assert.deepEqual(other.cancelledRuns, []);
  assert.equal(getRun(context.db, second.runId).status, 'queued');
});

test('a concurrency group without cancel-in-progress lets runs queue up', (t) => {
  const context = setup(t);
  const source = [
    'on: push',
    'concurrency:',
    '  group: shared',
    'jobs:',
    '  a:',
    '    runs-on: kukgit-linux',
    '    steps: [{run: echo}]',
  ].join('\n');
  const first = run(context, { source });
  const second = run(context, { source });
  assert.deepEqual(second.cancelledRuns, []);
  assert.equal(getRun(context.db, first.runId).status, 'queued');
});

test('a fork pull request receives no secrets at all', (t) => {
  const context = setup(t);
  putSecret(context.db, context.config, {
    scope: 'organization', scopeId: context.orgId, name: 'DEPLOY_TOKEN', value: 'organization-secret',
  });
  putSecret(context.db, context.config, {
    scope: 'repository', scopeId: context.repository.id, name: 'REPO_TOKEN', value: 'repository-secret',
  });

  const source = [
    'on: pull_request',
    'jobs:',
    '  a:',
    '    runs-on: kukgit-linux',
    '    steps: [{run: echo}]',
  ].join('\n');
  const event = { name: 'pull_request', ref: 'refs/heads/feature', sha: 'b'.repeat(40), paths: [] };

  const forked = run(context, { source, event, fork: true });
  // A fork job is not offered to a runner unless it opts in: on a self-hosted
  // runner that job would be untrusted code on someone's own machine.
  assert.equal(claimNextJob(context.db, { runnerId: 'r', labels: ['kukgit-linux'], organizationId: context.orgId }), null);
  const forkJob = claimNextJob(context.db, {
    runnerId: 'r', labels: ['kukgit-linux'], organizationId: context.orgId, allowForkJobs: true,
  });
  const forkContext = authorizeJobToken(context.db, forkJob.token);
  assert.equal(forkContext.fork, true);
  // Handing a fork the repository's credentials would make every secret readable
  // by anyone who can open a pull request.
  assert.deepEqual(secretsForJob(context.db, context.config, forkContext, { organizationId: context.orgId }), []);
  cancelRun(context.db, forked.runId);

  run(context, { source, event, fork: false });
  const internalJob = claimNextJob(context.db, { runnerId: 'r', labels: ['kukgit-linux'], organizationId: context.orgId });
  const internalContext = authorizeJobToken(context.db, internalJob.token);
  const secrets = secretsForJob(context.db, context.config, internalContext, { organizationId: context.orgId });
  assert.deepEqual(secrets.map((secret) => secret.name).sort(), ['DEPLOY_TOKEN', 'REPO_TOKEN']);
});

test('an event that does not match creates nothing, and runs in flight are bounded', (t) => {
  const context = setup(t);
  const skipped = createWorkflowRun(context.db, {
    repository: context.repository,
    workflow: workflowFrom(),
    workflowPath: '.kukgit/workflows/ci.yml',
    event: pushEvent({ ref: 'refs/heads/other' }),
  });
  assert.equal(skipped.created, false);
  assert.match(skipped.reason, /branches/);
  assert.equal(context.db.prepare('SELECT COUNT(*) AS count FROM workflow_runs').get().count, 0);

  const source = ['on: push', 'jobs:', '  a:', '    runs-on: kukgit-linux', '    steps: [{run: echo}]'].join('\n');
  for (let index = 0; index < RUN_LIMITS.maxQueuedRunsPerRepository; index += 1) run(context, { source });
  assert.throws(
    () => run(context, { source }),
    (error) => error.code === 'WORKFLOW_RUN_LIMIT_REACHED' && error.status === 429,
  );
});

test('an unresolved concurrency reference stays literal instead of collapsing groups', (t) => {
  const context = setup(t);
  const source = [
    'on: push',
    'concurrency:',
    '  group: ci-${{ matrix.os }}',
    '  cancel-in-progress: true',
    'jobs:',
    '  a:',
    '    runs-on: kukgit-linux',
    '    steps: [{run: echo}]',
  ].join('\n');
  // Resolving an unknown reference to an empty string would make every such
  // workflow share one group and cancel each other's runs.
  assert.equal(run(context, { source }).concurrencyGroup, 'ci-${{ matrix.os }}');
});
