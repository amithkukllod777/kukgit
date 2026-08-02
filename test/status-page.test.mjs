import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { openDatabase, seedCore, uid } from '../src/db.mjs';
import { hashPassword } from '../src/auth.mjs';
import {
  approveMaintenanceWindow,
  migrateMaintenanceWindows,
  scheduleMaintenanceWindow,
  startMaintenanceWindow,
} from '../src/maintenance-windows.mjs';
import {
  addIncidentUpdate,
  listIncidents,
  migrateStatusPage,
  publishIncident,
  renderStatusPage,
  statusSnapshot,
  writeStatusSnapshot,
} from '../src/status-page.mjs';

async function migrateEverything(db) {
  const dir = new URL('../src/', import.meta.url);
  const files = fs.readdirSync(dir).filter((name) => name.endsWith('.mjs')).sort();
  const deferred = [];
  for (const file of files) {
    let module;
    try { module = await import(new URL(file, dir).href); } catch { continue; }
    for (const [name, value] of Object.entries(module)) {
      if (!/^migrate[A-Z]/.test(name) || typeof value !== 'function' || value.length !== 1) continue;
      try { value(db); } catch { deferred.push(value); }
    }
  }
  for (const migrate of deferred) {
    try { migrate(db); } catch { /* not applicable */ }
  }
}

async function setup(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-status-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const config = loadConfig({
    dataDir,
    databasePath: path.join(dataDir, 'kukgit.db'),
    repositoriesDir: path.join(dataDir, 'repos'),
    tempDir: path.join(dataDir, 'tmp'),
    maintenancePath: path.join(dataDir, 'maintenance.json'),
    nodeEnv: 'test',
    adminEmail: 'owner@example.com',
    adminPassword: 'secure-owner-password',
    adminName: 'Owner',
  });
  const db = openDatabase(config);
  t.after(() => db.close());
  await migrateEverything(db);
  migrateMaintenanceWindows(db);
  migrateStatusPage(db);
  const { userId } = seedCore(db, config);
  const second = uid('usr');
  db.prepare('INSERT INTO users (id, email, password_hash, display_name) VALUES (?, ?, ?, ?)')
    .run(second, 'second@kuklabs.com', hashPassword('another-long-enough-password'), 'Second');
  return { config, db, userId, second, dataDir };
}

test('the banner is derived from what is open, never set by hand', async (t) => {
  const context = await setup(t);
  assert.equal(statusSnapshot(context.config, context.db).state, 'operational');

  const minor = publishIncident(context.db, {
    title: 'Slow repository search', severity: 'sev3', body: 'Search is returning results more slowly than usual.', userId: context.userId,
  });
  assert.equal(statusSnapshot(context.config, context.db).state, 'degraded');

  publishIncident(context.db, {
    title: 'Git pushes are failing', severity: 'sev1', body: 'Pushes over HTTPS are being rejected for all repositories.', userId: context.userId,
  });
  // A page that says "all systems operational" above an open SEV1 is worse than
  // no page, and that is what happens when the banner is a separate field.
  assert.equal(statusSnapshot(context.config, context.db).state, 'outage');

  addIncidentUpdate(context.db, { incidentId: minor.id, state: 'resolved', body: 'Search latency is back to normal.', userId: context.userId });
  assert.equal(statusSnapshot(context.config, context.db).state, 'outage', 'the SEV1 is still open');
});

test('an incident timeline is appended to, never rewritten', async (t) => {
  const context = await setup(t);
  const incident = publishIncident(context.db, {
    title: 'Webhook deliveries are delayed', severity: 'sev2', body: 'Deliveries are queued and have not been sent for ten minutes.', userId: context.userId,
  });
  addIncidentUpdate(context.db, {
    incidentId: incident.id, state: 'identified', body: 'A delivery worker stopped claiming its lease.', userId: context.userId,
  });
  const resolved = addIncidentUpdate(context.db, {
    incidentId: incident.id, state: 'resolved', body: 'The worker was restarted and the queue has drained.', userId: context.userId,
  });

  // Including the part that was wrong: the sequence of what was believed and
  // when is the thing anybody reads this for.
  assert.deepEqual(resolved.updates.map((update) => update.state), ['investigating', 'identified', 'resolved']);
  assert.equal(resolved.state, 'resolved');
  assert.ok(resolved.resolvedAt);
  assert.equal(listIncidents(context.db, { openOnly: true }).length, 0);
});

