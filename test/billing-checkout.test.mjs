import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.mjs';
import { loadConfig } from '../src/config.mjs';
import { openDatabase, seedCore, uid } from '../src/db.mjs';
import { migrateBilling } from '../src/billing.mjs';
import { createBillingApiHandler } from '../src/billing-api.mjs';
import { migrateInstanceSettings, putInstanceSetting } from '../src/instance-settings.mjs';
import { instanceAdminEmails } from '../src/instance-admin-safe.mjs';
import {
  CHECKOUT_PLANS,
  CHECKOUT_REUSE_MINUTES,
  attributionNotes,
  checkoutOptions,
  forgetCheckoutProviders,
  formEncode,
  migrateBillingCheckout,
  redactSecret,
  registerCheckoutProvider,
  startCheckout,
} from '../src/billing-checkout.mjs';
import { razorpayCheckout } from '../src/billing-razorpay.mjs';
import { stripeCheckout } from '../src/billing-stripe.mjs';

const RAZORPAY_SECRET = 'rzp_test_SecretNobodyMayReadBack';
const STRIPE_SECRET = 'sk_test_SecretNobodyMayReadBack';

function workspace(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-checkout-'));
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
    secretsEncryptionKey: 'k'.repeat(48),
  });
  const db = openDatabase(config);
  t.after(() => db.close());
  seedCore(db, config);
  migrateBilling(db);
  migrateInstanceSettings(db);
  migrateBillingCheckout(db);
  const organization = db.prepare("SELECT id, slug FROM organizations WHERE slug = 'kuklabs'").get();
  return { config, db, organization };
}

function configureRazorpay(db, config) {
  putInstanceSetting(db, config, { integration: 'billing.razorpay', field: 'keyId', value: 'rzp_test_keyid' });
  putInstanceSetting(db, config, { integration: 'billing.razorpay', field: 'keySecret', value: RAZORPAY_SECRET });
  putInstanceSetting(db, config, { integration: 'billing.razorpay', field: 'planIdTeam', value: 'plan_TeamMonthly' });
}

function configureStripe(db, config) {
  putInstanceSetting(db, config, { integration: 'billing.stripe', field: 'secretKey', value: STRIPE_SECRET });
  putInstanceSetting(db, config, { integration: 'billing.stripe', field: 'priceIdTeam', value: 'price_TeamMonthly' });
}

