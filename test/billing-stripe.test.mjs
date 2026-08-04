import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.mjs';
import { loadConfig } from '../src/config.mjs';
import { openDatabase, seedCore } from '../src/db.mjs';
import {
  billingEvents,
  forgetBillingProviders,
  migrateBilling,
  organizationInvoices,
  registerBillingProvider,
} from '../src/billing.mjs';
import { createBillingApiHandler } from '../src/billing-api.mjs';
import { migrateInstanceSettings, putInstanceSetting } from '../src/instance-settings.mjs';
import { TOLERANCE_SECONDS, stripeAdapter, verifyStripeSignature } from '../src/billing-stripe.mjs';
import { instanceAdminEmails } from '../src/instance-admin-safe.mjs';

const SECRET = 'whsec_the_stripe_signing_secret';

function workspace(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-stripe-'));
  t.after(() => { fs.rmSync(dataDir, { recursive: true, force: true }); forgetBillingProviders(); });
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
  putInstanceSetting(db, config, { integration: 'billing.stripe', field: 'webhookSecret', value: SECRET });
  registerBillingProvider('stripe', stripeAdapter);
  const organization = db.prepare("SELECT id, slug FROM organizations WHERE slug = 'kuklabs'").get();
  return { config, db, organization };
}

const METADATA = { kukgit_org: 'kuklabs', kukgit_plan: 'team' };

function subscriptionEvent(type, status, overrides = {}) {
  return {
    id: 'evt_stripe_1',
    type,
    data: {
      object: {
        object: 'subscription',
        id: 'sub_STRIPE9',
        status,
        current_period_end: 1_787_600_000,
        metadata: METADATA,
        ...overrides,
      },
    },
  };
}

function sign(payload, { secret = SECRET, at = Math.floor(Date.now() / 1000), extra = [] } = {}) {
  const raw = Buffer.from(JSON.stringify(payload));
  const signature = crypto.createHmac('sha256', secret).update(`${at}.${raw.toString('utf8')}`).digest('hex');
  const parts = [`t=${at}`, `v1=${signature}`, ...extra];
  return { raw, headers: { 'stripe-signature': parts.join(',') } };
}

test('the signature covers the timestamp as well as the body', async (t) => {
  const { config, db } = workspace(t);
  const payload = subscriptionEvent('customer.subscription.created', 'active');
  const { raw, headers } = sign(payload);
  assert.ok(stripeAdapter.verify(raw, headers, { config, db }));

  // Changing the timestamp invalidates the signature, which is what makes a
  // captured delivery unusable later.
  const moved = { 'stripe-signature': headers['stripe-signature'].replace(/^t=\d+/, `t=${Math.floor(Date.now() / 1000) - 1}`) };
  assert.equal(stripeAdapter.verify(raw, moved, { config, db }), null);
});

test('a delivery older than the tolerance is refused, and so is one from the future', async (t) => {
  const { config, db } = workspace(t);
  const payload = subscriptionEvent('customer.subscription.created', 'active');
  const now = Math.floor(Date.now() / 1000);

  const old = sign(payload, { at: now - TOLERANCE_SECONDS - 5 });
  assert.equal(stripeAdapter.verify(old.raw, old.headers, { config, db }), null);

  // A delivery from the future is as much a sign of a forged header as one
  // from last week.
  const future = sign(payload, { at: now + TOLERANCE_SECONDS + 5 });
  assert.equal(stripeAdapter.verify(future.raw, future.headers, { config, db }), null);

  const fresh = sign(payload, { at: now - 10 });
  assert.ok(stripeAdapter.verify(fresh.raw, fresh.headers, { config, db }));
});

test('a second v1 signature is accepted, because that is how a secret is rotated', async (t) => {
  const { config, db } = workspace(t);
  const payload = subscriptionEvent('customer.subscription.created', 'active');
  const at = Math.floor(Date.now() / 1000);
  const raw = Buffer.from(JSON.stringify(payload));
  const oldSignature = crypto.createHmac('sha256', 'whsec_previous').update(`${at}.${raw}`).digest('hex');
  const newSignature = crypto.createHmac('sha256', SECRET).update(`${at}.${raw}`).digest('hex');

  // Stripe sends both while a rotation is in flight. Taking only the first
  // would break exactly the deployment trying to rotate safely.
  const headers = { 'stripe-signature': `t=${at},v1=${oldSignature},v1=${newSignature}` };
  assert.ok(stripeAdapter.verify(raw, headers, { config, db }));
});

