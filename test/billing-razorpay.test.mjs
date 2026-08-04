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
  subscriptionFor,
} from '../src/billing.mjs';
import { createBillingApiHandler } from '../src/billing-api.mjs';
import { migrateInstanceSettings, putInstanceSetting } from '../src/instance-settings.mjs';
import { razorpayAdapter, verifyRazorpaySignature } from '../src/billing-razorpay.mjs';
import { instanceAdminEmails } from '../src/instance-admin-safe.mjs';

const SECRET = 'the-razorpay-webhook-secret';

function workspace(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-razorpay-'));
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
  putInstanceSetting(db, config, { integration: 'billing.razorpay', field: 'webhookSecret', value: SECRET });
  registerBillingProvider('razorpay', razorpayAdapter);
  const organization = db.prepare("SELECT id, slug FROM organizations WHERE slug = 'kuklabs'").get();
  return { config, db, organization };
}

function event(type, overrides = {}) {
  return {
    event: type,
    created_at: 1_785_000_000,
    payload: {
      subscription: {
        entity: {
          id: 'sub_RZP123',
          current_start: 1_785_000_000,
          current_end: 1_787_600_000,
          notes: { kukgit_org: 'kuklabs', kukgit_plan: 'team' },
          ...overrides.subscription,
        },
      },
      ...(overrides.invoice ? { invoice: { entity: overrides.invoice } } : {}),
    },
  };
}

function delivery(payload, { secret = SECRET, eventId = 'evt_rzp_1', signature } = {}) {
  const raw = Buffer.from(JSON.stringify(payload));
  return {
    raw,
    headers: {
      'x-razorpay-signature': signature ?? crypto.createHmac('sha256', secret).update(raw).digest('hex'),
      'x-razorpay-event-id': eventId,
    },
  };
}

test('the signature is checked against the raw bytes', async (t) => {
  const { config, db } = workspace(t);
  const { raw, headers } = delivery(event('subscription.activated'));
  assert.ok(razorpayAdapter.verify(raw, headers, { config, db }));

  // Re-serialising changes whitespace and key order, and the signature then
  // fails for reasons nobody can see. This is what verifying on bytes prevents.
  const reserialised = Buffer.from(JSON.stringify(JSON.parse(raw.toString('utf8')), null, 2));
  assert.equal(razorpayAdapter.verify(reserialised, headers, { config, db }), null);
});

test('a missing secret verifies nothing rather than everything', async () => {
  const raw = Buffer.from('{}');
  // An instance that has not been configured must refuse the webhook, not
  // accept any body that arrives at the URL.
  assert.equal(verifyRazorpaySignature(raw, { 'x-razorpay-signature': 'a'.repeat(64) }, null), false);
  assert.equal(verifyRazorpaySignature(raw, { 'x-razorpay-signature': 'a'.repeat(64) }, ''), false);
});

test('a wrong, short or absent signature is refused', async (t) => {
  const { config, db } = workspace(t);
  const payload = event('subscription.activated');
  for (const signature of [undefined, '', 'nope', 'a'.repeat(63), 'a'.repeat(64), 'A'.repeat(64)]) {
    const { raw, headers } = delivery(payload, { signature });
    if (signature === undefined) delete headers['x-razorpay-signature'];
    assert.equal(razorpayAdapter.verify(raw, headers, { config, db }), null, `accepted ${signature}`);
  }
});

test('a signature made with a different secret is refused', async (t) => {
  const { config, db } = workspace(t);
  const { raw, headers } = delivery(event('subscription.activated'), { secret: 'a-different-secret' });
  assert.equal(razorpayAdapter.verify(raw, headers, { config, db }), null);
});

test('the event id comes from Razorpay, not from the body', async (t) => {
  const { config, db } = workspace(t);
  const { raw, headers } = delivery(event('subscription.activated'), { eventId: 'evt_stable_across_retries' });
  assert.equal(razorpayAdapter.verify(raw, headers, { config, db }).eventId, 'evt_stable_across_retries');

  // Without it there is nothing stable to deduplicate on: hashing the body
  // would make a retry look new whenever Razorpay changed one byte of it.
  delete headers['x-razorpay-event-id'];
  assert.equal(razorpayAdapter.verify(raw, headers, { config, db }), null);
});

test('Razorpay states become the four the core understands', async (t) => {
  const { config, db, organization } = workspace(t);
  const cases = [
    ['subscription.activated', 'active'],
    ['subscription.charged', 'active'],
    ['subscription.authenticated', 'trialing'],
    // Both are a payment that has not gone through. The grace period decides
    // how long that is survivable, not the difference between these two names.
    ['subscription.pending', 'past_due'],
    ['subscription.halted', 'past_due'],
    ['subscription.cancelled', 'canceled'],
    ['subscription.completed', 'canceled'],
  ];
  for (const [type, expected] of cases) {
    const { raw, headers } = delivery(event(type));
    const change = razorpayAdapter.normalize(razorpayAdapter.verify(raw, headers, { config, db }), { db, config });
    assert.equal(change.status, expected, `${type} became ${change?.status}`);
    assert.equal(change.organizationId, organization.id);
    assert.equal(change.plan, 'team');
    assert.equal(change.reference, 'sub_RZP123');
  }
});

