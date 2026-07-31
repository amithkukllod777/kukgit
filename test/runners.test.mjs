import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createSession } from '../src/auth.mjs';
import { migrateCollaboration } from '../src/collaboration.mjs';
import { loadConfig } from '../src/config.mjs';
import { openDatabase, seedCore, uid } from '../src/db.mjs';
import { migrateRepositoryAccess } from '../src/repository-access.mjs';
import { migrateRepositoryLifecycle } from '../src/repository-lifecycle.mjs';
import {
  authorizeRunner,
  claimForRunner,
  createRunnersApiHandler,
  listRunners,
  migrateRunners,
  registerRunner,
  removeRunner,
  RUNNER_LIMITS,
  RUNNER_TOKEN_PREFIX,
} from '../src/runners.mjs';
import { migrateSecrets, putSecret } from '../src/secrets-vault.mjs';
import { validateWorkflowFile } from '../src/workflow-schema.mjs';
import { createWorkflowRun, migrateWorkflowRuns } from '../src/workflow-runs.mjs';

const WORKFLOW = [
  'on: [push, pull_request]',
  'env:',
  '  WORKFLOW_LEVEL: shared',
  'jobs:',
  '  build:',
  '    runs-on: kukgit-linux',
  '    env:',
  '      JOB_LEVEL: specific',
  '    steps:',
  '      - name: Build',
  '        run: npm ci && npm test',
].join('\n');

function setup(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-runners-test-'));
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
    secretsEncryptionKey: 'kukgit-runners-test-key-long-enough-here',
  });
  const db = openDatabase(config);
  t.after(() => db.close());
  migrateCollaboration(db);
  migrateRepositoryAccess(db);
  migrateRepositoryLifecycle(db);
  migrateSecrets(db);
  migrateWorkflowRuns(db);
  migrateRunners(db);
  const { userId, orgId } = seedCore(db, config);

  const repositoryId = uid('repo');
  db.prepare(`
    INSERT INTO repositories (id, organization_id, slug, name, description, visibility, default_branch, created_by)
    VALUES (?, ?, 'app', 'App', '', 'private', 'main', ?)
  `).run(repositoryId, orgId, userId);

  return { config, db, userId, orgId, repositoryId };
}

function otherOrganization(context, slug = 'other-labs') {
  const orgId = uid('org');
  context.db.prepare("INSERT INTO organizations (id, slug, name, plan) VALUES (?, ?, 'Other Labs', 'free')").run(orgId, slug);
  const repositoryId = uid('repo');
  context.db.prepare(`
    INSERT INTO repositories (id, organization_id, slug, name, description, visibility, default_branch, created_by)
    VALUES (?, ?, 'secret-app', 'Secret App', '', 'private', 'main', ?)
  `).run(repositoryId, orgId, context.userId);
  return { orgId, repositoryId };
}

function queueRun(context, { repositoryId = context.repositoryId, fork = false, event = null } = {}) {
  return createWorkflowRun(context.db, {
    repository: { id: repositoryId },
    workflow: validateWorkflowFile(WORKFLOW, { config: {} }),
    workflowPath: '.kukgit/workflows/ci.yml',
    event: event ?? { name: 'push', ref: 'refs/heads/main', sha: 'a'.repeat(40), paths: [] },
    actorId: context.userId,
    fork,
  });
}

function addUser(db, email) {
  const id = uid('usr');
  db.prepare("INSERT INTO users (id, email, password_hash, display_name) VALUES (?, ?, 'x$y', 'Member')").run(id, email);
  return id;
}

