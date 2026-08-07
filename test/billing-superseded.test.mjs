import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { openDatabase, seedCore, uid } from '../src/db.mjs';
import { migrateBilling, ingestBillingEvent, subscriptionFor } from '../src/billing.mjs';
import {
  migrateBillingSuperseded,
  openSupersededSubscriptions,
  recordSupersededSubscription,
  resolveSupersededSubscription,
} from '../src/billing-superseded.mjs';
import {
  forgetCheckoutProviders,
  migrateBillingCheckout,
  registerCheckoutProvider,
  startCheckout,
} from '../src/billing-checkout.mjs';

/**
 * Two live subscriptions for one organization, which is two charges.
 *
 * `billing_subscriptions` is keyed on the organization, so a second provider
 * subscription does not sit beside the first — its activation *replaces* the
 * stored reference. The first keeps charging the customer's card, and `Cancel`
 * on the billing screen can only ever reach the newer of the two.
 *
 * Nothing stopped that happening: checkout never looked at whether the
 * organization already had a subscription, so somebody on Team who bought
 * Business paid for both until they noticed. These tests are the record of that
 * and of the two things that address it — checkout refusing the second
 * purchase, and a net underneath for the ways a second one can appear without
 * going through checkout at all.
 */

function workspace(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-superseded-'));
  t.after(() => { fs.rmSync(dataDir, { recursive: true, force: true }); forgetCheckoutProviders(); });
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
  migrateBillingCheckout(db);
  const organization = db.prepare("SELECT id, slug FROM organizations WHERE slug = 'kuklabs'").get();

  let events = 0;
  const activate = (plan, reference, status = 'active') => {
    events += 1;
    return ingestBillingEvent(db, {
      provider: 'razorpay',
      providerEventId: `evt_${events}`,
      type: 'subscription.activated',
      change: { organizationId: organization.id, plan, status, provider: 'razorpay', reference },
    });
  };

  return { config, db, organization, activate };
}

/* ------------------------------------------------------ the net underneath */

test('a replaced provider reference is written down rather than lost', async (t) => {
  const space = workspace(t);
  space.activate('team', 'sub_TeamFirst');
  space.activate('business', 'sub_BusinessSecond');

  // The stored subscription now points at the newer one, which is correct —
  // it is the one that reflects the plan they have.
  assert.equal(subscriptionFor(space.db, space.organization.id).reference, 'sub_BusinessSecond');

  // And the older one, which is still live at Razorpay and still charging, is
  // no longer reachable from `billing_subscriptions`. Without this row it would
  // exist nowhere in KukGit at all.
  const orphans = openSupersededSubscriptions(space.db);
  assert.equal(orphans.length, 1);
  assert.equal(orphans[0].reference, 'sub_TeamFirst');
  assert.equal(orphans[0].plan, 'team');
  assert.equal(orphans[0].replacedByReference, 'sub_BusinessSecond');
  assert.equal(orphans[0].organizationSlug, 'kuklabs');
});

test('the reference is in the audit trail, because it is what an operator types', async (t) => {
  const space = workspace(t);
  space.activate('team', 'sub_TeamFirst');
  space.activate('business', 'sub_BusinessSecond');

  const row = space.db.prepare("SELECT metadata_json AS metadata FROM audit_logs WHERE action = 'billing.subscription.superseded'").get();
  assert.ok(row, 'nothing was audited');
  // Not a secret — it is the identifier that finds the subscription still
  // charging somebody, in the provider's own dashboard.
  assert.match(row.metadata, /sub_TeamFirst/);
  assert.match(row.metadata, /sub_BusinessSecond/);
});

test('an ordinary event on the same subscription files nothing', async (t) => {
  const space = workspace(t);
  space.activate('team', 'sub_TeamFirst');
  // A renewal, a payment failure, a cancellation — every one of these arrives
  // with the same reference. Filing them would bury the one that matters.
  space.activate('team', 'sub_TeamFirst');
  space.activate('team', 'sub_TeamFirst', 'past_due');
  space.activate('team', 'sub_TeamFirst', 'canceled');

  assert.deepEqual(openSupersededSubscriptions(space.db), []);
});

test('an event with no reference at all does not orphan the one that is stored', async (t) => {
  const space = workspace(t);
  space.activate('team', 'sub_TeamFirst');
  // Some providers omit the reference on some events. `applyChange` keeps the
  // stored one in that case, so nothing has been replaced.
  space.activate('team', null, 'past_due');

  assert.deepEqual(openSupersededSubscriptions(space.db), []);
  assert.equal(subscriptionFor(space.db, space.organization.id).reference, 'sub_TeamFirst');
});

