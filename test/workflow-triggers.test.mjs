import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createSession } from '../src/auth.mjs';
import { migrateCollaboration } from '../src/collaboration.mjs';
import { loadConfig } from '../src/config.mjs';
import { openDatabase, seedCore, uid } from '../src/db.mjs';
import { createBareRepository, repoDiskPath } from '../src/git.mjs';
import { migrateRepositoryAccess } from '../src/repository-access.mjs';
import { migrateRepositoryLifecycle } from '../src/repository-lifecycle.mjs';
import { migrateSecrets } from '../src/secrets-vault.mjs';
import { migrateWorkflowLogs } from '../src/workflow-logs.mjs';
import { getRun, migrateWorkflowRuns } from '../src/workflow-runs.mjs';
import { acquireLease, leaseHolder, releaseLease } from '../src/job-leases.mjs';
import {
  createWorkflowTriggersApiHandler,
  dispatchClosedPullRequests,
  dispatchDueSchedules,
  dispatchManualRun,
  migrateWorkflowTriggers,
  nextCronOccurrence,
  syncSchedules,
} from '../src/workflow-triggers.mjs';

function setup(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-triggers-test-'));
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
    secretsEncryptionKey: 'kukgit-triggers-test-key-long-enough-x',
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
  migrateWorkflowTriggers(db);
  const { userId, orgId } = seedCore(db, config);

  const repositoryId = uid('repo');
  createBareRepository(config, 'kuklabs', 'app');
  db.prepare(`
    INSERT INTO repositories (id, organization_id, slug, name, description, visibility, default_branch, created_by)
    VALUES (?, ?, 'app', 'App', '', 'private', 'main', ?)
  `).run(repositoryId, orgId, userId);

  const repository = { id: repositoryId, orgSlug: 'kuklabs', repoSlug: 'app', organizationId: orgId, defaultBranch: 'main' };
  return { config, db, userId, orgId, repositoryId, repository };
}

// Writes files into the bare repository through a scratch worktree, so the
// dispatcher reads exactly what a push would have produced.
function commit(context, files, { branch = 'main', from = null } = {}) {
  const gitDir = repoDiskPath(context.config, 'kuklabs', 'app');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-triggers-work-'));
  const run = (args, cwd = work) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
    return result.stdout.trim();
  };
  run(['init', '-q', '-b', branch], work);
  run(['config', 'user.email', 'test@example.com']);
  run(['config', 'user.name', 'Test']);
  // The sandbox host configures a signer that is not reachable from a test.
  run(['config', 'commit.gpgsign', 'false']);
  run(['config', 'tag.gpgsign', 'false']);
  run(['remote', 'add', 'origin', gitDir]);
  // A new branch starts from `from` when one is named, so a side branch carries
  // the workflow files that are on the branch it came from.
  for (const source of [branch, from].filter(Boolean)) {
    try { run(['fetch', '-q', 'origin', source]); run(['reset', '-q', '--hard', 'FETCH_HEAD']); break; }
    catch { /* try the next source, or start empty */ }
  }
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(work, file)), { recursive: true });
    fs.writeFileSync(path.join(work, file), content);
  }
  run(['add', '-A']);
  run(['commit', '-q', '-m', 'test']);
  const sha = run(['rev-parse', 'HEAD']);
  run(['push', '-q', 'origin', `HEAD:refs/heads/${branch}`]);
  fs.rmSync(work, { recursive: true, force: true });
  return sha;
}

const NIGHTLY = [
  'name: nightly',
  'on:',
  '  schedule:',
  "    cron: ['0 3 * * *']",
  'jobs:',
  '  build:',
  '    runs-on: kukgit-linux',
  '    steps: [{run: echo nightly}]',
].join('\n');

const MANUAL = [
  'name: deploy',
  'on:',
  '  manual:',
  '    inputs:',
  '      environment: {required: true}',
  '      dry_run: {default: "true"}',
  'jobs:',
  '  deploy:',
  '    runs-on: kukgit-linux',
  '    steps: [{run: echo deploying}]',
].join('\n');

