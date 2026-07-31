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
import { createBareRepository } from '../src/git.mjs';
import { migrateRepositoryAccess } from '../src/repository-access.mjs';
import { migrateRepositoryLifecycle } from '../src/repository-lifecycle.mjs';
import { migrateSecrets } from '../src/secrets-vault.mjs';
import { validateWorkflowFile } from '../src/workflow-schema.mjs';
import { claimNextJob, createWorkflowRun, migrateWorkflowRuns } from '../src/workflow-runs.mjs';
import {
  createWorkflowStorageApiHandler,
  listArtifacts,
  migrateWorkflowStorage,
  saveCache,
  STORAGE_LIMITS,
} from '../src/workflow-storage.mjs';

const WORKFLOW = [
  'on: [push, pull_request]',
  'jobs:',
  '  build:',
  '    runs-on: kukgit-linux',
  '    steps: [{run: echo hello}]',
].join('\n');

function setup(t, { fork = false } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-storage-api-test-'));
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
    secretsEncryptionKey: 'kukgit-storage-api-test-key-long-enough',
  });
  fs.mkdirSync(config.repositoriesDir, { recursive: true });
  const db = openDatabase(config);
  t.after(() => db.close());
  migrateCollaboration(db);
  migrateRepositoryAccess(db);
  migrateRepositoryLifecycle(db);
  migrateSecrets(db);
  migrateWorkflowRuns(db);
  migrateWorkflowStorage(db);
  const { userId, orgId } = seedCore(db, config);

  const repositoryId = uid('repo');
  createBareRepository(config, 'kuklabs', 'app');
  db.prepare(`
    INSERT INTO repositories (id, organization_id, slug, name, description, visibility, default_branch, created_by)
    VALUES (?, ?, 'app', 'App', '', 'private', 'main', ?)
  `).run(repositoryId, orgId, userId);

  const created = createWorkflowRun(db, {
    repository: { id: repositoryId },
    workflow: validateWorkflowFile(WORKFLOW, { config: {} }),
    workflowPath: '.kukgit/workflows/ci.yml',
    event: { name: fork ? 'pull_request' : 'push', ref: 'refs/heads/topic', sha: 'a'.repeat(40), paths: [] },
    actorId: userId,
    fork,
  });
  const job = claimNextJob(db, {
    runnerId: 'runner-1', labels: ['kukgit-linux'], organizationId: orgId, allowForkJobs: fork,
  });

  return { config, db, userId, orgId, repositoryId, runId: created.runId, job };
}

function addUser(db, email) {
  const id = uid('usr');
  db.prepare("INSERT INTO users (id, email, password_hash, display_name) VALUES (?, ?, 'x$y', 'Member')").run(id, email);
  return id;
}

async function request(context, pathname, { method = 'GET', cookie = '', bearer = '', body, headers = {} } = {}) {
  const handler = createWorkflowStorageApiHandler({ config: context.config, db: context.db });
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
        ...headers,
      },
      body,
    });
    const buffer = Buffer.from(await response.arrayBuffer());
    const type = response.headers.get('content-type') || '';
    return {
      status: response.status,
      headers: response.headers,
      body: buffer,
      payload: type.includes('json') && buffer.length ? JSON.parse(buffer.toString('utf8')) : null,
    };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('a job uploads an artifact and a repository reader downloads it', async (t) => {
  const context = setup(t);

  const uploaded = await request(context, '/api/workflow-jobs/self/artifacts', {
    method: 'POST',
    bearer: context.job.token,
    headers: { 'X-Artifact-Name': 'test report.xml', 'Content-Type': 'application/octet-stream' },
    body: '<testsuite tests="3"/>',
  });
  assert.equal(uploaded.status, 201);
  assert.equal(uploaded.payload.name, 'test report.xml');

  // Nothing in the request named a repository, a run or a job. The job token is
  // the only thing that decided where these bytes landed.
  const stored = listArtifacts(context.db, { repositoryId: context.repositoryId, runId: context.runId });
  assert.equal(stored.length, 1);
  assert.equal(stored[0].jobId, context.job.jobId);

  const cookie = `kukgit_session=${createSession(context.db, context.userId).token}`;
  const listed = await request(context, `/api/workflow-runs/kuklabs/app/${context.runId}/artifacts`, { cookie });
  assert.equal(listed.status, 200);
  assert.equal(listed.payload.artifacts.length, 1);

  const downloaded = await request(
    context,
    `/api/workflow-runs/kuklabs/app/${context.runId}/artifacts/${uploaded.payload.id}`,
    { cookie },
  );
  assert.equal(downloaded.status, 200);
  assert.equal(downloaded.body.toString(), '<testsuite tests="3"/>');
  assert.equal(downloaded.headers.get('content-disposition'), 'attachment; filename="test report.xml"');
  // A downloaded artifact is bytes a build produced. Serving it as anything a
  // browser will interpret would make an artifact upload a way to host content
  // on the instance's own origin.
  assert.equal(downloaded.headers.get('content-type'), 'application/octet-stream');
  assert.equal(downloaded.headers.get('x-content-type-options'), 'nosniff');
});

