import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.mjs';
import { loadConfig } from '../src/config.mjs';
import { openDatabase, seedCore, uid } from '../src/db.mjs';
import { createBareRepository, repoDiskPath } from '../src/git.mjs';
import { PLANS, against, planFor } from '../src/plans.mjs';
import { billingPeriod, exceeded, forgetGitSizes, instanceUsage, organizationUsage } from '../src/usage.mjs';
import { createUsageApiHandler } from '../src/usage-api.mjs';
import { instanceAdminEmails } from '../src/instance-admin-safe.mjs';

function workspace(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-usage-'));
  t.after(() => { fs.rmSync(dataDir, { recursive: true, force: true }); forgetGitSizes(); });
  const config = loadConfig({
    dataDir,
    databasePath: path.join(dataDir, 'test.db'),
    repositoriesDir: path.join(dataDir, 'repos'),
    tempDir: path.join(dataDir, 'tmp'),
    nodeEnv: 'test',
    adminEmail: 'operator@kuklabs.com',
    adminPassword: 'secure-test-password',
    adminName: 'Operator',
  });
  const db = openDatabase(config);
  t.after(() => db.close());
  seedCore(db, config);
  const organization = db.prepare("SELECT id, slug FROM organizations WHERE slug = 'kuklabs'").get();
  return { config, db, organization };
}

function addRepository(db, config, organization, slug, { archived = false, trashed = false } = {}) {
  const id = uid('repo');
  const owner = db.prepare('SELECT id FROM users LIMIT 1').get().id;
  db.prepare('INSERT INTO repositories (id, organization_id, slug, name, created_by) VALUES (?, ?, ?, ?, ?)')
    .run(id, organization.id, slug, slug, owner);
  if (archived) db.prepare("UPDATE repositories SET archived_at = datetime('now') WHERE id = ?").run(id);
  if (trashed) db.prepare("UPDATE repositories SET deleted_at = datetime('now') WHERE id = ?").run(id);
  createBareRepository(config, organization.slug, slug);
  return id;
}

test('a billing period is the calendar month in UTC', async () => {
  const period = billingPeriod(new Date('2026-08-04T18:30:00+05:30'));
  assert.equal(period.id, '2026-08');
  assert.equal(period.startsAt, '2026-08-01T00:00:00.000Z');
  assert.equal(period.endsAt, '2026-09-01T00:00:00.000Z');
  // 31 December in Mumbai is already January in UTC, and the invoice has to
  // land in exactly one month.
  assert.equal(billingPeriod(new Date('2026-12-31T23:00:00-05:00')).id, '2027-01');
});

test('an unknown plan falls back to free and says so', async (t) => {
  const { config, db, organization } = workspace(t);
  db.prepare('UPDATE organizations SET plan = ? WHERE id = ?').run('enterprise-gold', organization.id);

  const usage = organizationUsage(db, config, { organizationId: organization.id });
  // A plan string that no longer exists must not take somebody's Git hosting
  // down. It gives them the smallest plan, and the report says which string it
  // did not recognise rather than looking correct.
  assert.equal(usage.plan.id, 'free');
  assert.equal(usage.plan.recognised, false);
  assert.equal(usage.plan.stored, 'enterprise-gold');
  assert.equal(planFor('nonsense').id, 'free');
});

test('trashed and archived repositories still count, because they still occupy disk', async (t) => {
  const { config, db, organization } = workspace(t);
  addRepository(db, config, organization, 'active-one');
  addRepository(db, config, organization, 'archived-one', { archived: true });
  addRepository(db, config, organization, 'trashed-one', { trashed: true });

  const usage = organizationUsage(db, config, { organizationId: organization.id });
  // A delete that has not been purged is not a delete. Excluding trash from
  // the count is how somebody stores data for free forever.
  assert.equal(usage.storage.repositories.active, 1);
  assert.equal(usage.storage.repositories.archived, 1);
  assert.equal(usage.storage.repositories.trashed, 1);
  assert.equal(usage.storage.repositories.total, 3);
});

test('Git bytes are measured from the disk', async (t) => {
  const { config, db, organization } = workspace(t);
  addRepository(db, config, organization, 'measured');
  const before = organizationUsage(db, config, { organizationId: organization.id }).storage.gitBytes;

  const target = path.join(repoDiskPath(config, organization.slug, 'measured'), 'objects', 'pack');
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'big.pack'), Buffer.alloc(3 * 1024 * 1024, 7));
  forgetGitSizes();

  const after = organizationUsage(db, config, { organizationId: organization.id }).storage.gitBytes;
  assert.ok(after - before >= 3 * 1024 * 1024, `expected 3 MiB more, got ${after - before}`);
});

