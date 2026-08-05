import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { openDatabase, seedCore, uid } from '../src/db.mjs';
import {
  GRACE_DAYS,
  expireGracePeriods,
  forgetBillingProviders,
  ingestBillingEvent,
  migrateBilling,
  recordCancellationIntent,
  setBillingNotifier,
} from '../src/billing.mjs';
import { notifyBilling } from '../src/billing-notifications.mjs';
import {
  listNotifications,
  migrateNotifications,
  updateNotificationPreferences,
} from '../src/notifications.mjs';

function workspace(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-billmail-'));
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
  setBillingNotifier((database, payload) => notifyBilling(database, config, payload));
  const organization = db.prepare("SELECT id, slug, name FROM organizations WHERE slug = 'kuklabs'").get();
  return { config, db, organization };
}

/** Somebody else in the organization, at whatever role the test needs. */
async function addMember(db, { email, role }) {
  const { hashPassword } = await import('../src/auth.mjs');
  const organization = db.prepare("SELECT id FROM organizations WHERE slug = 'kuklabs'").get();
  const id = uid('usr');
  db.prepare('INSERT INTO users (id, email, display_name, password_hash) VALUES (?, ?, ?, ?)')
    .run(id, email, email.split('@')[0], hashPassword('secure-test-password'));
  db.prepare('INSERT INTO org_members (organization_id, user_id, role) VALUES (?, ?, ?)')
    .run(organization.id, id, role);
  return id;
}

function subscribe(db, organization, { status = 'active', eventId = 'seed', reference = 'sub_ABCDEFGHIJKLMN', periodEnd = '2026-09-01T00:00:00.000Z' } = {}) {
  return ingestBillingEvent(db, {
    provider: 'razorpay',
    providerEventId: `razorpay:${eventId}`,
    type: 'subscription.activated',
    change: { organizationId: organization.id, plan: 'team', status, reference, currentPeriodEnd: periodEnd },
  });
}

/** The queued mail itself. `listEmailOutbox` deliberately omits the body. */
function outbox(db) {
  return db.prepare('SELECT to_email AS toEmail, subject, text_body AS textBody FROM email_outbox ORDER BY created_at, id').all();
}

test('a failed payment is emailed to the people who can fix it', async (t) => {
  const { db, organization } = workspace(t);
  subscribe(db, organization);
  const developer = await addMember(db, { email: 'developer@kuklabs.com', role: 'developer' });
  const admin = await addMember(db, { email: 'admin@kuklabs.com', role: 'admin' });

  subscribe(db, organization, { status: 'past_due', eventId: 'failed' });

  const recipients = outbox(db).map((row) => row.toEmail).sort();
  // Owners and admins. A developer with push access did not agree to the
  // charge and cannot fix the card.
  assert.deepEqual(recipients, ['admin@kuklabs.com', 'operator@kuklabs.com']);
  assert.equal(listNotifications(db, developer).notifications.length, 0);
  assert.equal(listNotifications(db, admin).notifications.length, 1);
});

test('the failure email says how long they have and that nothing is lost', async (t) => {
  const { db, organization } = workspace(t);
  subscribe(db, organization);
  subscribe(db, organization, { status: 'past_due', eventId: 'failed' });

  const [email] = outbox(db);
  assert.match(email.subject, /Payment failed for Kuklabs/);
  const body = email.textBody;
  assert.match(body, new RegExp(`${GRACE_DAYS} days`));
  // The plan's label, not its identifier. "your team plan" reads like a typo
  // in a message somebody is already annoyed to be receiving.
  assert.match(body, /Team plan/);
  assert.doesNotMatch(body, /team plan/);
  // The first thing somebody reads this to find out.
  assert.match(body, /no repository is deleted and everything stays readable/);
});

