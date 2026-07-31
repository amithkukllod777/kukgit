import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { openDatabase, seedCore, uid } from '../src/db.mjs';
import { createSession } from '../src/auth.mjs';
import { migrateNotifications, queueTransactionalEmail } from '../src/notifications.mjs';
import {
  collectOperationalHealth,
  createOperationsHealthApiHandler,
  readinessProbe,
} from '../src/operations-health.mjs';
import { migrateWebhooks } from '../src/webhooks.mjs';

function setup(t, overrides = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-ops-health-test-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const config = loadConfig({
    dataDir,
    databasePath: path.join(dataDir, 'kukgit.db'),
    repositoriesDir: path.join(dataDir, 'repos'),
    lfsDir: path.join(dataDir, 'lfs'),
    tempDir: path.join(dataDir, 'tmp'),
    backupsDir: path.join(dataDir, 'backups'),
    maintenancePath: path.join(dataDir, 'maintenance.json'),
    backupLockPath: path.join(dataDir, 'backup.lock'),
    nodeEnv: 'test',
    baseUrl: 'http://127.0.0.1:8787',
    adminEmail: 'owner@example.com',
    adminPassword: 'secure-owner-password',
    adminName: 'Owner',
    ...overrides,
  });
  for (const dir of [config.tempDir, config.backupsDir, config.repositoriesDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const db = openDatabase(config);
  t.after(() => db.close());
  migrateNotifications(db);
  migrateWebhooks(db);
  const seeded = seedCore(db, config);
  return { config, db, ...seeded };
}

function findSignal(health, name) {
  const found = health.signals.find((entry) => entry.name === name);
  assert.ok(found, `signal ${name} must be reported`);
  return found;
}

async function request(config, db, pathname, { cookie = '' } = {}) {
  const handler = createOperationsHealthApiHandler({ config, db });
  const server = http.createServer(async (req, res) => {
    if (await handler(req, res)) return;
    res.writeHead(404); res.end('{}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${pathname}`, {
      headers: cookie ? { Cookie: cookie } : {},
    });
    return { status: response.status, payload: await response.json().catch(() => ({})) };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('a healthy instance reports every saturation signal with its thresholds', (t) => {
  const { config, db } = setup(t);
  const health = collectOperationalHealth(config, db);

  assert.equal(health.format, 'kukgit-operations-health-v1');
  for (const name of ['email.backlog_depth', 'email.oldest_waiting_age', 'email.stuck_processing',
    'webhooks.backlog_depth', 'storage.database_bytes', 'backups.newest_age']) {
    const entry = findSignal(health, name);
    assert.equal(typeof entry.value, 'number');
    assert.ok(['ok', 'warning', 'critical'].includes(entry.state));
  }

  assert.equal(findSignal(health, 'email.backlog_depth').state, 'ok');
  assert.equal(findSignal(health, 'email.backlog_depth').value, 0);

  // Every worker is still an in-process interval, and the health output says so
  // rather than leaving an operator to discover it during an incident.
  assert.equal(health.instance.singleNode, true);
});

test('an instance that has never been backed up is critical, not quietly fine', (t) => {
  const { config, db } = setup(t);
  const health = collectOperationalHealth(config, db);
  const backups = findSignal(health, 'backups.newest_age');

  assert.equal(backups.state, 'critical');
  assert.match(backups.detail, /no snapshot has ever been taken/);
  assert.equal(health.status, 'critical');
  assert.ok(health.degraded.includes('backups.newest_age'));
});

test('queue depth and backlog age are reported separately', async (t) => {
  const { config, db } = setup(t, {
    saturationQueueDepthWarning: 2,
    saturationQueueDepthCritical: 4,
    saturationQueueAgeWarningSeconds: 60,
  });

  // A shallow queue is fine regardless of how old the instance is.
  queueTransactionalEmail(db, config, { to: 'a@example.com', category: 'operations', subject: 'One', text: 'Body.' });
  assert.equal(findSignal(collectOperationalHealth(config, db), 'email.backlog_depth').state, 'ok');

  queueTransactionalEmail(db, config, { to: 'b@example.com', category: 'operations', subject: 'Two', text: 'Body.' });
  queueTransactionalEmail(db, config, { to: 'c@example.com', category: 'operations', subject: 'Three', text: 'Body.' });
  const warned = collectOperationalHealth(config, db);
  assert.equal(findSignal(warned, 'email.backlog_depth').state, 'warning');
  assert.equal(findSignal(warned, 'email.backlog_depth').value, 3);

  queueTransactionalEmail(db, config, { to: 'd@example.com', category: 'operations', subject: 'Four', text: 'Body.' });
  queueTransactionalEmail(db, config, { to: 'e@example.com', category: 'operations', subject: 'Five', text: 'Body.' });
  const critical = collectOperationalHealth(config, db);
  assert.equal(findSignal(critical, 'email.backlog_depth').state, 'critical');
  assert.equal(critical.status, 'critical');

  // The queue is deep but nothing has been waiting long, so age stays clean —
  // that difference is what tells an operator whether the queue is draining.
  assert.equal(findSignal(critical, 'email.oldest_waiting_age').state, 'ok');
});

test('a message claimed by a worker that died is a fault at any count', (t) => {
  const { config, db } = setup(t);
  const queued = queueTransactionalEmail(db, config, {
    to: 'stuck@example.com', category: 'operations', subject: 'Stuck', text: 'Body.',
  });

  assert.equal(findSignal(collectOperationalHealth(config, db), 'email.stuck_processing').state, 'ok');

  // Claimed an hour ago and never completed: nothing in the system will retry it.
  db.prepare(`
    UPDATE email_outbox SET status = 'processing', updated_at = datetime('now', '-1 hour') WHERE id = ?
  `).run(queued.id);

  const stuck = findSignal(collectOperationalHealth(config, db), 'email.stuck_processing');
  assert.equal(stuck.value, 1);
  assert.equal(stuck.state, 'critical');
});

test('WebSocket capacity is reported against the configured cap when a server is attached', (t) => {
  const { config, db } = setup(t, { realtimeMaxConnections: 100 });
  const realtime = { stats: () => ({ activeConnections: 80 }) };

  const health = collectOperationalHealth(config, db, { realtime });
  const capacity = findSignal(health, 'realtime.connection_capacity');
  assert.equal(capacity.value, 80);
  assert.equal(capacity.state, 'warning');
  assert.match(capacity.detail, /80 of 100 sockets/);

  // Without a server attached the signal is absent rather than fabricated as zero.
  const detached = collectOperationalHealth(config, db);
  assert.equal(detached.signals.some((entry) => entry.name === 'realtime.connection_capacity'), false);
});

test('readiness reports the subsystems that make this instance serviceable', (t) => {
  const { config, db } = setup(t);
  const probe = readinessProbe(config, db);
  assert.equal(probe.ready, true);
  assert.deepEqual(probe.checks.map((check) => check.name).sort(),
    ['data_volume_writable', 'database', 'repository_storage']);

  fs.rmSync(config.repositoriesDir, { recursive: true, force: true });
  const degraded = readinessProbe(config, db);
  assert.equal(degraded.ready, false);
  assert.equal(degraded.checks.find((check) => check.name === 'repository_storage').ready, false);
});

test('the readiness probe is public but leaks no detail, and saturation requires an operator', async (t) => {
  const { config, db, userId } = setup(t);

  const ready = await request(config, db, '/api/health/ready');
  assert.equal(ready.status, 200);
  assert.deepEqual(ready.payload, { status: 'ready' });

  // A load balancer needs the status code; an attacker must not learn which
  // subsystem is failing.
  assert.equal(Object.keys(ready.payload).length, 1);

  const anonymous = await request(config, db, '/api/instance-admin/health');
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.payload.signals, undefined);

  // A signed-in user who is not an instance operator is refused too.
  const outsider = db.prepare('SELECT id FROM users WHERE id <> ?').get(userId)
    ?? { id: (() => {
      const id = uid('usr');
      db.prepare("INSERT INTO users (id, email, password_hash, display_name) VALUES (?, 'member@example.com', 'x$y', 'Member')").run(id);
      return id;
    })() };
  const memberSession = createSession(db, outsider.id);
  const refused = await request(config, db, '/api/instance-admin/health', { cookie: `kukgit_session=${memberSession.token}` });
  assert.equal(refused.status, 403);
  assert.equal(refused.payload.error.code, 'INSTANCE_ADMIN_REQUIRED');
  assert.equal(refused.payload.signals, undefined);

  const operatorSession = createSession(db, userId);
  const allowed = await request(config, db, '/api/instance-admin/health', { cookie: `kukgit_session=${operatorSession.token}` });
  assert.equal(allowed.status, 200);
  assert.ok(Array.isArray(allowed.payload.signals));
  assert.ok(allowed.payload.readiness.ready);
  assert.ok(allowed.payload.requestId);
});

test('the health payload carries no user data', (t) => {
  const { config, db } = setup(t);
  queueTransactionalEmail(db, config, {
    to: 'private-recipient@example.com', category: 'security', subject: 'Secret subject', text: 'Body.',
  });

  const serialized = JSON.stringify(collectOperationalHealth(config, db));
  assert.doesNotMatch(serialized, /private-recipient/);
  assert.doesNotMatch(serialized, /Secret subject/);
  assert.doesNotMatch(serialized, /owner@example\.com/);
});
