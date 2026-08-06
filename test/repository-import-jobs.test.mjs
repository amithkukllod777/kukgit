import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadConfig } from '../src/config.mjs';
import { openDatabase, seedCore, uid } from '../src/db.mjs';
import { createSession } from '../src/auth.mjs';
import { createBareRepository } from '../src/git.mjs';
import { PLANS } from '../src/plans.mjs';
import { forgetPlanUsage } from '../src/plan-limits.mjs';
import { forgetGitSizes } from '../src/usage.mjs';
import {
  cancelBulkImportJob,
  createBulkImportJob,
  importJobHasToken,
  importJobStatus,
  migrateRepositoryImportJobs,
  runBulkImportJob,
} from '../src/repository-import-jobs.mjs';
import { createBulkImportApiHandler } from '../src/repository-import-api.mjs';

/**
 * Importing a whole account's worth of repositories.
 *
 * The clone itself is the one part not exercised here — it needs a network and a
 * forge. What is exercised is everything that decides whether a forty-repository
 * import is usable: that one failure does not stop the other thirty-nine, that
 * the plan limit is still enforced partway through, that a skipped repository is
 * accounted for by name, and that the token does not outlive the job.
 */

function workspace(t, plan = 'pro') {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-bulk-'));
  t.after(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
    forgetPlanUsage();
    forgetGitSizes();
  });
  const config = loadConfig({
    dataDir,
    databasePath: path.join(dataDir, 'test.db'),
    repositoriesDir: path.join(dataDir, 'repos'),
    tempDir: path.join(dataDir, 'tmp'),
    nodeEnv: 'test',
    adminEmail: 'founder@kuklabs.com',
    adminPassword: 'secure-test-password',
    adminName: 'Founder',
  });
  const db = openDatabase(config);
  t.after(() => db.close());
  seedCore(db, config);
  migrateRepositoryImportJobs(db);
  const organization = db.prepare("SELECT id, slug FROM organizations WHERE slug = 'kuklabs'").get();
  db.prepare('UPDATE organizations SET plan = ? WHERE id = ?').run(plan, organization.id);
  const user = db.prepare('SELECT id FROM users LIMIT 1').get();
  return { config, db, organization, user, dataDir };
}

/**
 * A clone that succeeds, or one that does not.
 *
 * The real `importMirror` needs a network and a forge; what these tests are
 * about is the queue around it. `refuse` names the repositories whose clone
 * fails, so a failure can be placed in the middle of the list.
 */
function importer(refuse = []) {
  const cloned = [];
  return async (config, orgSlug, slug, sourceUrl, options) => {
    if (refuse.includes(slug)) throw Object.assign(new Error(`Import failed: no such repository ${sourceUrl}`), { status: 400 });
    cloned.push({ slug, sourceUrl, credential: options?.credential ?? null });
    // A real import leaves a bare repository behind, and the code under test
    // reads its branches straight afterwards.
    createBareRepository(config, orgSlug, slug);
    return null;
  };
}

test('the whole plan is recorded before anything is cloned, skips included', async (t) => {
  const { db, organization, user } = workspace(t);
  const jobId = createBulkImportJob(db, {
    organizationId: organization.id,
    userId: user.id,
    forge: 'github',
    owner: 'kuklabs',
    authenticated: true,
    note: null,
    selected: [{ name: 'alpha', slug: 'alpha', cloneUrl: 'https://example.com/alpha.git', private: true }],
    skipped: [{ name: 'a-fork', slug: 'a-fork', cloneUrl: 'https://example.com/a-fork.git', reason: 'it is a fork' }],
    token: 'github_pat_VALUE',
  });

  const status = importJobStatus(db, jobId);
  assert.equal(status.total, 2);
  assert.equal(status.counts.pending, 1);
  // Kept, not dropped. Somebody who expected forty and got thirty-nine needs
  // the fortieth accounted for by name, after the fact as well as before it.
  assert.equal(status.counts.skipped, 1);
  assert.equal(status.items.find((item) => item.name === 'a-fork').message, 'it is a fork');
});

test('a job with nothing to do is refused rather than started', async (t) => {
  const { db, organization, user } = workspace(t);
  assert.throws(
    () => createBulkImportJob(db, { organizationId: organization.id, userId: user.id, forge: 'github', owner: 'k', authenticated: false, selected: [], skipped: [] }),
    /Nothing here can be imported/,
  );
});