test('a provider retrying does not send the same warning twice', async (t) => {
  const { db, organization } = workspace(t);
  subscribe(db, organization);
  subscribe(db, organization, { status: 'past_due', eventId: 'failed-1' });
  subscribe(db, organization, { status: 'past_due', eventId: 'failed-2' });
  subscribe(db, organization, { status: 'past_due', eventId: 'failed-3' });

  // A customer whose card fails three times in an hour has one problem. Three
  // identical emails about it makes it two.
  assert.equal(outbox(db).length, 1);
});

test('muting organization email does not mute a failed payment', async (t) => {
  const { db, organization } = workspace(t);
  const owner = db.prepare("SELECT id FROM users WHERE email = 'operator@kuklabs.com'").get().id;
  updateNotificationPreferences(db, owner, [{ category: 'organization', inAppEnabled: true, emailEnabled: false }]);
  subscribe(db, organization);

  subscribe(db, organization, { status: 'past_due', eventId: 'failed' });

  // Somebody who muted organization email did not thereby agree to stop being
  // told that a charge failed. This is a notice about money, not an update.
  assert.equal(outbox(db).length, 1);
});

test('a cancellation somebody scheduled can be turned off, and is by preference', async (t) => {
  const { db, organization } = workspace(t);
  const owner = db.prepare("SELECT id FROM users WHERE email = 'operator@kuklabs.com'").get().id;
  subscribe(db, organization);

  recordCancellationIntent(db, organization.id, { cancelsAt: '2026-09-01T00:00:00.000Z', provider: 'razorpay' });
  assert.equal(outbox(db).length, 1);
  assert.match(outbox(db)[0].subject, /will not renew/);
  // It says who could have done it, because a cancellation you did not make is
  // the one thing here worth acting on quickly.
  assert.match(outbox(db)[0].textBody, /If you did not expect this/);

  updateNotificationPreferences(db, owner, [{ category: 'organization', inAppEnabled: true, emailEnabled: false }]);
  recordCancellationIntent(db, organization.id, { cancelsAt: null, provider: 'razorpay', resumed: true });
  recordCancellationIntent(db, organization.id, { cancelsAt: '2026-10-01T00:00:00.000Z', provider: 'razorpay' });
  assert.equal(outbox(db).length, 1, 'an optional notice respects the preference');
});

test('resuming does not mail anybody', async (t) => {
  const { db, organization } = workspace(t);
  subscribe(db, organization);
  recordCancellationIntent(db, organization.id, { cancelsAt: '2026-09-01T00:00:00.000Z', provider: 'stripe' });
  const before = outbox(db).length;

  recordCancellationIntent(db, organization.id, { cancelsAt: null, provider: 'stripe', resumed: true });

  // Undoing your own click a moment later is not news for the whole admin list.
  assert.equal(outbox(db).length, before);
});

test('the grace period running out is told to somebody, at whatever hour', async (t) => {
  const { db, organization } = workspace(t);
  subscribe(db, organization);
  subscribe(db, organization, { status: 'past_due', eventId: 'failed' });
  db.prepare("UPDATE billing_subscriptions SET grace_until = '2026-01-01T00:00:00.000Z' WHERE organization_id = ?")
    .run(organization.id);

  const { expired } = expireGracePeriods(db, {});
  assert.equal(expired, 1);

  // A worker changed their plan an hour after midnight because a card expired
  // two weeks ago. Nobody is looking at a screen.
  const ending = outbox(db).find((row) => /moved to the free plan/.test(row.subject));
  assert.ok(ending, 'the plan change was emailed');
  assert.match(ending.textBody, /Nothing has been deleted/);
});

