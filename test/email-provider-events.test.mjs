import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createSession, sessionCookie } from '../src/auth.mjs';
import { loadConfig } from '../src/config.mjs';
import { openDatabase, seedCore } from '../src/db.mjs';
import {
  activeEmailSuppression,
  ingestEmailProviderEvent,
  listEmailSuppressions,
  migrateEmailProviderEvents,
  unsuppressEmail,
  verifyEmailProviderSignature,
} from '../src/email-provider-events.mjs';
import { createEmailProviderEventsApiHandler } from '../src/email-provider-events-safe.mjs';
import { migrateNotifications, processEmailOutbox, queueTransactionalEmail } from '../src/notifications.mjs';

function setup(t, overrides = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-email-provider-test-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const config = loadConfig({
    dataDir,
    databasePath: path.join(dataDir, 'kukgit.db'),
    repositoriesDir: path.join(dataDir, 'repos'),
    tempDir: path.join(dataDir, 'tmp'),
    nodeEnv: 'test',
    baseUrl: 'http://127.0.0.1:8787',
    adminEmail: 'owner@example.com',
    adminPassword: 'secure-owner-password',
    adminName: 'Owner',
    smtpHost: 'smtp.test',
    emailProviderWebhookSecret: 'test-email-provider-webhook-secret-with-strong-entropy',
    emailProviderWebhookToleranceSeconds: 300,
    emailSoftBounceThreshold: 3,
    emailSoftBounceWindowDays: 7,
    emailSoftBounceSuppressionDays: 30,
    ...overrides,
  });
  const db = openDatabase(config);
  t.after(() => db.close());
  const seeded = seedCore(db, config);
  migrateNotifications(db);
  migrateEmailProviderEvents(db);
  const owner = db.prepare('SELECT id, email, display_name AS displayName FROM users WHERE id = ?').get(seeded.userId);
  return { config, db, owner };
}

function signedHeaders(config, body, timestamp = Math.floor(Date.now() / 1000)) {
  const signature = crypto.createHmac('sha256', config.emailProviderWebhookSecret)
    .update(`${timestamp}.`)
    .update(body)
    .digest('hex');
  return {
    'content-type': 'application/json',
    'x-kukgit-email-timestamp': String(timestamp),
    'x-kukgit-email-signature-256': `sha256=${signature}`,
  };
}