test('an event about something else is ignored, not guessed at', async (t) => {
  const { config, db } = workspace(t);
  const { raw, headers } = delivery({ event: 'payment.captured', payload: {} });
  const verified = razorpayAdapter.verify(raw, headers, { config, db });
  assert.ok(verified, 'it is still a real Razorpay delivery');
  assert.equal(razorpayAdapter.normalize(verified, { db, config }), null);
});

test('notes naming an organization that does not exist resolve to nothing', async (t) => {
  const { config, db } = workspace(t);
  const { raw, headers } = delivery(event('subscription.activated', {
    subscription: { notes: { kukgit_org: 'not-a-real-org', kukgit_plan: 'team' } },
  }));
  // A webhook must not be able to pick a customer by being wrong.
  assert.equal(razorpayAdapter.normalize(razorpayAdapter.verify(raw, headers, { config, db }), { db, config }), null);
});

test('a subscription with no plan note is refused', async (t) => {
  const { config, db } = workspace(t);
  const { raw, headers } = delivery(event('subscription.activated', {
    subscription: { notes: { kukgit_org: 'kuklabs' } },
  }));
  assert.equal(razorpayAdapter.normalize(razorpayAdapter.verify(raw, headers, { config, db }), { db, config }), null);
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
  const { raw, headers } = delivery(event('subscription.activated'));
  const send = (body = raw, head = headers) => fetch(`${origin}/api/billing/webhooks/razorpay`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...head }, body,
  });

  const first = await send();
  assert.equal(first.status, 200);
  assert.equal((await first.json()).outcome, 'applied');
  assert.equal(context.db.prepare('SELECT plan FROM organizations WHERE id = ?').get(context.organization.id).plan, 'team');
  assert.equal(subscriptionFor(context.db, context.organization.id).reference, 'sub_RZP123');

  const retry = await send();
  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).duplicate, true);
  assert.equal(billingEvents(context.db, {}).length, 1);
});

test('a forged delivery changes nothing and records nothing', async (t) => {
  const context = workspace(t);
  const origin = await server(t, context);
  const { raw } = delivery(event('subscription.activated'));

  const response = await fetch(`${origin}/api/billing/webhooks/razorpay`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': 'f'.repeat(64), 'x-razorpay-event-id': 'evt_forged' },
    body: raw,
  });
  assert.equal(response.status, 400);
  assert.equal(context.db.prepare('SELECT plan FROM organizations WHERE id = ?').get(context.organization.id).plan, 'founder');
  assert.equal(billingEvents(context.db, {}).length, 0);
});

test('a charge records an invoice in paise, and the plan stays active', async (t) => {
  const context = workspace(t);
  const origin = await server(t, context);
  const { raw, headers } = delivery(event('subscription.charged', {
    invoice: { id: 'inv_RZP9', amount: 149900, currency: 'INR' },
  }));

  const response = await fetch(`${origin}/api/billing/webhooks/razorpay`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: raw,
  });
  assert.equal(response.status, 200);

  const [invoice] = organizationInvoices(context.db, context.organization.id);
  // Razorpay reports paise, which is already the minor unit — no conversion,
  // and no float anywhere near it.
  assert.equal(invoice.amountMinor, 149900);
  assert.equal(invoice.currency, 'INR');
  assert.equal(invoice.status, 'paid');
  assert.equal(invoice.period, '2026-07');
  assert.equal(context.db.prepare('SELECT plan FROM organizations WHERE id = ?').get(context.organization.id).plan, 'team');
});

test('an invoice that cannot be recorded does not stop the plan change', async (t) => {
  const context = workspace(t);
  const origin = await server(t, context);
  // A currency Razorpay should never send, which `recordInvoice` refuses.
  const { raw, headers } = delivery(event('subscription.charged', {
    invoice: { id: 'inv_bad', amount: 100, currency: 'rupees' },
  }));

  const response = await fetch(`${origin}/api/billing/webhooks/razorpay`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: raw,
  });
  assert.equal(response.status, 200);
  // The customer paid. Refusing to activate them because the invoice row was
  // malformed would be punishing them for our bookkeeping.
  assert.equal(context.db.prepare('SELECT plan FROM organizations WHERE id = ?').get(context.organization.id).plan, 'team');
  assert.equal(organizationInvoices(context.db, context.organization.id).length, 0);
});

test('the unlimited plan cannot arrive by webhook', async (t) => {
  const context = workspace(t);
  const origin = await server(t, context);
  const { raw, headers } = delivery(event('subscription.activated', {
    subscription: { notes: { kukgit_org: 'kuklabs', kukgit_plan: 'founder' } },
  }));

  const response = await fetch(`${origin}/api/billing/webhooks/razorpay`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: raw,
  });
  // Anybody who can set a note could otherwise buy everything for the price of
  // the cheapest thing Razorpay will sell.
  assert.equal(response.status, 422);
  const [recorded] = billingEvents(context.db, {});
  assert.match(recorded.outcome, /^failed:/);
});
