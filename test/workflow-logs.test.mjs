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
import { migrateSecrets, putSecret } from '../src/secrets-vault.mjs';
import { validateWorkflowFile } from '../src/workflow-schema.mjs';
import {
  appendJobLog,
  createWorkflowLogsApiHandler,
  jobHeartbeat,
  LOG_LIMITS,
  migrateWorkflowLogs,
  readJobLog,
  reapStalledJobs,
  sanitizeLogContent,
} from '../src/workflow-logs.mjs';
import {
  cancelRun,
  claimNextJob,
  createWorkflowRun,
  getRun,
  listRunJobs,
  migrateWorkflowRuns,
} from '../src/workflow-runs.mjs';

const WORKFLOW = [
  'on: push',
  'jobs:',
  '  build:',
  '    runs-on: kukgit-linux',
  '    steps: [{run: echo hello}]',
].join('\n');

function setup(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-logs-test-'));
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
    secretsEncryptionKey: 'kukgit-workflow-logs-test-key-long-enough',
  });
  fs.mkdirSync(config.repositoriesDir, { recursive: true });
  const db = openDatabase(config);
  t.after(() => db.close());
  migrateCollaboration(db);
  migrateRepositoryAccess(db);
  migrateRepositoryLifecycle(db);
  migrateSecrets(db);
  migrateWorkflowRuns(db);
  migrateWorkflowLogs(db);
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
    event: { name: 'push', ref: 'refs/heads/main', sha: 'a'.repeat(40), paths: [] },
    actorId: userId,
  });
  const claimed = claimNextJob(db, { runnerId: 'runner-1', labels: ['kukgit-linux'] });

  return { config, db, userId, orgId, repositoryId, runId: created.runId, job: claimed };
}

function addUser(db, email) {
  const id = uid('usr');
  db.prepare("INSERT INTO users (id, email, password_hash, display_name) VALUES (?, ?, 'x$y', 'Member')").run(id, email);
  return id;
}

