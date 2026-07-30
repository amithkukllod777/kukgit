import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { openDatabase, seedCore } from '../src/db.mjs';
import {
  activeEmailSuppression,
  classifySmtpRejection,
  migrateEmailProviderEvents,
  recordSmtpRejection,
} from '../src/email-provider-events.mjs';
import { migrateNotifications, processEmailOutbox, queueTransactionalEmail, retryOutboxEmail } from '../src/notifications.mjs';

// Mirrors what SmtpConnection throws: a status code plus the protocol stage that
// produced it.
function smtpError(message, { code, stage }) {
  const error = new Error(message);
  error.smtpCode = code;
  error.smtpStage = stage;
  return error;
}

function setup(t, overrides = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-smtp-rejection-test-'));
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
    emailFrom: 'noreply@example.com',
    ...overrides,
  });
  const db = openDatabase(config);
  t.after(() => db.close());
  seedCore(db, config);
  migrateNotifications(db);
  migrateEmailProviderEvents(db);
  return { config, db };
}

function outboxRow(db, id) {
  return db.prepare('SELECT status, last_error AS lastError FROM email_outbox WHERE id = ?').get(id);
}

test('only a permanent rejection at the recipient stage is classified as a hard bounce', () => {
  // The recipient handshake is the only stage that speaks about the recipient.
  assert.equal(classifySmtpRejection(smtpError('550 5.1.1 User unknown', { code: 550, stage: 'recipient' })).suppress, true);
  assert.equal(classifySmtpRejection(smtpError('550 No such user here', { code: 550, stage: 'recipient' })).suppress, true);
  assert.equal(classifySmtpRejection(smtpError('551 5.1.2 User not local', { code: 551, stage: 'recipient' })).suppress, true);
  assert.equal(classifySmtpRejection(smtpError('553 5.1.3 Bad address syntax', { code: 553, stage: 'recipient' })).suppress, true);

  // The same code at another stage describes our sender, credentials or message.
  for (const stage of ['sender', 'auth', 'data', undefined]) {
    assert.equal(
      classifySmtpRejection(smtpError('550 rejected', { code: 550, stage })).suppress,
      false,
      `stage ${stage} must not suppress`,
    );
  }

  // Capacity failures are valid addresses with temporarily unusable mailboxes.
  assert.equal(classifySmtpRejection(smtpError('552 5.2.2 Mailbox full', { code: 552, stage: 'recipient' })).suppress, false);
  assert.equal(classifySmtpRejection(smtpError('550 5.2.2 over quota', { code: 550, stage: 'recipient' })).suppress, false);
  assert.equal(classifySmtpRejection(smtpError('550 5.3.4 Message too big', { code: 550, stage: 'recipient' })).suppress, false);

  // Policy and reputation blocks are ambiguous and usually not about the recipient.
  assert.equal(classifySmtpRejection(smtpError('550 5.7.1 Message blocked', { code: 550, stage: 'recipient' })).suppress, false);
  assert.equal(classifySmtpRejection(smtpError('554 5.7.0 Rejected', { code: 554, stage: 'recipient' })).suppress, false);

  // Transient failures and transport errors always retry.
  assert.equal(classifySmtpRejection(smtpError('451 4.3.0 Try again', { code: 451, stage: 'recipient' })).suppress, false);
  assert.equal(classifySmtpRejection(new Error('socket hang up')).suppress, false);
});

test('a recorded SMTP rejection suppresses the address and files a provider event', (t) => {
  const { db } = setup(t);
  const result = recordSmtpRejection(db, {
    email: 'Gone@Example.com',
    outboxId: null,
    error: smtpError('550 5.1.1 User unknown', { code: 550, stage: 'recipient' }),
  });
  assert.equal(result.suppressed, true);
  assert.equal(result.reason, 'hard_bounce');

  const suppression = activeEmailSuppression(db, 'gone@example.com');
  assert.ok(suppression, 'address must be suppressed');
  assert.equal(suppression.reason, 'hard_bounce');

  // The event joins the same audit trail as provider webhooks, tagged as SMTP.
  const event = db.prepare("SELECT provider, event_type AS eventType, severity, reason_code AS reasonCode FROM email_provider_events WHERE recipient = ?").get('gone@example.com');
  assert.equal(event.provider, 'smtp');
  assert.equal(event.eventType, 'bounce');
  assert.equal(event.severity, 'permanent');
  assert.equal(event.reasonCode, '5.1.1');

  // The suppression references the event it came from.
  const linked = db.prepare('SELECT source_event_id AS sourceEventId FROM email_suppressions WHERE email = ?').get('gone@example.com');
  assert.ok(linked.sourceEventId, 'suppression must link its source event');
});

