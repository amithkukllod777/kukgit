import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.mjs';
import { loadConfig } from '../src/config.mjs';
import { openDatabase, seedCore, uid } from '../src/db.mjs';
import {
  forgetBillingProviders,
  ingestBillingEvent,
  migrateBilling,
  registerBillingProvider,
  subscriptionFor,
} from '../src/billing.mjs';
import { createBillingApiHandler } from '../src/billing-api.mjs';
import { forgetCheckoutProviders, migrateBillingCheckout, registerCheckoutProvider } from '../src/billing-checkout.mjs';
import { requestCancellation, resumeSubscription, subscriptionActions } from '../src/billing-subscription.mjs';
import { razorpayCheckout } from '../src/billing-razorpay.mjs';
import { stripeAdapter, stripeCheckout } from '../src/billing-stripe.mjs';
import { migrateInstanceSettings, putInstanceSetting } from '../src/instance-settings.mjs';
import { instanceAdminEmails } from '../src/instance-admin-safe.mjs';

function workspace(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-cancel-'));
  t.after(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
    forgetCheckoutProviders();
    forgetBillingProviders();
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
    secretsEncryptionKey: 'k'.repeat(48),
  });
  const db = openDatabase(config);
  t.after(() => db.close());
  seedCore(db, config);
  migrateBilling(db);
  migrateInstanceSettings(db);
  migrateBillingCheckout(db);
  putInstanceSetting(db, config, { integration: 'billing.razorpay', field: 'keyId', value: 'rzp_test_keyid' });
  putInstanceSetting(db, config, { integration: 'billing.razorpay', field: 'keySecret', value: 'rzp_secret' });
  putInstanceSetting(db, config, { integration: 'billing.stripe', field: 'secretKey', value: 'sk_test_secret' });
  const organization = db.prepare("SELECT id, slug FROM organizations WHERE slug = 'kuklabs'").get();
  return { config, db, organization };
}

