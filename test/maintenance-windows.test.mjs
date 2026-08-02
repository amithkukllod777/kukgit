import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { openDatabase, seedCore, uid } from '../src/db.mjs';
import { hashPassword } from '../src/auth.mjs';
import { createMaintenanceGuard, getMaintenanceState } from '../src/backups.mjs';
import {
  approveMaintenanceWindow,
  cancelMaintenanceWindow,
  endMaintenanceWindow,
  listMaintenanceWindows,
  migrateMaintenanceWindows,
  scheduleMaintenanceWindow,
  startMaintenanceWindow,
} from '../src/maintenance-windows.mjs';

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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-maint-'));
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
  const { userId: firstOperator } = seedCore(db, config);
  const secondOperator = uid('usr');
  db.prepare('INSERT INTO users (id, email, password_hash, display_name) VALUES (?, ?, ?, ?)')
    .run(secondOperator, 'second@kuklabs.com', hashPassword('another-long-enough-password'), 'Second');
  return { config, db, firstOperator, secondOperator };
}

function hoursFromNow(hours) {
  return new Date(Date.now() + hours * 3600_000).toISOString();
}

function schedule(context, options = {}) {
  return scheduleMaintenanceWindow(context.db, {
    summary: 'PostgreSQL minor version upgrade',
    startsAt: hoursFromNow(48),
    endsAt: hoursFromNow(49),
    userId: context.firstOperator,
    ...options,
  });
}

test('a window with short notice is not a planned window, whatever it is called', async (t) => {
  const context = await setup(t);
  const planned = schedule(context);
  assert.equal(planned.kind, 'planned');
  assert.ok(planned.noticeMinutes >= 24 * 60);

  // Relabelled rather than refused. A rule that said no would be worked around
  // by whoever has to fix something tonight, and the honest record would be the
  // first thing lost.
  const soon = schedule(context, {
    startsAt: hoursFromNow(2), endsAt: hoursFromNow(3), reason: 'the connection pool is exhausting every ten minutes',
  });
  assert.equal(soon.kind, 'expedited');
  assert.throws(
    () => schedule(context, { startsAt: hoursFromNow(4), endsAt: hoursFromNow(5) }),
    /reason of at least 20 characters/,
  );
});

test('one operator cannot approve their own window', async (t) => {
  const context = await setup(t);
  const window = schedule(context);

  // The failure this guards against is not malice; it is one tired person at
  // 2am with the wrong window open.
  assert.throws(
    () => approveMaintenanceWindow(context.db, { id: window.id, userId: context.firstOperator }),
    /different operator/,
  );
  const approved = approveMaintenanceWindow(context.db, { id: window.id, userId: context.secondOperator });
  assert.equal(approved.status, 'approved');
});

test('maintenance mode cannot be entered except through an approved window', async (t) => {
  const context = await setup(t);
  const window = schedule(context, {
    startsAt: hoursFromNow(0.1), endsAt: hoursFromNow(1), reason: 'the connection pool is exhausting every ten minutes',
  });

  assert.throws(
    () => startMaintenanceWindow(context.config, context.db, { id: window.id, userId: context.firstOperator }),
    /not been approved/,
  );
  assert.equal(getMaintenanceState(context.config).enabled, false);

  approveMaintenanceWindow(context.db, { id: window.id, userId: context.secondOperator });
  const started = startMaintenanceWindow(context.config, context.db, { id: window.id, userId: context.firstOperator });
  assert.equal(started.status, 'in_progress');
  assert.equal(getMaintenanceState(context.config).enabled, true);
  assert.equal(getMaintenanceState(context.config).reason, 'PostgreSQL minor version upgrade');
});

test('an approved window is not a licence to start whenever', async (t) => {
  const context = await setup(t);
  const window = schedule(context, { startsAt: hoursFromNow(48), endsAt: hoursFromNow(49) });
  approveMaintenanceWindow(context.db, { id: window.id, userId: context.secondOperator });

  // Otherwise a window approved for next month lets the instance be taken down
  // today with everybody's agreement on record for something else.
  assert.throws(
    () => startMaintenanceWindow(context.config, context.db, { id: window.id, userId: context.firstOperator }),
    /cannot start before/,
  );
  assert.equal(getMaintenanceState(context.config).enabled, false);
});

