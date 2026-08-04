import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.mjs';
import { loadConfig } from '../src/config.mjs';
import { openDatabase, seedCore, uid } from '../src/db.mjs';
import { createBareRepository } from '../src/git.mjs';
import { forgetGitSizes } from '../src/usage.mjs';
import {
  closePeriod,
  instancePeriod,
  migrateUsageHistory,
  organizationPeriods,
  sampleUsage,
} from '../src/usage-history.mjs';
import { createUsageApiHandler } from '../src/usage-api.mjs';
import { instanceAdminEmails } from '../src/instance-admin-safe.mjs';

function workspace(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-history-'));
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
  migrateUsageHistory(db);
  const organization = db.prepare("SELECT id, slug FROM organizations WHERE slug = 'kuklabs'").get();
  return { config, db, organization };
}

/** Storage of a given size, so a sample has something to read. */
function fill(config, organization, slug, megabytes, db) {
  const owner = db.prepare('SELECT id FROM users LIMIT 1').get().id;
  const existing = db.prepare('SELECT id FROM repositories WHERE organization_id = ? AND slug = ?').get(organization.id, slug);
  if (!existing) {
    db.prepare('INSERT INTO repositories (id, organization_id, slug, name, created_by) VALUES (?, ?, ?, ?, ?)')
      .run(uid('repo'), organization.id, slug, slug, owner);
    createBareRepository(config, organization.slug, slug);
  }
  const target = path.join(config.repositoriesDir, organization.slug, `${slug}.git`, 'fill.pack');
  if (megabytes === 0) fs.rmSync(target, { force: true });
  else fs.writeFileSync(target, Buffer.alloc(megabytes * 1024 * 1024, 1));
  forgetGitSizes();
}

test('a period is closed on the peak, not on what is left at the end', async (t) => {
  const { config, db, organization } = workspace(t);

  // 60 MiB through the month...
  fill(config, organization, 'big', 60, db);
  sampleUsage(db, config, { now: new Date('2026-07-05T00:00:00Z') });
  sampleUsage(db, config, { now: new Date('2026-07-18T00:00:00Z') });
  // ...deleted on the 30th, which is the move this exists to defeat.
  fill(config, organization, 'big', 0, db);
  sampleUsage(db, config, { now: new Date('2026-07-30T00:00:00Z') });

  const result = closePeriod(db, config, { period: '2026-07', now: new Date('2026-08-02T00:00:00Z') });
  assert.equal(result.closed >= 1, true);

  const [period] = organizationPeriods(db, organization.id);
  assert.equal(period.period, '2026-07');
  assert.equal(period.samples, 3);
  assert.ok(period.storage.peakBytes >= 60 * 1024 * 1024, 'the peak was not kept');
  assert.ok(period.storage.lastBytes < 10 * 1024 * 1024, 'the last reading should be the empty one');
  // Both are kept, so a disputed invoice can be looked at rather than argued
  // about.
  assert.ok(period.storage.averageBytes > period.storage.lastBytes);
  assert.ok(period.storage.averageBytes < period.storage.peakBytes);
});

test('closing twice does not move a number somebody was invoiced for', async (t) => {
  const { config, db, organization } = workspace(t);
  fill(config, organization, 'one', 20, db);
  sampleUsage(db, config, { now: new Date('2026-07-10T00:00:00Z') });
  closePeriod(db, config, { period: '2026-07', now: new Date('2026-08-02T00:00:00Z') });
  const first = organizationPeriods(db, organization.id)[0];

  // More storage arrives, and another sample lands in the closed period.
  fill(config, organization, 'one', 90, db);
  sampleUsage(db, config, { now: new Date('2026-07-28T00:00:00Z') });
  const second = closePeriod(db, config, { period: '2026-07', now: new Date('2026-08-02T00:00:00Z') });

  assert.equal(second.closed, 0, 'a closed period must not be closed again');
  assert.deepEqual(organizationPeriods(db, organization.id)[0], first);
});

test('the running period is refused', async (t) => {
  const { config, db } = workspace(t);
  const now = new Date('2026-08-04T12:00:00Z');
  // A figure recorded while the month is open is not that month's figure, and
  // recording it would make the real one look like a correction.
  const result = closePeriod(db, config, { period: '2026-08', now });
  assert.equal(result.closed, 0);
  assert.match(result.skipped, /has not ended/);
});

