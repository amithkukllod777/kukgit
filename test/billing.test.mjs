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
  GRACE_DAYS,
  billingEvents,
  entitlement,
  expireGracePeriods,
  forgetBillingProviders,
  ingestBillingEvent,
  migrateBilling,
  organizationInvoices,
  recordInvoice,
  registerBillingProvider,
  subscriptionFor,
} from '../src/billing.mjs';
import { createBillingApiHandler } from '../src/billing-api.mjs';
import { instanceAdminEmails } from '../src/instance-admin-safe.mjs';

function workspace(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-billing-'));
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
  });
  const db = openDatabase(config);
  t.after(() => db.close());
  seedCore(db, config);
  migrateBilling(db);
  const organization = db.prepare("SELECT id, slug FROM organizations WHERE slug = 'kuklabs'").get();
  return { config, db, organization };
}

function planOf(db, organizationId) {
  return db.prepare('SELECT plan FROM organizations WHERE id = ?').get(organizationId).plan;
}

test('a plan changes only through a billing event, and the event says so', async (t) => {
  const { db, organization } = workspace(t);
  const result = ingestBillingEvent(db, {
    provider: 'manual',
    providerEventId: 'manual:1',
    type: 'subscription.recorded',
    change: { organizationId: organization.id, plan: 'team', status: 'active' },
  });

  assert.equal(result.outcome, 'applied');
  assert.equal(planOf(db, organization.id), 'team');
  assert.equal(subscriptionFor(db, organization.id).status, 'active');

  const audited = db.prepare("SELECT metadata_json AS metadata FROM audit_logs WHERE action = 'billing.plan_changed'").get();
  assert.match(audited.metadata, /"to":"team"/);
  // No amounts and no provider reference in the audit row: it is read by more
  // people than a billing record is.
  assert.doesNotMatch(audited.metadata, /amount|secret|reference/i);
});

test('a duplicate event does nothing at all', async (t) => {
  const { db, organization } = workspace(t);
  const change = { organizationId: organization.id, plan: 'team', status: 'active' };
  ingestBillingEvent(db, { provider: 'stripe', providerEventId: 'evt_1', type: 'x', change });

  // Every provider retries. A retry that applied the change again would be
  // indistinguishable from two real changes.
  const second = ingestBillingEvent(db, {
    provider: 'stripe', providerEventId: 'evt_1', type: 'x',
    change: { ...change, plan: 'business' },
  });
  assert.equal(second.duplicate, true);
  assert.equal(planOf(db, organization.id), 'team');
  assert.equal(billingEvents(db, {}).length, 1);
});

test('the same event id from two providers is two events', async (t) => {
  const { db, organization } = workspace(t);
  const change = { organizationId: organization.id, plan: 'team', status: 'active' };
  ingestBillingEvent(db, { provider: 'stripe', providerEventId: 'shared-1', type: 'x', change });
  const other = ingestBillingEvent(db, { provider: 'razorpay', providerEventId: 'shared-1', type: 'x', change });
  // Providers do not coordinate their identifiers; keying on the id alone would
  // silently drop one of them.
  assert.equal(other.duplicate, false);
  assert.equal(billingEvents(db, {}).length, 2);
});

test('the unlimited plan cannot be bought', async (t) => {
  const { db, organization } = workspace(t);
  assert.throws(
    () => ingestBillingEvent(db, {
      provider: 'stripe', providerEventId: 'evt_founder', type: 'x',
      change: { organizationId: organization.id, plan: 'founder', status: 'active' },
    }),
    (error) => error.code === 'BILLING_PLAN_INVALID',
  );
  // A provider event that could select `founder` would buy everything for the
  // price of the cheapest thing the provider will sell.
  assert.equal(subscriptionFor(db, organization.id), null, 'nothing was recorded');
});

test('a failed event stays recorded, with why', async (t) => {
  const { db, organization } = workspace(t);
  assert.throws(() => ingestBillingEvent(db, {
    provider: 'stripe', providerEventId: 'evt_bad', type: 'x',
    change: { organizationId: organization.id, plan: 'nonsense', status: 'active' },
  }));

  const [event] = billingEvents(db, {});
  assert.match(event.outcome, /^failed:/);
  // Deleting it would make the provider's retry look like a first delivery, and
  // the failure would repeat silently instead of being visible once.
  const retry = ingestBillingEvent(db, {
    provider: 'stripe', providerEventId: 'evt_bad', type: 'x',
    change: { organizationId: organization.id, plan: 'team', status: 'active' },
  });
  assert.equal(retry.duplicate, true);
});

