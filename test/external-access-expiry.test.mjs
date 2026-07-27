import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createSession, hashPassword, sessionCookie } from '../src/auth.mjs';
import { migrateCollaboration } from '../src/collaboration.mjs';
import { loadConfig } from '../src/config.mjs';
import { openDatabase, seedCore, uid } from '../src/db.mjs';
import {
  createExternalAccessExpiryGuard,
  createExternalAccessHistoryApiHandler,
  expireExternalAccessGrants,
  migrateExternalAccessExpiryGuard,
} from '../src/external-access-expiry-guard.mjs';
import {
  createExternalAccessReviewsApiHandler,
  migrateExternalAccessReviews,
  sweepExternalAccessNotifications,
} from '../src/external-access-reviews.mjs';
import { migrateNotifications } from '../src/notifications.mjs';
import {
  getEffectiveRepositoryAccess,
  migrateRepositoryAccess,
  requireRepositoryAccess,
} from '../src/repository-access.mjs';
import { migrateRepositoryInvitations } from '../src/repository-invitations.mjs';

function setup(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-external-expiry-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const config = loadConfig({
    dataDir,
    databasePath: path.join(dataDir, 'kukgit.db'),
    repositoriesDir: path.join(dataDir, 'repos'),
    tempDir: path.join(dataDir, 'tmp'),
    nodeEnv: 'test',
    adminEmail: 'owner@example.com',
    adminPassword: 'secure-owner-password',
    adminName: 'Organization Owner',
  });
  const db = openDatabase(config);
  t.after(() => db.close());
  migrateCollaboration(db);
  migrateRepositoryAccess(db);
  migrateRepositoryInvitations(db);
  migrateExternalAccessReviews(db);
  migrateExternalAccessExpiryGuard(db);
  migrateNotifications(db);
  const { userId: ownerId, orgId } = seedCore(db, config);
  const externalId = uid('usr');
  db.prepare('INSERT INTO users (id, email, password_hash, display_name) VALUES (?, ?, ?, ?)')
    .run(externalId, 'contractor@example.com', hashPassword('secure-contractor-password'), 'External Contractor');
  const repositoryId = uid('repo');
  db.prepare(`
    INSERT INTO repositories
      (id, organization_id, slug, name, description, visibility, default_branch, created_by)
    VALUES (?, ?, 'alpha', 'Alpha', '', 'private', 'main', ?)
  `).run(repositoryId, orgId, ownerId);
  return { config, db, ownerId, externalId, orgId, repositoryId };
}

function cookie(db, userId) {
  const session = createSession(db, userId);
  return sessionCookie(session.token, false).split(';')[0];
}