test('a retried replacement files one orphan, not five', async (t) => {
  const space = workspace(t);
  space.activate('team', 'sub_TeamFirst');
  space.activate('business', 'sub_BusinessSecond');
  // The provider retries. Each delivery is a distinct event id, so
  // deduplication by event id does not cover this — the uniqueness has to be on
  // the reference.
  recordSupersededSubscription(space.db, {
    organizationId: space.organization.id,
    provider: 'razorpay',
    previousReference: 'sub_TeamFirst',
    previousPlan: 'team',
    replacedByReference: 'sub_BusinessSecond',
    replacedByPlan: 'business',
  });

  assert.equal(openSupersededSubscriptions(space.db).length, 1);
});

test('the recorder guards itself, because it is exported and callable directly', async (t) => {
  const space = workspace(t);
  space.activate('team', 'sub_TeamFirst');
  const call = (previousReference, replacedByReference) => recordSupersededSubscription(space.db, {
    organizationId: space.organization.id, provider: 'razorpay',
    previousReference, previousPlan: 'team', replacedByReference, replacedByPlan: 'business',
  });

  // `applyChange` checks the same thing before calling. Both are deliberate:
  // the caller stops the common case cheaply, and this stops anything else that
  // ever calls it — the two are only redundant while there is one caller.
  assert.equal(call('sub_TeamFirst', 'sub_TeamFirst'), null, 'the same reference was filed as an orphan');
  assert.equal(call('sub_TeamFirst', null), null, 'a missing replacement was filed as an orphan');
  assert.equal(call(null, 'sub_Second'), null, 'a missing original was filed as an orphan');
  assert.deepEqual(openSupersededSubscriptions(space.db), []);

  assert.ok(call('sub_TeamFirst', 'sub_Second'), 'a real replacement was not filed');
});

test('it stays open until somebody says what happened to it', async (t) => {
  const space = workspace(t);
  space.activate('team', 'sub_TeamFirst');
  space.activate('business', 'sub_BusinessSecond');
  const [orphan] = openSupersededSubscriptions(space.db);

  // Nothing cancels it automatically. Cancelling a subscription KukGit has lost
  // track of, with no human looking, is how a paid plan ends because two events
  // arrived out of order.
  assert.equal(resolveSupersededSubscription(space.db, orphan.id, { resolution: '' }), false);
  assert.equal(openSupersededSubscriptions(space.db).length, 1);

  assert.equal(resolveSupersededSubscription(space.db, orphan.id, { resolution: 'Cancelled in the Razorpay dashboard; February refunded.' }), true);
  assert.deepEqual(openSupersededSubscriptions(space.db), []);
  // And resolving it twice is not a second resolution.
  assert.equal(resolveSupersededSubscription(space.db, orphan.id, { resolution: 'again' }), false);
});

test('deleting the organization takes its orphan records with it', async (t) => {
  const space = workspace(t);
  space.activate('team', 'sub_TeamFirst');
  space.activate('business', 'sub_BusinessSecond');
  space.db.prepare('DELETE FROM organizations WHERE id = ?').run(space.organization.id);

  assert.equal(space.db.prepare('SELECT COUNT(*) AS n FROM billing_superseded_subscriptions').get().n, 0);
});

/* --------------------------------------------------------- the actual fix */

function checkoutWorkspace(t) {
  const space = workspace(t);
  const created = [];
  registerCheckoutProvider('razorpay', {
    configured: () => true,
    create: async (db, config, { plan }) => {
      created.push(plan);
      return { url: `https://rzp.example/checkout/${plan}`, reference: `sub_new_${plan}` };
    },
  });
  return { ...space, created };
}

test('a second purchase is refused while a live subscription exists', async (t) => {
  const space = checkoutWorkspace(t);
  space.activate('team', 'sub_TeamFirst');

  await assert.rejects(
    () => startCheckout(space.db, space.config, { organization: space.organization, plan: 'business', provider: 'razorpay' }),
    (error) => {
      assert.equal(error.status, 409);
      assert.equal(error.code, 'BILLING_SUBSCRIPTION_ACTIVE');
      // The message has to say what to do, because the alternative the customer
      // will otherwise find is paying twice.
      assert.match(error.message, /Cancel it first/);
      return true;
    },
  );
  // Nothing was created at the provider, so there is nothing to clean up.
  assert.deepEqual(space.created, []);
  assert.deepEqual(openSupersededSubscriptions(space.db), []);
});

test('buying the plan they already have says so plainly', async (t) => {
  const space = checkoutWorkspace(t);
  space.activate('team', 'sub_TeamFirst');

  await assert.rejects(
    () => startCheckout(space.db, space.config, { organization: space.organization, plan: 'team', provider: 'razorpay' }),
    { code: 'BILLING_ALREADY_ON_PLAN' },
  );
  assert.deepEqual(space.created, []);
});