test('every repository is imported, and one failure does not stop the rest', async (t) => {
  const { config, db, organization, user, dataDir } = workspace(t);
  const jobId = createBulkImportJob(db, {
    organizationId: organization.id,
    userId: user.id,
    forge: 'github',
    owner: 'kuklabs',
    authenticated: false,
    selected: [
      { name: 'alpha', slug: 'alpha', cloneUrl: 'https://github.com/k/alpha.git', private: false },
      // The middle one cannot be cloned. The whole point of a bulk import is
      // that nobody is watching it, so it must not stop here.
      { name: 'beta', slug: 'beta', cloneUrl: 'https://github.com/k/beta.git', private: false },
      { name: 'gamma', slug: 'gamma', cloneUrl: 'https://github.com/k/gamma.git', private: false },
    ],
    skipped: [],
  });

  const status = await runBulkImportJob(db, config, jobId, { importRepository: importer(['beta']) });

  assert.equal(status.status, 'done');
  assert.equal(status.counts.imported, 2);
  assert.equal(status.counts.failed, 1);
  assert.deepEqual(
    status.items.filter((item) => item.status === 'imported').map((item) => item.slug),
    ['alpha', 'gamma'],
  );
  assert.match(status.items.find((item) => item.slug === 'beta').message, /Import failed/);

  // The rows exist, with a default branch read from what actually landed.
  const rows = db.prepare("SELECT slug, default_branch AS defaultBranch FROM repositories WHERE organization_id = ? AND slug IN ('alpha','beta','gamma') ORDER BY slug").all(organization.id);
  assert.deepEqual(rows.map((row) => `${row.slug}:${row.defaultBranch}`), ['alpha:main', 'gamma:main']);
  // And a failure left nothing on disk for the next attempt to trip over.
  assert.equal(fs.existsSync(path.join(config.repositoriesDir, 'kuklabs', 'beta.git')), false);
});

test('the plan limit is checked per repository, not once for the batch', async (t) => {
  const { config, db, organization, user, dataDir } = workspace(t, 'free');
  const owner = db.prepare('SELECT id FROM users LIMIT 1').get().id;
  // One short of the limit, so exactly one of the two below can be created.
  const existing = db.prepare('SELECT COUNT(*) AS count FROM repositories WHERE organization_id = ?').get(organization.id).count;
  for (let index = existing; index < PLANS.free.repositories - 1; index += 1) {
    const slug = `filler-${index}`;
    db.prepare('INSERT INTO repositories (id, organization_id, slug, name, created_by) VALUES (?, ?, ?, ?, ?)')
      .run(uid('repo'), organization.id, slug, slug, owner);
    createBareRepository(config, organization.slug, slug);
  }

  const jobId = createBulkImportJob(db, {
    organizationId: organization.id,
    userId: user.id,
    forge: 'github',
    owner: 'kuklabs',
    authenticated: false,
    selected: [
      { name: 'first', slug: 'first', cloneUrl: 'https://github.com/k/first.git', private: false },
      { name: 'second', slug: 'second', cloneUrl: 'https://github.com/k/second.git', private: false },
    ],
    skipped: [],
  });

  const status = await runBulkImportJob(db, config, jobId, { importRepository: importer() });

  // A job that takes an hour can cross the limit partway through. Checking once
  // at the start would let a whole batch land over the ceiling.
  assert.equal(status.counts.imported, 1);
  assert.equal(status.counts.failed, 1);
  assert.match(status.items.find((item) => item.slug === 'second').message, /plan|limit/i);
});

test('a private repository whose token has gone says so, rather than failing obscurely', async (t) => {
  const { config, db, organization, user, dataDir } = workspace(t);
  const jobId = createBulkImportJob(db, {
    organizationId: organization.id,
    userId: user.id,
    forge: 'github',
    owner: 'kuklabs',
    authenticated: true,
    // Marked private, and no token passed — which is what a process restart
    // mid-job looks like from here.
    selected: [{ name: 'secret', slug: 'secret', cloneUrl: 'https://github.com/k/secret.git', private: true }],
    skipped: [],
    token: null,
  });

  const status = await runBulkImportJob(db, config, jobId, { importRepository: importer() });
  assert.equal(status.counts.failed, 1);
  assert.match(status.items[0].message, /server restarted/);
  assert.match(status.items[0].message, /Start the import again/);
});

test('the token does not outlive the job', async (t) => {
  const { config, db, organization, user, dataDir } = workspace(t);
  const jobId = createBulkImportJob(db, {
    organizationId: organization.id,
    userId: user.id,
    forge: 'github',
    owner: 'kuklabs',
    authenticated: true,
    selected: [{ name: 'held', slug: 'held', cloneUrl: 'https://github.com/k/held.git', private: false }],
    skipped: [],
    token: 'github_pat_HELDVALUE',
  });

  assert.equal(importJobHasToken(jobId), true);
  await runBulkImportJob(db, config, jobId, { importRepository: importer() });
  // The credential's whole life is that function. Nothing was written down, so
  // nothing has to be cleaned up later or rotated.
  assert.equal(importJobHasToken(jobId), false);
});

test('cancelling stops what has not started and forgets the token', async (t) => {
  const { db, organization, user } = workspace(t);
  const jobId = createBulkImportJob(db, {
    organizationId: organization.id,
    userId: user.id,
    forge: 'github',
    owner: 'kuklabs',
    authenticated: true,
    selected: [
      { name: 'one', slug: 'one', cloneUrl: 'https://example.com/one.git', private: true },
      { name: 'two', slug: 'two', cloneUrl: 'https://example.com/two.git', private: true },
    ],
    skipped: [],
    token: 'github_pat_CANCELME',
  });

  const status = cancelBulkImportJob(db, jobId);
  assert.equal(status.status, 'cancelled');
  assert.equal(status.counts.pending, 0);
  assert.equal(status.counts.skipped, 2);
  assert.equal(status.items[0].message, 'cancelled before it started');
  assert.equal(importJobHasToken(jobId), false);
});