test('maintenance in progress shows on the page without an incident', async (t) => {
  const context = await setup(t);
  const window = scheduleMaintenanceWindow(context.db, {
    summary: 'PostgreSQL minor version upgrade',
    startsAt: new Date(Date.now() + 6 * 60_000).toISOString(),
    endsAt: new Date(Date.now() + 66 * 60_000).toISOString(),
    reason: 'the upgrade window agreed with the database vendor',
    userId: context.userId,
  });
  approveMaintenanceWindow(context.db, { id: window.id, userId: context.second });
  assert.equal(statusSnapshot(context.config, context.db).state, 'operational', 'scheduled is not the same as happening');

  startMaintenanceWindow(context.config, context.db, { id: window.id, userId: context.userId });
  const snapshot = statusSnapshot(context.config, context.db);
  assert.equal(snapshot.state, 'maintenance');
  assert.equal(snapshot.maintenance[0].summary, 'PostgreSQL minor version upgrade');
});

test('the page is one file that needs nothing else to render', async (t) => {
  const context = await setup(t);
  publishIncident(context.db, {
    title: 'Git pushes are failing', severity: 'sev1', body: 'Pushes over HTTPS are being rejected for all repositories.', userId: context.userId,
  });
  const html = renderStatusPage(statusSnapshot(context.config, context.db));

  // No stylesheet, script, font or image. A status page that needs the asset
  // pipeline of the thing it reports on goes down with it.
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /<link\b/i);
  assert.doesNotMatch(html, /https?:\/\//i);
  assert.match(html, /Major outage/);
  assert.match(html, /Pushes over HTTPS are being rejected/);
  // The limitation is on the page rather than only in the docs.
  assert.match(html, /cannot report a total\s+outage/);
});

test('operator prose is escaped rather than rendered', async (t) => {
  const context = await setup(t);
  publishIncident(context.db, {
    title: 'Investigating <script>alert(1)</script>',
    severity: 'sev2',
    body: 'A customer reported "quotes" & <b>markup</b> in an error message.',
    userId: context.userId,
  });
  const html = renderStatusPage(statusSnapshot(context.config, context.db));

  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /&lt;b&gt;markup&lt;\/b&gt;/);
});

test('an incident needs enough words to be worth reading', async (t) => {
  const context = await setup(t);
  assert.throws(() => publishIncident(context.db, { title: 'Down', body: 'A perfectly adequate first update.', userId: context.userId }), /at least 8 characters/);
  assert.throws(() => publishIncident(context.db, { title: 'Something is wrong', body: 'looking', userId: context.userId }), /at least 20 characters/);
  assert.throws(() => publishIncident(context.db, {
    title: 'Something is wrong', severity: 'sev9', body: 'A perfectly adequate first update.', userId: context.userId,
  }), /Severity must be one of/);
  // No incident was created by any of the refusals.
  assert.equal(listIncidents(context.db).length, 0);
});

test('a snapshot can be written for hosting somewhere else', async (t) => {
  const context = await setup(t);
  publishIncident(context.db, {
    title: 'Git pushes are failing', severity: 'sev1', body: 'Pushes over HTTPS are being rejected for all repositories.', userId: context.userId,
  });
  const target = path.join(context.dataDir, 'public-status');
  const written = writeStatusSnapshot(context.config, context.db, target);

  assert.equal(written.state, 'outage');
  // Two ordinary files, pushable to object storage on a schedule — which is the
  // only way a status page reports that the instance itself is gone.
  assert.deepEqual(written.files, ['status.json', 'index.html']);
  const snapshot = JSON.parse(fs.readFileSync(path.join(target, 'status.json'), 'utf8'));
  assert.equal(snapshot.state, 'outage');
  assert.equal(snapshot.incidents[0].updates.length, 1);
  assert.match(fs.readFileSync(path.join(target, 'index.html'), 'utf8'), /Major outage/);
});