test('a subscription ending is told once, and not to an organization already free', async (t) => {
  const { db, organization } = workspace(t);
  subscribe(db, organization);
  ingestBillingEvent(db, {
    provider: 'razorpay',
    providerEventId: 'razorpay:ended',
    type: 'subscription.cancelled',
    change: { organizationId: organization.id, plan: 'team', status: 'canceled', reference: 'sub_ABCDEFGHIJKLMN' },
  });
  assert.equal(outbox(db).filter((row) => /subscription has ended/.test(row.subject)).length, 1);

  ingestBillingEvent(db, {
    provider: 'razorpay',
    providerEventId: 'razorpay:ended-again',
    type: 'subscription.expired',
    change: { organizationId: organization.id, plan: 'team', status: 'canceled', reference: 'sub_ABCDEFGHIJKLMN' },
  });
  // Already free. Telling somebody their subscription ended twice is telling
  // them once too many.
  assert.equal(outbox(db).filter((row) => /subscription has ended/.test(row.subject)).length, 1);
});

test('an organization the grace period already dropped is not told twice', async (t) => {
  const { db, organization } = workspace(t);
  subscribe(db, organization);
  subscribe(db, organization, { status: 'past_due', eventId: 'failed' });
  db.prepare("UPDATE billing_subscriptions SET grace_until = '2026-01-01T00:00:00.000Z' WHERE organization_id = ?")
    .run(organization.id);
  expireGracePeriods(db, {});
  assert.equal(outbox(db).filter((row) => /moved to the free plan/.test(row.subject)).length, 1);

  // The provider cancels after a failed charge, which is the normal sequence.
  // By then the customer already got the message that matters, and the second
  // one says the same thing about a plan they no longer have.
  ingestBillingEvent(db, {
    provider: 'razorpay',
    providerEventId: 'razorpay:after-grace',
    type: 'subscription.cancelled',
    change: { organizationId: organization.id, plan: 'team', status: 'canceled', reference: 'sub_ABCDEFGHIJKLMN' },
  });
  assert.equal(outbox(db).filter((row) => /subscription has ended/.test(row.subject)).length, 0);
});

test('a payment that worked is not an email', async (t) => {
  const { db, organization } = workspace(t);
  subscribe(db, organization);
  subscribe(db, organization, { eventId: 'charged-again' });
  // Mail nobody reads is mail that teaches people not to read the next one.
  // A charge that worked is on the invoice list.
  assert.equal(outbox(db).length, 0);
});

test('a notifier that throws does not stop the plan changing', async (t) => {
  const { db, organization } = workspace(t);
  subscribe(db, organization);
  setBillingNotifier(() => { throw new Error('the mail server is on fire'); });

  const result = subscribe(db, organization, { status: 'past_due', eventId: 'failed' });

  // Refusing the plan change because email is down is the more expensive
  // failure by far.
  assert.equal(result.outcome, 'applied');
  assert.equal(db.prepare('SELECT status FROM billing_subscriptions WHERE organization_id = ?').get(organization.id).status, 'past_due');
});

test('no notifier at all is a working instance', async (t) => {
  const { db, organization } = workspace(t);
  setBillingNotifier(null);
  subscribe(db, organization);
  const result = subscribe(db, organization, { status: 'past_due', eventId: 'failed' });
  assert.equal(result.outcome, 'applied');
  assert.equal(outbox(db).length, 0);
});

test('an organization that vanished mid-flight is not a crash', async (t) => {
  const { config, db } = workspace(t);
  assert.deepEqual(notifyBilling(db, config, { organizationId: 'org_gone', kind: 'payment_failed', plan: 'team' }), { sent: 0 });
});

test('nothing in a billing email is an offer', async (t) => {
  const { db, organization } = workspace(t);
  subscribe(db, organization);
  subscribe(db, organization, { status: 'past_due', eventId: 'failed' });
  recordCancellationIntent(db, organization.id, { cancelsAt: '2026-09-01T00:00:00.000Z', provider: 'razorpay' });

  for (const row of outbox(db)) {
    const text = `${row.subject} ${row.textBody}`;
    // The moment it reads like marketing it gets filtered like marketing, and
    // then the one that says "your card failed" is filtered too.
    assert.doesNotMatch(text, /act now|limited time|upgrade today|don't miss|special offer/i);
  }
});