test('a missing secret verifies nothing rather than everything', async () => {
  const raw = Buffer.from('{}');
  const headers = { 'stripe-signature': `t=${Math.floor(Date.now() / 1000)},v1=${'a'.repeat(64)}` };
  assert.equal(verifyStripeSignature(raw, headers, null), false);
  assert.equal(verifyStripeSignature(raw, headers, ''), false);
});

test('a malformed, wrong or absent signature header is refused', async (t) => {
  const { config, db } = workspace(t);
  const payload = subscriptionEvent('customer.subscription.created', 'active');
  const raw = Buffer.from(JSON.stringify(payload));
  const at = Math.floor(Date.now() / 1000);

  for (const header of [undefined, '', 'nonsense', `t=${at}`, `v1=${'a'.repeat(64)}`, `t=abc,v1=${'a'.repeat(64)}`, `t=${at},v1=${'a'.repeat(64)}`]) {
    const headers = header === undefined ? {} : { 'stripe-signature': header };
    assert.equal(stripeAdapter.verify(raw, headers, { config, db }), null, `accepted ${header}`);
  }
});

test('the event id is Stripe’s own, and anything else is refused', async (t) => {
  const { config, db } = workspace(t);
  const { raw, headers } = sign(subscriptionEvent('customer.subscription.created', 'active'));
  assert.equal(stripeAdapter.verify(raw, headers, { config, db }).eventId, 'evt_stripe_1');

  // A payload without a real event id has nothing stable to deduplicate on.
  const nameless = sign({ ...subscriptionEvent('customer.subscription.created', 'active'), id: 'sub_not_an_event' });
  assert.equal(stripeAdapter.verify(nameless.raw, nameless.headers, { config, db }), null);
});

test('Stripe statuses become the four the core understands', async (t) => {
  const { config, db, organization } = workspace(t);
  const cases = [
    ['trialing', 'trialing'],
    ['active', 'active'],
    ['past_due', 'past_due'],
    // Money was expected and did not arrive. The grace period decides how long
    // that is survivable, not which of Stripe's three names it arrived under.
    ['unpaid', 'past_due'],
    ['incomplete', 'past_due'],
    ['incomplete_expired', 'canceled'],
    ['canceled', 'canceled'],
  ];
  for (const [stripeStatus, expected] of cases) {
    const { raw, headers } = sign(subscriptionEvent('customer.subscription.updated', stripeStatus));
    const change = stripeAdapter.normalize(stripeAdapter.verify(raw, headers, { config, db }), { db, config });
    assert.equal(change.status, expected, `${stripeStatus} became ${change?.status}`);
    assert.equal(change.organizationId, organization.id);
    assert.equal(change.reference, 'sub_STRIPE9');
  }
});

test('deletion is cancellation even when the object still says active', async (t) => {
  const { config, db } = workspace(t);
  // Stripe sends the subscription as it last was, which may still read
  // `active`. Taking the status from the object here would keep a cancelled
  // customer on their plan.
  const { raw, headers } = sign(subscriptionEvent('customer.subscription.deleted', 'active'));
  const change = stripeAdapter.normalize(stripeAdapter.verify(raw, headers, { config, db }), { db, config });
  assert.equal(change.status, 'canceled');
});

test('metadata naming an organization that does not exist resolves to nothing', async (t) => {
  const { config, db } = workspace(t);
  const { raw, headers } = sign(subscriptionEvent('customer.subscription.updated', 'active', {
    metadata: { kukgit_org: 'not-a-real-org', kukgit_plan: 'team' },
  }));
  assert.equal(stripeAdapter.normalize(stripeAdapter.verify(raw, headers, { config, db }), { db, config }), null);
});

test('an event about something else is ignored, not guessed at', async (t) => {
  const { config, db } = workspace(t);
  const { raw, headers } = sign({ id: 'evt_other', type: 'charge.refunded', data: { object: { object: 'charge' } } });
  const verified = stripeAdapter.verify(raw, headers, { config, db });
  assert.ok(verified, 'it is still a real Stripe delivery');
  assert.equal(stripeAdapter.normalize(verified, { db, config }), null);
});