async function request(context, pathname, { method = 'GET', cookie = '', bearer = '', body } = {}) {
  const handler = createRunnersApiHandler({ config: context.config, db: context.db });
  const server = http.createServer(async (req, res) => {
    if (await handler(req, res)) return;
    res.writeHead(404); res.end('{}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${pathname}`, {
      method,
      headers: {
        ...(cookie ? { Cookie: cookie } : {}),
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, payload: text ? JSON.parse(text) : null, raw: text };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('a runner token is shown once and stored only as a hash', (t) => {
  const context = setup(t);
  const runner = registerRunner(context.db, {
    organizationId: context.orgId, name: 'build-box-1', labels: ['kukgit-linux'],
  });

  assert.ok(runner.token.startsWith(RUNNER_TOKEN_PREFIX));
  const stored = context.db.prepare('SELECT token_hash AS hash FROM runners WHERE id = ?').get(runner.id);
  assert.notEqual(stored.hash, runner.token);
  assert.equal(stored.hash.length, 64);

  // Nothing in the listing can be turned back into a credential.
  const listed = listRunners(context.db, context.orgId);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].token, undefined);
  assert.equal(JSON.stringify(listed).includes(runner.token), false);

  assert.equal(authorizeRunner(context.db, runner.token).id, runner.id);
  assert.throws(() => authorizeRunner(context.db, 'kgr_wrong'), (error) => error.code === 'RUNNER_TOKEN_INVALID');
  assert.throws(() => authorizeRunner(context.db, runner.token.slice(4)), (error) => error.code === 'RUNNER_TOKEN_INVALID');
});

test('a runner cannot claim work belonging to another organization', (t) => {
  const context = setup(t);
  const foreign = otherOrganization(context);
  queueRun(context, { repositoryId: foreign.repositoryId });

  const runner = authorizeRunner(context.db, registerRunner(context.db, {
    organizationId: context.orgId, name: 'ours', labels: ['kukgit-linux'],
  }).token);

  // The only queued job belongs to another tenant, so there is nothing to do.
  assert.equal(claimForRunner(context.db, context.config, { runner }), null);

  // Its own organization's work is claimable.
  queueRun(context);
  assert.ok(claimForRunner(context.db, context.config, { runner }));
});

test('a runner claims only for labels it registered with', (t) => {
  const context = setup(t);
  queueRun(context);
  const runner = authorizeRunner(context.db, registerRunner(context.db, {
    organizationId: context.orgId, name: 'linux-only', labels: ['kukgit-linux'],
  }).token);

  // Asking for a label it does not hold yields nothing rather than an error, so
  // a misconfigured agent idles instead of quietly picking up other work.
  assert.equal(claimForRunner(context.db, context.config, { runner, labels: ['kukgit-windows'] }), null);
  assert.ok(claimForRunner(context.db, context.config, { runner, labels: ['kukgit-linux'] }));
});

test('a claim carries everything needed to execute and nothing else', (t) => {
  const context = setup(t);
  putSecret(context.db, context.config, {
    scope: 'organization', scopeId: context.orgId, name: 'DEPLOY_TOKEN', value: 'organization-secret',
  });
  queueRun(context);

  const runner = authorizeRunner(context.db, registerRunner(context.db, {
    organizationId: context.orgId, name: 'box', labels: ['kukgit-linux'],
  }).token);
  const claimed = claimForRunner(context.db, context.config, { runner });

  assert.equal(claimed.job.key, 'build');
  assert.equal(claimed.job.steps.length, 1);
  assert.equal(claimed.job.steps[0].run, 'npm ci && npm test');
  // Workflow-level and job-level env arrive merged, so a runner never has to
  // know the precedence rule.
  assert.deepEqual(claimed.job.env, { WORKFLOW_LEVEL: 'shared', JOB_LEVEL: 'specific' });
  assert.equal(claimed.run.repository, 'kuklabs/app');
  assert.equal(claimed.run.cloneUrl, 'http://127.0.0.1:8787/git/kuklabs/app.git');
  assert.equal(claimed.secrets.DEPLOY_TOKEN, 'organization-secret');
  assert.ok(claimed.token);
  assert.ok(claimed.tokenExpiresAt);

  // A claim records that the runner is alive.
  assert.ok(listRunners(context.db, context.orgId)[0].lastSeenAt);
});

test('a fork job is not offered unless the runner opted in, and never with secrets', (t) => {
  const context = setup(t);
  putSecret(context.db, context.config, {
    scope: 'organization', scopeId: context.orgId, name: 'DEPLOY_TOKEN', value: 'organization-secret',
  });
  const forkEvent = { name: 'pull_request', ref: 'refs/heads/feature', sha: 'b'.repeat(40), paths: [] };
  queueRun(context, { fork: true, event: forkEvent });

  // On a self-hosted runner a fork job is untrusted code on someone's own
  // machine, so it is refused by default rather than offered.
  const cautious = authorizeRunner(context.db, registerRunner(context.db, {
    organizationId: context.orgId, name: 'default', labels: ['kukgit-linux'],
  }).token);
  assert.equal(claimForRunner(context.db, context.config, { runner: cautious }), null);

  const opted = authorizeRunner(context.db, registerRunner(context.db, {
    organizationId: context.orgId, name: 'accepts-forks', labels: ['kukgit-linux'], allowForkJobs: true,
  }).token);
  const claimed = claimForRunner(context.db, context.config, { runner: opted });
  assert.ok(claimed);
  assert.equal(claimed.run.fork, true);
  // Opting in to running the code never means opting in to the credentials.
  assert.deepEqual(claimed.secrets, {});
});

test('runner names and labels are validated, and a scope is bounded', (t) => {
  const context = setup(t);
  for (const name of ['', '  ', '-leading', 'has/slash', 'a'.repeat(RUNNER_LIMITS.maxNameLength + 1)]) {
    assert.throws(
      () => registerRunner(context.db, { organizationId: context.orgId, name, labels: ['x'] }),
      (error) => error.status === 400, `'${name}' must be refused`,
    );
  }
  for (const labels of [[], [''], ['has space'], ['UPPER!'], Array.from({ length: RUNNER_LIMITS.maxLabels + 1 }, (_, i) => `l${i}`)]) {
    assert.throws(
      () => registerRunner(context.db, { organizationId: context.orgId, name: 'valid', labels }),
      (error) => error.status === 400, `${JSON.stringify(labels)} must be refused`,
    );
  }

  // Labels are normalized, deduplicated and sorted so a claim comparison is exact.
  const runner = registerRunner(context.db, {
    organizationId: context.orgId, name: 'normalizing', labels: [' Kukgit-Linux ', 'kukgit-linux', 'arm64'],
  });
  assert.deepEqual(runner.labels, ['arm64', 'kukgit-linux']);

  assert.throws(
    () => registerRunner(context.db, { organizationId: context.orgId, name: 'normalizing', labels: ['x'] }),
    (error) => error.code === 'RUNNER_NAME_TAKEN',
  );

  removeRunner(context.db, { organizationId: context.orgId, runnerId: runner.id });
  assert.deepEqual(listRunners(context.db, context.orgId), []);
  assert.throws(
    () => removeRunner(context.db, { organizationId: context.orgId, runnerId: runner.id }),
    (error) => error.code === 'RUNNER_NOT_FOUND',
  );
});

test('registering a runner is organization Admin work', async (t) => {
  const context = setup(t);
  const developer = addUser(context.db, 'developer@example.com');
  context.db.prepare('INSERT INTO org_members (organization_id, user_id, role) VALUES (?, ?, ?)')
    .run(context.orgId, developer, 'developer');

  // Registering a runner decides what machine executes an organization's code.
  const refused = await request(context, '/api/runners/orgs/kuklabs', {
    method: 'POST',
    cookie: `kukgit_session=${createSession(context.db, developer).token}`,
    body: { name: 'attempt', labels: ['kukgit-linux'] },
  });
  assert.equal(refused.status, 403);
  assert.equal(refused.payload.error.code, 'ORGANIZATION_ACCESS_DENIED');

  const anonymous = await request(context, '/api/runners/orgs/kuklabs', {});
  assert.equal(anonymous.status, 401);

  const ownerCookie = `kukgit_session=${createSession(context.db, context.userId).token}`;
  const created = await request(context, '/api/runners/orgs/kuklabs', {
    method: 'POST', cookie: ownerCookie, body: { name: 'build-box', labels: ['kukgit-linux'] },
  });
  assert.equal(created.status, 201);
  assert.ok(created.payload.token.startsWith(RUNNER_TOKEN_PREFIX));

  const listed = await request(context, '/api/runners/orgs/kuklabs', { cookie: ownerCookie });
  assert.equal(listed.payload.runners.length, 1);
  assert.equal(listed.payload.runners[0].online, false, 'a runner that has never reported is not online');
  assert.doesNotMatch(listed.raw, new RegExp(created.payload.token));

  const removed = await request(context, `/api/runners/orgs/kuklabs/${created.payload.id}`, {
    method: 'DELETE', cookie: ownerCookie,
  });
  assert.equal(removed.status, 204);
});

test('an idle claim is 204, not an error', async (t) => {
  const context = setup(t);
  const token = registerRunner(context.db, {
    organizationId: context.orgId, name: 'idle', labels: ['kukgit-linux'],
  }).token;

  // An idle runner polls constantly; a 4xx would make every quiet minute look
  // like a fault.
  const idle = await request(context, '/api/runners/claim', { method: 'POST', bearer: token, body: {} });
  assert.equal(idle.status, 204);
  assert.equal(idle.raw, '');

  queueRun(context);
  const claimed = await request(context, '/api/runners/claim', {
    method: 'POST', bearer: token, body: { version: '1.0.0' },
  });
  assert.equal(claimed.status, 200);
  assert.equal(claimed.payload.job.key, 'build');
  assert.ok(claimed.payload.token);

  const unauthenticated = await request(context, '/api/runners/claim', { method: 'POST', body: {} });
  assert.equal(unauthenticated.status, 401);
  assert.equal(unauthenticated.payload.error.code, 'RUNNER_TOKEN_REQUIRED');

  const listed = listRunners(context.db, context.orgId);
  assert.equal(listed[0].lastSeenVersion, '1.0.0');
  assert.equal(listed[0].online, true);
});

test('the audit trail records a runner registration without its token', async (t) => {
  const context = setup(t);
  const cookie = `kukgit_session=${createSession(context.db, context.userId).token}`;
  const created = await request(context, '/api/runners/orgs/kuklabs', {
    method: 'POST', cookie, body: { name: 'audited', labels: ['kukgit-linux'] },
  });
  await request(context, `/api/runners/orgs/kuklabs/${created.payload.id}`, { method: 'DELETE', cookie });

  const events = context.db.prepare("SELECT action, metadata_json AS metadata FROM audit_logs WHERE action LIKE 'runner.%'").all();
  assert.deepEqual(events.map((event) => event.action).sort(), ['runner.registered', 'runner.removed']);
  for (const event of events) {
    assert.doesNotMatch(event.metadata, new RegExp(created.payload.token));
  }
});