test('past due keeps the plan for the grace period, then does not', async (t) => {
  const { db, organization } = workspace(t);
  const now = new Date('2026-08-04T00:00:00Z');
  ingestBillingEvent(db, {
    provider: 'stripe', providerEventId: 'evt_active', type: 'x', now,
    change: { organizationId: organization.id, plan: 'team', status: 'active' },
  });
  ingestBillingEvent(db, {
    provider: 'stripe', providerEventId: 'evt_pastdue', type: 'x', now,
    change: { organizationId: organization.id, plan: 'team', status: 'past_due' },
  });

  // A card expires, a bank declines a legitimate charge. Taking the plan away
  // the same hour turns a payment problem into an outage they did not cause.
  assert.equal(entitlement(db, organization.id, { now }).plan, 'team');
  assert.equal(planOf(db, organization.id), 'team');

  const later = new Date(now.getTime() + (GRACE_DAYS + 1) * 86_400_000);
  assert.equal(entitlement(db, organization.id, { now: later }).plan, 'free');
  assert.equal(expireGracePeriods(db, { now: later }).expired, 1);
  assert.equal(planOf(db, organization.id), 'free');
});

test('grace expiry is idempotent', async (t) => {
  const { db, organization } = workspace(t);
  const now = new Date('2026-08-04T00:00:00Z');
  ingestBillingEvent(db, {
    provider: 'stripe', providerEventId: 'evt_pd', type: 'x', now,
    change: { organizationId: organization.id, plan: 'team', status: 'past_due' },
  });
  const later = new Date(now.getTime() + (GRACE_DAYS + 1) * 86_400_000);
  assert.equal(expireGracePeriods(db, { now: later }).expired, 1);
  assert.equal(expireGracePeriods(db, { now: later }).expired, 0);
});

test('cancelling drops the entitlement and deletes nothing', async (t) => {
  const { db, organization } = workspace(t);
  ingestBillingEvent(db, {
    provider: 'stripe', providerEventId: 'a', type: 'x',
    change: { organizationId: organization.id, plan: 'business', status: 'active' },
  });
  const repositories = db.prepare('SELECT COUNT(*) AS count FROM repositories').get().count;

  ingestBillingEvent(db, {
    provider: 'stripe', providerEventId: 'b', type: 'x',
    change: { organizationId: organization.id, plan: 'business', status: 'canceled' },
  });
  assert.equal(planOf(db, organization.id), 'free');
  // Enforcement refuses growth, never a read. A lapsed customer keeps every
  // repository they have.
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM repositories').get().count, repositories);
});

test('an invoice is whole minor units in a real currency', async (t) => {
  const { db, organization } = workspace(t);
  const invoice = recordInvoice(db, {
    organizationId: organization.id, period: '2026-07', provider: 'manual',
    amountMinor: 149900, currency: 'inr', status: 'paid', paidAt: '2026-08-01T00:00:00Z',
  });
  assert.equal(invoice.amount_minor, 149900);
  assert.equal(invoice.currency, 'INR');

  for (const bad of [{ amountMinor: 1499.5 }, { amountMinor: -1 }, { currency: 'rupees' }]) {
    assert.throws(() => recordInvoice(db, {
      organizationId: organization.id, period: '2026-06', provider: 'manual',
      amountMinor: 1000, currency: 'INR', ...bad,
    }));
  }
  // A float amount is how a rounding difference becomes a complaint nobody can
  // reproduce.
  assert.equal(organizationInvoices(db, organization.id).length, 1);
});

test('recording the same period twice updates rather than duplicating', async (t) => {
  const { db, organization } = workspace(t);
  recordInvoice(db, { organizationId: organization.id, period: '2026-07', provider: 'manual', amountMinor: 1000, currency: 'INR', status: 'open' });
  recordInvoice(db, { organizationId: organization.id, period: '2026-07', provider: 'manual', amountMinor: 1000, currency: 'INR', status: 'paid' });
  const invoices = organizationInvoices(db, organization.id);
  assert.equal(invoices.length, 1);
  assert.equal(invoices[0].status, 'paid');
});

// --------------------------------------------------------------- over HTTP

function stubProvider(secret) {
  return {
    verify(raw, headers) {
      const expected = crypto.createHmac('sha256', secret).update(raw).digest('hex');
      const received = String(headers['x-stub-signature'] || '');
      if (received.length !== expected.length) return null;
      if (!crypto.timingSafeEqual(Buffer.from(received), Buffer.from(expected))) return null;
      const payload = JSON.parse(raw.toString('utf8'));
      return { eventId: payload.id, type: payload.type, payload };
    },
    normalize(verified, { db }) {
      const organization = db.prepare('SELECT id FROM organizations WHERE slug = ?').get(verified.payload.org);
      if (!organization) return null;
      return { organizationId: organization.id, plan: verified.payload.plan, status: verified.payload.status };
    },
  };
}