test('a rejection that does not prove a dead mailbox records nothing', (t) => {
  const { db } = setup(t);
  const result = recordSmtpRejection(db, {
    email: 'busy@example.com',
    error: smtpError('452 4.2.2 Mailbox full', { code: 452, stage: 'recipient' }),
  });
  assert.equal(result.suppressed, false);
  assert.equal(activeEmailSuppression(db, 'busy@example.com'), null);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM email_provider_events').get().count, 0);
});

test('recording the same message rejection twice does not duplicate the event', (t) => {
  const { config, db } = setup(t);
  // A real outbox row is required: email_provider_events.outbox_id is a foreign key.
  const queued = queueTransactionalEmail(db, config, {
    to: 'dupe@example.com',
    category: 'organization',
    subject: 'Invitation',
    text: 'Join us.',
  });
  const error = smtpError('550 5.1.1 User unknown', { code: 550, stage: 'recipient' });
  recordSmtpRejection(db, { email: 'dupe@example.com', outboxId: queued.id, error });
  recordSmtpRejection(db, { email: 'dupe@example.com', outboxId: queued.id, error });
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM email_provider_events').get().count, 1);
  assert.ok(activeEmailSuppression(db, 'dupe@example.com'));
});

test('the outbox suppresses on a permanent recipient rejection and stops delivering', async (t) => {
  const { config, db } = setup(t);
  const queued = queueTransactionalEmail(db, config, {
    to: 'gone@example.com',
    category: 'security',
    subject: 'Security alert',
    text: 'Someone signed in.',
  });

  const result = await processEmailOutbox(db, config, {
    sendEmail: async () => { throw smtpError('550 5.1.1 User unknown', { code: 550, stage: 'recipient' }); },
  });
  assert.equal(result.suppressed, 1);
  assert.equal(result.failed, 0);
  assert.equal(outboxRow(db, queued.id).status, 'cancelled');
  assert.ok(activeEmailSuppression(db, 'gone@example.com'));

  // The failing attempt stays in delivery history so the cause is auditable.
  const attempts = db.prepare('SELECT COUNT(*) AS count FROM email_delivery_attempts WHERE outbox_id = ?').get(queued.id);
  assert.equal(attempts.count, 1);

  // A newly queued message to the same address is cancelled by the outbox trigger
  // and never reaches the transport.
  const followUp = queueTransactionalEmail(db, config, {
    to: 'gone@example.com',
    category: 'security',
    subject: 'Second alert',
    text: 'Another sign-in.',
  });
  assert.equal(outboxRow(db, followUp.id).status, 'cancelled');

  let attempted = 0;
  await processEmailOutbox(db, config, {
    sendEmail: async () => { attempted += 1; return { responseCode: 250, response: 'OK' }; },
  });
  assert.equal(attempted, 0);
});

test('a transient failure retries without suppressing', async (t) => {
  const { config, db } = setup(t);
  const queued = queueTransactionalEmail(db, config, {
    to: 'busy@example.com',
    category: 'operations',
    subject: 'Backup complete',
    text: 'Snapshot verified.',
  });

  const result = await processEmailOutbox(db, config, {
    sendEmail: async () => { throw smtpError('451 4.3.0 Try again later', { code: 451, stage: 'recipient' }); },
  });
  assert.equal(result.failed, 1);
  assert.equal(result.suppressed, 0);
  assert.equal(outboxRow(db, queued.id).status, 'failed');
  assert.equal(activeEmailSuppression(db, 'busy@example.com'), null);
});

test('a sender-stage rejection never suppresses the recipient', async (t) => {
  const { config, db } = setup(t);
  const queued = queueTransactionalEmail(db, config, {
    to: 'valid@example.com',
    category: 'organization',
    subject: 'Invitation',
    text: 'Join us.',
  });

  // Our own sender address being refused must not blackhole a valid recipient.
  const result = await processEmailOutbox(db, config, {
    sendEmail: async () => { throw smtpError('550 5.7.1 Sender address rejected', { code: 550, stage: 'sender' }); },
  });
  assert.equal(result.suppressed, 0);
  assert.equal(result.failed, 1);
  assert.equal(outboxRow(db, queued.id).status, 'failed');
  assert.equal(activeEmailSuppression(db, 'valid@example.com'), null);
});

test('a suppressed message cannot be retried while the suppression is active', async (t) => {
  const { config, db } = setup(t);
  const queued = queueTransactionalEmail(db, config, {
    to: 'gone@example.com',
    category: 'organization',
    subject: 'Invitation',
    text: 'Join us.',
  });
  await processEmailOutbox(db, config, {
    sendEmail: async () => { throw smtpError('550 5.1.1 User unknown', { code: 550, stage: 'recipient' }); },
  });

  // The outbox trigger refuses the status change, so the retry finds nothing to do.
  assert.throws(() => retryOutboxEmail(db, queued.id), (error) => error.code === 'EMAIL_OUTBOX_NOT_RETRYABLE');
  assert.equal(outboxRow(db, queued.id).status, 'cancelled');
});