async function request(context, pathname, { method = 'GET', cookie = '', body, origin } = {}) {
  const handler = createWorkflowTriggersApiHandler({ config: context.config, db: context.db });
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
        ...(origin === undefined ? { Origin: context.config.baseUrl } : origin ? { Origin: origin } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, payload: text ? JSON.parse(text) : null };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('a lease is won by exactly one holder and released back', (t) => {
  const context = setup(t);
  const now = new Date('2026-08-01T00:00:00Z');

  assert.equal(acquireLease(context.db, 'workflow-schedule', { owner: 'instance-a', now }), true);
  // Two instances that both read "free" would both fire every schedule. One
  // statement decides it, so the second is simply told no.
  assert.equal(acquireLease(context.db, 'workflow-schedule', { owner: 'instance-b', now }), false);
  // The holder renews without contention.
  assert.equal(acquireLease(context.db, 'workflow-schedule', { owner: 'instance-a', now }), true);
  assert.equal(leaseHolder(context.db, 'workflow-schedule').owner, 'instance-a');

  // An instance that died does not hold the lease forever.
  const later = new Date('2026-08-01T00:05:00Z');
  assert.equal(acquireLease(context.db, 'workflow-schedule', { owner: 'instance-b', now: later }), true);
  assert.equal(leaseHolder(context.db, 'workflow-schedule').owner, 'instance-b');

  assert.equal(releaseLease(context.db, 'workflow-schedule', 'instance-a'), false, 'only the holder may release');
  assert.equal(releaseLease(context.db, 'workflow-schedule', 'instance-b'), true);
  assert.equal(leaseHolder(context.db, 'workflow-schedule'), null);
});

test('cron is evaluated in UTC and follows cron day rules', () => {
  const at = (iso) => new Date(iso);
  const next = (cron, from) => nextCronOccurrence(cron, at(from)).toISOString();

  assert.equal(next('0 3 * * *', '2026-08-01T02:59:00Z'), '2026-08-01T03:00:00.000Z');
  assert.equal(next('0 3 * * *', '2026-08-01T03:00:00Z'), '2026-08-02T03:00:00.000Z', 'strictly after');
  assert.equal(next('*/15 * * * *', '2026-08-01T00:01:00Z'), '2026-08-01T00:15:00.000Z');
  assert.equal(next('5/10 * * * *', '2026-08-01T00:06:00Z'), '2026-08-01T00:15:00.000Z');
  assert.equal(next('30 1,13 * * *', '2026-08-01T02:00:00Z'), '2026-08-01T13:30:00.000Z');

  // Day-of-month and day-of-week restricted together are a union, which is
  // cron's rule. Read as an intersection this would be "never".
  const union = next('0 0 1 * 1', '2026-08-02T00:00:00Z');
  assert.equal(union, '2026-08-03T00:00:00.000Z', 'the next Monday comes before the next 1st');

  // A schedule read in a local zone would run twice on one day a year and not
  // at all on another, with nothing in the file to explain it.
  assert.equal(next('0 0 * * *', '2026-03-29T00:30:00Z'), '2026-03-30T00:00:00.000Z');

  // Far-apart dates still resolve.
  assert.equal(next('0 0 29 2 *', '2026-08-01T00:00:00Z'), '2028-02-29T00:00:00.000Z');
});

test('schedules come from the default branch only, and follow the file', (t) => {
  const context = setup(t);
  const now = new Date('2026-08-01T00:00:00Z');
  commit(context, { 'README.md': 'app' });

  // A schedule on a side branch installs nothing. Otherwise anyone who can push
  // a branch could give themselves recurring work on the instance.
  commit(context, { '.kukgit/workflows/nightly.yml': NIGHTLY }, { branch: 'sneaky' });
  assert.deepEqual(syncSchedules(context.db, context.config, { repository: context.repository, now }).schedules, []);

  commit(context, { '.kukgit/workflows/nightly.yml': NIGHTLY });
  const synced = syncSchedules(context.db, context.config, { repository: context.repository, now });
  assert.equal(synced.schedules.length, 1);
  assert.equal(synced.schedules[0].cron, '0 3 * * *');
  assert.equal(synced.schedules[0].nextDueAt, '2026-08-01T03:00:00.000Z');

  // Deleting the schedule from the file deletes the row: removing a schedule is
  // an ordinary edit, not an operator task.
  commit(context, { '.kukgit/workflows/nightly.yml': NIGHTLY.replace("on:\n  schedule:\n    cron: ['0 3 * * *']", 'on: push') });
  syncSchedules(context.db, context.config, { repository: context.repository, now });
  assert.equal(context.db.prepare('SELECT COUNT(*) AS count FROM workflow_schedules').get().count, 0);
});

test('a due schedule starts one run and moves to its next occurrence', (t) => {
  const context = setup(t);
  commit(context, {
    '.kukgit/workflows/nightly.yml': NIGHTLY,
    '.kukgit/workflows/other.yml': NIGHTLY.replace('nightly', 'other'),
  });
  syncSchedules(context.db, context.config, {
    repository: context.repository, now: new Date('2026-08-01T00:00:00Z'),
  });
  assert.equal(context.db.prepare('SELECT COUNT(*) AS count FROM workflow_schedules').get().count, 2);

  const fired = dispatchDueSchedules(context.db, context.config, { now: new Date('2026-08-01T03:00:00Z') });
  assert.equal(fired.length, 2);

  // Two schedules due in the same minute start two runs, not four: each row
  // dispatches only its own workflow.
  const runs = context.db.prepare("SELECT workflow_path AS path, event, ref, actor_id AS actorId FROM workflow_runs WHERE event = 'schedule'").all();
  assert.equal(runs.length, 2);
  assert.deepEqual(runs.map((run) => run.path).sort(), ['.kukgit/workflows/nightly.yml', '.kukgit/workflows/other.yml']);
  assert.equal(runs[0].ref, 'refs/heads/main');
  // No actor: nobody asked for this at that moment, and naming whoever last
  // touched the file would put their name on work they did not start.
  assert.equal(runs[0].actorId, null);

  const row = context.db.prepare('SELECT next_due_at AS nextDueAt, last_fired_at AS lastFiredAt FROM workflow_schedules LIMIT 1').get();
  assert.equal(row.nextDueAt, '2026-08-02T03:00:00.000Z');
  assert.equal(row.lastFiredAt, '2026-08-01T03:00:00.000Z');

  // An instance that was down overnight owes one run per schedule, not one per
  // minute it was asleep.
  const catchUp = dispatchDueSchedules(context.db, context.config, { now: new Date('2026-08-05T09:00:00Z') });
  assert.equal(catchUp.length, 2);
  assert.equal(
    context.db.prepare("SELECT COUNT(*) AS count FROM workflow_runs WHERE event = 'schedule'").get().count,
    4,
  );
});

test('a manual run needs the trigger declared, a real ref and declared inputs', (t) => {
  const context = setup(t);
  const sha = commit(context, { '.kukgit/workflows/deploy.yml': MANUAL, '.kukgit/workflows/nightly.yml': NIGHTLY });

  const started = dispatchManualRun(context.db, context.config, {
    repository: context.repository,
    workflowPath: '.kukgit/workflows/deploy.yml',
    ref: 'main',
    inputs: { environment: 'staging' },
    actorId: context.userId,
  });
  assert.equal(started.sha, sha);
  assert.equal(started.ref, 'refs/heads/main');
  // A declared default fills in for an input nobody supplied.
  assert.deepEqual(started.inputs.sort(), ['dry_run', 'environment']);
  assert.equal(getRun(context.db, started.runId).event, 'manual');

  const fails = (options, code) => {
    let thrown = null;
    try {
      dispatchManualRun(context.db, context.config, {
        repository: context.repository,
        workflowPath: '.kukgit/workflows/deploy.yml',
        ref: 'main',
        inputs: { environment: 'staging' },
        actorId: context.userId,
        ...options,
      });
    } catch (error) { thrown = error; }
    assert.ok(thrown, `expected ${code}`);
    assert.equal(thrown.code, code, thrown.message);
  };

  // A workflow that never asked to be started by hand is not started by hand.
  fails({ workflowPath: '.kukgit/workflows/nightly.yml' }, 'WORKFLOW_MANUAL_NOT_DECLARED');
  // The ref is resolved through Git rather than trusted as text.
  fails({ ref: 'no-such-branch' }, 'WORKFLOW_REF_NOT_FOUND');
  fails({ workflowPath: '.kukgit/workflows/absent.yml' }, 'WORKFLOW_NOT_FOUND');
  // An undeclared input would be an environment variable the file's author
  // never wrote, chosen by whoever pressed the button.
  fails({ inputs: { environment: 'staging', SECRET_OVERRIDE: 'x' } }, 'WORKFLOW_INPUT_UNKNOWN');
  fails({ inputs: { dry_run: 'false' } }, 'WORKFLOW_INPUT_REQUIRED');
});

test('a closed pull request gets exactly one closed run', (t) => {
  const context = setup(t);
  commit(context, { '.kukgit/workflows/ci.yml': [
    'on:',
    '  pull_request:',
    '    types: [opened, closed]',
    'jobs:',
    '  build:',
    '    runs-on: kukgit-linux',
    '    steps: [{run: echo hi}]',
  ].join('\n') });
  const headSha = commit(context, { 'feature.txt': 'work' }, { branch: 'feature', from: 'main' });

  const pullId = uid('pr');
  context.db.prepare(`
    INSERT INTO pull_requests (id, repository_id, number, title, base_branch, head_branch, status, author_id)
    VALUES (?, ?, 1, 'Add a feature', 'main', 'feature', 'merged', ?)
  `).run(pullId, context.repositoryId, context.userId);

  const first = dispatchClosedPullRequests(context.db, context.config, { repository: context.repository });
  assert.equal(first.length, 1);
  assert.equal(first[0].started.length, 1);

  const run = context.db.prepare("SELECT commit_sha AS sha, event_action AS action, ref FROM workflow_runs WHERE event = 'pull_request'").get();
  assert.equal(run.action, 'closed');
  assert.equal(run.ref, 'refs/heads/feature');
  // The run describes the commit the pull request proposed, not the base it
  // landed on.
  assert.equal(run.sha, headSha);

  // Asked as a question about state, so a second sweep is a no-op rather than a
  // second run — `event_action` is what makes the question answerable.
  assert.deepEqual(dispatchClosedPullRequests(context.db, context.config, { repository: context.repository }), []);
  assert.equal(context.db.prepare('SELECT COUNT(*) AS count FROM workflow_runs').get().count, 1);
});

test('manual dispatch needs repository write and a same-origin request', async (t) => {
  const context = setup(t);
  commit(context, { '.kukgit/workflows/deploy.yml': MANUAL });
  const target = '/api/repos/kuklabs/app/workflow-dispatch';
  const payload = { workflow: '.kukgit/workflows/deploy.yml', ref: 'main', inputs: { environment: 'staging' } };

  const anonymous = await request(context, target, { method: 'POST', body: payload });
  assert.equal(anonymous.status, 401);

  const reader = uid('usr');
  context.db.prepare("INSERT INTO users (id, email, password_hash, display_name) VALUES (?, 'reader@example.com', 'x$y', 'Reader')").run(reader);
  context.db.prepare(`
    INSERT INTO repository_collaborators (repository_id, user_id, permission, added_by)
    VALUES (?, ?, 'read', ?)
  `).run(context.repositoryId, reader, context.userId);

  // Starting a workflow runs the repository's own code with the repository's
  // own secrets, on a runner the organization owns. That is a write.
  const refused = await request(context, target, {
    method: 'POST', cookie: `kukgit_session=${createSession(context.db, reader).token}`, body: payload,
  });
  assert.equal(refused.status, 403);
  assert.equal(refused.payload.error.code, 'REPOSITORY_ACCESS_DENIED');

  const ownerCookie = `kukgit_session=${createSession(context.db, context.userId).token}`;
  const crossSite = await request(context, target, {
    method: 'POST', cookie: ownerCookie, body: payload, origin: 'https://evil.example',
  });
  assert.equal(crossSite.status, 403);
  assert.equal(crossSite.payload.error.code, 'CSRF_BLOCKED');
  assert.equal(context.db.prepare('SELECT COUNT(*) AS count FROM workflow_runs').get().count, 0);

  const started = await request(context, target, { method: 'POST', cookie: ownerCookie, body: payload });
  assert.equal(started.status, 201);
  assert.equal(getRun(context.db, started.payload.runId).event, 'manual');

  // The schedules listing is a read.
  const schedules = await request(context, '/api/repos/kuklabs/app/workflow-schedules', {
    cookie: `kukgit_session=${createSession(context.db, reader).token}`,
  });
  assert.equal(schedules.status, 200);
  assert.deepEqual(schedules.payload.schedules, []);
});