/** A provider that records what it was sent and answers however the test says. */
function recordingFetch(answer) {
  const calls = [];
  const impl = async (url, options) => {
    calls.push({ url, options });
    const reply = typeof answer === 'function' ? answer(calls.length) : answer;
    return new Response(typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body ?? {}), {
      status: reply.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  impl.calls = calls;
  return impl;
}

/**
 * A real HTTP server whose `baseUrl` is the port it actually got.
 *
 * The handler is wired after `listen` on purpose: the origin check compares
 * against `config.baseUrl`, so a server built before the port is known refuses
 * every browser-shaped request as cross-origin and the CSRF test below would
 * pass for the wrong reason.
 */
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
  assert.equal(login.status, 200, `${email} could not sign in`);
  return login.headers.get('set-cookie').split(';')[0];
}

test('free is not something checkout sells', async () => {
  // Downgrading to free is a cancellation: a different operation, with
  // different consequences, and calling it a purchase would hide that.
  assert.deepEqual([...CHECKOUT_PLANS], ['team', 'business']);
});

test('the notes a provider must echo back name the organization and the plan', async () => {
  assert.deepEqual(attributionNotes({ slug: 'KukLabs' }, 'Team'), { kukgit_org: 'kuklabs', kukgit_plan: 'team' });
});

test('a secret is removed from whatever the provider said back', async () => {
  const said = `Invalid api key sk_test_Secret provided`;
  assert.equal(redactSecret(said, 'sk_test_Secret'), 'Invalid api key [redacted] provided');
  assert.equal(redactSecret(said, ''), said);
});

test('nested parameters encode the way Stripe reads them', async () => {
  const encoded = formEncode({ mode: 'subscription', line_items: [{ price: 'p1', quantity: 1 }], metadata: { a: 'b' } });
  const params = new URLSearchParams(encoded.toString());
  assert.equal(params.get('line_items[0][price]'), 'p1');
  assert.equal(params.get('metadata[a]'), 'b');
  assert.equal(params.get('mode'), 'subscription');
});

test('a provider with no price configured is not offered', async (t) => {
  const { config, db } = workspace(t);
  registerCheckoutProvider('razorpay', razorpayCheckout);
  assert.deepEqual(checkoutOptions(db, config), []);

  configureRazorpay(db, config);
  // Team has a plan id, Business does not. Somebody set up the first price and
  // stopped, and a button that would fail is worse than no button.
  assert.deepEqual(checkoutOptions(db, config), [{ provider: 'razorpay', plan: 'team', label: 'Team' }]);
});

test('Razorpay is asked for a subscription carrying the attribution notes', async (t) => {
  const { config, db, organization } = workspace(t);
  configureRazorpay(db, config);
  registerCheckoutProvider('razorpay', razorpayCheckout);
  const fetchImpl = recordingFetch({ body: { id: 'sub_ABC', short_url: 'https://rzp.io/i/abc' } });

  const session = await startCheckout(db, config, {
    organization, plan: 'team', provider: 'razorpay', userId: null, fetchImpl,
  });

  assert.equal(session.url, 'https://rzp.io/i/abc');
  assert.equal(session.reference, 'sub_ABC');
  const [call] = fetchImpl.calls;
  const body = JSON.parse(call.options.body);
  assert.equal(body.plan_id, 'plan_TeamMonthly');
  // Without these the webhook has no way to say whose payment it is, which is
  // the whole reason an operator was typing them by hand.
  assert.deepEqual(body.notes, { kukgit_org: 'kuklabs', kukgit_plan: 'team' });
  assert.match(call.options.headers.Authorization, /^Basic /);
});

test('Stripe is asked for a session whose subscription carries the metadata', async (t) => {
  const { config, db, organization } = workspace(t);
  configureStripe(db, config);
  registerCheckoutProvider('stripe', stripeCheckout);
  const fetchImpl = recordingFetch({ body: { id: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1' } });

  const session = await startCheckout(db, config, {
    organization, plan: 'team', provider: 'stripe', userId: null, fetchImpl,
  });

  assert.equal(session.reference, 'cs_test_1');
  const [call] = fetchImpl.calls;
  const params = new URLSearchParams(call.options.body);
  assert.equal(params.get('mode'), 'subscription');
  assert.equal(params.get('line_items[0][price]'), 'price_TeamMonthly');
  // On the subscription, not only the session. Stripe does not copy a session's
  // metadata to the subscription it creates, and the webhook reads the
  // subscription — setting only the session's produces a paid customer nobody
  // can attribute.
  assert.equal(params.get('subscription_data[metadata][kukgit_org]'), 'kuklabs');
  assert.equal(params.get('subscription_data[metadata][kukgit_plan]'), 'team');
  assert.ok(call.options.headers['Idempotency-Key'], 'Stripe is given an idempotency key');
  // A return URL that is not a route is a customer landing on an empty page
  // after paying. `#/orgs` was what this said until a browser was pointed at it.
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  for (const key of ['success_url', 'cancel_url']) {
    const route = new URL(params.get(key)).hash;
    assert.equal(route, '#/organizations');
    assert.ok(app.includes(`first === '${route.slice(2)}'`), `${route} is a route app.js renders`);
  }
});

test('clicking twice does not create two subscriptions', async (t) => {
  const { config, db, organization } = workspace(t);
  configureRazorpay(db, config);
  registerCheckoutProvider('razorpay', razorpayCheckout);
  const fetchImpl = recordingFetch((call) => ({ body: { id: `sub_${call}`, short_url: `https://rzp.io/i/${call}` } }));

  const first = await startCheckout(db, config, { organization, plan: 'team', provider: 'razorpay', fetchImpl });
  const second = await startCheckout(db, config, { organization, plan: 'team', provider: 'razorpay', fetchImpl });

  assert.equal(second.reused, true);
  assert.equal(second.url, first.url);
  // The customer who refreshes the tab must not end up with two subscriptions
  // to cancel.
  assert.equal(fetchImpl.calls.length, 1);
});

test('an abandoned session is not what somebody is shown tomorrow', async (t) => {
  const { config, db, organization } = workspace(t);
  configureRazorpay(db, config);
  registerCheckoutProvider('razorpay', razorpayCheckout);
  const fetchImpl = recordingFetch((call) => ({ body: { id: `sub_${call}`, short_url: `https://rzp.io/i/${call}` } }));

  const now = new Date('2026-08-05T10:00:00.000Z');
  await startCheckout(db, config, { organization, plan: 'team', provider: 'razorpay', fetchImpl, now });
  const later = await startCheckout(db, config, {
    organization, plan: 'team', provider: 'razorpay', fetchImpl,
    now: new Date(now.getTime() + (CHECKOUT_REUSE_MINUTES + 1) * 60_000),
  });

  assert.equal(later.reused, false);
  assert.equal(fetchImpl.calls.length, 2);
});

test('a different plan is a different checkout', async (t) => {
  const { config, db, organization } = workspace(t);
  configureRazorpay(db, config);
  putInstanceSetting(db, config, { integration: 'billing.razorpay', field: 'planIdBusiness', value: 'plan_BusinessMonthly' });
  registerCheckoutProvider('razorpay', razorpayCheckout);
  const fetchImpl = recordingFetch((call) => ({ body: { id: `sub_${call}`, short_url: `https://rzp.io/i/${call}` } }));

  await startCheckout(db, config, { organization, plan: 'team', provider: 'razorpay', fetchImpl });
  const business = await startCheckout(db, config, { organization, plan: 'business', provider: 'razorpay', fetchImpl });
  assert.equal(business.reused, false);
  assert.equal(JSON.parse(fetchImpl.calls[1].options.body).plan_id, 'plan_BusinessMonthly');
});

test('the provider refusing does not leave a session behind', async (t) => {
  const { config, db, organization } = workspace(t);
  configureRazorpay(db, config);
  registerCheckoutProvider('razorpay', razorpayCheckout);
  const fetchImpl = recordingFetch({ status: 400, body: { error: { description: `key ${RAZORPAY_SECRET} is not live` } } });

  await assert.rejects(
    () => startCheckout(db, config, { organization, plan: 'team', provider: 'razorpay', fetchImpl }),
    (error) => {
      assert.equal(error.code, 'BILLING_CHECKOUT_REFUSED');
      // Providers echo credentials back in error bodies, and this message is
      // shown to an operator and pasted into support messages.
      assert.doesNotMatch(error.message, /rzp_test_Secret/);
      assert.match(error.message, /\[redacted\]/);
      return true;
    },
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM billing_checkout_sessions').get().n, 0);
});

test('a subscription with no payable link is a failure, not a link', async (t) => {
  const { config, db, organization } = workspace(t);
  configureRazorpay(db, config);
  registerCheckoutProvider('razorpay', razorpayCheckout);
  const fetchImpl = recordingFetch({ body: { id: 'sub_NoUrl' } });

  await assert.rejects(
    () => startCheckout(db, config, { organization, plan: 'team', provider: 'razorpay', fetchImpl }),
    (error) => error.code === 'BILLING_CHECKOUT_FAILED',
  );
});

test('an unconfigured provider and an unknown one answer the same', async (t) => {
  const { config, db, organization } = workspace(t);
  registerCheckoutProvider('razorpay', razorpayCheckout);
  const unconfigured = await startCheckout(db, config, { organization, plan: 'team', provider: 'razorpay' })
    .then(() => null, (error) => error);
  const unknown = await startCheckout(db, config, { organization, plan: 'team', provider: 'paypal' })
    .then(() => null, (error) => error);
  // Which providers an instance has set up is not something a guess should be
  // able to enumerate.
  assert.equal(unconfigured.code, 'BILLING_CHECKOUT_UNAVAILABLE');
  assert.equal(unknown.code, unconfigured.code);
  assert.equal(unknown.message, unconfigured.message);
});

test('founder cannot be bought at checkout either', async (t) => {
  const { config, db, organization } = workspace(t);
  configureRazorpay(db, config);
  registerCheckoutProvider('razorpay', razorpayCheckout);
  for (const plan of ['founder', 'free', 'nonsense']) {
    await assert.rejects(
      () => startCheckout(db, config, { organization, plan, provider: 'razorpay' }),
      (error) => error.code === 'BILLING_CHECKOUT_PLAN_INVALID',
      `${plan} should not be purchasable`,
    );
  }
});

test('starting a checkout is audited without the link', async (t) => {
  const { config, db, organization } = workspace(t);
  configureRazorpay(db, config);
  registerCheckoutProvider('razorpay', razorpayCheckout);
  const fetchImpl = recordingFetch({ body: { id: 'sub_ABC', short_url: 'https://rzp.io/i/abc' } });
  await startCheckout(db, config, { organization, plan: 'team', provider: 'razorpay', fetchImpl });

  const row = db.prepare("SELECT metadata_json AS metadata FROM audit_logs WHERE action = 'billing.checkout.started'").get();
  assert.match(row.metadata, /"plan":"team"/);
  // A checkout URL starts a payment. It does not belong in a log somebody can
  // page through.
  assert.doesNotMatch(row.metadata, /rzp\.io/);
});

test('starting a checkout does not change the plan', async (t) => {
  const { config, db, organization } = workspace(t);
  configureRazorpay(db, config);
  registerCheckoutProvider('razorpay', razorpayCheckout);
  const fetchImpl = recordingFetch({ body: { id: 'sub_ABC', short_url: 'https://rzp.io/i/abc' } });
  const before = db.prepare('SELECT plan FROM organizations WHERE id = ?').get(organization.id).plan;
  await startCheckout(db, config, { organization, plan: 'team', provider: 'razorpay', fetchImpl });

  // Checkout starts a purchase; the webhook grants the plan. Anything else is a
  // second writer of `organizations.plan`, and a free upgrade for anybody who
  // can press a button.
  assert.equal(db.prepare('SELECT plan FROM organizations WHERE id = ?').get(organization.id).plan, before);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM billing_subscriptions').get().n, 0);
});

test('somebody signed out cannot start a checkout', async (t) => {
  const context = workspace(t);
  configureRazorpay(context.db, context.config);
  registerCheckoutProvider('razorpay', razorpayCheckout);
  const { origin } = await server(t, context);

  const response = await fetch(`${origin}/api/orgs/kuklabs/billing/checkout`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ plan: 'team', provider: 'razorpay' }),
  });
  assert.equal(response.status, 401);
});

test('a member who is not an administrator cannot spend the organization money', async (t) => {
  const context = workspace(t);
  const { config, db } = context;
  configureRazorpay(db, config);
  registerCheckoutProvider('razorpay', razorpayCheckout);
  const { origin } = await server(t, context);

  const { hashPassword } = await import('../src/auth.mjs');
  const organization = db.prepare("SELECT id FROM organizations WHERE slug = 'kuklabs'").get();
  const memberId = uid('usr');
  db.prepare('INSERT INTO users (id, email, display_name, password_hash) VALUES (?, ?, ?, ?)')
    .run(memberId, 'developer@kuklabs.com', 'Dev', hashPassword('secure-test-password'));
  db.prepare('INSERT INTO org_members (organization_id, user_id, role) VALUES (?, ?, ?)')
    .run(organization.id, memberId, 'maintainer');

  const cookie = await signIn(origin, 'developer@kuklabs.com', 'secure-test-password');
  const response = await fetch(`${origin}/api/orgs/kuklabs/billing/checkout`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: cookie },
    body: JSON.stringify({ plan: 'team', provider: 'razorpay' }),
  });
  // A maintainer can merge to main. That is not the same question as whether
  // they may put the organization on a recurring charge.
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, 'ORG_ADMIN_REQUIRED');

  // And they are not shown the button they would be refused for pressing.
  const billing = await fetch(`${origin}/api/orgs/kuklabs/billing`, { headers: { Cookie: cookie } });
  assert.deepEqual((await billing.json()).checkout, []);
});

