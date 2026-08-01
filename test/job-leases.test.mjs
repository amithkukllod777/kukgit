import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { openDatabase, seedCore } from '../src/db.mjs';
import {
  acquireLease,
  holdsLease,
  instanceId,
  leaseGate,
  leaseHolder,
  listLeases,
  migrateJobLeases,
  releaseLease,
  requeueStranded,
} from '../src/job-leases.mjs';
import { migrateNotifications, queueTransactionalEmail } from '../src/notifications.mjs';
import { migrateWebhooks } from '../src/webhooks.mjs';

function setup(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-leases-test-'));
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
  });
  fs.mkdirSync(config.repositoriesDir, { recursive: true });
  const db = openDatabase(config);
  t.after(() => db.close());
  migrateNotifications(db);
  migrateWebhooks(db);
  migrateJobLeases(db);
  const seeded = seedCore(db, config);
  return { config, db, ...seeded };
}

test('one instance wins a job and the other is simply told no', (t) => {
  const { db } = setup(t);
  const now = new Date('2026-08-01T00:00:00Z');

  assert.equal(acquireLease(db, 'email', { owner: 'a', now }), true);
  // Two instances that both read "free" would both send every queued message.
  assert.equal(acquireLease(db, 'email', { owner: 'b', now }), false);

  // Leases are per job, not per instance: email on one node, webhooks on another.
  assert.equal(acquireLease(db, 'webhooks', { owner: 'b', now }), true);
  assert.deepEqual(listLeases(db).map((lease) => [lease.job, lease.owner]), [['email', 'a'], ['webhooks', 'b']]);
});

test('a tick is the heartbeat, and holding time is preserved across renewals', (t) => {
  const { db } = setup(t);
  const start = new Date('2026-08-01T00:00:00Z');
  acquireLease(db, 'email', { owner: 'a', now: start });

  const renewed = new Date('2026-08-01T00:00:45Z');
  assert.equal(acquireLease(db, 'email', { owner: 'a', now: renewed }), true);
  const held = leaseHolder(db, 'email');
  // Acquiring and renewing are the same call, so there is no separate heartbeat
  // path that could stop while the work carries on.
  assert.equal(held.acquiredAt, start.toISOString(), 'an operator sees how long this node has held the job');
  assert.equal(held.heartbeatAt, renewed.toISOString());
  assert.equal(held.expiresAt, '2026-08-01T00:02:15.000Z');
});

test('an instance that stops heartbeating loses the job to another', (t) => {
  const { db } = setup(t);
  const start = new Date('2026-08-01T00:00:00Z');
  acquireLease(db, 'email', { owner: 'a', now: start });

  const beforeExpiry = new Date('2026-08-01T00:01:00Z');
  assert.equal(acquireLease(db, 'email', { owner: 'b', now: beforeExpiry }), false);
  assert.equal(holdsLease(db, 'email', { owner: 'a', now: beforeExpiry }), true);

  // The lease expires on its own, so losing an instance does not stop the work.
  const afterExpiry = new Date('2026-08-01T00:02:30Z');
  assert.equal(acquireLease(db, 'email', { owner: 'b', now: afterExpiry }), true);
  assert.equal(leaseHolder(db, 'email').acquiredAt, afterExpiry.toISOString(), 'a new holder resets the clock');

  // Fencing: the old owner can find out it no longer owns the job.
  assert.equal(holdsLease(db, 'email', { owner: 'a', now: afterExpiry }), false);
  assert.equal(releaseLease(db, 'email', 'a'), false, 'only the holder may release');
  assert.equal(releaseLease(db, 'email', 'b'), true);
});

test('the gate acquires, renews, fences and releases', (t) => {
  const { db } = setup(t);
  const mine = leaseGate(db, 'webhooks');
  const theirs = leaseGate(db, 'webhooks', { owner: 'other-instance' });

  assert.equal(mine(), true);
  assert.equal(mine.holds(), true);
  assert.equal(theirs(), false);
  assert.equal(theirs.holds(), false);
  assert.equal(leaseHolder(db, 'webhooks').owner, instanceId());

  mine.release();
  assert.equal(leaseHolder(db, 'webhooks'), null);
  // A gate that lost the job does not stop; it tries again and can win it back.
  assert.equal(theirs(), true);
  assert.equal(mine(), false);
});

test('a lease that cannot be read is not permission to run', (t) => {
  const { db } = setup(t);
  const gate = leaseGate(db, 'email');
  db.exec('DROP TABLE job_leases');

  // Failing open would turn a database blip into every instance working at
  // once, which is the one thing the lease exists to prevent.
  assert.equal(gate(), false);
  assert.deepEqual(listLeases(db), [], 'a missing table reads as "nothing is held", not as a fault');
});

test('stranded rows are reclaimed by age, never wholesale', (t) => {
  const { config, db } = setup(t);
  const stale = queueTransactionalEmail(db, config, { to: 'a@example.com', category: 'operations', subject: 'Old', text: 'Body.' });
  const live = queueTransactionalEmail(db, config, { to: 'b@example.com', category: 'operations', subject: 'New', text: 'Body.' });

  db.prepare("UPDATE email_outbox SET status = 'processing', updated_at = datetime('now', '-1 hour') WHERE id = ?").run(stale.id);
  // Claimed a second ago: another instance is sending this right now.
  db.prepare("UPDATE email_outbox SET status = 'processing', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(live.id);

  assert.equal(requeueStranded(db, { table: 'email_outbox' }), 1);
  const statusOf = (id) => db.prepare('SELECT status FROM email_outbox WHERE id = ?').get(id).status;
  assert.equal(statusOf(stale.id), 'pending');
  // Resetting this one would resurrect work another instance is performing, and
  // the recipient would get the message twice.
  assert.equal(statusOf(live.id), 'processing');

  assert.throws(() => requeueStranded(db, { table: 'email_outbox; DROP TABLE users' }), /fixed identifiers/);
});

test('a webhook delivery in flight survives another instance starting up', (t) => {
  const { db, userId, orgId } = setup(t);
  db.prepare(`
    INSERT INTO repositories (id, organization_id, slug, name, description, visibility, default_branch, created_by)
    VALUES ('repo_1', ?, 'app', 'App', '', 'private', 'main', ?)
  `).run(orgId, userId);
  db.prepare(`
    INSERT INTO repository_webhooks (id, repository_id, url, events_json, secret_ciphertext, secret_iv, secret_tag, created_by, updated_by)
    VALUES ('hook_1', 'repo_1', 'https://example.test/hook', '["push"]', 'x', 'y', 'z', ?, ?)
  `).run(userId, userId);
  db.prepare(`
    INSERT INTO webhook_deliveries (id, webhook_id, event, payload_json, status, next_attempt_at, updated_at)
    VALUES ('del_1', 'hook_1', 'push', '{}', 'processing', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run();

  // Migration used to reset every `processing` row, so a second instance
  // starting up resurrected a delivery the first was mid-send on — and the
  // endpoint received it twice.
  migrateWebhooks(db);
  assert.equal(db.prepare("SELECT status FROM webhook_deliveries WHERE id = 'del_1'").get().status, 'processing');

  db.prepare("UPDATE webhook_deliveries SET updated_at = datetime('now', '-1 hour') WHERE id = 'del_1'").run();
  assert.equal(requeueStranded(db, { table: 'webhook_deliveries', extraSet: 'next_attempt_at = CURRENT_TIMESTAMP' }), 1);
  assert.equal(db.prepare("SELECT status FROM webhook_deliveries WHERE id = 'del_1'").get().status, 'pending');
});