async function request(context, pathname, { method = 'GET', cookie = '', bearer = '', body } = {}) {
  const handler = createWorkflowLogsApiHandler({ config: context.config, db: context.db });
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

test('terminal escape sequences are stripped from build output', () => {
  // A log viewer where a build can move the cursor or clear the screen is a log
  // viewer where a failure can be made to look like a pass.
  assert.equal(sanitizeLogContent('[2Jcleared'), '[2Jcleared');
  assert.equal(sanitizeLogContent('[31mred[0m'), '[31mred[0m');
  assert.equal(sanitizeLogContent('progress\roverwritten'), 'progress\noverwritten');
  assert.equal(sanitizeLogContent('line\r\nnext'), 'line\nnext');
  assert.equal(sanitizeLogContent('bellgone'), 'bellgone');
  assert.equal(sanitizeLogContent('delgone'), 'delgone');
  assert.equal(sanitizeLogContent('c1gone'), 'c1gone');

  // Newlines, tabs and ordinary text survive intact.
  assert.equal(sanitizeLogContent('keep\tthis\nand this'), 'keep\tthis\nand this');
  assert.equal(sanitizeLogContent('unicode ✓ 中文'), 'unicode ✓ 中文');

  // One unbroken line of many megabytes is a denial of service against every
  // viewer that ever renders it.
  const long = sanitizeLogContent('x'.repeat(LOG_LIMITS.maxLineBytes + 5000));
  assert.ok(long.endsWith('[line truncated]'));
  assert.ok(long.length < LOG_LIMITS.maxLineBytes + 100);
});

test('a secret is masked before the bytes are stored, not when they are read', (t) => {
  const context = setup(t);
  putSecret(context.db, context.config, {
    scope: 'organization', scopeId: context.orgId, name: 'TOKEN', value: 'super-secret-token-value',
  });

  appendJobLog(context.db, context.config, {
    jobId: context.job.jobId,
    organizationId: context.orgId,
    repositoryId: context.repositoryId,
    chunks: [{ stream: 'stdout', content: 'using super-secret-token-value to deploy\n' }],
  });

  // The raw value was never written down: not in the row, not in a backup, not
  // in a replica. Masking on read would have left it on disk.
  const stored = context.db.prepare('SELECT content FROM workflow_job_logs WHERE job_id = ?').all(context.job.jobId);
  assert.equal(stored.length, 1);
  assert.doesNotMatch(stored[0].content, /super-secret-token-value/);
  assert.match(stored[0].content, /using \*\*\* to deploy/);
});

test('a job log is read forward with a cursor and reports when it is complete', (t) => {
  const context = setup(t);
  for (let index = 0; index < 5; index += 1) {
    appendJobLog(context.db, context.config, {
      jobId: context.job.jobId,
      chunks: [{ stream: 'stdout', content: `line ${index}\n` }],
    });
  }

  const first = readJobLog(context.db, { jobId: context.job.jobId, limit: 2 });
  assert.equal(first.chunks.length, 2);
  assert.equal(first.cursor, 2);
  assert.equal(first.more, true);
  assert.equal(first.complete, false);

  const rest = readJobLog(context.db, { jobId: context.job.jobId, after: first.cursor });
  assert.equal(rest.chunks.length, 3);
  assert.equal(rest.more, false);
  // Still running, so a viewer keeps polling even with nothing new.
  assert.equal(rest.complete, false);

  cancelRun(context.db, context.runId);
  const afterEnd = readJobLog(context.db, { jobId: context.job.jobId, after: rest.cursor });
  assert.deepEqual(afterEnd.chunks, []);
  // A finished job with nothing more will never produce another chunk, which is
  // how a viewer knows to stop rather than guessing from a timeout.
  assert.equal(afterEnd.complete, true);
});

test('a job log is bounded and says so once rather than silently stopping', (t) => {
  const context = setup(t);
  // Many lines rather than one long one, so per-line truncation is not what
  // ends the test — the per-job cap is.
  const chunk = `${'x'.repeat(1023)}\n`.repeat(200);
  let truncated = false;
  for (let index = 0; index < 60 && !truncated; index += 1) {
    truncated = appendJobLog(context.db, context.config, {
      jobId: context.job.jobId,
      chunks: [{ stream: 'stdout', content: chunk }],
    }).truncated;
  }
  assert.equal(truncated, true, 'the cap must be reached');

  const read = readJobLog(context.db, { jobId: context.job.jobId, limit: LOG_LIMITS.defaultReadChunks });
  assert.equal(read.truncated, true);
  const notice = read.chunks.filter((entry) => entry.stream === 'system' && entry.content.includes('truncated'));
  assert.equal(notice.length, 1, 'the notice is written once, not on every append');

  // Nothing more is accepted, and the caller is told rather than silently ignored.
  const after = appendJobLog(context.db, context.config, {
    jobId: context.job.jobId, chunks: [{ stream: 'stdout', content: 'more output\n' }],
  });
  assert.equal(after.accepted, 0);
  assert.equal(after.truncated, true);

  assert.throws(
    () => appendJobLog(context.db, context.config, { jobId: context.job.jobId, chunks: [{ content: 'y'.repeat(LOG_LIMITS.maxChunkBytes + 1) }] }),
    (error) => error.code === 'LOG_CHUNK_TOO_LARGE',
  );
  assert.throws(
    () => appendJobLog(context.db, context.config, { jobId: context.job.jobId, chunks: [] }),
    (error) => error.code === 'LOG_CHUNKS_REQUIRED',
  );
});

test('a heartbeat tells the runner when the job has been cancelled', (t) => {
  const context = setup(t);
  const beating = jobHeartbeat(context.db, context.job.jobId);
  assert.equal(beating.cancelled, false);
  assert.equal(beating.status, 'running');
  assert.ok(beating.heartbeatIntervalSeconds > 0);

  cancelRun(context.db, context.runId, 'cancelled by an operator');

  // Cancellation is delivered as the answer to a heartbeat: a runner that lost
  // its connection cannot be pushed to, but one still talking asks every beat.
  const stopped = jobHeartbeat(context.db, context.job.jobId);
  assert.equal(stopped.cancelled, true);
});

test('a runner that stops reporting does not hold a job open forever', (t) => {
  const context = setup(t);
  assert.equal(reapStalledJobs(context.db).reaped, 0);

  context.db.prepare("UPDATE workflow_jobs SET last_heartbeat_at = datetime('now', '-1 hour') WHERE id = ?")
    .run(context.job.jobId);
  assert.equal(reapStalledJobs(context.db).reaped, 1);

  const job = listRunJobs(context.db, context.runId).find((entry) => entry.id === context.job.jobId);
  assert.equal(job.status, 'failure');
  assert.match(job.conclusionReason, /stopped reporting/);
  // The run concludes rather than staying in flight against the repository limit.
  assert.equal(getRun(context.db, context.runId).status, 'failure');
});

test('a runner posts logs with its job token and cannot name another job', async (t) => {
  const context = setup(t);

  const posted = await request(context, '/api/workflow-jobs/self/logs', {
    method: 'POST', bearer: context.job.token,
    body: { chunks: [{ stream: 'stdout', content: 'building\n' }] },
  });
  assert.equal(posted.status, 202);
  assert.equal(posted.payload.accepted, 1);

  // The token identifies exactly one job; there is no job id in the route to get
  // wrong or to point somewhere else.
  const beat = await request(context, '/api/workflow-jobs/self/heartbeat', { method: 'POST', bearer: context.job.token });
  assert.equal(beat.status, 200);
  assert.equal(beat.payload.cancelled, false);

  const anonymous = await request(context, '/api/workflow-jobs/self/logs', {
    method: 'POST', body: { chunks: [{ content: 'x' }] },
  });
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.payload.error.code, 'JOB_TOKEN_REQUIRED');

  const forged = await request(context, '/api/workflow-jobs/self/logs', {
    method: 'POST', bearer: 'not-a-real-token', body: { chunks: [{ content: 'x' }] },
  });
  assert.equal(forged.status, 401);

  const completed = await request(context, '/api/workflow-jobs/self/complete', {
    method: 'POST', bearer: context.job.token, body: { status: 'success' },
  });
  assert.equal(completed.status, 200);
  assert.equal(completed.payload.runStatus, 'success');

  // The token died with the job.
  const afterComplete = await request(context, '/api/workflow-jobs/self/logs', {
    method: 'POST', bearer: context.job.token, body: { chunks: [{ content: 'late output' }] },
  });
  assert.equal(afterComplete.status, 401);
});