function recordingFetch(answer) {
  const calls = [];
  const impl = async (url, options) => {
    calls.push({ url, options });
    const reply = typeof answer === 'function' ? answer(calls.length) : answer;
    return new Response(JSON.stringify(reply.body ?? {}), {
      status: reply.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  impl.calls = calls;
  return impl;
}

/** An organization with a live subscription, recorded the way a webhook would. */
function subscribe(db, organization, { provider = 'razorpay', reference = 'sub_ABC', periodEnd = '2026-09-01T00:00:00.000Z' } = {}) {
  ingestBillingEvent(db, {
    provider,
    providerEventId: `${provider}:seed`,
    type: 'subscription.activated',
    change: { organizationId: organization.id, plan: 'team', status: 'active', reference, currentPeriodEnd: periodEnd },
  });
  return subscriptionFor(db, organization.id);
}

async function server(t, { config, db }) {
  let handler = () => {};
  const node = http.createServer((req, res) => handler(req, res));
  await new Promise((resolve) => node.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => node.close(resolve)));
  const origin = `http://127.0.0.1:${node.address().port}`;
  const settings = { ...config, baseUrl: origin };
  const api = createBillingApiHandler({
    config: settings,
    db,
    isInstanceAdmin: (given, user) => instanceAdminEmails(given).includes(String(user.email || '').toLowerCase()),
  });
  const app = createApp({ config: settings, db });
  handler = async (req, res) => {
    if (await api(req, res)) return;
    return app(req, res);
  };
  return { origin };
}

async function signIn(origin, email, password) {
  const login = await fetch(`${origin}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(login.status, 200);
  return login.headers.get('set-cookie').split(';')[0];
}

test('cancelling asks the provider to stop at the end of the paid cycle', async (t) => {
  const { config, db, organization } = workspace(t);
  registerCheckoutProvider('razorpay', razorpayCheckout);
  subscribe(db, organization);
  const fetchImpl = recordingFetch({ body: { id: 'sub_ABC', status: 'active', current_end: 1_788_000_000 } });

  const { subscription } = await requestCancellation(db, config, { organization, fetchImpl });

  const [call] = fetchImpl.calls;
  assert.match(call.url, /\/subscriptions\/sub_ABC\/cancel$/);
  // Not immediately. They bought this period, and taking it away the moment
  // they click is charging for something and then withdrawing it.
  assert.deepEqual(JSON.parse(call.options.body), { cancel_at_cycle_end: true });
  assert.equal(subscription.cancelsAt, new Date(1_788_000_000 * 1000).toISOString());
});

test('cancelling changes nothing about what the organization may do', async (t) => {
  const { config, db, organization } = workspace(t);
  registerCheckoutProvider('razorpay', razorpayCheckout);
  subscribe(db, organization);
  const before = db.prepare('SELECT plan FROM organizations WHERE id = ?').get(organization.id).plan;
  assert.equal(before, 'team');

  await requestCancellation(db, config, { organization, fetchImpl: recordingFetch({ body: { current_end: 1_788_000_000 } }) });

  // A cancellation is a thing that will happen, not a thing that has. What
  // moves them to free is the provider event when the period runs out.
  assert.equal(db.prepare('SELECT plan FROM organizations WHERE id = ?').get(organization.id).plan, 'team');
  assert.equal(subscriptionFor(db, organization.id).status, 'active');
});

test('a provider that does not say when leaves the period end', async (t) => {
  const { config, db, organization } = workspace(t);
  registerCheckoutProvider('razorpay', razorpayCheckout);
  subscribe(db, organization, { periodEnd: '2026-09-01T00:00:00.000Z' });

  const { subscription } = await requestCancellation(db, config, {
    organization, fetchImpl: recordingFetch({ body: { id: 'sub_ABC', status: 'active' } }),
  });
  // A cancellation with no date reads as "already gone", and their
  // repositories are still there.
  assert.equal(subscription.cancelsAt, '2026-09-01T00:00:00.000Z');
});

test('cancelling twice does not cancel twice', async (t) => {
  const { config, db, organization } = workspace(t);
  registerCheckoutProvider('razorpay', razorpayCheckout);
  subscribe(db, organization);
  const fetchImpl = recordingFetch({ body: { current_end: 1_788_000_000 } });

  await requestCancellation(db, config, { organization, fetchImpl });
  const second = await requestCancellation(db, config, { organization, fetchImpl });

  assert.equal(second.alreadyRequested, true);
  // Providers differ on what a second cancellation of one subscription means,
  // and none of the answers is better than not asking.
  assert.equal(fetchImpl.calls.length, 1);
});

test('Razorpay offers no way back, and does not pretend to', async (t) => {
  const { config, db, organization } = workspace(t);
  registerCheckoutProvider('razorpay', razorpayCheckout);
  subscribe(db, organization);
  await requestCancellation(db, config, { organization, fetchImpl: recordingFetch({ body: { current_end: 1_788_000_000 } }) });

  assert.deepEqual(subscriptionActions(db, organization.id), { canCancel: false, canResume: false });
  await assert.rejects(
    () => resumeSubscription(db, config, { organization }),
    (error) => error.code === 'BILLING_ACTION_UNSUPPORTED',
  );
});

test('Stripe can be told to keep the plan after all', async (t) => {
  const { config, db, organization } = workspace(t);
  registerCheckoutProvider('stripe', stripeCheckout);
  subscribe(db, organization, { provider: 'stripe', reference: 'sub_stripe' });

  const cancelFetch = recordingFetch({ body: { id: 'sub_stripe', cancel_at_period_end: true, cancel_at: 1_788_000_000 } });
  await requestCancellation(db, config, { organization, fetchImpl: cancelFetch });
  assert.equal(new URLSearchParams(cancelFetch.calls[0].options.body).get('cancel_at_period_end'), 'true');
  assert.deepEqual(subscriptionActions(db, organization.id), { canCancel: false, canResume: true });

  const resumeFetch = recordingFetch({ body: { id: 'sub_stripe', cancel_at_period_end: false, cancel_at: null } });
  const { subscription } = await resumeSubscription(db, config, { organization, fetchImpl: resumeFetch });
  assert.equal(new URLSearchParams(resumeFetch.calls[0].options.body).get('cancel_at_period_end'), 'false');
  assert.equal(subscription.cancelsAt, null);
  assert.deepEqual(subscriptionActions(db, organization.id), { canCancel: true, canResume: false });
});

test('an undo done in the provider portal is reflected here', async (t) => {
  const { config, db, organization } = workspace(t);
  registerCheckoutProvider('stripe', stripeCheckout);
  registerBillingProvider('stripe', stripeAdapter);
  subscribe(db, organization, { provider: 'stripe', reference: 'sub_stripe' });
  await requestCancellation(db, config, {
    organization,
    fetchImpl: recordingFetch({ body: { cancel_at_period_end: true, cancel_at: 1_788_000_000 } }),
  });
  assert.ok(subscriptionFor(db, organization.id).cancelsAt);

  // Stripe reports the pending cancellation on every subscription event, which
  // makes Stripe authoritative — somebody who undoes it in Stripe's own portal
  // does not also have to tell KukGit.
  const change = stripeAdapter.normalize({
    eventId: 'evt_1',
    type: 'customer.subscription.updated',
    payload: {
      data: {
        object: {
          object: 'subscription', id: 'sub_stripe', status: 'active',
          cancel_at_period_end: false, cancel_at: null,
          metadata: { kukgit_org: 'kuklabs', kukgit_plan: 'team' },
        },
      },
    },
  }, { db, config });
  ingestBillingEvent(db, { provider: 'stripe', providerEventId: 'evt_1', type: 'customer.subscription.updated', change });

  assert.equal(subscriptionFor(db, organization.id).cancelsAt, null);
});

test('a subscription that actually ended has no date left on it', async (t) => {
  const { config, db, organization } = workspace(t);
  registerCheckoutProvider('razorpay', razorpayCheckout);
  subscribe(db, organization);
  await requestCancellation(db, config, { organization, fetchImpl: recordingFetch({ body: { current_end: 1_788_000_000 } }) });

  ingestBillingEvent(db, {
    provider: 'razorpay',
    providerEventId: 'razorpay:ended',
    type: 'subscription.cancelled',
    change: { organizationId: organization.id, plan: 'team', status: 'canceled', reference: 'sub_ABC' },
  });

  // A date in the past that says "ends soon" is worse than no date.
  assert.equal(subscriptionFor(db, organization.id).cancelsAt, null);
  assert.equal(db.prepare('SELECT plan FROM organizations WHERE id = ?').get(organization.id).plan, 'free');
  assert.deepEqual(subscriptionActions(db, organization.id), { canCancel: false, canResume: false });
});

test('a subscription arranged directly is not cancelled by a button', async (t) => {
  const { config, db, organization } = workspace(t);
  registerCheckoutProvider('razorpay', razorpayCheckout);
  subscribe(db, organization, { provider: 'manual', reference: 'PO-2026-114' });

  await assert.rejects(
    () => requestCancellation(db, config, { organization }),
    (error) => {
      assert.equal(error.code, 'BILLING_ACTION_UNSUPPORTED');
      // There is no provider to call and no self-serve way to end an agreement
      // somebody signed. Saying so beats a button that fails.
      assert.match(error.message, /Contact support/);
      return true;
    },
  );
});

test('nothing to cancel is said plainly', async (t) => {
  const { config, db, organization } = workspace(t);
  registerCheckoutProvider('razorpay', razorpayCheckout);
  await assert.rejects(
    () => requestCancellation(db, config, { organization }),
    (error) => error.code === 'BILLING_NO_SUBSCRIPTION',
  );
  assert.deepEqual(subscriptionActions(db, organization.id), { canCancel: false, canResume: false });
});

test('a subscription the provider has not confirmed yet is a wait, not a failure', async (t) => {
  const { config, db, organization } = workspace(t);
  registerCheckoutProvider('razorpay', razorpayCheckout);
  subscribe(db, organization, { reference: null });

  await assert.rejects(
    () => requestCancellation(db, config, { organization }),
    (error) => error.code === 'BILLING_NOT_CONFIRMED',
  );
});

test('the provider refusing leaves no cancellation recorded', async (t) => {
  const { config, db, organization } = workspace(t);
  registerCheckoutProvider('razorpay', razorpayCheckout);
  subscribe(db, organization);

  await assert.rejects(
    () => requestCancellation(db, config, {
      organization,
      fetchImpl: recordingFetch({ status: 400, body: { error: { description: 'key rzp_secret is not live' } } }),
    }),
    (error) => {
      assert.equal(error.code, 'BILLING_CHECKOUT_REFUSED');
      assert.doesNotMatch(error.message, /rzp_secret/);
      return true;
    },
  );
  // Telling a customer their plan is ending when the provider never agreed is
  // the one outcome worse than the refusal.
  assert.equal(subscriptionFor(db, organization.id).cancelsAt, null);
});

test('cancelling is audited, and says what it did', async (t) => {
  const { config, db, organization } = workspace(t);
  registerCheckoutProvider('razorpay', razorpayCheckout);
  subscribe(db, organization);
  await requestCancellation(db, config, { organization, fetchImpl: recordingFetch({ body: { current_end: 1_788_000_000 } }) });

  const row = db.prepare("SELECT metadata_json AS metadata FROM audit_logs WHERE action = 'billing.subscription.cancellation_requested'").get();
  assert.ok(row, 'the cancellation is in the audit log');
  assert.match(row.metadata, /"provider":"razorpay"/);
  assert.match(row.metadata, /"cancelsAt":"20/);
});

test('a member who is not an administrator cannot cancel', async (t) => {
  const context = workspace(t);
  const { db } = context;
  registerCheckoutProvider('razorpay', razorpayCheckout);
  const organization = db.prepare("SELECT id, slug FROM organizations WHERE slug = 'kuklabs'").get();
  subscribe(db, organization);
  const { origin } = await server(t, context);

  const { hashPassword } = await import('../src/auth.mjs');
  const memberId = uid('usr');
  db.prepare('INSERT INTO users (id, email, display_name, password_hash) VALUES (?, ?, ?, ?)')
    .run(memberId, 'developer@kuklabs.com', 'Dev', hashPassword('secure-test-password'));
  db.prepare('INSERT INTO org_members (organization_id, user_id, role) VALUES (?, ?, ?)')
    .run(organization.id, memberId, 'maintainer');
  const cookie = await signIn(origin, 'developer@kuklabs.com', 'secure-test-password');

  const response = await fetch(`${origin}/api/orgs/kuklabs/billing/cancel`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: cookie },
  });
  // Ending a subscription is the same decision as starting one.
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, 'ORG_ADMIN_REQUIRED');

  const billing = await (await fetch(`${origin}/api/orgs/kuklabs/billing`, { headers: { Cookie: cookie } })).json();
  assert.deepEqual(billing.actions, { canCancel: false, canResume: false });
});

test('an owner is offered cancel, and it works over HTTP', async (t) => {
  const context = workspace(t);
  registerCheckoutProvider('razorpay', razorpayCheckout);
  subscribe(context.db, context.organization);
  const { origin } = await server(t, context);
  const cookie = await signIn(origin, 'operator@kuklabs.com', 'secure-test-password');

  const before = await (await fetch(`${origin}/api/orgs/kuklabs/billing`, { headers: { Cookie: cookie } })).json();
  assert.deepEqual(before.actions, { canCancel: true, canResume: false });

  const previous = globalThis.fetch;
  globalThis.fetch = recordingFetch({ body: { id: 'sub_ABC', current_end: 1_788_000_000 } });
  t.after(() => { globalThis.fetch = previous; });
  const response = await previous(`${origin}/api/orgs/kuklabs/billing/cancel`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: cookie },
  });
  globalThis.fetch = previous;

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.ok(payload.subscription.cancelsAt);
  // Razorpay cannot resume, so nothing offers it.
  assert.deepEqual(payload.actions, { canCancel: false, canResume: false });
});

test('a cancel from another origin is refused', async (t) => {
  const context = workspace(t);
  registerCheckoutProvider('razorpay', razorpayCheckout);
  subscribe(context.db, context.organization);
  const { origin } = await server(t, context);
  const cookie = await signIn(origin, 'operator@kuklabs.com', 'secure-test-password');

  const response = await fetch(`${origin}/api/orgs/kuklabs/billing/cancel`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://not-kukgit.example', Cookie: cookie },
  });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, 'CSRF_BLOCKED');
});