test('an artifact does not cross a repository boundary', async (t) => {
  const context = setup(t);
  await request(context, '/api/workflow-jobs/self/artifacts', {
    method: 'POST',
    bearer: context.job.token,
    headers: { 'X-Artifact-Name': 'secret-build-output' },
    body: 'internal',
  });
  const artifactId = listArtifacts(context.db, { repositoryId: context.repositoryId })[0].id;

  const outsider = addUser(context.db, 'outsider@example.com');
  const outsiderCookie = `kukgit_session=${createSession(context.db, outsider).token}`;
  const refused = await request(
    context,
    `/api/workflow-runs/kuklabs/app/${context.runId}/artifacts/${artifactId}`,
    { cookie: outsiderCookie },
  );
  assert.equal(refused.status, 403);
  assert.doesNotMatch(refused.body.toString(), /internal/);

  // A second repository whose path is used to name the first repository's run.
  // The run must be rejected as not belonging to it, or read access anywhere
  // would become read access everywhere.
  createBareRepository(context.config, 'kuklabs', 'other');
  context.db.prepare(`
    INSERT INTO repositories (id, organization_id, slug, name, description, visibility, default_branch, created_by)
    VALUES (?, ?, 'other', 'Other', '', 'private', 'main', ?)
  `).run(uid('repo'), context.orgId, context.userId);

  const cookie = `kukgit_session=${createSession(context.db, context.userId).token}`;
  const crossed = await request(
    context,
    `/api/workflow-runs/kuklabs/other/${context.runId}/artifacts/${artifactId}`,
    { cookie },
  );
  assert.equal(crossed.status, 404);
  assert.equal(crossed.payload.error.code, 'WORKFLOW_RUN_NOT_FOUND');
});

test('deleting an artifact needs repository write', async (t) => {
  const context = setup(t);
  const uploaded = await request(context, '/api/workflow-jobs/self/artifacts', {
    method: 'POST',
    bearer: context.job.token,
    headers: { 'X-Artifact-Name': 'evidence' },
    body: 'kept',
  });
  const target = `/api/workflow-runs/kuklabs/app/${context.runId}/artifacts/${uploaded.payload.id}`;

  const reader = addUser(context.db, 'reader@example.com');
  context.db.prepare(`
    INSERT INTO repository_collaborators (repository_id, user_id, permission, added_by)
    VALUES (?, ?, 'read', ?)
  `).run(context.repositoryId, reader, context.userId);

  const refused = await request(context, target, {
    method: 'DELETE',
    cookie: `kukgit_session=${createSession(context.db, reader).token}`,
    headers: { Origin: context.config.baseUrl },
  });
  assert.equal(refused.status, 403);
  assert.equal(listArtifacts(context.db, { repositoryId: context.repositoryId }).length, 1);

  const ownerCookie = `kukgit_session=${createSession(context.db, context.userId).token}`;
  const crossSite = await request(context, target, {
    method: 'DELETE', cookie: ownerCookie, headers: { Origin: 'https://evil.example' },
  });
  assert.equal(crossSite.status, 403);
  assert.equal(crossSite.payload.error.code, 'CSRF_BLOCKED');

  const deleted = await request(context, target, {
    method: 'DELETE', cookie: ownerCookie, headers: { Origin: context.config.baseUrl },
  });
  assert.equal(deleted.status, 200);
  assert.equal(listArtifacts(context.db, { repositoryId: context.repositoryId }).length, 0);
  // The blob goes with the last row referencing it, so deleting to free space
  // actually frees space.
  assert.equal(context.db.prepare('SELECT COUNT(*) AS count FROM workflow_blobs').get().count, 0);
});

