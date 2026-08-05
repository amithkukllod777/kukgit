import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { openDatabase, seedCore } from '../src/db.mjs';
import {
  forgetBillingProviders,
  ingestBillingEvent,
  migrateBilling,
  setBillingNotifier,
} from '../src/billing.mjs';
import { notifyBilling } from '../src/billing-notifications.mjs';
import { DUNNING_STAGES, dunningStage, runDunning } from '../src/billing-dunning.mjs';
import { migrateNotifications } from '../src/notifications.mjs';

const DAY = 86_400_000;

function workspace(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-dunning-'));
  t.after(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
    forgetBillingProviders();
    setBillingNotifier(null);
  });
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
  migrateBilling(db);
  migrateNotifications(db);
  const organization = db.prepare("SELECT id, slug, name FROM organizations WHERE slug = 'kuklabs'").get();
  return { config, db, organization };
}

/** A subscription in grace, with the deadline the test wants. */
function failing(db, organization, { daysLeft = 10, eventId = 'failed' } = {}) {
  ingestBillingEvent(db, {
    provider: 'razorpay',
    providerEventId: `razorpay:${eventId}`,
    type: 'subscription.pending',
    change: { organizationId: organization.id, plan: 'team', status: 'past_due', reference: 'sub_ABCDEFGHIJKLMN' },
  });
  const graceUntil = new Date(Date.now() + daysLeft * DAY).toISOString();
  db.prepare('UPDATE billing_subscriptions SET grace_until = ? WHERE organization_id = ?')
    .run(graceUntil, organization.id);
  return graceUntil;
}

function outbox(db) {
  return db.prepare('SELECT to_email AS toEmail, subject, text_body AS textBody FROM email_outbox ORDER BY created_at, id').all();
}

function reminders(db) {
  return outbox(db).filter((row) => /changes (tomorrow|in \d+ days|shortly)/.test(row.subject));
}

function notifier(config) {
  return (db, payload) => notifyBilling(db, config, payload);
}

test('nothing is said while there is still time', async () => {
  const now = new Date('2026-08-05T00:00:00.000Z');
  assert.equal(dunningStage(new Date(now.getTime() + 13 * DAY).toISOString(), now), null);
  assert.equal(dunningStage(new Date(now.getTime() + 8 * DAY).toISOString(), now), null);
});

test('the stage is the most urgent one reached, not the one that was missed', async () => {
  const now = new Date('2026-08-05T00:00:00.000Z');
  assert.equal(dunningStage(new Date(now.getTime() + 7 * DAY).toISOString(), now).id, 'reminder');
  assert.equal(dunningStage(new Date(now.getTime() + 3 * DAY).toISOString(), now).id, 'reminder');
  // A worker that had not run for a week must send the final notice, not the
  // one it missed on day seven. A reminder that arrives after the deadline it
  // warns about is worse than none.
  assert.equal(dunningStage(new Date(now.getTime() + 2 * DAY).toISOString(), now).id, 'final');
  assert.equal(dunningStage(new Date(now.getTime() + 0.5 * DAY).toISOString(), now).id, 'final');
});

test('a deadline that has passed is nobody to remind', async () => {
  const now = new Date('2026-08-05T00:00:00.000Z');
  // The grace worker owns what happens then, and a reminder about a deadline
  // that has gone is a message about nothing.
  assert.equal(dunningStage(new Date(now.getTime() - DAY).toISOString(), now), null);
  assert.equal(dunningStage(null, now), null);
  assert.equal(dunningStage('not a date', now), null);
});

test('days left are rounded up, so nothing says "in 0 days"', async () => {
  const now = new Date('2026-08-05T00:00:00.000Z');
  assert.equal(dunningStage(new Date(now.getTime() + 1.2 * DAY).toISOString(), now).daysLeft, 2);
  assert.equal(dunningStage(new Date(now.getTime() + 0.1 * DAY).toISOString(), now).daysLeft, 1);
});

test('two reminders, not five', async () => {
  // The point is to be remembered. A message every day is a message that gets
  // a filter rule.
  assert.equal(DUNNING_STAGES.length, 2);
});

test('a reminder goes out when the deadline is close', async (t) => {
  const { config, db, organization } = workspace(t);
  failing(db, organization, { daysLeft: 5 });
  db.prepare('DELETE FROM email_outbox').run();

  const result = runDunning(db, { notify: notifier(config) });

  assert.deepEqual(result, { due: 1, sent: 1 });
  const [email] = reminders(db);
  assert.match(email.subject, /changes in 5 days/);
  assert.match(email.textBody, /moves to the free plan on/);
  // The thing they most need to know, in every message.
  assert.match(email.textBody, /nothing is deleted/);
});