test('the record shows planned against actual', async (t) => {
  const context = await setup(t);
  const window = schedule(context, {
    startsAt: hoursFromNow(0.1), endsAt: hoursFromNow(1.1), reason: 'the connection pool is exhausting every ten minutes',
  });
  approveMaintenanceWindow(context.db, { id: window.id, userId: context.secondOperator });
  startMaintenanceWindow(context.config, context.db, { id: window.id, userId: context.firstOperator });

  const ended = endMaintenanceWindow(context.config, context.db, { id: window.id, userId: context.firstOperator });
  assert.equal(ended.status, 'completed');
  assert.equal(ended.plannedMinutes, 60);
  // "We were down for twenty minutes" should be checkable rather than
  // remembered.
  assert.equal(typeof ended.actualMinutes, 'number');
  assert.equal(getMaintenanceState(context.config).enabled, false);
});

test('ending a window works while the instance is in maintenance mode', async (t) => {
  const context = await setup(t);
  const window = schedule(context, {
    startsAt: hoursFromNow(0.1), endsAt: hoursFromNow(1), reason: 'the connection pool is exhausting every ten minutes',
  });
  approveMaintenanceWindow(context.db, { id: window.id, userId: context.secondOperator });
  startMaintenanceWindow(context.config, context.db, { id: window.id, userId: context.firstOperator });

  const seen = [];
  const guard = createMaintenanceGuard({ config: context.config, next: async (req) => { seen.push(req.url); return true; } });
  const refused = [];
  const res = {
    writeHead(status) { refused.push(status); return this; },
    end() { return this; },
    setHeader() { return this; },
  };

  await guard({ method: 'POST', url: '/api/repos/acme/app/issues', headers: {} }, res);
  assert.deepEqual(refused, [503], 'ordinary writes are refused');

  // Refusing this would make maintenance mode a state the API can enter and not
  // leave, recoverable only by deleting a file on the box.
  await guard({ method: 'POST', url: `/api/instance-admin/maintenance/windows/${window.id}/end`, headers: {} }, res);
  assert.equal(seen.length, 1);
  assert.match(seen[0], /\/end$/);
});

test('two windows cannot claim the same hour', async (t) => {
  const context = await setup(t);
  schedule(context, { startsAt: hoursFromNow(48), endsAt: hoursFromNow(50) });

  // Two overlapping windows means two people believe different things about
  // when the instance is down.
  assert.throws(
    () => schedule(context, { startsAt: hoursFromNow(49), endsAt: hoursFromNow(51) }),
    /overlaps window/,
  );
  // A cancelled one frees its slot.
  const later = schedule(context, { startsAt: hoursFromNow(72), endsAt: hoursFromNow(73) });
  cancelMaintenanceWindow(context.db, { id: later.id, userId: context.firstOperator });
  assert.ok(schedule(context, { startsAt: hoursFromNow(72), endsAt: hoursFromNow(73) }));
});

test('customers are shown what is coming, not what is over', async (t) => {
  const context = await setup(t);
  const upcoming = schedule(context, { startsAt: hoursFromNow(48), endsAt: hoursFromNow(49) });
  const past = schedule(context, {
    startsAt: hoursFromNow(-48), endsAt: hoursFromNow(-47), reason: 'an emergency restart of the delivery workers',
  });
  const cancelled = schedule(context, { startsAt: hoursFromNow(96), endsAt: hoursFromNow(97) });
  cancelMaintenanceWindow(context.db, { id: cancelled.id, userId: context.firstOperator });

  const announced = listMaintenanceWindows(context.db, { upcomingOnly: true }).map((window) => window.id);
  assert.deepEqual(announced, [upcoming.id]);
  assert.equal(listMaintenanceWindows(context.db).length, 3, 'operators still see all of it');
  assert.ok(past.noticeMinutes < 0);
});

test('a window that has already passed cannot be started', async (t) => {
  const context = await setup(t);
  const window = schedule(context, {
    startsAt: hoursFromNow(-4), endsAt: hoursFromNow(-3), reason: 'a window that was scheduled and then forgotten',
  });
  approveMaintenanceWindow(context.db, { id: window.id, userId: context.secondOperator });

  assert.throws(
    () => startMaintenanceWindow(context.config, context.db, { id: window.id, userId: context.firstOperator }),
    /already passed/,
  );
  assert.equal(getMaintenanceState(context.config).enabled, false);
});