test('by default it closes the month that just ended', async (t) => {
  const { config, db, organization } = workspace(t);
  sampleUsage(db, config, { now: new Date('2026-07-15T00:00:00Z') });
  const result = closePeriod(db, config, { now: new Date('2026-08-04T12:00:00Z') });
  assert.equal(result.period, '2026-07');
  assert.equal(organizationPeriods(db, organization.id)[0].period, '2026-07');
});

test('a period nobody sampled is recorded as unknown, not as nothing', async (t) => {
  const { config, db, organization } = workspace(t);
  fill(config, organization, 'quiet', 40, db);
  // No samples at all — the instance was down for the month, or the
  // organization was created after the last one.
  const result = closePeriod(db, config, { period: '2026-06', now: new Date('2026-07-01T00:00:00Z') });
  assert.equal(result.withoutSamples >= 1, true);

  const [period] = organizationPeriods(db, organization.id);
  assert.equal(period.samples, 0);
  // Reads as "we do not know", which is the difference between an unbilled
  // month and a month billed at zero.
  assert.equal(period.billable, false);
});

test('samples land in the period they were taken in', async (t) => {
  const { config, db, organization } = workspace(t);
  sampleUsage(db, config, { now: new Date('2026-06-20T00:00:00Z') });
  sampleUsage(db, config, { now: new Date('2026-07-20T00:00:00Z') });

  closePeriod(db, config, { period: '2026-06', now: new Date('2026-08-02T00:00:00Z') });
  closePeriod(db, config, { period: '2026-07', now: new Date('2026-08-02T00:00:00Z') });

  const periods = organizationPeriods(db, organization.id);
  assert.deepEqual(periods.map((entry) => entry.period), ['2026-07', '2026-06']);
  for (const entry of periods) assert.equal(entry.samples, 1);
});

test('the instance report totals the period and names what was not sampled', async (t) => {
  const { config, db, organization } = workspace(t);
  fill(config, organization, 'counted', 12, db);
  sampleUsage(db, config, { now: new Date('2026-07-11T00:00:00Z') });
  closePeriod(db, config, { period: '2026-07', now: new Date('2026-08-02T00:00:00Z') });

  const report = instancePeriod(db, '2026-07');
  assert.equal(report.period, '2026-07');
  assert.equal(report.totals.organizations, report.organizations.length);
  assert.equal(
    report.totals.storagePeakBytes,
    report.organizations.reduce((sum, entry) => sum + entry.storage.peakBytes, 0),
  );
  assert.equal(report.totals.unsampled, 0);
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

test('history is readable by a member and refused to everybody else', async (t) => {
  const context = workspace(t);
  sampleUsage(context.db, context.config, { now: new Date('2026-07-12T00:00:00Z') });
  closePeriod(context.db, context.config, { period: '2026-07', now: new Date('2026-08-02T00:00:00Z') });
  const { origin, cookie } = await server(t, context);

  const mine = await fetch(`${origin}/api/orgs/kuklabs/usage/history`, { headers: { Cookie: cookie } });
  assert.equal(mine.status, 200);
  assert.equal((await mine.json()).periods[0].period, '2026-07');

  assert.equal((await fetch(`${origin}/api/orgs/kuklabs/usage/history`)).status, 401);
  // Same as a organization that does not exist, so history cannot enumerate
  // customers either.
  assert.equal((await fetch(`${origin}/api/orgs/somebody-else/usage/history`, { headers: { Cookie: cookie } })).status, 404);
});

test('the operator history needs an operator, and defaults to the month that ended', async (t) => {
  const context = workspace(t);
  const { origin, cookie } = await server(t, context);

  const response = await fetch(`${origin}/api/instance-admin/usage/history`, { headers: { Cookie: cookie } });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.match(payload.period, /^\d{4}-\d{2}$/);
  assert.notEqual(payload.period, new Date().toISOString().slice(0, 7), 'the running month is not a bill');

  assert.equal((await fetch(`${origin}/api/instance-admin/usage/history`)).status, 401);
});

test('history is read-only', async (t) => {
  const context = workspace(t);
  const { origin, cookie } = await server(t, context);
  for (const method of ['POST', 'PUT', 'DELETE']) {
    const response = await fetch(`${origin}/api/orgs/kuklabs/usage/history`, { method, headers: { Cookie: cookie } });
    assert.equal(response.status, 405, `${method} was not refused`);
  }
});