test('an hourly worker does not send an hourly email', async (t) => {
  const { config, db, organization } = workspace(t);
  failing(db, organization, { daysLeft: 5 });
  db.prepare('DELETE FROM email_outbox').run();

  for (let hour = 0; hour < 24; hour += 1) runDunning(db, { notify: notifier(config) });

  assert.equal(reminders(db).length, 1);
});

test('the final notice is a different message, and is sent', async (t) => {
  const { config, db, organization } = workspace(t);
  failing(db, organization, { daysLeft: 5 });
  db.prepare('DELETE FROM email_outbox').run();
  runDunning(db, { notify: notifier(config) });

  db.prepare('UPDATE billing_subscriptions SET grace_until = ? WHERE organization_id = ?')
    .run(new Date(Date.now() + DAY).toISOString(), organization.id);
  runDunning(db, { notify: notifier(config) });

  const subjects = reminders(db).map((row) => row.subject);
  assert.equal(subjects.length, 2);
  // The last one before the plan changes should not read like the first.
  assert.ok(subjects.some((subject) => /tomorrow/.test(subject)), subjects.join(' | '));
});

test('the next failure gets the sequence again', async (t) => {
  const { config, db, organization } = workspace(t);
  failing(db, organization);
  db.prepare('DELETE FROM email_outbox').run();

  db.prepare("UPDATE billing_subscriptions SET grace_until = '2026-08-10T00:00:00.000Z' WHERE organization_id = ?")
    .run(organization.id);
  runDunning(db, { notify: notifier(config), now: new Date('2026-08-05T00:00:00.000Z') });
  assert.equal(reminders(db).length, 1);

  // A card that fails again next month: the same stage, a new deadline. The
  // deadline is part of the key, so the second failure is not silently
  // deduplicated against the first one a month earlier.
  db.prepare("UPDATE billing_subscriptions SET grace_until = '2026-09-10T00:00:00.000Z' WHERE organization_id = ?")
    .run(organization.id);
  runDunning(db, { notify: notifier(config), now: new Date('2026-09-05T00:00:00.000Z') });
  assert.equal(reminders(db).length, 2);
});

test('paying stops the reminders', async (t) => {
  const { config, db, organization } = workspace(t);
  failing(db, organization, { daysLeft: 3 });
  db.prepare('DELETE FROM email_outbox').run();

  ingestBillingEvent(db, {
    provider: 'razorpay',
    providerEventId: 'razorpay:paid',
    type: 'subscription.charged',
    change: { organizationId: organization.id, plan: 'team', status: 'active', reference: 'sub_ABCDEFGHIJKLMN' },
  });
  const result = runDunning(db, { notify: notifier(config) });

  // Only `past_due` is reminded. Chasing somebody who has already paid is the
  // fastest way to have every message from us ignored.
  assert.deepEqual(result, { due: 0, sent: 0 });
  assert.equal(reminders(db).length, 0);
});

test('a cancelled subscription is not chased', async (t) => {
  const { config, db, organization } = workspace(t);
  failing(db, organization, { daysLeft: 3 });
  db.prepare('DELETE FROM email_outbox').run();
  db.prepare("UPDATE billing_subscriptions SET status = 'canceled' WHERE organization_id = ?").run(organization.id);

  assert.deepEqual(runDunning(db, { notify: notifier(config) }), { due: 0, sent: 0 });
});

test('an instance with no notifier does no work', async (t) => {
  const { db, organization } = workspace(t);
  failing(db, organization, { daysLeft: 3 });
  assert.deepEqual(runDunning(db, {}), { due: 0, sent: 0 });
});

test('a database without the billing tables is not an hourly error', async (t) => {
  const { config } = workspace(t);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-dunning-bare-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const bare = openDatabase(loadConfig({
    dataDir,
    databasePath: path.join(dataDir, 'bare.db'),
    repositoriesDir: path.join(dataDir, 'repos'),
    tempDir: path.join(dataDir, 'tmp'),
    nodeEnv: 'test',
  }));
  t.after(() => bare.close());

  // Before the billing migration there is nothing to remind anybody about, and
  // that is not worth a log line every hour.
  assert.deepEqual(runDunning(bare, { notify: notifier(config) }), { due: 0, sent: 0 });
});

test('the reminder is not an offer either', async (t) => {
  const { config, db, organization } = workspace(t);
  failing(db, organization, { daysLeft: 2 });
  db.prepare('DELETE FROM email_outbox').run();
  runDunning(db, { notify: notifier(config) });

  for (const row of reminders(db)) {
    assert.doesNotMatch(`${row.subject} ${row.textBody}`, /act now|limited time|don't miss|special offer|last chance/i);
  }
});
