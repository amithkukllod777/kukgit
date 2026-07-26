import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.mjs';
import { hashPassword } from '../src/auth.mjs';
import { createCollaborationApiHandler, migrateCollaboration } from '../src/collaboration.mjs';
import {
  createCollaborationNotificationCapture,
  createInvitationResendApiHandler,
} from '../src/collaboration-notifications-safe.mjs';
import { loadConfig } from '../src/config.mjs';
import { openDatabase, seedCore, uid } from '../src/db.mjs';
import { listEmailOutbox, listNotifications, migrateNotifications } from '../src/notifications.mjs';

function setup(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-collaboration-notifications-test-'));
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
    adminName: 'Organization Owner',
    smtpHost: 'smtp.test',
    smtpPort: 2525,
    smtpSecure: false,
    smtpStartTls: false,
    emailFrom: 'noreply@kukgit.test',
    emailMaxAttempts: 3,
    emailBatchSize: 20,
  });
  const db = openDatabase(config);
  t.after(() => db.close());
  migrateCollaboration(db);
  const seeded = seedCore(db, config);
  const developerId = uid('usr');
  db.prepare('INSERT INTO users (id, email, password_hash, display_name) VALUES (?, ?, ?, ?)')
    .run(developerId, 'developer@example.com', hashPassword('secure-developer-password'), 'Developer User');
  migrateNotifications(db);
  return { config, db, ownerId: seeded.userId, developerId };
}

async function listen(t, context) {
  const app = createApp({ config: context.config, db: context.db });
  const collaboration = createCollaborationApiHandler({ config: context.config, db: context.db });
  const resend = createInvitationResendApiHandler({ config: context.config, db: context.db });
  const next = async (req, res) => {
    if (await resend(req, res)) return;
    if (await collaboration(req, res)) return;
    return app(req, res);
  };
  const captured = createCollaborationNotificationCapture({ config: context.config, db: context.db, next });
  const server = http.createServer(captured);
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

function settle() {
  return new Promise((resolve) => setImmediate(resolve));
}

test('creation queues invitation email and acceptance notifies inviter and member', async (t) => {
  const context = setup(t);
  const origin = await listen(t, context);
  const ownerCookie = await login(origin, 'owner@example.com', 'secure-owner-password');
  const developerCookie = await login(origin, 'developer@example.com', 'secure-developer-password');

  const create = await fetch(`${origin}/api/collaboration/orgs/kuklabs/invitations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify({ email: 'developer@example.com', role: 'developer', expiresInDays: 14 }),
  });
  assert.equal(create.status, 201);
  const invitation = (await create.json()).invitation;
  await settle();

  const developerInbox = listNotifications(context.db, context.developerId);
  assert.equal(developerInbox.unreadCount, 1);
  assert.match(developerInbox.notifications[0].title, /Invitation to join/);
  assert.match(developerInbox.notifications[0].link, /accept-invite/);
  const inviteEmail = listEmailOutbox(context.db).emails.find((email) => email.subject.includes('Invitation to join'));
  assert.ok(inviteEmail);
  assert.equal(inviteEmail.toEmail, 'developer@example.com');

  const accept = await fetch(`${origin}/api/collaboration/invitations/accept`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: developerCookie },
    body: JSON.stringify({ token: invitation.token }),
  });
  assert.equal(accept.status, 200);
  await settle();

  assert.ok(listNotifications(context.db, context.ownerId).notifications.some((item) => item.title.includes('joined Kuklabs')));
  assert.ok(listNotifications(context.db, context.developerId).notifications.some((item) => item.title.includes('You joined')));
  const emailSubjects = listEmailOutbox(context.db).emails.map((email) => email.subject);
  assert.ok(emailSubjects.some((subject) => subject.includes('joined Kuklabs')));
  assert.ok(emailSubjects.some((subject) => subject.includes('You joined Kuklabs')));
});

test('resend revokes the old link, creates a fresh secret and queues one new email', async (t) => {
  const context = setup(t);
  const origin = await listen(t, context);
  const ownerCookie = await login(origin, 'owner@example.com', 'secure-owner-password');

  const create = await fetch(`${origin}/api/collaboration/orgs/kuklabs/invitations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify({ email: 'external@example.com', role: 'viewer', expiresInDays: 7 }),
  });
  const original = (await create.json()).invitation;
  await settle();

  const resend = await fetch(`${origin}/api/collaboration/orgs/kuklabs/invitations/${original.id}/resend`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify({ expiresInDays: 30 }),
  });
  assert.equal(resend.status, 201);
  const replacement = (await resend.json()).invitation;
  assert.notEqual(replacement.id, original.id);
  assert.notEqual(replacement.token, original.token);
  assert.match(replacement.acceptanceUrl, /kgi_/);
  assert.ok(context.db.prepare('SELECT revoked_at AS revokedAt FROM organization_invitations WHERE id = ?').get(original.id).revokedAt);
  assert.equal(context.db.prepare('SELECT accepted_at AS acceptedAt FROM organization_invitations WHERE id = ?').get(replacement.id).acceptedAt, null);
  assert.equal(context.db.prepare("SELECT COUNT(*) AS count FROM email_outbox WHERE to_email = 'external@example.com'").get().count, 2);

  const auditMetadata = context.db.prepare("SELECT metadata_json AS metadata FROM audit_logs WHERE action = 'organization_invitation.resent'").get().metadata;
  assert.doesNotMatch(auditMetadata, /kgi_/);
  assert.doesNotMatch(auditMetadata, new RegExp(replacement.token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('resend requires organization Admin and blocks CSRF', async (t) => {
  const context = setup(t);
  const origin = await listen(t, context);
  const ownerCookie = await login(origin, 'owner@example.com', 'secure-owner-password');
  const developerCookie = await login(origin, 'developer@example.com', 'secure-developer-password');
  const orgId = context.db.prepare("SELECT id FROM organizations WHERE slug = 'kuklabs'").get().id;
  context.db.prepare("INSERT INTO org_members (organization_id, user_id, role) VALUES (?, ?, 'developer')").run(orgId, context.developerId);

  const create = await fetch(`${origin}/api/collaboration/orgs/kuklabs/invitations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify({ email: 'external@example.com', role: 'viewer', expiresInDays: 7 }),
  });
  const invitation = (await create.json()).invitation;

  const forbidden = await fetch(`${origin}/api/collaboration/orgs/kuklabs/invitations/${invitation.id}/resend`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: developerCookie },
    body: '{}',
  });
  assert.equal(forbidden.status, 403);

  const csrf = await fetch(`${origin}/api/collaboration/orgs/kuklabs/invitations/${invitation.id}/resend`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: ownerCookie, Origin: 'https://attacker.example' },
    body: '{}',
  });
  assert.equal(csrf.status, 403);
});