function event(id, type, recipient = 'recipient@example.com', extra = {}) {
  return {
    id,
    provider: 'test-provider',
    type,
    recipient,
    occurred_at: new Date().toISOString(),
    ...extra,
  };
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

test('email provider signature is timing-safe, bounded and freshness checked', (t) => {
  const { config } = setup(t);
  const body = Buffer.from(JSON.stringify(event('evt_signature', 'delivered')));
  const headers = signedHeaders(config, body);
  assert.doesNotThrow(() => verifyEmailProviderSignature(config, headers, body));
  assert.throws(
    () => verifyEmailProviderSignature(config, { ...headers, 'x-kukgit-email-signature-256': 'sha256=' + '0'.repeat(64) }, body),
    (error) => error.code === 'EMAIL_PROVIDER_SIGNATURE_INVALID',
  );
  assert.throws(
    () => verifyEmailProviderSignature(config, signedHeaders(config, body, Math.floor(Date.now() / 1000) - 1000), body),
    (error) => error.code === 'EMAIL_PROVIDER_TIMESTAMP_STALE',
  );
});

test('hard bounce suppresses immediately, cancels queued mail and duplicate is harmless', async (t) => {
  const { config, db } = setup(t);
  const recipient = 'hard-bounce@example.com';
  const queued = queueTransactionalEmail(db, config, {
    to: recipient,
    category: 'operations',
    subject: 'Queued before bounce',
    text: 'This message must be cancelled after a hard bounce.',
    dedupeKey: 'hard-bounce-before',
  });
  const payload = event('evt_hard_1', 'hard_bounce', recipient);
  const raw = Buffer.from(JSON.stringify(payload));
  const first = ingestEmailProviderEvent(db, config, payload, raw);
  assert.equal(first.duplicate, false);
  assert.equal(first.suppressed, true);
  assert.equal(activeEmailSuppression(db, recipient).reason, 'hard_bounce');
  assert.equal(db.prepare('SELECT status FROM email_outbox WHERE id = ?').get(queued.id).status, 'cancelled');
  const second = ingestEmailProviderEvent(db, config, payload, raw);
  assert.equal(second.duplicate, true);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM email_provider_events').get().count, 1);

  const after = queueTransactionalEmail(db, config, {
    to: recipient,
    category: 'operations',
    subject: 'Queued after bounce',
    text: 'Database trigger must cancel this message.',
    dedupeKey: 'hard-bounce-after',
  });
  assert.equal(db.prepare('SELECT status FROM email_outbox WHERE id = ?').get(after.id).status, 'cancelled');
  let sends = 0;
  const processed = await processEmailOutbox(db, config, {
    sendEmail: async () => { sends += 1; return { response: 'accepted' }; },
  });
  assert.equal(sends, 0);
  assert.equal(processed.sent, 0);
});

test('complaint is permanent and soft bounces suppress only after configured threshold', (t) => {
  const { config, db } = setup(t);
  const complaint = ingestEmailProviderEvent(db, config, event('evt_complaint_1', 'complaint', 'spam@example.com'));
  assert.equal(complaint.suppressed, true);
  const complaintSuppression = activeEmailSuppression(db, 'spam@example.com');
  assert.equal(complaintSuppression.reason, 'complaint');
  assert.equal(complaintSuppression.expiresAt, null);

  const recipient = 'soft@example.com';
  const first = ingestEmailProviderEvent(db, config, event('evt_soft_1', 'deferred', recipient));
  const second = ingestEmailProviderEvent(db, config, event('evt_soft_2', 'soft_bounce', recipient));
  assert.equal(first.suppressed, false);
  assert.equal(second.suppressed, false);
  assert.equal(activeEmailSuppression(db, recipient), null);
  const third = ingestEmailProviderEvent(db, config, event('evt_soft_3', 'deferred', recipient));
  assert.equal(third.suppressed, true);
  const suppression = activeEmailSuppression(db, recipient);
  assert.equal(suppression.reason, 'soft_bounce_threshold');
  assert.equal(suppression.softBounceCount, 3);
  assert.ok(new Date(suppression.expiresAt).getTime() > Date.now());
});

test('delivered resets temporary health but never silently removes an active suppression', (t) => {
  const { config, db } = setup(t);
  const recipient = 'delivered@example.com';
  ingestEmailProviderEvent(db, config, event('evt_delivered_soft_1', 'deferred', recipient));
  ingestEmailProviderEvent(db, config, event('evt_delivered_soft_2', 'deferred', recipient));
  ingestEmailProviderEvent(db, config, event('evt_delivered_1', 'delivered', recipient));
  const health = db.prepare('SELECT soft_bounce_count AS count FROM email_recipient_health WHERE email = ?').get(recipient);
  assert.equal(health.count, 0);

  ingestEmailProviderEvent(db, config, event('evt_delivered_complaint', 'complaint', recipient));
  ingestEmailProviderEvent(db, config, event('evt_delivered_2', 'delivered', recipient));
  assert.equal(activeEmailSuppression(db, recipient).reason, 'complaint');
});

test('instance administrator must explicitly confirm and document unsuppression', (t) => {
  const { config, db, owner } = setup(t);
  const recipient = 'review@example.com';
  ingestEmailProviderEvent(db, config, event('evt_review_1', 'hard_bounce', recipient));
  assert.throws(
    () => unsuppressEmail(db, config, owner, recipient, { confirmEmail: 'wrong@example.com', note: 'Verified correction.' }),
    (error) => error.code === 'EMAIL_UNSUPPRESS_CONFIRMATION_INVALID',
  );
  assert.throws(
    () => unsuppressEmail(db, config, owner, recipient, { confirmEmail: recipient, note: '' }),
    (error) => error.code === 'EMAIL_UNSUPPRESS_NOTE_INVALID',
  );
  const result = unsuppressEmail(db, config, owner, recipient, {
    confirmEmail: recipient,
    note: 'Mailbox was corrected and recipient requested delivery again.',
  });
  assert.equal(result.unsuppressed, true);
  assert.equal(activeEmailSuppression(db, recipient), null);
  assert.equal(listEmailSuppressions(db, { activeOnly: true }).stats.active, 0);
  const audit = db.prepare("SELECT metadata_json AS metadataJson FROM audit_logs WHERE action = 'instance_support.email_unsuppressed'").get();
  assert.ok(audit);
  assert.equal(audit.metadataJson.includes(recipient), false);
});

test('signed provider API accepts events, sanitizes provider IDs and enforces admin origin', async (t) => {
  const { config, db, owner } = setup(t);
  const handler = createEmailProviderEventsApiHandler({ config, db });
  const server = http.createServer(async (req, res) => {
    if (await handler(req, res)) return;
    res.writeHead(404).end();
  });
  t.after(() => server.close());
  const origin = await listen(server);
  config.baseUrl = origin;
  const payload = event('evt_api_1', 'hard_bounce', 'api@example.com', { message_id: 'provider-message-not-an-outbox-id' });
  const raw = Buffer.from(JSON.stringify(payload));
  const webhook = await fetch(`${origin}/api/email-provider/events`, {
    method: 'POST',
    headers: signedHeaders(config, raw),
    body: raw,
  });
  assert.equal(webhook.status, 202);
  const stored = db.prepare('SELECT outbox_id AS outboxId FROM email_provider_events WHERE provider_event_id = ?').get('evt_api_1');
  assert.equal(stored.outboxId, null);
  const replay = await fetch(`${origin}/api/email-provider/events`, {
    method: 'POST',
    headers: signedHeaders(config, raw),
    body: raw,
  });
  assert.equal(replay.status, 200);

  const anonymous = await fetch(`${origin}/api/email-provider/admin/suppressions`, {
    headers: { Origin: origin },
  });
  assert.equal(anonymous.status, 401);

  const session = createSession(db, owner.id);
  const cookie = sessionCookie(session.token, false).split(';')[0];
  const admin = await fetch(`${origin}/api/email-provider/admin/suppressions`, {
    headers: { Origin: origin, Cookie: cookie },
  });
  assert.equal(admin.status, 200);
  const body = await admin.json();
  assert.equal(body.stats.active, 1);

  const crossOrigin = await fetch(`${origin}/api/email-provider/admin/suppressions`, {
    headers: { Origin: 'https://evil.example', Cookie: cookie },
  });
  assert.equal(crossOrigin.status, 403);
});