test("one organization cannot read another's import job", async (t) => {
  const { db, organization, user } = workspace(t);
  const jobId = createBulkImportJob(db, {
    organizationId: organization.id,
    userId: user.id,
    forge: 'github',
    owner: 'kuklabs',
    authenticated: false,
    selected: [{ name: 'x', slug: 'x', cloneUrl: 'https://example.com/x.git', private: false }],
    skipped: [],
  });
  // A job id is a repository list, and a repository list of a private
  // organization is not public information.
  assert.throws(() => importJobStatus(db, jobId, { organizationId: 'org_somebody_else' }), /not found/i);
});

async function server(t, { config, db, forgeHandler }) {
  const fetchImpl = async (url) => {
    const result = forgeHandler(url);
    return new Response(JSON.stringify(result.body ?? []), { status: result.status ?? 200, headers: { 'Content-Type': 'application/json' } });
  };
  const started = [];
  const api = createBulkImportApiHandler({
    config,
    db,
    fetchImpl,
    runJob: async (...args) => { started.push(args[2]); },
  });
  const httpServer = http.createServer(async (req, res) => {
    if (await api(req, res)) return;
    res.writeHead(404).end();
  });
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => httpServer.close(resolve)));
  const origin = `http://127.0.0.1:${httpServer.address().port}`;
  // This handler serves only /api/repository-imports, so a session is created
  // directly rather than through a login route it does not host.
  const signIn = (userId) => `kukgit_session=${createSession(db, userId).token}`;
  return { origin, started, signIn };
}

test('the API previews without importing, and starting answers before the work is done', async (t) => {
  const { config, db } = workspace(t);
  const forgeHandler = (url) => {
    if (url.endsWith('/user')) return { body: { login: 'someone-else' } };
    if (url.includes('/orgs/acme/repos')) {
      return {
        body: [
          { name: 'alpha', full_name: 'acme/alpha', clone_url: 'https://github.com/acme/alpha.git', private: true, size: 40, default_branch: 'main' },
          { name: 'a-fork', full_name: 'acme/a-fork', clone_url: 'https://github.com/acme/a-fork.git', fork: true, size: 40 },
        ],
      };
    }
    return { status: 404, body: { message: 'Not Found' } };
  };
  const { origin, started, signIn } = await server(t, { config, db, forgeHandler });
  const cookie = signIn(db.prepare('SELECT id FROM users LIMIT 1').get().id);

  const preview = await fetch(`${origin}/api/repository-imports/preview`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ orgSlug: 'kuklabs', forge: 'github', owner: 'acme', accessToken: 'github_pat_PREVIEW' }),
  });
  assert.equal(preview.status, 200);
  const previewBody = await preview.json();
  assert.deepEqual(previewBody.selected.map((entry) => entry.slug), ['alpha']);
  assert.equal(previewBody.skipped[0].reason, 'it is a fork');
  // A preview imports nothing and starts nothing.
  assert.deepEqual(started, []);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM repository_import_jobs').get().count, 0);
  // And it does not hand the token back.
  assert.equal(JSON.stringify(previewBody).includes('github_pat_PREVIEW'), false);

  const start = await fetch(`${origin}/api/repository-imports`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ orgSlug: 'kuklabs', forge: 'github', owner: 'acme', accessToken: 'github_pat_PREVIEW' }),
  });
  // 202: the clones take minutes, so the caller gets a job to watch rather than
  // a held connection.
  assert.equal(start.status, 202);
  const job = (await start.json()).job;
  assert.equal(job.counts.pending, 1);
  assert.deepEqual(started, [job.id]);

  const read = await fetch(`${origin}/api/repository-imports/${job.id}`, { headers: { Cookie: cookie } });
  assert.equal(read.status, 200);
  assert.equal((await read.json()).job.id, job.id);
});

test('a member without maintainer cannot start an import', async (t) => {
  const { config, db } = workspace(t);
  const { origin, signIn } = await server(t, { config, db, forgeHandler: () => ({ body: [] }) });
  const organization = db.prepare("SELECT id FROM organizations WHERE slug = 'kuklabs'").get();
  const viewerId = uid('user');
  db.prepare("INSERT INTO users (id, email, display_name, password_hash) VALUES (?, ?, ?, '')").run(viewerId, 'viewer@kuklabs.com', 'Viewer');
  db.prepare("INSERT INTO org_members (organization_id, user_id, role) VALUES (?, ?, 'viewer')").run(organization.id, viewerId);

  const response = await fetch(`${origin}/api/repository-imports`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: signIn(viewerId) },
    body: JSON.stringify({ orgSlug: 'kuklabs', forge: 'github', owner: 'acme' }),
  });

  // Importing creates repositories and spends the organization's plan.
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, 'FORBIDDEN');
});
