import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createSession, hashPassword, sessionCookie } from '../src/auth.mjs';
import { migrateAuthKitIdentity } from '../src/authkit-identity.mjs';
import { migrateCollaboration } from '../src/collaboration.mjs';
import { loadConfig } from '../src/config.mjs';
import { audit, openDatabase, seedCore, uid } from '../src/db.mjs';
import { migrateExternalAccessExpiryGuard } from '../src/external-access-expiry-guard.mjs';
import { migrateExternalAccessReviews } from '../src/external-access-reviews.mjs';
import {
  createInstanceAdminApiHandler,
  migrateInstanceAdmin,
} from '../src/instance-admin.mjs';
import { migrateGitLfs } from '../src/git-lfs.mjs';
import { migrateNotifications } from '../src/notifications.mjs';
import { migrateOrganizationOnboarding } from '../src/organization-onboarding.mjs';
import { migrateRepositoryAccess } from '../src/repository-access.mjs';
import { migrateRepositoryInvitations } from '../src/repository-invitations.mjs';
import { migrateSshKeys } from '../src/ssh-keys.mjs';
import { migrateWebhooks } from '../src/webhooks.mjs';

function setup(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-instance-admin-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const config = loadConfig({
    dataDir,
    databasePath: path.join(dataDir, 'kukgit.db'),
    repositoriesDir: path.join(dataDir, 'repos'),
    lfsDir: path.join(dataDir, 'lfs'),
    backupsDir: path.join(dataDir, 'backups'),
    tempDir: path.join(dataDir, 'tmp'),
    nodeEnv: 'test',
    adminEmail: 'support@kuklabs.com',
    adminPassword: 'secure-support-password',
    adminName: 'Kuklabs Support',
  });
  fs.mkdirSync(config.backupsDir, { recursive: true });
  fs.writeFileSync(path.join(config.backupsDir, 'snapshot.kgbak'), 'verified-backup');
  const db = openDatabase(config);
  t.after(() => db.close());
  migrateAuthKitIdentity(db);
  migrateCollaboration(db);
  migrateOrganizationOnboarding(db);
  migrateRepositoryAccess(db);
  migrateRepositoryInvitations(db);
  migrateExternalAccessReviews(db);
  migrateExternalAccessExpiryGuard(db);
  migrateNotifications(db);
  migrateWebhooks(db);
  migrateGitLfs(db);
  migrateSshKeys(db);
  migrateInstanceAdmin(db);
  const { userId: adminId, orgId: primaryOrgId } = seedCore(db, config);

  const memberId = uid('usr');
  db.prepare('INSERT INTO users (id, email, password_hash, display_name) VALUES (?, ?, ?, ?)')
    .run(memberId, 'member@example.com', hashPassword('secure-member-password'), 'Tenant Member');
  db.prepare('INSERT INTO org_members (organization_id, user_id, role) VALUES (?, ?, ?)')
    .run(primaryOrgId, memberId, 'viewer');

  const otherOrgId = uid('org');
  db.prepare(`INSERT INTO organizations (id, slug, name, plan, description) VALUES (?, 'other-tenant', 'Other Tenant', 'free', 'Isolated tenant')`)
    .run(otherOrgId);
  const otherUserId = uid('usr');
  db.prepare('INSERT INTO users (id, email, password_hash, display_name) VALUES (?, ?, ?, ?)')
    .run(otherUserId, 'other@example.com', hashPassword('secure-other-password'), 'Other User');
  db.prepare('INSERT INTO org_members (organization_id, user_id, role) VALUES (?, ?, ?)')
    .run(otherOrgId, otherUserId, 'owner');

  const repoId = uid('repo');
  db.prepare(`
    INSERT INTO repositories
      (id, organization_id, slug, name, description, visibility, default_branch, created_by)
    VALUES (?, ?, 'alpha', 'Alpha Repository', '', 'private', 'main', ?)
  `).run(repoId, primaryOrgId, adminId);
  const otherRepoId = uid('repo');
  db.prepare(`
    INSERT INTO repositories
      (id, organization_id, slug, name, description, visibility, default_branch, created_by)
    VALUES (?, ?, 'secret-repo', 'Secret Repository', '', 'private', 'main', ?)
  `).run(otherRepoId, otherOrgId, otherUserId);

  db.prepare(`
    INSERT INTO repository_collaborators
      (repository_id, user_id, permission, added_by, expires_at)
    VALUES (?, ?, 'read', ?, ?)
  `).run(repoId, otherUserId, adminId, new Date(Date.now() + 5 * 86400000).toISOString());

  const webhookId = uid('whk');
  const deliveryId = uid('whd');
  db.prepare(`
    INSERT INTO repository_webhooks
      (id, repository_id, url, events_json, secret_ciphertext, secret_iv, secret_tag, created_by, updated_by)
    VALUES (?, ?, 'https://hooks.example.com/kukgit', '["push"]', 'ciphertext', 'iv', 'tag', ?, ?)
  `).run(webhookId, repoId, adminId, adminId);
  db.prepare(`
    INSERT INTO webhook_deliveries
      (id, webhook_id, event, payload_json, status, attempt_count, last_error)
    VALUES (?, ?, 'push', '{}', 'failure', 5, 'HTTP 500')
  `).run(deliveryId, webhookId);

  const emailId = uid('eml');
  db.prepare(`
    INSERT INTO email_outbox
      (id, user_id, to_email, category, subject, text_body, status, attempt_count, last_error)
    VALUES (?, ?, 'member@example.com', 'operations', 'Delivery failed', 'Safe body', 'failed', 8, 'SMTP 550')
  `).run(emailId, memberId);

  const oid = 'a'.repeat(64);
  db.prepare(`INSERT INTO lfs_objects (oid, size, storage_path) VALUES (?, 2048, 'objects/aa/object')`).run(oid);
  db.prepare(`INSERT INTO repository_lfs_objects (repository_id, oid, attached_by) VALUES (?, ?, ?)`).run(repoId, oid, adminId);

  audit(db, {
    organizationId: primaryOrgId,
    userId: adminId,
    action: 'support.test_secret_redaction',
    targetType: 'organization',
    targetId: primaryOrgId,
    metadata: {
      requestId: 'req_support_lookup',
      token: 'kgp_plaintext_must_not_leave_api',
      nested: { password: 'never-return', safe: 'visible' },
    },
  });
  audit(db, {
    organizationId: otherOrgId,
    userId: otherUserId,
    action: 'other.secret_activity',
    targetType: 'repository',
    targetId: otherRepoId,
    metadata: { safe: 'other-tenant-only' },
  });

  return {
    config,
    db,
    adminId,
    memberId,
    otherUserId,
    primaryOrgId,
    otherOrgId,
    repoId,
    otherRepoId,
    emailId,
    deliveryId,
  };
}

