import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { openDatabase, seedCore, uid } from '../src/db.mjs';
import { migrateCollaboration } from '../src/collaboration.mjs';
import { migrateRepositoryAccess } from '../src/repository-access.mjs';
import { migrateIssueComments, addIssueComment } from '../src/issue-comments.mjs';
import {
  NOTIFICATION_CATEGORIES,
  migrateNotifications,
  notifyIssueComment,
  listNotifications,
  listEmailOutbox,
  updateNotificationPreferences,
} from '../src/notifications.mjs';

/**
 * Being told that somebody replied.
 *
 * Two separate things are proved here. The first is who gets told — a tracker
 * that mails the whole organization on every comment is a tracker whose
 * notifications everybody turns off, and the ones that mattered go with them.
 * The second is the schema change that made an `issue` category possible at
 * all: SQLite cannot alter a CHECK constraint, so the tables are rebuilt, and a
 * rebuild that loses a row or a foreign key is worse than no new category.
 */

const inbox = (space, userId) => listNotifications(space.db, userId).notifications;

function workspace(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-issue-notify-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
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
  migrateCollaboration(db);
  migrateRepositoryAccess(db);
  migrateIssueComments(db);
  migrateNotifications(db);

  const organization = db.prepare("SELECT id, slug FROM organizations WHERE slug = 'kuklabs'").get();
  const founder = db.prepare('SELECT id FROM users LIMIT 1').get();
  const repositoryId = uid('repo');
  db.prepare('INSERT INTO repositories (id, organization_id, slug, name, visibility, created_by) VALUES (?, ?, ?, ?, ?, ?)')
    .run(repositoryId, organization.id, 'thread', 'Thread', 'private', founder.id);
  const issueId = uid('iss');
  db.prepare('INSERT INTO issues (id, repository_id, number, title, body, author_id) VALUES (?, ?, 1, ?, ?, ?)')
    .run(issueId, repositoryId, 'Login is slow', 'It takes eight seconds.', founder.id);

  const member = (email, role = 'developer') => {
    const id = uid('user');
    db.prepare("INSERT INTO users (id, email, display_name, password_hash) VALUES (?, ?, ?, '')").run(id, email, email.split('@')[0]);
    db.prepare('INSERT INTO org_members (organization_id, user_id, role) VALUES (?, ?, ?)').run(organization.id, id, role);
    return id;
  };

  const comment = (authorId, body, extra = {}) => addIssueComment(db, { issueId, authorId, body, ...extra });
  const notify = (actorId, commentId) => notifyIssueComment(db, config, {
    orgSlug: 'kuklabs', repoSlug: 'thread', number: 1, actorId, commentId,
  });

  return { config, db, organization, founder, repositoryId, issueId, member, comment, notify };
}

test('the issue category exists and is off for email by default', async (t) => {
  const space = workspace(t);
  assert.ok(NOTIFICATION_CATEGORIES.includes('issue'));
  const rows = space.db.prepare("SELECT email_enabled AS email, in_app_enabled AS inApp FROM notification_preferences WHERE user_id = ? AND category = 'issue'")
    .get(space.founder.id);
  // In the bell, not in the inbox. A tracker sends more of these than
  // everything else here put together.
  assert.equal(rows.email, 0);
  assert.equal(rows.inApp, 1);
});

