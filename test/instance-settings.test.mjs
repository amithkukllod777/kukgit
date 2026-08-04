import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.mjs';
import { loadConfig } from '../src/config.mjs';
import { openDatabase, seedCore } from '../src/db.mjs';
import {
  INTEGRATIONS,
  createInstanceSettingsApiHandler,
  describeIntegrations,
  instanceSetting,
  integrationCredentials,
  migrateInstanceSettings,
  putInstanceSetting,
  setIntegrationEnabled,
} from '../src/instance-settings.mjs';
import { instanceAdminEmails } from '../src/instance-admin-safe.mjs';

const RESEND_KEY = 're_live_ThisIsTheKeyNobodyMayReadBack';

function workspace(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-settings-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
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
  migrateInstanceSettings(db);
  return { config, db };
}

async function server(t, { config, db }) {
  const api = createInstanceSettingsApiHandler({
    config,
    db,
    isInstanceAdmin: (settings, user) => instanceAdminEmails(settings).includes(String(user.email || '').toLowerCase()),
  });
  const app = createApp({ config, db });
  const node = http.createServer(async (req, res) => {
    if (await api(req, res)) return;
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

test('a secret is stored encrypted and never appears in the table', async (t) => {
  const { config, db } = workspace(t);
  putInstanceSetting(db, config, { integration: 'email.resend', field: 'apiKey', value: RESEND_KEY });

  const row = db.prepare("SELECT * FROM instance_settings WHERE integration = 'email.resend' AND field = 'apiKey'").get();
  assert.equal(row.value_plain, null);
  assert.ok(row.value_ciphertext.startsWith('v1.'));
  assert.doesNotMatch(JSON.stringify(row), /ThisIsTheKey/);
  // And it comes back for the code that actually needs it.
  assert.equal(instanceSetting(db, config, 'email.resend', 'apiKey'), RESEND_KEY);
});

test('nothing the console can reach returns a secret', async (t) => {
  const context = workspace(t);
  putInstanceSetting(context.db, context.config, { integration: 'email.resend', field: 'apiKey', value: RESEND_KEY });
  putInstanceSetting(context.db, context.config, { integration: 'billing.stripe', field: 'secretKey', value: 'sk_live_alsoSecret' });
  const { origin, cookie } = await server(t, context);

  const response = await fetch(`${origin}/api/instance-admin/integrations`, { headers: { Cookie: cookie } });
  const text = await response.text();
  assert.equal(response.status, 200);
  // The one that matters. An endpoint that returns the value is one stolen
  // session away from being every credential the business has.
  assert.doesNotMatch(text, /ThisIsTheKey|sk_live_alsoSecret/);

  const { integrations } = JSON.parse(text);
  const resend = integrations.find((entry) => entry.id === 'email.resend');
  const apiKey = resend.fields.find((field) => field.key === 'apiKey');
  assert.equal(apiKey.set, true);
  assert.equal(apiKey.value, null);
  assert.match(apiKey.fingerprint, /^[0-9a-f]{12}$/);
});

test('the audit row carries a fingerprint and never the value', async (t) => {
  const { config, db } = workspace(t);
  putInstanceSetting(db, config, { integration: 'email.resend', field: 'apiKey', value: RESEND_KEY });
  const row = db.prepare("SELECT metadata_json FROM audit_logs WHERE action = 'instance_settings.updated'").get();
  // Not even a prefix: an audit log is read by more people and kept longer than
  // the settings table is.
  assert.doesNotMatch(row.metadata_json, /ThisIsTheKey|re_live/);
  assert.match(row.metadata_json, /"fingerprint":"[0-9a-f]{12}"/);
});

test('a non-secret field is readable, because it is not a secret', async (t) => {
  const context = workspace(t);
  putInstanceSetting(context.db, context.config, { integration: 'email.resend', field: 'fromAddress', value: 'noreply@kuklabs.com' });
  const { origin, cookie } = await server(t, context);

  const { integrations } = await (await fetch(`${origin}/api/instance-admin/integrations`, { headers: { Cookie: cookie } })).json();
  const field = integrations.find((entry) => entry.id === 'email.resend').fields.find((item) => item.key === 'fromAddress');
  assert.equal(field.value, 'noreply@kuklabs.com');
  assert.equal(field.secret, false);
});

test('an unknown integration or field is refused, not stored', async (t) => {
  const { config, db } = workspace(t);
  assert.throws(
    () => putInstanceSetting(db, config, { integration: 'billing.paypal', field: 'key', value: 'x' }),
    (error) => error.code === 'INTEGRATION_UNKNOWN',
  );
  assert.throws(
    () => putInstanceSetting(db, config, { integration: 'billing.stripe', field: 'sercetKey', value: 'x' }),
    (error) => error.code === 'INTEGRATION_FIELD_UNKNOWN',
  );
  // A typo that stored happily would be a value that silently never applies.
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM instance_settings').get().count, 0);
});

test('the environment wins where it is set, and the console says so', async (t) => {
  const { config, db } = workspace(t);
  putInstanceSetting(db, config, { integration: 'billing.stripe', field: 'secretKey', value: 'sk_from_console' });
  const saved = process.env.KUKGIT_STRIPE_SECRET_KEY;
  t.after(() => {
    if (saved === undefined) delete process.env.KUKGIT_STRIPE_SECRET_KEY;
    else process.env.KUKGIT_STRIPE_SECRET_KEY = saved;
  });
  process.env.KUKGIT_STRIPE_SECRET_KEY = 'sk_from_environment';

  assert.equal(instanceSetting(db, config, 'billing.stripe', 'secretKey'), 'sk_from_environment');
  const field = describeIntegrations(db, config)
    .find((entry) => entry.id === 'billing.stripe').fields.find((item) => item.key === 'secretKey');
  // "I set that and nothing changed" is otherwise unanswerable.
  assert.equal(field.source, 'environment');
});

test('complete means every field, so nothing half-configured is switched on by accident', async (t) => {
  const { config, db } = workspace(t);
  const stripe = () => describeIntegrations(db, config).find((entry) => entry.id === 'billing.stripe');
  assert.equal(stripe().complete, false);

  for (const field of INTEGRATIONS['billing.stripe'].fields) {
    putInstanceSetting(db, config, { integration: 'billing.stripe', field: field.key, value: `value-${field.key}` });
  }
  assert.equal(stripe().complete, true);
  assert.equal(stripe().enabled, false, 'configured is not the same as switched on');

  setIntegrationEnabled(db, { integration: 'billing.stripe', enabled: true });
  assert.equal(stripe().enabled, true);
});

test('credentials come back as one object for the library that needs them', async (t) => {
  const { config, db } = workspace(t);
  putInstanceSetting(db, config, { integration: 'auth.google', field: 'clientId', value: 'the-client-id' });
  putInstanceSetting(db, config, { integration: 'auth.google', field: 'clientSecret', value: 'the-client-secret' });
  assert.deepEqual(integrationCredentials(db, config, 'auth.google'), {
    clientId: 'the-client-id',
    clientSecret: 'the-client-secret',
  });
});

test('a secret rotated is a secret replaced, with a new fingerprint', async (t) => {
  const { config, db } = workspace(t);
  const first = putInstanceSetting(db, config, { integration: 'email.resend', field: 'apiKey', value: 're_one' });
  const second = putInstanceSetting(db, config, { integration: 'email.resend', field: 'apiKey', value: 're_two' });
  assert.notEqual(first.fingerprint, second.fingerprint);
  assert.equal(instanceSetting(db, config, 'email.resend', 'apiKey'), 're_two');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM instance_settings').get().count, 1);
});

test('only an instance administrator may read or write integrations', async (t) => {
  const context = workspace(t);
  const { db } = context;
  db.prepare('INSERT INTO users (id, email, password_hash, display_name) VALUES (?, ?, ?, ?)')
    .run('usr_other', 'someone@example.com', 'scrypt$x$y', 'Someone');
  const { origin } = await server(t, context);

  assert.equal((await fetch(`${origin}/api/instance-admin/integrations`)).status, 401);
  const write = await fetch(`${origin}/api/instance-admin/integrations/email.resend/fields/apiKey`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value: 'x' }),
  });
  assert.equal(write.status, 401);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM instance_settings').get().count, 0);
});