test('a symlink out of the tree is not billed to the customer', async (t) => {
  const { config, db, organization } = workspace(t);
  addRepository(db, config, organization, 'linky');
  const root = repoDiskPath(config, organization.slug, 'linky');
  const outside = path.join(config.dataDir, 'not-theirs.bin');
  fs.writeFileSync(outside, Buffer.alloc(2 * 1024 * 1024, 9));
  const before = organizationUsage(db, config, { organizationId: organization.id }).storage.gitBytes;

  fs.symlinkSync(outside, path.join(root, 'linked.bin'));
  forgetGitSizes();

  const after = organizationUsage(db, config, { organizationId: organization.id }).storage.gitBytes;
  // Following it would let anybody who can write a ref bill themselves for the
  // operating system — or, worse, for another tenant's repository.
  assert.equal(after, before);
});

test('one LFS object in two repositories is charged once, and the saving is shown', async (t) => {
  const { config, db, organization } = workspace(t);
  const first = addRepository(db, config, organization, 'lfs-one');
  const second = addRepository(db, config, organization, 'lfs-two');
  db.exec(`
    CREATE TABLE IF NOT EXISTS lfs_objects (oid TEXT PRIMARY KEY, size INTEGER NOT NULL, storage_path TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS repository_lfs_objects (repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE, oid TEXT NOT NULL REFERENCES lfs_objects(oid) ON DELETE CASCADE, PRIMARY KEY (repository_id, oid));
  `);
  db.prepare('INSERT INTO lfs_objects (oid, size, storage_path) VALUES (?, ?, ?)').run('a'.repeat(64), 10 * 1024 * 1024, 'a/a');
  db.prepare('INSERT INTO repository_lfs_objects (repository_id, oid) VALUES (?, ?)').run(first, 'a'.repeat(64));
  db.prepare('INSERT INTO repository_lfs_objects (repository_id, oid) VALUES (?, ?)').run(second, 'a'.repeat(64));

  const usage = organizationUsage(db, config, { organizationId: organization.id });
  assert.equal(usage.storage.lfsBytes, 10 * 1024 * 1024);
  assert.equal(usage.storage.lfsLinkedBytes, 20 * 1024 * 1024);
  // Both numbers, because the difference is what dedup is saving them and a
  // bill that hides it is a bill that looks arbitrary.
  assert.equal(usage.storage.lfsSavedBytes, 10 * 1024 * 1024);
});

test('CI minutes round up per job, and a job still running is already costing', async (t) => {
  const { config, db, organization } = workspace(t);
  const repository = addRepository(db, config, organization, 'ci-repo');
  const now = new Date('2026-08-04T12:00:00Z');
  db.exec(`
    CREATE TABLE IF NOT EXISTS workflow_runs (id TEXT PRIMARY KEY, repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS workflow_jobs (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE, started_at TEXT, completed_at TEXT);
  `);
  db.prepare('INSERT INTO workflow_runs (id, repository_id) VALUES (?, ?)').run('run_1', repository);
  const job = (id, started, completed) => db.prepare('INSERT INTO workflow_jobs (id, run_id, started_at, completed_at) VALUES (?, ?, ?, ?)').run(id, 'run_1', started, completed);
  job('job_1', '2026-08-04 10:00:00', '2026-08-04 10:00:30'); // 30s → 1 minute
  job('job_2', '2026-08-04 10:05:00', '2026-08-04 10:07:10'); // 2m10s → 3 minutes
  job('job_3', '2026-08-04 11:00:00', null); // running for an hour
  job('job_4', '2026-07-30 10:00:00', '2026-07-30 11:00:00'); // last month

  const usage = organizationUsage(db, config, { organizationId: organization.id, now });
  // 1 + 3 + 60. The running job counts: a workflow that has been going six
  // hours is six hours of machine, and showing zero until it ends is how a
  // runaway stays invisible until the invoice.
  assert.equal(usage.ci.minutes, 64);
  assert.equal(usage.ci.running, 1);
  assert.equal(usage.ci.jobs, 3, 'last month must not be in this period');
});

test('limits report over, remaining and ratio — and unlimited is not zero', async () => {
  assert.deepEqual(against(6, 5), { used: 6, limit: 5, ratio: 1.2, over: true, remaining: 0 });
  assert.deepEqual(against(2, 5), { used: 2, limit: 5, ratio: 0.4, over: false, remaining: 3 });
  // A percentage of no limit is meaningless, and an unlimited plan can never be
  // over. Returning 0 for either would make both look like a full bar.
  assert.deepEqual(against(9_000_000, null), { used: 9_000_000, limit: null, ratio: null, over: false, remaining: null });
  assert.equal(against(0, 0).over, false);
  assert.equal(against(1, 0).over, true);
});