test('reading a log needs repository read, and cancelling needs write', async (t) => {
  const context = setup(t);
  appendJobLog(context.db, context.config, {
    jobId: context.job.jobId, chunks: [{ stream: 'stdout', content: 'visible output\n' }],
  });
  const base = `/api/workflow-runs/kuklabs/app/${context.runId}`;

  const outsider = addUser(context.db, 'outsider@example.com');
  const outsiderCookie = `kukgit_session=${createSession(context.db, outsider).token}`;
  const refused = await request(context, `${base}/jobs/${context.job.jobId}/logs`, { cookie: outsiderCookie });
  // 403 rather than 404 matches how every other repository route in KukGit
  // answers; what matters here is that no log content crosses the boundary.
  assert.equal(refused.status, 403);
  assert.equal(refused.payload.error.code, 'REPOSITORY_ACCESS_DENIED');
  assert.doesNotMatch(refused.raw, /visible output/);

  const reader = addUser(context.db, 'reader@example.com');
  context.db.prepare(`
    INSERT INTO repository_collaborators (repository_id, user_id, permission, added_by)
    VALUES (?, ?, 'read', ?)
  `).run(context.repositoryId, reader, context.userId);
  const readerCookie = `kukgit_session=${createSession(context.db, reader).token}`;

  const allowed = await request(context, `${base}/jobs/${context.job.jobId}/logs`, { cookie: readerCookie });
  assert.equal(allowed.status, 200);
  assert.match(allowed.payload.chunks[0].content, /visible output/);

  // Cancelling stops work on the repository, so it is a write.
  const cancelRefused = await request(context, `${base}/cancel`, { method: 'POST', cookie: readerCookie, body: {} });
  assert.equal(cancelRefused.status, 403);
  assert.equal(getRun(context.db, context.runId).status, 'running');

  const ownerCookie = `kukgit_session=${createSession(context.db, context.userId).token}`;
  const cancelled = await request(context, `${base}/cancel`, { method: 'POST', cookie: ownerCookie, body: {} });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.payload.run.status, 'cancelled');
});

test('a run can only be read through the repository it belongs to', async (t) => {
  const context = setup(t);
  const otherId = uid('repo');
  createBareRepository(context.config, 'kuklabs', 'other');
  context.db.prepare(`
    INSERT INTO repositories (id, organization_id, slug, name, description, visibility, default_branch, created_by)
    VALUES (?, ?, 'other', 'Other', '', 'private', 'main', ?)
  `).run(otherId, context.orgId, context.userId);

  const cookie = `kukgit_session=${createSession(context.db, context.userId).token}`;
  // Naming a foreign run id under a repository the caller can reach must not
  // become a way to read another repository's logs.
  const crossed = await request(context, `/api/workflow-runs/kuklabs/other/${context.runId}`, { cookie });
  assert.equal(crossed.status, 404);

  const correct = await request(context, `/api/workflow-runs/kuklabs/app/${context.runId}`, { cookie });
  assert.equal(correct.status, 200);
  assert.equal(correct.payload.run.id, context.runId);
  assert.equal(correct.payload.jobs.length, 1);
});

test('the live status view reports each job and its outcome', async (t) => {
  const context = setup(t);
  const cookie = `kukgit_session=${createSession(context.db, context.userId).token}`;

  const running = await request(context, `/api/workflow-runs/kuklabs/app/${context.runId}`, { cookie });
  assert.equal(running.payload.run.status, 'running');
  assert.equal(running.payload.jobs[0].status, 'running');
  assert.equal(running.payload.jobs[0].runnerId, 'runner-1');

  await request(context, '/api/workflow-jobs/self/complete', {
    method: 'POST', bearer: context.job.token, body: { status: 'failure', reason: 'exit code 1' },
  });

  const finished = await request(context, `/api/workflow-runs/kuklabs/app/${context.runId}`, { cookie });
  assert.equal(finished.payload.run.status, 'failure');
  assert.equal(finished.payload.jobs[0].conclusionReason, 'exit code 1');
  assert.ok(finished.payload.jobs[0].completedAt);
});
