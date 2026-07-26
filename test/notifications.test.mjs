import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.mjs';
import { hashPassword } from '../src/auth.mjs';
import { loadConfig } from '../src/config.mjs';
import { openDatabase, seedCore, uid } from '../src/db.mjs';
import {
  createNotification,
  createNotificationsApiHandler,
  listEmailOutbox,
  listNotificationPreferences,
  listNotifications,
  markAllNotificationsRead,
  migrateNotifications,
  processEmailOutbox,
  queueTransactionalEmail,
  scheduleTokenExpiryNotifications,
  setNotificationRead,
  updateNotificationPreferences,
} from '../src/notifications.mjs';
import { createPersonalAccessToken } from '../src/tokens.mjs';

function setup(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-notifications-test-'));
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
    adminName: 'Repository Owner',
    smtpHost: 'smtp.test',
    smtpPort: 2525,
    smtpSecure: false,
    smtpStartTls: false,
    smtpUser: '',
    smtpPassword: '',
    emailFrom: 'noreply@kukgit.test',
    emailFromName: 'KukGit',
    emailWorkerIntervalMs: 30000,
    emailMaxAttempts: 3,
    emailBatchSize: 20,
  });
  const db = openDatabase(config);
  t.after(() => db.close());
  const seeded = seedCore(db, config);
  migrateNotifications(db);
  const secondUserId = uid('usr');
  db.prepare('INSERT INTO users (id, email, password_hash, display_name) VALUES (?, ?, ?, ?)')
    .run(secondUserId, 'developer@example.com', hashPassword('secure-developer-password'), 'Developer');
  migrateNotifications(db);
  return { config, db, ownerId: seeded.userId, secondUserId };
}

