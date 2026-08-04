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
  forgetBillingProviders,
  migrateBilling,
  recordWebhookRejection,
  registerBillingProvider,
  webhookRejections,
} from '../src/billing.mjs';
import { createBillingApiHandler } from '../src/billing-api.mjs';
import { migrateInstanceSettings, putInstanceSetting } from '../src/instance-settings.mjs';
import { razorpayAdapter } from '../src/billing-razorpay.mjs';
import { stripeAdapter } from '../src/billing-stripe.mjs';
import { instanceAdminEmails } from '../src/instance-admin-safe.mjs';

const CUSTOMER_DATA = 'rahul@example.com';

function workspace(t, { configured = true } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-webhook-diag-'));
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
  if (configured) {
    putInstanceSetting(db, config, { integration: 'billing.razorpay', field: 'webhookSecret', value: 'the-real-secret' });
    putInstanceSetting(db, config, { integration: 'billing.stripe', field: 'webhookSecret', value: 'whsec_real' });
  }
  registerBillingProvider('razorpay', razorpayAdapter);
  registerBillingProvider('stripe', stripeAdapter);
  return { config, db };
}

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

const BODY = JSON.stringify({ event: 'subscription.activated', payer: CUSTOMER_DATA });

async function post(origin, provider, headers = {}) {
  return fetch(`${origin}/api/billing/webhooks/${provider}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: BODY,
  });
}

test('a refused delivery is recorded, and the body is not', async (t) => {
  const context = workspace(t);
  const origin = await server(t, context);

  await post(origin, 'razorpay', { 'x-razorpay-signature': 'f'.repeat(64), 'x-razorpay-event-id': 'evt_1' });

  const [rejection] = webhookRejections(context.db, {});
  assert.equal(rejection.provider, 'razorpay');
  assert.match(rejection.reason, /does not match the configured webhook secret/);
  // The body is unverified input from a stranger, and it is exactly where a
  // real provider would have put customer data.
  const stored = JSON.stringify(context.db.prepare('SELECT * FROM billing_webhook_rejections').all());
  assert.doesNotMatch(stored, new RegExp(CUSTOMER_DATA));
  assert.equal(rejection.bytes, Buffer.byteLength(BODY));
  assert.match(rejection.fingerprint, /^[0-9a-f]{12}$/);
});

test('the reason distinguishes the mistakes somebody actually makes', async (t) => {
  const context = workspace(t);
  const origin = await server(t, context);

  await post(origin, 'razorpay');
  await post(origin, 'razorpay', { 'x-razorpay-signature': 'short' });
  await post(origin, 'razorpay', { 'x-razorpay-signature': 'f'.repeat(64) });

  const reasons = webhookRejections(context.db, {}).map((row) => row.reason).reverse();
  // Wiring a provider up for the first time goes wrong in a small number of
  // specific ways, and "signature invalid" tells an operator none of them.
  assert.match(reasons[0], /no x-razorpay-signature header/);
  assert.match(reasons[1], /not 64 hex characters/);
  assert.match(reasons[2], /does not match/);
});

test('an unconfigured provider says so instead of blaming the signature', async (t) => {
  const context = workspace(t, { configured: false });
  const origin = await server(t, context);

  await post(origin, 'razorpay', { 'x-razorpay-signature': 'f'.repeat(64), 'x-razorpay-event-id': 'e' });
  await post(origin, 'stripe', { 'stripe-signature': `t=${Math.floor(Date.now() / 1000)},v1=${'f'.repeat(64)}` });

  const reasons = webhookRejections(context.db, {}).map((row) => row.reason);
  // The commonest first-time failure by a distance: the URL is right and the
  // secret was never pasted in.
  assert.ok(reasons.some((reason) => /no webhook secret is configured for razorpay/.test(reason)));
  assert.ok(reasons.some((reason) => /no webhook signing secret is configured for stripe/.test(reason)));
});

test('a stale Stripe delivery says how stale, and in which direction', async (t) => {
  const context = workspace(t);
  const origin = await server(t, context);
  const at = Math.floor(Date.now() / 1000) - 4000;
  const signature = crypto.createHmac('sha256', 'whsec_real').update(`${at}.${BODY}`).digest('hex');

  await post(origin, 'stripe', { 'stripe-signature': `t=${at},v1=${signature}` });

  const [rejection] = webhookRejections(context.db, {});
  // A replayed capture and a server with a wrong clock look identical until
  // somebody can see which way and by how much.
  assert.match(rejection.reason, /timestamp is \d+s old, outside the 300s window/);
});

test('the same refused delivery twice has the same fingerprint', async (t) => {
  const context = workspace(t);
  const origin = await server(t, context);
  const headers = { 'x-razorpay-signature': 'f'.repeat(64), 'x-razorpay-event-id': 'evt_1' };

  await post(origin, 'razorpay', headers);
  await post(origin, 'razorpay', headers);

  const rows = webhookRejections(context.db, {});
  assert.equal(rows.length, 2);
  // A provider retrying a delivery we keep refusing should be recognisable as
  // one problem rather than read as several.
  assert.equal(rows[0].fingerprint, rows[1].fingerprint);
});

test('the table is bounded, because anybody can reach the endpoint', async (t) => {
  const context = workspace(t);
  const { db } = context;
  for (let index = 0; index < 260; index += 1) {
    recordWebhookRejection(db, { provider: 'razorpay', reason: 'flood', raw: Buffer.from(`body-${index}`) });
  }
  // A table that grows on request is a way to fill the disk.
  const kept = db.prepare('SELECT COUNT(*) AS count FROM billing_webhook_rejections').get().count;
  assert.ok(kept <= 200, `kept ${kept}`);
});

test('an accepted delivery records nothing here', async (t) => {
  const context = workspace(t);
  const origin = await server(t, context);
  const body = JSON.stringify({ event: 'payment.captured', payload: {} });
  const raw = Buffer.from(body);
  const signature = crypto.createHmac('sha256', 'the-real-secret').update(raw).digest('hex');

  const response = await fetch(`${origin}/api/billing/webhooks/razorpay`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': signature, 'x-razorpay-event-id': 'evt_ok' },
    body: raw,
  });
  assert.equal(response.status, 200);
  assert.equal(webhookRejections(context.db, {}).length, 0);
});

test('rejections are visible to an operator and to nobody else', async (t) => {
  const context = workspace(t);
  const origin = await server(t, context);
  await post(origin, 'razorpay', { 'x-razorpay-signature': 'f'.repeat(64) });

  assert.equal((await fetch(`${origin}/api/instance-admin/billing/events`)).status, 401);

  const login = await fetch(`${origin}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'operator@kuklabs.com', password: 'secure-test-password' }),
  });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const payload = await (await fetch(`${origin}/api/instance-admin/billing/events`, { headers: { Cookie: cookie } })).json();
  assert.equal(payload.rejected.length, 1);
  assert.deepEqual(payload.providers, ['razorpay', 'stripe']);
});