test('exceeded names every limit that is over', async (t) => {
  const { config, db, organization } = workspace(t);
  db.prepare('UPDATE organizations SET plan = ? WHERE id = ?').run('free', organization.id);
  for (let index = 0; index <= PLANS.free.repositories; index += 1) {
    addRepository(db, config, organization, `repo-${index}`);
  }
  const usage = organizationUsage(db, config, { organizationId: organization.id });
  // Exactly at the limit is not over — the boundary is the whole point of a
  // limit, and off by one here is a customer blocked for being compliant.
  assert.equal(usage.limits.repositories.used, PLANS.free.repositories + 1);
  assert.deepEqual(exceeded(usage), ['repositories']);
});

async function server(t, { config, db }) {
  const usageApi = createUsageApiHandler({
    config,
    db,
    isInstanceAdmin: (settings, user) => instanceAdminEmails(settings).includes(String(user.email || '').toLowerCase()),
  });
  const app = createApp({ config, db });
  const node = http.createServer(async (req, res) => {
    if (await usageApi(req, res)) return;
    return app(req, res);
  });
  await new Promise((resolve) => node.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => node.close(resolve)));
  const origin = `http://127.0.0.1:${node.address().port}`;
  const login = await fetch(`${origin}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'operator@kuklabs.com', password: 'secure-test-password' }),
  });
  return { origin, cookie: login.headers.get('set-cookie').split(';')[0] };
}

test('usage is readable by a member and refused to everybody else', async (t) => {
  const context = workspace(t);
  const { origin, cookie } = await server(t, context);

  const mine = await fetch(`${origin}/api/orgs/kuklabs/usage`, { headers: { Cookie: cookie } });
  assert.equal(mine.status, 200);
  assert.equal((await mine.json()).usage.organization.slug, 'kuklabs');

  const signedOut = await fetch(`${origin}/api/orgs/kuklabs/usage`);
  assert.equal(signedOut.status, 401);

  // An organization somebody is not in must be indistinguishable from one that
  // does not exist — otherwise this endpoint enumerates customers.
  const other = await fetch(`${origin}/api/orgs/somebody-else/usage`, { headers: { Cookie: cookie } });
  assert.equal(other.status, 404);
});

test('a member who is not an owner can still see the usage they are asked to stay inside', async (t) => {
  const context = workspace(t);
  const { db } = context;
  const viewer = uid('usr');
  db.prepare('INSERT INTO users (id, email, password_hash, display_name) VALUES (?, ?, ?, ?)')
    .run(viewer, 'viewer@example.com', 'scrypt$x$y', 'Viewer');
  db.prepare('INSERT INTO org_members (organization_id, user_id, role) VALUES (?, ?, ?)')
    .run(context.organization.id, viewer, 'viewer');

  const usage = organizationUsage(context.db, context.config, { organizationId: context.organization.id });
  assert.equal(usage.people.seats, 2);
});

test('the instance report refuses a caller who is not an operator', async (t) => {
  const context = workspace(t);
  const { origin, cookie } = await server(t, context);

  const operator = await fetch(`${origin}/api/instance-admin/usage`, { headers: { Cookie: cookie } });
  assert.equal(operator.status, 200);
  const payload = await operator.json();
  assert.ok(payload.organizations.length >= 1);
  assert.equal(payload.totals.organizations, payload.organizations.length);

  assert.equal((await fetch(`${origin}/api/instance-admin/usage`)).status, 401);
});

test('the plan catalogue carries limits and no prices', async (t) => {
  const context = workspace(t);
  const { origin, cookie } = await server(t, context);
  const response = await fetch(`${origin}/api/plans`, { headers: { Cookie: cookie } });
  assert.equal(response.status, 200);
  const { plans } = await response.json();
  assert.deepEqual(plans.map((plan) => plan.id), ['free', 'team', 'business']);
  // Pricing is not decided in this file, and a number here would become the one
  // somebody quotes to a customer.
  assert.doesNotMatch(JSON.stringify(plans), /price|amount|currency|inr|usd/i);
  // `founder` is not purchasable: an enterprise agreement is a row somebody
  // sets, not a plan anybody can pick.
  assert.ok(!plans.some((plan) => plan.id === 'founder'));
});

test('nothing here can change a plan', async (t) => {
  const context = workspace(t);
  const { origin, cookie } = await server(t, context);
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const response = await fetch(`${origin}/api/orgs/kuklabs/usage`, { method, headers: { Cookie: cookie } });
    assert.equal(response.status, 405, `${method} was not refused`);
  }
  assert.equal(context.db.prepare('SELECT plan FROM organizations WHERE slug = ?').get('kuklabs').plan, 'founder');
});

test('the instance report totals what it lists', async (t) => {
  const { config, db, organization } = workspace(t);
  addRepository(db, config, organization, 'counted');
  const report = instanceUsage(db, config, {});
  const summed = report.organizations.reduce((total, entry) => total + entry.storage.totalBytes, 0);
  assert.equal(report.totals.storageBytes, summed);
  assert.equal(report.totals.seats, report.organizations.reduce((total, entry) => total + entry.people.seats, 0));
});