test('an operator can set, rotate and clear a credential over HTTP', async (t) => {
  const context = workspace(t);
  const { origin, cookie } = await server(t, context);
  const route = `${origin}/api/instance-admin/integrations/email.resend/fields/apiKey`;

  const put = await fetch(route, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ value: RESEND_KEY }),
  });
  assert.equal(put.status, 200);
  assert.equal(instanceSetting(context.db, context.config, 'email.resend', 'apiKey'), RESEND_KEY);

  const cleared = await fetch(route, { method: 'DELETE', headers: { Cookie: cookie } });
  assert.equal(cleared.status, 200);
  assert.equal(instanceSetting(context.db, context.config, 'email.resend', 'apiKey'), null);
});

test('an empty value is refused rather than storing a blank credential', async (t) => {
  const context = workspace(t);
  const { origin, cookie } = await server(t, context);
  const response = await fetch(`${origin}/api/instance-admin/integrations/email.resend/fields/apiKey`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ value: '   ' }),
  });
  // A blank credential is indistinguishable from a working one until the first
  // request that needs it.
  assert.equal(response.status, 422);
});

test('every declared field has a label and a stable key', async () => {
  for (const [id, entry] of Object.entries(INTEGRATIONS)) {
    assert.ok(entry.label, `${id} has no label`);
    assert.ok(entry.summary.length > 20, `${id} has no summary`);
    const keys = entry.fields.map((field) => field.key);
    assert.equal(new Set(keys).size, keys.length, `${id} has a duplicate field key`);
    for (const field of entry.fields) {
      assert.match(field.key, /^[A-Za-z]+$/, `${id}.${field.key} is not a plain key`);
      assert.equal(typeof field.secret, 'boolean', `${id}.${field.key} does not say whether it is secret`);
    }
  }
});