test('a checkout request from another origin is refused', async (t) => {
  const context = workspace(t);
  configureRazorpay(context.db, context.config);
  registerCheckoutProvider('razorpay', razorpayCheckout);
  const { origin } = await server(t, context);
  const cookie = await signIn(origin, 'operator@kuklabs.com', 'secure-test-password');

  const response = await fetch(`${origin}/api/orgs/kuklabs/billing/checkout`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://not-kukgit.example', Cookie: cookie },
    body: JSON.stringify({ plan: 'team', provider: 'razorpay' }),
  });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, 'CSRF_BLOCKED');
});

test('an owner is told what they can buy, and buys it', async (t) => {
  const context = workspace(t);
  configureRazorpay(context.db, context.config);
  registerCheckoutProvider('razorpay', razorpayCheckout);
  const { origin } = await server(t, context);
  const cookie = await signIn(origin, 'operator@kuklabs.com', 'secure-test-password');

  const billing = await (await fetch(`${origin}/api/orgs/kuklabs/billing`, { headers: { Cookie: cookie } })).json();
  assert.deepEqual(billing.checkout, [{ provider: 'razorpay', plan: 'team', label: 'Team' }]);

  const previous = globalThis.fetch;
  globalThis.fetch = recordingFetch({ body: { id: 'sub_ABC', short_url: 'https://rzp.io/i/abc' } });
  t.after(() => { globalThis.fetch = previous; });
  const response = await previous(`${origin}/api/orgs/kuklabs/billing/checkout`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: cookie },
    body: JSON.stringify({ plan: 'team', provider: 'razorpay' }),
  });
  assert.equal(response.status, 201);
  assert.equal((await response.json()).checkout.url, 'https://rzp.io/i/abc');
});

test('a checkout for an organization somebody is not in is a 404', async (t) => {
  const context = workspace(t);
  const { db } = context;
  configureRazorpay(context.db, context.config);
  registerCheckoutProvider('razorpay', razorpayCheckout);
  const { origin } = await server(t, context);
  const cookie = await signIn(origin, 'operator@kuklabs.com', 'secure-test-password');

  db.prepare('INSERT INTO organizations (id, slug, name, plan) VALUES (?, ?, ?, ?)')
    .run(uid('org'), 'someone-else', 'Someone Else', 'free');
  const response = await fetch(`${origin}/api/orgs/someone-else/billing/checkout`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: cookie },
    body: JSON.stringify({ plan: 'team', provider: 'razorpay' }),
  });
  // Not a 403: whether that organization exists is not this person's business.
  assert.equal(response.status, 404);
});