async function listen(t, context) {
  const app = createApp({ config: context.config, db: context.db });
  const notifications = createNotificationsApiHandler({ config: context.config, db: context.db });
  const server = http.createServer(async (req, res) => {
    if (await notifications(req, res)) return;
    return app(req, res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  context.config.baseUrl = origin;
  return origin;
}

async function login(origin, email, password) {
  const response = await fetch(`${origin}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(response.status, 200);
  return response.headers.get('set-cookie').split(';')[0];
}

test('creates deduplicated inbox and email records and manages read lifecycle', (t) => {
  const context = setup(t);
  const first = createNotification(context.db, context.config, {
    userId: context.ownerId,
    category: 'security',
    title: 'Token expires soon',
    body: 'Rotate the developer token before expiry.',
    link: '#/settings',
    dedupeKey: 'security:test-token:7',
    metadata: { tokenId: 'pat_test' },
    email: { subject: 'Token expires soon', text: 'Rotate the developer token before expiry.' },
  });
  const duplicate = createNotification(context.db, context.config, {
    userId: context.ownerId,
    category: 'security',
    title: 'Token expires soon',
    body: 'Rotate the developer token before expiry.',
    link: '#/settings',
    dedupeKey: 'security:test-token:7',
    metadata: { tokenId: 'pat_test' },
    email: { subject: 'Token expires soon', text: 'Rotate the developer token before expiry.' },
  });
  assert.equal(first.notification.id, duplicate.notification.id);
  assert.equal(context.db.prepare('SELECT COUNT(*) AS count FROM notifications').get().count, 1);
  assert.equal(context.db.prepare('SELECT COUNT(*) AS count FROM email_outbox').get().count, 1);

  let inbox = listNotifications(context.db, context.ownerId);
  assert.equal(inbox.unreadCount, 1);
  setNotificationRead(context.db, context.ownerId, first.notification.id, true);
  inbox = listNotifications(context.db, context.ownerId);
  assert.equal(inbox.unreadCount, 0);
  setNotificationRead(context.db, context.ownerId, first.notification.id, false);
  assert.equal(listNotifications(context.db, context.ownerId).unreadCount, 1);
  assert.equal(markAllNotificationsRead(context.db, context.ownerId).updated, 1);
});

test('notification preferences independently disable in-app and email channels', (t) => {
  const context = setup(t);
  const preferences = listNotificationPreferences(context.db, context.secondUserId);
  const updated = preferences.map((item) => item.category === 'organization'
    ? { category: item.category, inAppEnabled: false, emailEnabled: false }
    : item);
  updateNotificationPreferences(context.db, context.secondUserId, updated);
  const result = createNotification(context.db, context.config, {
    userId: context.secondUserId,
    category: 'organization',
    title: 'Organization update',
    body: 'A team membership changed.',
    dedupeKey: 'organization:disabled-test',
    email: { subject: 'Organization update', text: 'A team membership changed.' },
  });
  assert.equal(result.notification, null);
  assert.equal(result.email, null);
  assert.equal(listNotifications(context.db, context.secondUserId).notifications.length, 0);
});

test('email outbox records successful and retryable failed attempts without secrets', async (t) => {
  const context = setup(t);
  queueTransactionalEmail(context.db, context.config, {
    userId: context.ownerId,
    to: 'owner@example.com',
    category: 'operations',
    subject: 'Backup completed',
    text: 'The verified backup completed.',
    dedupeKey: 'email:backup:test',
  });
  const success = await processEmailOutbox(context.db, context.config, {
    sendEmail: async () => ({ responseCode: 250, response: 'queued' }),
  });
  assert.equal(success.sent, 1);
  assert.equal(listEmailOutbox(context.db).emails[0].status, 'sent');

  queueTransactionalEmail(context.db, context.config, {
    userId: context.ownerId,
    to: 'owner@example.com',
    category: 'operations',
    subject: 'Webhook failed',
    text: 'Webhook delivery failed.',
    dedupeKey: 'email:webhook:test',
  });
  const failed = await processEmailOutbox(context.db, context.config, {
    sendEmail: async () => { throw new Error('AUTH PLAIN super-secret-password token=hidden-token'); },
  });
  assert.equal(failed.failed, 1);
  const row = listEmailOutbox(context.db).emails.find((email) => email.subject === 'Webhook failed');
  assert.equal(row.status, 'failed');
  assert.doesNotMatch(row.lastError, /super-secret-password|hidden-token/);
  assert.match(row.lastError, /REDACTED/);
  assert.equal(context.db.prepare("SELECT COUNT(*) AS count FROM email_delivery_attempts WHERE status = 'failure'").get().count, 1);
});

test('schedules token expiry reminders without exposing the token secret', (t) => {
  const context = setup(t);
  const token = createPersonalAccessToken(context.db, context.ownerId, {
    name: 'CI runner',
    scopes: ['repo:read', 'repo:write'],
    expiresAt: new Date(Date.now() + 2 * 86400000).toISOString(),
  });
  const result = scheduleTokenExpiryNotifications(context.db, context.config, new Date());
  assert.equal(result.candidates, 1);
  assert.equal(result.created, 1);
  const notification = listNotifications(context.db, context.ownerId).notifications[0];
  assert.match(notification.body, /CI runner/);
  assert.match(notification.body, new RegExp(token.tokenPrefix));
  assert.doesNotMatch(notification.body, new RegExp(token.token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(context.db.prepare('SELECT COUNT(*) AS count FROM email_outbox').get().count, 1);
  scheduleTokenExpiryNotifications(context.db, context.config, new Date());
  assert.equal(context.db.prepare('SELECT COUNT(*) AS count FROM notifications').get().count, 1);
});

test('notification API enforces ownership, CSRF, preferences and instance admin access', async (t) => {
  const context = setup(t);
  const origin = await listen(t, context);
  const ownerCookie = await login(origin, 'owner@example.com', 'secure-owner-password');
  const developerCookie = await login(origin, 'developer@example.com', 'secure-developer-password');
  const created = createNotification(context.db, context.config, {
    userId: context.ownerId,
    category: 'operations',
    title: 'Backup ready',
    body: 'A verified backup is available.',
    dedupeKey: 'operations:api-test',
  });

  const ownerList = await fetch(`${origin}/api/notifications`, { headers: { Cookie: ownerCookie } });
  assert.equal(ownerList.status, 200);
  assert.equal((await ownerList.json()).unreadCount, 1);

  const otherRead = await fetch(`${origin}/api/notifications/${created.notification.id}/read`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: developerCookie }, body: '{}',
  });
  assert.equal(otherRead.status, 404);

  const crossOrigin = await fetch(`${origin}/api/notifications/read-all`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie, Origin: 'https://attacker.example' }, body: '{}',
  });
  assert.equal(crossOrigin.status, 403);

  const preferences = await fetch(`${origin}/api/notifications/preferences`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: developerCookie },
    body: JSON.stringify({ preferences: [{ category: 'pull_request', inAppEnabled: true, emailEnabled: true }] }),
  });
  assert.equal(preferences.status, 200);

  const forbiddenAdmin = await fetch(`${origin}/api/notifications/admin/outbox`, { headers: { Cookie: developerCookie } });
  assert.equal(forbiddenAdmin.status, 403);
  const admin = await fetch(`${origin}/api/notifications/admin/outbox`, { headers: { Cookie: ownerCookie } });
  assert.equal(admin.status, 200);
  assert.equal((await admin.json()).configured, true);
});