test('a job saves and restores a cache without naming its own ref', async (t) => {
  const context = setup(t);

  const saved = await request(context, '/api/workflow-jobs/self/cache', {
    method: 'POST', bearer: context.job.token, headers: { 'X-Cache-Key': 'npm-lock-abc123' }, body: 'node_modules',
  });
  assert.equal(saved.status, 201);
  // The ref came from the run record; the request had no way to state one.
  assert.equal(
    context.db.prepare('SELECT ref FROM workflow_caches WHERE cache_key = ?').get('npm-lock-abc123').ref,
    'refs/heads/topic',
  );

  const hit = await request(context, '/api/workflow-jobs/self/cache?key=npm-lock-abc123', { bearer: context.job.token });
  assert.equal(hit.status, 200);
  assert.equal(hit.body.toString(), 'node_modules');
  assert.equal(hit.headers.get('x-cache-exact'), 'true');

  const miss = await request(context, '/api/workflow-jobs/self/cache?key=npm-lock-different', { bearer: context.job.token });
  assert.equal(miss.status, 404);
  assert.equal(miss.payload.error.code, 'CACHE_MISS');

  // The default branch is the fallback, which is what makes a cache useful on a
  // branch that has never built before.
  saveCache(context.db, context.config, {
    repositoryId: context.repositoryId, ref: 'refs/heads/main', key: 'shared-toolchain', content: Buffer.from('from main'),
  });
  const fallback = await request(context, '/api/workflow-jobs/self/cache?key=shared-toolchain', { bearer: context.job.token });
  assert.equal(fallback.status, 200);
  assert.equal(fallback.body.toString(), 'from main');
  assert.equal(fallback.headers.get('x-cache-ref'), 'refs/heads/main');
});

test('a fork pull request may restore a cache but never save one', async (t) => {
  const context = setup(t, { fork: true });
  saveCache(context.db, context.config, {
    repositoryId: context.repositoryId, ref: 'refs/heads/main', key: 'toolchain', content: Buffer.from('trusted'),
  });

  // Two forks can choose the same branch name, so a fork write would let one
  // contributor hand another's build content it never produced.
  const refused = await request(context, '/api/workflow-jobs/self/cache', {
    method: 'POST', bearer: context.job.token, headers: { 'X-Cache-Key': 'toolchain' }, body: 'poisoned',
  });
  assert.equal(refused.status, 403);
  assert.equal(refused.payload.error.code, 'CACHE_FORK_WRITE_DENIED');
  assert.equal(context.db.prepare('SELECT COUNT(*) AS count FROM workflow_caches').get().count, 1);

  // Reading is the safe direction and stays open.
  const restored = await request(context, '/api/workflow-jobs/self/cache?key=toolchain', { bearer: context.job.token });
  assert.equal(restored.status, 200);
  assert.equal(restored.body.toString(), 'trusted');
});

test('an upload larger than the limit is refused before it is read', async (t) => {
  const context = setup(t);
  const refused = await request(context, '/api/workflow-jobs/self/artifacts', {
    method: 'POST',
    bearer: context.job.token,
    headers: {
      'X-Artifact-Name': 'huge',
      // Declared, not sent. The limit has to hold on the claim alone, or the
      // instance buffers the whole upload before deciding to reject it.
      'Content-Length': String(STORAGE_LIMITS.maxArtifactBytes + 1),
    },
    body: 'x',
  }).catch((error) => ({ status: 413, payload: null, error }));
  assert.equal(refused.status, 413);
});

test('storage routes refuse an invalid job credential', async (t) => {
  const context = setup(t);
  for (const route of ['/api/workflow-jobs/self/artifacts', '/api/workflow-jobs/self/cache']) {
    const anonymous = await request(context, route, { method: 'POST', headers: { 'X-Artifact-Name': 'x', 'X-Cache-Key': 'x' }, body: 'x' });
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.payload.error.code, 'JOB_TOKEN_REQUIRED');

    const forged = await request(context, route, {
      method: 'POST', bearer: 'not-a-real-token', headers: { 'X-Artifact-Name': 'x', 'X-Cache-Key': 'x' }, body: 'x',
    });
    assert.equal(forged.status, 401);
    assert.equal(forged.payload.error.code, 'JOB_TOKEN_INVALID');
  }
});

test('usage is readable by a repository reader and only for that repository', async (t) => {
  const context = setup(t);
  await request(context, '/api/workflow-jobs/self/artifacts', {
    method: 'POST', bearer: context.job.token, headers: { 'X-Artifact-Name': 'bundle' }, body: 'x'.repeat(64),
  });

  const cookie = `kukgit_session=${createSession(context.db, context.userId).token}`;
  const usage = await request(context, '/api/repositories/kuklabs/app/ci-storage', { cookie });
  assert.equal(usage.status, 200);
  assert.equal(usage.payload.artifacts.bytes, 64);
  assert.equal(usage.payload.artifacts.quotaBytes, STORAGE_LIMITS.artifactQuotaBytes);

  const outsider = addUser(context.db, 'outsider@example.com');
  const refused = await request(context, '/api/repositories/kuklabs/app/ci-storage', {
    cookie: `kukgit_session=${createSession(context.db, outsider).token}`,
  });
  assert.equal(refused.status, 403);
});