function cookie(db, userId) {
  const session = createSession(db, userId);
  return sessionCookie(session.token, false).split(';')[0];
}

async function listen(t, context) {
  const api = createInstanceAdminApiHandler(context);
  const server = http.createServer(async (req, res) => {
    if (await api(req, res)) return;
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

async function request(origin, route, { method = 'GET', cookie: authCookie, body, requestOrigin } = {}) {
  const response = await fetch(`${origin}${route}`, {
    method,
    headers: {
      ...(authCookie ? { Cookie: authCookie } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(requestOrigin ? { Origin: requestOrigin } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { response, payload: await response.json().catch(() => ({})) };
}

test('instance admin API fails closed for tenant members', async (t) => {
  const context = setup(t);
  const origin = await listen(t, context);
  const denied = await request(origin, '/api/instance-admin/overview', { cookie: cookie(context.db, context.memberId) });
  assert.equal(denied.response.status, 403);
  assert.equal(denied.payload.error.code, 'INSTANCE_ADMIN_REQUIRED');

  const allowed = await request(origin, '/api/instance-admin/status', { cookie: cookie(context.db, context.adminId) });
  assert.equal(allowed.response.status, 200);
  assert.equal(allowed.payload.instanceAdmin, true);
  assert.equal(allowed.payload.email, 'support@kuklabs.com');
});

test('overview and bounded search expose operational metadata without secrets', async (t) => {
  const context = setup(t);
  const origin = await listen(t, context);
  const adminCookie = cookie(context.db, context.adminId);
  const overview = await request(origin, '/api/instance-admin/overview', { cookie: adminCookie });
  assert.equal(overview.response.status, 200);
  assert.ok(overview.payload.overview.users.total >= 3);
  assert.ok(overview.payload.overview.organizations.total >= 2);
  assert.ok(overview.payload.overview.repositories.active >= 2);
  assert.equal(overview.payload.overview.email.failed, 1);
  assert.equal(overview.payload.overview.webhooks.failure, 1);
  assert.equal(overview.payload.overview.lfs.bytes, 2048);
  assert.equal(overview.payload.overview.backups.count, 1);

  const search = await request(origin, '/api/instance-admin/search?q=Alpha&type=all&pageSize=10', { cookie: adminCookie });
  assert.equal(search.response.status, 200);
  assert.equal(search.payload.results.repositories[0].slug, 'alpha');
  assert.equal(JSON.stringify(search.payload).includes('password_hash'), false);
  assert.equal(JSON.stringify(search.payload).includes('secret_ciphertext'), false);
});

test('organization detail is tenant-scoped and redacts audit secrets', async (t) => {
  const context = setup(t);
  const origin = await listen(t, context);
  const result = await request(origin, '/api/instance-admin/organizations/kuklabs', { cookie: cookie(context.db, context.adminId) });
  assert.equal(result.response.status, 200);
  assert.equal(result.payload.organization.slug, 'kuklabs');
  assert.equal(result.payload.repositories.some((repo) => repo.slug === 'alpha'), true);
  assert.equal(result.payload.repositories.some((repo) => repo.slug === 'secret-repo'), false);
  assert.equal(result.payload.activity.some((event) => event.action === 'other.secret_activity'), false);
  const event = result.payload.activity.find((item) => item.action === 'support.test_secret_redaction');
  assert.equal(event.metadata.token, '[redacted]');
  assert.equal(event.metadata.nested.password, '[redacted]');
  assert.equal(event.metadata.nested.safe, 'visible');
  const serialized = JSON.stringify(result.payload);
  assert.equal(serialized.includes('kgp_plaintext_must_not_leave_api'), false);
  assert.equal(serialized.includes('never-return'), false);
  assert.equal(serialized.includes('ciphertext'), false);
});

test('support notes require explicit tenant confirmation and are audited', async (t) => {
  const context = setup(t);
  const origin = await listen(t, context);
  const adminCookie = cookie(context.db, context.adminId);
  const rejected = await request(origin, '/api/instance-admin/organizations/kuklabs/notes', {
    method: 'POST', cookie: adminCookie, body: { note: 'Customer asked for access review.', confirm: 'wrong' },
  });
  assert.equal(rejected.response.status, 400);
  assert.equal(rejected.payload.error.code, 'SUPPORT_CONFIRMATION_REQUIRED');

  const created = await request(origin, '/api/instance-admin/organizations/kuklabs/notes', {
    method: 'POST', cookie: adminCookie, body: { note: 'Customer asked for access review.', confirm: 'kuklabs' },
  });
  assert.equal(created.response.status, 201);
  assert.equal(created.payload.note.body, 'Customer asked for access review.');
  const auditRow = context.db.prepare(`SELECT action FROM audit_logs WHERE target_id = ? ORDER BY created_at DESC LIMIT 1`).get(context.primaryOrgId);
  assert.equal(auditRow.action, 'instance_support.note_added');
});

test('failed email and webhook retries require IDs, CSRF protection and audit', async (t) => {
  const context = setup(t);
  const origin = await listen(t, context);
  const adminCookie = cookie(context.db, context.adminId);

  const csrf = await request(origin, `/api/instance-admin/email/${context.emailId}/retry`, {
    method: 'POST', cookie: adminCookie, requestOrigin: 'https://attacker.example', body: { confirm: context.emailId },
  });
  assert.equal(csrf.response.status, 403);
  assert.equal(csrf.payload.error.code, 'CSRF_BLOCKED');

  const email = await request(origin, `/api/instance-admin/email/${context.emailId}/retry`, {
    method: 'POST', cookie: adminCookie, body: { confirm: context.emailId },
  });
  assert.equal(email.response.status, 200);
  assert.equal(email.payload.delivery.status, 'pending');
  assert.equal(context.db.prepare('SELECT status FROM email_outbox WHERE id = ?').get(context.emailId).status, 'pending');

  const webhook = await request(origin, `/api/instance-admin/webhooks/${context.deliveryId}/retry`, {
    method: 'POST', cookie: adminCookie, body: { confirm: context.deliveryId },
  });
  assert.equal(webhook.response.status, 200);
  assert.equal(webhook.payload.delivery.status, 'pending');
  assert.equal(context.db.prepare('SELECT status FROM webhook_deliveries WHERE id = ?').get(context.deliveryId).status, 'pending');
  const actions = context.db.prepare(`SELECT action FROM audit_logs WHERE action LIKE 'instance_support.%' ORDER BY created_at`).all().map((row) => row.action);
  assert.ok(actions.includes('instance_support.email_retried'));
  assert.ok(actions.includes('instance_support.webhook_retried'));
});

test('user detail returns counts and access metadata but no credential material', async (t) => {
  const context = setup(t);
  context.db.prepare(`
    INSERT INTO personal_access_tokens
      (id, user_id, name, token_hash, token_prefix, scopes_json, expires_at)
    VALUES (?, ?, 'Support test', 'secret-hash-never-return', 'kgp_test', '["repo:read"]', ?)
  `).run(uid('pat'), context.memberId, new Date(Date.now() + 86400000).toISOString());
  const origin = await listen(t, context);
  const result = await request(origin, `/api/instance-admin/users/${context.memberId}`, { cookie: cookie(context.db, context.adminId) });
  assert.equal(result.response.status, 200);
  assert.equal(result.payload.user.email, 'member@example.com');
  assert.equal(result.payload.security.activePersonalAccessTokens, 1);
  const serialized = JSON.stringify(result.payload);
  assert.equal(serialized.includes('secure-member-password'), false);
  assert.equal(serialized.includes('secret-hash-never-return'), false);
  assert.equal(serialized.includes('tokenHash'), false);
  assert.equal(serialized.includes('passwordHash'), false);
});
