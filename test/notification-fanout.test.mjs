import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { openDatabase, seedCore, uid } from '../src/db.mjs';
import { migrateNotifications, queueTransactionalEmail } from '../src/notifications.mjs';
import {
  createFanoutReader,
  latestFanoutId,
  migrateNotificationFanout,
  pruneFanout,
  readFanoutSince,
} from '../src/notification-fanout.mjs';

function setup(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-fanout-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const config = loadConfig({
    dataDir,
    databasePath: path.join(dataDir, 'kukgit.db'),
    repositoriesDir: path.join(dataDir, 'repos'),
    tempDir: path.join(dataDir, 'tmp'),
    nodeEnv: 'test',
    adminEmail: 'owner@example.com',
    adminPassword: 'secure-owner-password',
    adminName: 'Owner',
  });
  const db = openDatabase(config);
  t.after(() => db.close());
  migrateNotifications(db);
  migrateNotificationFanout(db);
  const seeded = seedCore(db, config);
  return { config, db, ...seeded };
}

function notify(db, userId, body = 'Something happened') {
  const id = uid('ntf');
  db.prepare(`
    INSERT INTO notifications (id, user_id, category, title, body)
    VALUES (?, ?, 'operations', 'Test', ?)
  `).run(id, userId, body);
  return id;
}

test('a notification written on one connection is visible to another', (t) => {
  const { config, db, userId } = setup(t);

  // The second instance of a deployment: a separate connection to the same
  // volume. A TEMP trigger only fires for writes on the connection that created
  // it, which is why a notification written here never reached a socket there.
  const other = openDatabase(config);
  t.after(() => other.close());

  const reader = createFanoutReader(other, { autoStart: false, onEvents: () => {} });
  const seen = [];
  const watching = createFanoutReader(other, { autoStart: false, onEvents: (rows) => seen.push(...rows) });

  const notificationId = notify(db, userId);
  assert.equal(watching.tick().delivered, 1);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].userId, userId);
  assert.equal(seen[0].reason, 'created');
  assert.equal(seen[0].notificationId, notificationId);
  assert.ok(reader);
});

test('marking read and unread fans out as distinct reasons', (t) => {
  const { db, userId } = setup(t);
  const seen = [];
  const reader = createFanoutReader(db, { autoStart: false, onEvents: (rows) => seen.push(...rows) });

  const id = notify(db, userId);
  db.prepare("UPDATE notifications SET read_at = CURRENT_TIMESTAMP WHERE id = ?").run(id);
  db.prepare('UPDATE notifications SET read_at = NULL WHERE id = ?').run(id);
  // A write that does not change `read_at` is not an event.
  db.prepare("UPDATE notifications SET title = 'Renamed' WHERE id = ?").run(id);

  reader.tick();
  assert.deepEqual(seen.map((row) => row.reason), ['created', 'read', 'unread']);
});

test('a new instance starts from the newest row rather than replaying history', (t) => {
  const { db, userId } = setup(t);
  for (let index = 0; index < 5; index += 1) notify(db, userId);

  // A client fetches its inbox on connect, so everything from before this
  // instance was listening is already on screen. Replaying it would be a burst
  // of stale badges on every restart.
  const seen = [];
  const reader = createFanoutReader(db, { autoStart: false, onEvents: (rows) => seen.push(...rows) });
  assert.equal(reader.cursor(), latestFanoutId(db));
  assert.equal(reader.tick().delivered, 0);

  notify(db, userId);
  assert.equal(reader.tick().delivered, 1);
  assert.equal(seen.length, 1);
});

test('a burst is bounded and the rest arrives on the next tick', (t) => {
  const { db, userId } = setup(t);
  const reader = createFanoutReader(db, { autoStart: false, maxPerTick: 3, onEvents: () => {} });
  for (let index = 0; index < 7; index += 1) notify(db, userId);

  // One instance recovering from a pause must not push everything into a socket
  // in a single tick.
  assert.equal(reader.tick().delivered, 3);
  assert.equal(reader.tick().delivered, 3);
  assert.equal(reader.tick().delivered, 1);
  assert.equal(reader.tick().delivered, 0);
});

test('a failing poll is reported and retried, never thrown', (t) => {
  const { db, userId } = setup(t);
  const reader = createFanoutReader(db, {
    autoStart: false,
    onEvents: () => { throw new Error('socket layer exploded'); },
  });
  notify(db, userId);

  // The socket is an accelerator; the inbox is the delivery guarantee. A fan-out
  // failure must degrade to "the badge updates on reload", not to an error.
  const result = reader.tick();
  assert.match(result.error, /socket layer exploded/);
  assert.match(reader.stats().lastError, /socket layer exploded/);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM notifications').get().count, 1);
});

test('old rows are pruned without touching the inbox', (t) => {
  const { db, userId } = setup(t);
  notify(db, userId);
  notify(db, userId);
  db.prepare("UPDATE notification_fanout SET created_at = datetime('now', '-1 hour') WHERE id = 1").run();

  assert.equal(pruneFanout(db), 1);
  assert.equal(readFanoutSince(db, 0).length, 1);
  // The notification itself is what anybody reads later, and pruning a delivery
  // hint must never touch it.
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM notifications').get().count, 2);
});

test('a connection that never registered the server can still write notifications', (t) => {
  const { config, db, userId } = setup(t);
  // A backup, a script, the doctor. A trigger calling a function only the server
  // registers would turn `npm run seed` into a crash.
  const plain = openDatabase(config);
  t.after(() => plain.close());
  assert.doesNotThrow(() => notify(plain, userId));
  assert.equal(readFanoutSince(db, 0).length, 1);

  // And so can the ordinary email path, which writes through its own module.
  assert.doesNotThrow(() => queueTransactionalEmail(plain, config, {
    to: 'someone@example.com', category: 'operations', subject: 'Hello', text: 'Body.',
  }));
});