async function server(t, context) {
  const billingApi = createBillingApiHandler({
    config: context.config,
    db: context.db,
    isInstanceAdmin: (settings, user) => instanceAdminEmails(settings).includes(String(user.email || '').toLowerCase()),
  });
  const app = createApp({ config: context.config, db: context.db });
  const node = http.createServer(async (req, res) => {
    if (await billingApi(req, res)) return;
    return app(req, res);
  });
  await new Promise((resolve) => node.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => node.close(resolve)));
  return `http://127.0.0.1:${node.address().port}`;
}

test('a real delivery changes the plan, and its retry does not change it again', async (t) => {
  const context = workspace(t);
  const origin = await server(t, context);
  const { raw, headers } = sign(subscriptionEvent('customer.subscription.created', 'active'));
  const send = () => fetch(`${origin}/api/billing/webhooks/stripe`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: raw,
  });

  assert.equal((await (await send()).json()).outcome, 'applied');
  assert.equal(context.db.prepare('SELECT plan FROM organizations WHERE id = ?').get(context.organization.id).plan, 'team');
  assert.equal((await (await send()).json()).duplicate, true);
  assert.equal(billingEvents(context.db, {}).length, 1);
});

test('a forged delivery changes nothing and records nothing', async (t) => {
  const context = workspace(t);
  const origin = await server(t, context);
  const { raw } = sign(subscriptionEvent('customer.subscription.created', 'active'));

  const response = await fetch(`${origin}/api/billing/webhooks/stripe`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'stripe-signature': `t=${Math.floor(Date.now() / 1000)},v1=${'f'.repeat(64)}`,
    },
    body: raw,
  });
  assert.equal(response.status, 400);
  assert.equal(context.db.prepare('SELECT plan FROM organizations WHERE id = ?').get(context.organization.id).plan, 'founder');
  assert.equal(billingEvents(context.db, {}).length, 0);
});

test('a paid invoice is recorded in minor units and changes no entitlement', async (t) => {
  const context = workspace(t);
  const origin = await server(t, context);
  const { raw, headers } = sign({
    id: 'evt_invoice_1',
    type: 'invoice.paid',
    data: {
      object: {
        object: 'invoice',
        id: 'in_STRIPE7',
        amount_paid: 4900,
        currency: 'usd',
        period_start: 1_785_000_000,
        subscription: 'sub_STRIPE9',
        subscription_details: { metadata: METADATA },
      },
    },
  });

  const response = await fetch(`${origin}/api/billing/webhooks/stripe`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: raw,
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).outcome, 'ignored', 'an invoice does not move the subscription');

  const [invoice] = organizationInvoices(context.db, context.organization.id);
  // Stripe reports minor units already — cents here, paise in INR. Nothing is
  // converted and no float goes near it.
  assert.equal(invoice.amountMinor, 4900);
  assert.equal(invoice.currency, 'USD');
  assert.equal(invoice.status, 'paid');
  assert.equal(invoice.period, '2026-07');
});

test('a failed payment moves the subscription to past due', async (t) => {
  const context = workspace(t);
  const origin = await server(t, context);
  const { raw, headers } = sign({
    id: 'evt_failed_1',
    type: 'invoice.payment_failed',
    data: {
      object: {
        object: 'invoice',
        id: 'in_failed',
        subscription: 'sub_STRIPE9',
        subscription_details: { metadata: METADATA },
      },
    },
  });

  await fetch(`${origin}/api/billing/webhooks/stripe`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: raw,
  });
  const subscription = context.db.prepare('SELECT status, grace_until FROM billing_subscriptions WHERE organization_id = ?')
    .get(context.organization.id);
  assert.equal(subscription.status, 'past_due');
  assert.ok(subscription.grace_until, 'a grace period was opened');
  // The plan is kept for the grace window rather than taken away the same hour.
  assert.equal(context.db.prepare('SELECT plan FROM organizations WHERE id = ?').get(context.organization.id).plan, 'team');
});

test('the unlimited plan cannot arrive by webhook', async (t) => {
  const context = workspace(t);
  const origin = await server(t, context);
  const { raw, headers } = sign(subscriptionEvent('customer.subscription.updated', 'active', {
    metadata: { kukgit_org: 'kuklabs', kukgit_plan: 'founder' },
  }));

  const response = await fetch(`${origin}/api/billing/webhooks/stripe`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: raw,
  });
  assert.equal(response.status, 422);
  assert.match(billingEvents(context.db, {})[0].outcome, /^failed:/);
});
