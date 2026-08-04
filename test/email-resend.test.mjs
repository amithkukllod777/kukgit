import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { openDatabase, seedCore } from '../src/db.mjs';
import { migrateInstanceSettings, putInstanceSetting } from '../src/instance-settings.mjs';
import { emailTransport, resendConfigured, sendResendMessage } from '../src/email-resend.mjs';

const API_KEY = 're_live_TheKeyThatMustNotBeLogged';

function workspace(t, overrides = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-resend-'));
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
    ...overrides,
  });
  const db = openDatabase(config);
  t.after(() => db.close());
  seedCore(db, config);
  migrateInstanceSettings(db);
  return { config, db };
}

function configureResend(db, config, { key = API_KEY, from = 'noreply@kuklabs.com', name = 'KukGit' } = {}) {
  putInstanceSetting(db, config, { integration: 'email.resend', field: 'apiKey', value: key });
  putInstanceSetting(db, config, { integration: 'email.resend', field: 'fromAddress', value: from });
  if (name) putInstanceSetting(db, config, { integration: 'email.resend', field: 'fromName', value: name });
}

/** Captures the request instead of making it. */
function stubFetch(t, reply) {
  const saved = globalThis.fetch;
  t.after(() => { globalThis.fetch = saved; });
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      text: async () => reply.body ?? '',
    };
  };
  return calls;
}

const MESSAGE = { to: 'Rahul@Example.COM', subject: 'Your invitation', text: 'Join the organization.' };

test('a message is posted to Resend with the configured sender', async (t) => {
  const { config, db } = workspace(t);
  configureResend(db, config);
  const calls = stubFetch(t, { status: 200, body: JSON.stringify({ id: 'e1b2' }) });

  const result = await sendResendMessage(db, config, MESSAGE);
  assert.equal(result.accepted, true);
  assert.match(result.response, /resend id e1b2/);

  const [call] = calls;
  assert.equal(call.url, 'https://api.resend.com/emails');
  assert.equal(call.options.headers.Authorization, `Bearer ${API_KEY}`);
  const body = JSON.parse(call.options.body);
  assert.equal(body.from, 'KukGit <noreply@kuklabs.com>');
  // Normalised, so the address the outbox recorded and the address Resend was
  // given are the same string.
  assert.deepEqual(body.to, ['rahul@example.com']);
  assert.equal(body.headers['Auto-Submitted'], 'auto-generated');
});

test('a failure is tagged with the stage the bounce classifier needs', async (t) => {
  const { config, db } = workspace(t);
  configureResend(db, config);

  const cases = [
    [401, 'auth'],
    [403, 'auth'],
    [422, 'data'],
    [429, 'transport'],
    [500, 'transport'],
  ];
  for (const [status, stage] of cases) {
    const restore = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: false, status, text: async () => JSON.stringify({ message: 'no' }) });
    // Suppressing a recipient for our own expired API key would silently
    // blackhole a valid address.
    await assert.rejects(
      () => sendResendMessage(db, config, MESSAGE),
      (error) => error.smtpStage === stage,
      `${status} should be ${stage}`,
    );
    globalThis.fetch = restore;
  }
});

test('a network failure is retryable and never reads as a bad recipient', async (t) => {
  const { config, db } = workspace(t);
  configureResend(db, config);
  const saved = globalThis.fetch;
  t.after(() => { globalThis.fetch = saved; });
  globalThis.fetch = async () => { throw new Error('ECONNRESET'); };

  await assert.rejects(
    () => sendResendMessage(db, config, MESSAGE),
    (error) => error.code === 'RESEND_UNREACHABLE' && error.smtpStage === 'transport',
  );
});

test('the API key never appears in a thrown error', async (t) => {
  const { config, db } = workspace(t);
  configureResend(db, config);
  const saved = globalThis.fetch;
  t.after(() => { globalThis.fetch = saved; });
  globalThis.fetch = async () => ({ ok: false, status: 401, text: async () => `invalid key ${API_KEY}` });

  const error = await sendResendMessage(db, config, MESSAGE).catch((thrown) => thrown);
  // Resend echoing the key back does not make it ours to log. This is where an
  // API key ends up in an outbox row that somebody later reads.
  assert.doesNotMatch(String(error.message), /TheKeyThatMustNotBeLogged/);
});

test('no key, or no from address, is not configured', async (t) => {
  const { config, db } = workspace(t);
  assert.equal(resendConfigured(db, config), false);

  putInstanceSetting(db, config, { integration: 'email.resend', field: 'apiKey', value: API_KEY });
  // A key with nothing to send from fails on the first message and looks like
  // an outage rather than a missing setting.
  assert.equal(resendConfigured(db, config), Boolean(config.emailFrom));

  putInstanceSetting(db, config, { integration: 'email.resend', field: 'fromAddress', value: 'noreply@kuklabs.com' });
  assert.equal(resendConfigured(db, config), true);
});

test('Resend wins over SMTP when both are configured', async (t) => {
  const { config, db } = workspace(t, { smtpHost: 'smtp.example.com', emailFrom: 'old@kuklabs.com' });
  assert.equal(emailTransport(db, config).name, 'smtp');

  configureResend(db, config);
  // Configuring Resend is a deliberate act; an SMTP host left in an environment
  // file is often just history.
  assert.equal(emailTransport(db, config).name, 'resend');
});

test('with neither configured, sending fails loudly rather than silently', async (t) => {
  const { config, db } = workspace(t, { smtpHost: '', emailFrom: '' });
  const transport = emailTransport(db, config);
  assert.equal(transport.name, 'none');
  assert.equal(transport.configured, false);
  // A transport that quietly accepted and dropped messages is how an
  // invitation nobody received looks like an invitation that was sent.
  assert.throws(() => transport.send(config, MESSAGE), (error) => error.code === 'EMAIL_NOT_CONFIGURED');
});

test('a rotated key takes effect on the next message, not the next restart', async (t) => {
  const { config, db } = workspace(t);
  configureResend(db, config);
  const calls = stubFetch(t, { status: 200, body: '{}' });

  await sendResendMessage(db, config, MESSAGE);
  putInstanceSetting(db, config, { integration: 'email.resend', field: 'apiKey', value: 're_rotated' });
  await sendResendMessage(db, config, MESSAGE);

  assert.equal(calls[0].options.headers.Authorization, `Bearer ${API_KEY}`);
  assert.equal(calls[1].options.headers.Authorization, 'Bearer re_rotated');
});

test('HTML is sent only when there is HTML', async (t) => {
  const { config, db } = workspace(t);
  configureResend(db, config);
  const calls = stubFetch(t, { status: 200, body: '{}' });

  await sendResendMessage(db, config, MESSAGE);
  assert.equal(JSON.parse(calls[0].options.body).html, undefined);

  await sendResendMessage(db, config, { ...MESSAGE, html: '<p>Join</p>' });
  assert.equal(JSON.parse(calls[1].options.body).html, '<p>Join</p>');
});