async function server(t, { config, db }) {
  const billingApi = createBillingApiHandler({
    config,
    db,
    isInstanceAdmin: (settings, user) => instanceAdminEmails(settings).includes(String(user.email || '').toLowerCase()),
  });
  const app = createApp({ config, db });
  const node = http.createServer(async (req, res) => {
    if (await billingApi(req, res)) return;
    return app(req, res);
  });
  await new Promise((resolve) => node.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => node.close(resolve)));
  const origin = `http://127.0.0.1:${node.address().port}`;
  const login = await fetch(`${origin}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'operator@kuklabs.com', password: 'secure-test-password' }),
  });
  return { origin, cookie: login.headers.get('set-cookie').split(';')[0] };
}

test('a webhook without a valid signature changes nothing', async (t) => {
  const context = workspace(t);
  registerBillingProvider('stub', stubProvider('the-shared-secret'));
  const { origin } = await server(t, context);
  const body = JSON.stringify({ id: 'evt_forged', type: 'sub', org: 'kuklabs', plan: 'business', status: 'active' });

  for (const headers of [{}, { 'x-stub-signature': 'nonsense' }, { 'x-stub-signature': 'a'.repeat(64) }]) {
    const response = await fetch(`${origin}/api/billing/webhooks/stub`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body,
    });
    assert.equal(response.status, 400, 'an unsigned webhook was accepted');
  }
  // The only place a stranger can change what an organization is entitled to.
  assert.equal(planOf(context.db, context.organization.id), 'founder');
  assert.equal(billingEvents(context.db, {}).length, 0);
});

test('a signed webhook applies once, and its retry is a 200 that does nothing', async (t) => {
  const context = workspace(t);
  registerBillingProvider('stub', stubProvider('the-shared-secret'));
  const { origin } = await server(t, context);
  const body = JSON.stringify({ id: 'evt_real', type: 'sub', org: 'kuklabs', plan: 'team', status: 'active' });
  const signature = crypto.createHmac('sha256', 'the-shared-secret').update(Buffer.from(body)).digest('hex');
  const send = () => fetch(`${origin}/api/billing/webhooks/stub`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-stub-signature': signature },
    body,
  });

  const first = await send();
  assert.equal(first.status, 200);
  assert.equal((await first.json()).duplicate, false);
  assert.equal(planOf(context.db, context.organization.id), 'team');

  const retry = await send();
  // 200, not an error: a provider that gets anything else keeps retrying, and a
  // queue that never drains is the provider's problem becoming ours.
  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).duplicate, true);
});

test('an unknown provider is a 404 that names nothing', async (t) => {
  const context = workspace(t);
  registerBillingProvider('stub', stubProvider('s'));
  const { origin } = await server(t, context);
  const response = await fetch(`${origin}/api/billing/webhooks/nobody`, { method: 'POST', body: '{}' });
  assert.equal(response.status, 404);
  assert.doesNotMatch(JSON.stringify(await response.json()), /stub/);
});

test('a member sees the subscription and invoices; a stranger sees a 404', async (t) => {
  const context = workspace(t);
  recordInvoice(context.db, {
    organizationId: context.organization.id, period: '2026-07', provider: 'manual',
    amountMinor: 149900, currency: 'INR', status: 'paid',
  });
  const { origin, cookie } = await server(t, context);

  const mine = await fetch(`${origin}/api/orgs/kuklabs/billing`, { headers: { Cookie: cookie } });
  assert.equal(mine.status, 200);
  const payload = await mine.json();
  assert.equal(payload.invoices[0].amountMinor, 149900);
  assert.equal(payload.entitlement.plan, 'free', 'no subscription means free, whatever the column says');

  assert.equal((await fetch(`${origin}/api/orgs/kuklabs/billing`)).status, 401);
  assert.equal((await fetch(`${origin}/api/orgs/somebody-else/billing`, { headers: { Cookie: cookie } })).status, 404);
});

test('an operator can record a subscription taken outside any provider', async (t) => {
  const context = workspace(t);
  const { origin, cookie } = await server(t, context);

  const response = await fetch(`${origin}/api/instance-admin/billing/subscriptions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ orgSlug: 'kuklabs', plan: 'business', status: 'active', reference: 'bank transfer 4411' }),
  });
  assert.equal(response.status, 201);
  assert.equal(planOf(context.db, context.organization.id), 'business');

  // Recorded as an event like any other, so "what changed this plan" has one
  // answer whoever changed it.
  const [event] = billingEvents(context.db, {});
  assert.equal(event.provider, 'manual');
  assert.equal(event.outcome, 'applied');
});

test('recording a subscription needs an operator', async (t) => {
  const context = workspace(t);
  const { db, organization } = context;
  db.prepare('INSERT INTO users (id, email, password_hash, display_name) VALUES (?, ?, ?, ?)')
    .run('usr_member', 'member@example.com', 'scrypt$x$y', 'Member');
  db.prepare('INSERT INTO org_members (organization_id, user_id, role) VALUES (?, ?, ?)')
    .run(organization.id, 'usr_member', 'owner');
  const { origin } = await server(t, context);

  const signedOut = await fetch(`${origin}/api/instance-admin/billing/subscriptions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orgSlug: 'kuklabs', plan: 'business' }),
  });
  assert.equal(signedOut.status, 401);
  // Being an owner of the organization is not enough. Otherwise the way to get
  // the business plan is to ask for it.
  assert.equal(planOf(db, organization.id), 'founder');
});