test('the people in the conversation are told, and the person who wrote it is not', async (t) => {
  const space = workspace(t);
  const priya = space.member('priya@kuklabs.com');
  const dev = space.member('dev@kuklabs.com');

  space.comment(priya, 'Reproduced on staging.');
  const commentId = space.comment(dev, 'Same on production.');
  const told = space.notify(dev, commentId);

  // The author of the issue and the earlier replier. Not the writer.
  assert.equal(told, 2);
  assert.equal(inbox(space, dev).length, 0);
  assert.equal(inbox(space, priya).length, 1);
  assert.match(inbox(space, space.founder.id)[0].title, /commented on #1 in thread/);
});

test('somebody with write access who has not joined in is left alone', async (t) => {
  const space = workspace(t);
  const bystander = space.member('bystander@kuklabs.com');
  const priya = space.member('priya@kuklabs.com');
  const commentId = space.comment(priya, 'Reproduced.');
  space.notify(priya, commentId);

  // They can write here, so a broadcast to everyone with write access would
  // have reached them. That is exactly the notification everybody mutes.
  assert.equal(inbox(space, bystander).length, 0);
});

test('the assignee is told even if they have never replied', async (t) => {
  const space = workspace(t);
  const owner = space.member('owner@kuklabs.com');
  space.db.prepare('UPDATE issues SET assignee_id = ? WHERE id = ?').run(owner, space.issueId);
  const priya = space.member('priya@kuklabs.com');
  const commentId = space.comment(priya, 'Any progress?');
  space.notify(priya, commentId);

  assert.equal(inbox(space, owner).length, 1);
});

test('importing a conversation does not subscribe the person who imported it', async (t) => {
  const space = workspace(t);
  const importer = space.member('importer@kuklabs.com');
  const priya = space.member('priya@kuklabs.com');
  // Every imported row is owned by the account that ran the import. Counting
  // those as participation would subscribe one person to every conversation
  // they carried across, on the strength of pressing a button once.
  space.comment(importer, 'Same here.', { importedAuthor: 'octocat', importedFrom: 'github.com/acme/thread' });

  const commentId = space.comment(priya, 'Still happening.');
  space.notify(priya, commentId);

  assert.equal(inbox(space, importer).length, 0);
  assert.equal(inbox(space, space.founder.id).length, 1);
});

test('a participant who has lost access is not told what the issue is called', async (t) => {
  const space = workspace(t);
  const removed = space.member('removed@kuklabs.com');
  const priya = space.member('priya@kuklabs.com');
  space.comment(removed, 'I looked at this.');
  // They were in the conversation last month. The repository is private and the
  // title of the issue is in the notification.
  space.db.prepare('DELETE FROM org_members WHERE user_id = ?').run(removed);

  const commentId = space.comment(priya, 'Fixed.');
  space.notify(priya, commentId);

  assert.equal(inbox(space, removed).length, 0);
  assert.equal(inbox(space, space.founder.id).length, 1);
});

test('each reply is its own notification, not a repeat of the first', async (t) => {
  const space = workspace(t);
  const priya = space.member('priya@kuklabs.com');
  space.notify(priya, space.comment(priya, 'One.'));
  space.notify(priya, space.comment(priya, 'Two.'));

  // Deduplicating by issue rather than by comment would make a conversation
  // look like it stopped after its first answer.
  assert.equal(inbox(space, space.founder.id).length, 2);
});

test('turning the issue category on sends email, and it is off until then', async (t) => {
  const space = workspace(t);
  const priya = space.member('priya@kuklabs.com');
  space.notify(priya, space.comment(priya, 'One.'));
  assert.equal(listEmailOutbox(space.db).emails.length, 0);

  updateNotificationPreferences(space.db, space.founder.id, [{ category: 'issue', inAppEnabled: true, emailEnabled: true }]);
  space.notify(priya, space.comment(priya, 'Two.'));

  const queued = listEmailOutbox(space.db).emails;
  assert.equal(queued.length, 1);
  assert.match(queued[0].subject, /\[thread\] #1 Login is slow/);
});

test('a comment on an issue that is not there is not an error', async (t) => {
  const space = workspace(t);
  assert.equal(notifyIssueComment(space.db, space.config, {
    orgSlug: 'kuklabs', repoSlug: 'thread', number: 99, actorId: space.founder.id, commentId: 'nope',
  }), 0);
});

/* ------------------------------------------------------------------ schema */

/**
 * Starts a database at the schema as it was before `issue` existed, so the
 * widening is exercised on real rows rather than on an empty table.
 */
function legacyDatabase(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-notify-legacy-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
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

  const OLD = "CHECK(category IN ('organization','security','pull_request','status','operations'))";
  db.exec(`
    CREATE TABLE notification_preferences (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      category TEXT NOT NULL ${OLD},
      in_app_enabled INTEGER NOT NULL DEFAULT 1 CHECK(in_app_enabled IN (0,1)),
      email_enabled INTEGER NOT NULL DEFAULT 0 CHECK(email_enabled IN (0,1)),
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, category)
    );
    CREATE TABLE notifications (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      category TEXT NOT NULL ${OLD},
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      link TEXT,
      dedupe_key TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      read_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, dedupe_key)
    );
    CREATE TABLE email_outbox (
      id TEXT PRIMARY KEY,
      user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      to_email TEXT NOT NULL,
      category TEXT NOT NULL ${OLD},
      subject TEXT NOT NULL,
      text_body TEXT NOT NULL,
      html_body TEXT,
      dedupe_key TEXT UNIQUE,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','sent','failed','cancelled')),
      attempt_count INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 8,
      next_attempt_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_attempt_at TEXT,
      sent_at TEXT,
      last_error TEXT,
      provider_response TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE email_delivery_attempts (
      id TEXT PRIMARY KEY,
      outbox_id TEXT NOT NULL REFERENCES email_outbox(id) ON DELETE CASCADE,
      attempt_number INTEGER NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('success','failure')),
      response_code INTEGER,
      response_text TEXT,
      error_message TEXT,
      started_at TEXT NOT NULL,
      completed_at TEXT NOT NULL
    );
    CREATE INDEX idx_email_attempts_outbox ON email_delivery_attempts(outbox_id, attempt_number DESC);
  `);

  const founder = db.prepare('SELECT id FROM users LIMIT 1').get();
  db.prepare("INSERT INTO notification_preferences (user_id, category, in_app_enabled, email_enabled) VALUES (?, 'security', 1, 1)").run(founder.id);
  db.prepare("INSERT INTO notifications (id, user_id, category, title, body, link, dedupe_key) VALUES ('n1', ?, 'security', 'A token expires', 'Soon', '#/settings', 'k1')").run(founder.id);
  db.prepare("INSERT INTO email_outbox (id, user_id, to_email, category, subject, text_body, status) VALUES ('o1', ?, 'founder@kuklabs.com', 'security', 'A token expires', 'Soon', 'sent')").run(founder.id);
  db.exec("INSERT INTO email_delivery_attempts (id, outbox_id, attempt_number, status, started_at, completed_at) VALUES ('a1', 'o1', 1, 'success', '2026-01-01 00:00:00', '2026-01-01 00:00:01')");

  return { config, db, founder };
}

test('the widening keeps every row it found', async (t) => {
  const legacy = legacyDatabase(t);
  migrateNotifications(legacy.db);

  assert.equal(legacy.db.prepare('SELECT COUNT(*) AS n FROM notifications').get().n, 1);
  assert.equal(legacy.db.prepare('SELECT COUNT(*) AS n FROM email_outbox').get().n, 1);
  // The one that goes first if the rebuild is done naively: renaming
  // `email_outbox` aside repoints this table's foreign key at the temporary
  // name, and dropping the temporary table then cascades these away.
  assert.equal(legacy.db.prepare('SELECT COUNT(*) AS n FROM email_delivery_attempts').get().n, 1);
  const preference = legacy.db.prepare("SELECT email_enabled AS email FROM notification_preferences WHERE user_id = ? AND category = 'security'").get(legacy.founder.id);
  assert.equal(preference.email, 1);
});

test('the widening leaves the foreign key pointing where it did', async (t) => {
  const legacy = legacyDatabase(t);
  migrateNotifications(legacy.db);

  const ddl = legacy.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'email_delivery_attempts'").get().sql;
  assert.match(ddl, /REFERENCES "?email_outbox"?\(id\)/);
  assert.ok(!ddl.includes('__old'), 'the foreign key still points at the temporary table');
  assert.deepEqual(legacy.db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('the widening puts the indexes back', async (t) => {
  const legacy = legacyDatabase(t);
  migrateNotifications(legacy.db);

  // A rebuilt table has no indexes, so they are created after the rebuild and
  // not in the same statement as the tables.
  const indexes = legacy.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%'").all().map((row) => row.name);
  for (const name of ['idx_notifications_user_created', 'idx_notifications_user_unread', 'idx_email_outbox_due', 'idx_email_attempts_outbox']) {
    assert.ok(indexes.includes(name), `missing ${name}`);
  }
});

test('the new category is accepted afterwards, and a made-up one still is not', async (t) => {
  const legacy = legacyDatabase(t);
  migrateNotifications(legacy.db);

  legacy.db.prepare("INSERT INTO notifications (id, user_id, category, title, body) VALUES ('n2', ?, 'issue', 'Someone replied', 'Login is slow')").run(legacy.founder.id);
  assert.equal(legacy.db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE category = 'issue'").get().n, 1);

  // The constraint is still a constraint. It was widened, not removed.
  assert.throws(() => legacy.db.prepare("INSERT INTO notifications (id, user_id, category, title, body) VALUES ('n3', ?, 'invented', 'x', 'y')").run(legacy.founder.id));
});

test('running the migration again changes nothing', async (t) => {
  const legacy = legacyDatabase(t);
  migrateNotifications(legacy.db);
  const before = legacy.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'notifications'").get().sql;
  migrateNotifications(legacy.db);
  migrateNotifications(legacy.db);
  const after = legacy.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'notifications'").get().sql;

  assert.equal(before, after);
  assert.equal(legacy.db.prepare('SELECT COUNT(*) AS n FROM email_delivery_attempts').get().n, 1);
  // And nothing is left lying around from a rebuild.
  const leftovers = legacy.db.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%__old'").all();
  assert.deepEqual(leftovers, []);
});