async function listen(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

async function jsonRequest(origin, route, { method = 'GET', cookie: authCookie, body, originHeader } = {}) {
  const response = await fetch(`${origin}${route}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(authCookie ? { Cookie: authCookie } : {}),
      ...(originHeader ? { Origin: originHeader } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { response, payload: await response.json().catch(() => ({})) };
}

test('accepted repository invitations create a time-bounded external grant', (t) => {
  const context = setup(t);
  const invitationId = uid('rpi');
  const acceptedAt = new Date().toISOString();
  dbInsertInvitation(context, { invitationId, acceptedAt, accessDays: 30 });
  context.db.prepare(`
    INSERT INTO repository_collaborators
      (repository_id, user_id, permission, added_by)
    VALUES (?, ?, 'write', ?)
  `).run(context.repositoryId, context.externalId, context.ownerId);

  const grant = context.db.prepare(`
    SELECT permission, expires_at AS expiresAt, access_origin AS accessOrigin,
      invitation_id AS invitationId, next_review_at AS nextReviewAt
    FROM repository_collaborators WHERE repository_id = ? AND user_id = ?
  `).get(context.repositoryId, context.externalId);
  assert.equal(grant.permission, 'write');
  assert.equal(grant.accessOrigin, 'invitation');
  assert.equal(grant.invitationId, invitationId);
  assert.ok(new Date(grant.expiresAt).getTime() > Date.now() + 29 * 86400000);
  assert.ok(grant.nextReviewAt);
});

function dbInsertInvitation(context, { invitationId = uid('rpi'), acceptedAt = new Date().toISOString(), accessDays = 90 } = {}) {
  context.db.prepare(`
    INSERT INTO repository_invitations
      (id, repository_id, email, permission, token_hash, token_prefix, invited_by,
       expires_at, accepted_at, accepted_by, access_duration_days)
    VALUES (?, ?, 'contractor@example.com', 'write', ?, 'kgr_test', ?, ?, ?, ?, ?)
  `).run(
    invitationId,
    context.repositoryId,
    `hash-${invitationId}`,
    context.ownerId,
    new Date(Date.now() + 86400000).toISOString(),
    acceptedAt,
    context.externalId,
    accessDays,
  );
  return invitationId;
}

test('expired access is archived, denied and renewable without recreating the user', async (t) => {
  const context = setup(t);
  context.db.prepare(`
    INSERT INTO repository_collaborators
      (repository_id, user_id, permission, added_by, expires_at, access_origin)
    VALUES (?, ?, 'write', ?, ?, 'invitation')
  `).run(context.repositoryId, context.externalId, context.ownerId, new Date(Date.now() - 60000).toISOString());

  const expired = expireExternalAccessGrants(context.db, context.config);
  assert.equal(expired.expired, 1);
  assert.equal(context.db.prepare('SELECT COUNT(*) AS count FROM repository_collaborators').get().count, 0);
  const history = context.db.prepare('SELECT id, archived_reason AS reason FROM external_access_grant_history').get();
  assert.equal(history.reason, 'expired');
  assert.equal(getEffectiveRepositoryAccess(context.db, { userId: context.externalId, repositoryId: context.repositoryId }).permission, 'none');
  assert.throws(
    () => requireRepositoryAccess(context.db, context.externalId, { repositoryId: context.repositoryId }, 'read'),
    (error) => error.code === 'REPOSITORY_ACCESS_DENIED',
  );

  const historyApi = createExternalAccessHistoryApiHandler(context);
  const reviewApi = createExternalAccessReviewsApiHandler(context);
  const origin = await listen(t, async (req, res) => {
    if (await historyApi(req, res)) return;
    if (await reviewApi(req, res)) return;
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
  const ownerCookie = cookie(context.db, context.ownerId);
  const renewed = await jsonRequest(origin, `/api/external-access-history/kuklabs/alpha/${history.id}/renew`, {
    method: 'POST', cookie: ownerCookie, body: { accessDays: 90, permission: 'write' },
  });
  assert.equal(renewed.response.status, 200);
  assert.equal(renewed.payload.grant.userId, context.externalId);
  assert.ok(new Date(renewed.payload.grant.expiresAt).getTime() > Date.now() + 89 * 86400000);
  assert.equal(requireRepositoryAccess(context.db, context.externalId, { repositoryId: context.repositoryId }, 'write').permission, 'write');
  assert.equal(context.db.prepare('SELECT restored_at IS NOT NULL AS restored FROM external_access_grant_history WHERE id = ?').get(history.id).restored, 1);
});

test('external Repository Admin cannot extend their own access or certify Admin grants', async (t) => {
  const context = setup(t);
  context.db.prepare(`
    INSERT INTO repository_collaborators
      (repository_id, user_id, permission, added_by, expires_at)
    VALUES (?, ?, 'admin', ?, ?)
  `).run(context.repositoryId, context.externalId, context.ownerId, new Date(Date.now() + 30 * 86400000).toISOString());
  const reviewsApi = createExternalAccessReviewsApiHandler(context);
  const origin = await listen(t, async (req, res) => {
    if (await reviewsApi(req, res)) return;
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
  const externalCookie = cookie(context.db, context.externalId);
  const result = await jsonRequest(origin, `/api/external-access/kuklabs/alpha/collaborators/${context.externalId}`, {
    method: 'PATCH', cookie: externalCookie, body: { accessDays: 365 },
  });
  assert.equal(result.response.status, 403);
  assert.equal(result.payload.error.code, 'EXTERNAL_ACCESS_SELF_EXTENSION_FORBIDDEN');
});

test('organization Admin completes an access review with renewal', async (t) => {
  const context = setup(t);
  context.db.prepare(`
    INSERT INTO repository_collaborators
      (repository_id, user_id, permission, added_by, expires_at)
    VALUES (?, ?, 'read', ?, ?)
  `).run(context.repositoryId, context.externalId, context.ownerId, new Date(Date.now() + 20 * 86400000).toISOString());
  const reviewsApi = createExternalAccessReviewsApiHandler(context);
  const origin = await listen(t, async (req, res) => {
    if (await reviewsApi(req, res)) return;
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
  const ownerCookie = cookie(context.db, context.ownerId);
  const created = await jsonRequest(origin, '/api/external-access/kuklabs/reviews', {
    method: 'POST', cookie: ownerCookie, body: { name: 'Quarterly contractor review', dueInDays: 14 },
  });
  assert.equal(created.response.status, 201);
  assert.equal(created.payload.campaign.items.length, 1);
  const campaignId = created.payload.campaign.id;
  const itemId = created.payload.campaign.items[0].id;
  const decided = await jsonRequest(origin, `/api/external-access/kuklabs/reviews/${campaignId}/items/${itemId}`, {
    method: 'POST', cookie: ownerCookie, body: { decision: 'renew', accessDays: 180, note: 'Current contract remains active.' },
  });
  assert.equal(decided.response.status, 200);
  assert.equal(decided.payload.campaign.status, 'completed');
  assert.equal(decided.payload.campaign.items[0].decision, 'renew');
  const grant = context.db.prepare('SELECT expires_at AS expiresAt, last_reviewed_at AS reviewedAt FROM repository_collaborators WHERE repository_id = ? AND user_id = ?')
    .get(context.repositoryId, context.externalId);
  assert.ok(new Date(grant.expiresAt).getTime() > Date.now() + 179 * 86400000);
  assert.ok(grant.reviewedAt);
});

test('expiry guard runs before the protected request and writes one reminder', async (t) => {
  const context = setup(t);
  context.db.prepare(`
    INSERT INTO repository_collaborators
      (repository_id, user_id, permission, added_by, expires_at)
    VALUES (?, ?, 'read', ?, ?)
  `).run(context.repositoryId, context.externalId, context.ownerId, new Date(Date.now() - 1000).toISOString());
  const guard = createExternalAccessExpiryGuard({
    ...context,
    next: (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ active: context.db.prepare('SELECT COUNT(*) AS count FROM repository_collaborators').get().count }));
    },
  });
  const origin = await listen(t, guard);
  const response = await fetch(`${origin}/anything`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { active: 0 });
  const notifications = context.db.prepare(`SELECT COUNT(*) AS count FROM notifications WHERE user_id = ? AND title = 'External repository access expired'`).get(context.externalId).count;
  assert.equal(notifications, 1);
  sweepExternalAccessNotifications(context.db, context.config);
  const afterSweep = context.db.prepare(`SELECT COUNT(*) AS count FROM notifications WHERE user_id = ? AND title = 'External repository access expired'`).get(context.externalId).count;
  assert.equal(afterSweep, 1);
});

test('external access writes are same-origin protected', async (t) => {
  const context = setup(t);
  context.db.prepare(`
    INSERT INTO repository_collaborators
      (repository_id, user_id, permission, added_by, expires_at)
    VALUES (?, ?, 'read', ?, ?)
  `).run(context.repositoryId, context.externalId, context.ownerId, new Date(Date.now() + 30 * 86400000).toISOString());
  const reviewsApi = createExternalAccessReviewsApiHandler(context);
  const origin = await listen(t, async (req, res) => {
    if (await reviewsApi(req, res)) return;
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
  const ownerCookie = cookie(context.db, context.ownerId);
  const result = await jsonRequest(origin, `/api/external-access/kuklabs/alpha/collaborators/${context.externalId}`, {
    method: 'PATCH',
    cookie: ownerCookie,
    originHeader: 'https://attacker.example',
    body: { accessDays: 365 },
  });
  assert.equal(result.response.status, 403);
  assert.equal(result.payload.error.code, 'CSRF_BLOCKED');
});