test('a lapsed customer can still buy, which is how they come back', async (t) => {
  const space = checkoutWorkspace(t);
  space.activate('team', 'sub_TeamFirst', 'canceled');
  const session = await startCheckout(space.db, space.config, { organization: space.organization, plan: 'team', provider: 'razorpay' });
  assert.match(session.url, /checkout\/team/);

  const other = checkoutWorkspace(t);
  other.activate('team', 'sub_TeamFirst', 'past_due');
  // Nothing is charging them during a failed payment, and refusing here would
  // leave the only way back through support.
  assert.ok(await startCheckout(other.db, other.config, { organization: other.organization, plan: 'business', provider: 'razorpay' }));
});

test('a subscription already ending at cycle end does not block a new one', async (t) => {
  const space = checkoutWorkspace(t);
  space.activate('team', 'sub_TeamFirst');
  space.db.prepare('UPDATE billing_subscriptions SET cancels_at = ? WHERE organization_id = ?')
    .run('2026-09-01T00:00:00.000Z', space.organization.id);

  // They have already said they want it gone, so the overlap is bounded and it
  // is their decision to make.
  const session = await startCheckout(space.db, space.config, { organization: space.organization, plan: 'business', provider: 'razorpay' });
  assert.match(session.url, /checkout\/business/);
});

test('an organization with no subscription buys as it always did', async (t) => {
  const space = checkoutWorkspace(t);
  const session = await startCheckout(space.db, space.config, { organization: space.organization, plan: 'team', provider: 'razorpay' });
  assert.match(session.url, /checkout\/team/);
  assert.deepEqual(space.created, ['team']);
});

test('the guard is on the subscription, not on the organization row', async (t) => {
  const space = checkoutWorkspace(t);
  // A `founder` organization has no subscription and never bought anything; the
  // plan column alone would have refused it.
  space.db.prepare("UPDATE organizations SET plan = 'founder' WHERE id = ?").run(space.organization.id);
  assert.ok(await startCheckout(space.db, space.config, { organization: space.organization, plan: 'team', provider: 'razorpay' }));
});

test('migrating twice is a no-op', async (t) => {
  const space = workspace(t);
  migrateBillingSuperseded(space.db);
  migrateBillingSuperseded(space.db);
  assert.equal(space.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'billing_superseded_subscriptions'").get().n, 1);
  assert.ok(uid('sup').startsWith('sup_'));
});

/* ------------------------------------------------ the operator can see it */

test('an orphan appears on the operator billing screen and can be closed', async (t) => {
  const { default: http } = await import('node:http');
  const { createApp } = await import('../src/app.mjs');
  const { createBillingApiHandler } = await import('../src/billing-api.mjs');
  const { createSession } = await import('../src/auth.mjs');

  const space = workspace(t);
  space.activate('team', 'sub_TeamFirst');
  space.activate('business', 'sub_BusinessSecond');

  let handler = () => {};
  const node = http.createServer((req, res) => handler(req, res));
  await new Promise((resolve) => node.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => node.close(resolve)));
  const origin = `http://127.0.0.1:${node.address().port}`;
  const settings = { ...space.config, baseUrl: origin };
  const api = createBillingApiHandler({ config: settings, db: space.db, isInstanceAdmin: () => true });
  const app = createApp({ config: settings, db: space.db });
  handler = async (req, res) => { if (await api(req, res)) return; return app(req, res); };

  const operator = space.db.prepare('SELECT id FROM users LIMIT 1').get();
  const cookie = `kukgit_session=${createSession(space.db, operator.id).token}`;
  const call = async (pathname, { method = 'GET', body } = {}) => {
    const response = await fetch(`${origin}${pathname}`, {
      method,
      headers: { Cookie: cookie, Origin: origin, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  };

  // Beside the rejected webhooks, which is the other list somebody opens this
  // screen to find.
  const events = await call('/api/instance-admin/billing/events');
  assert.equal(events.status, 200);
  assert.equal(events.body.superseded.length, 1);
  assert.equal(events.body.superseded[0].reference, 'sub_TeamFirst');

  const [orphan] = events.body.superseded;
  const empty = await call(`/api/instance-admin/billing/superseded/${orphan.id}/resolve`, { method: 'POST', body: {} });
  assert.equal(empty.status, 422);
  assert.equal(empty.body.error.code, 'BILLING_SUPERSEDED_RESOLUTION_REQUIRED');

  const closed = await call(`/api/instance-admin/billing/superseded/${orphan.id}/resolve`, {
    method: 'POST',
    body: { resolution: 'Cancelled at Razorpay, refund issued.' },
  });
  assert.equal(closed.status, 200);
  assert.deepEqual(closed.body.superseded, []);
});
