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
  createExternalAccessHistoryApiHandler,
  migrateExternalAccessExpiryGuard,
} from '../src/external-access-expiry-guard.mjs';
import { createExternalAccessInvitationDurationApiHandler } from '../src/external-access-invitation-duration.mjs';
import {
  createExternalAccessReviewsApiHandler,
  migrateExternalAccessReviews,
} from '../src/external-access-reviews.mjs';
import { migrateNotifications } from '../src/notifications.mjs';
import { migrateRepositoryAccess } from '../src/repository-access.mjs';
import { migrateRepositoryInvitations } from '../src/repository-invitations.mjs';

function setup(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-external-ui-api-'));
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
    .run(externalId, 'agency@example.com', hashPassword('secure-agency-password'), 'Agency Developer');
  const repositoryId = uid('repo');
  db.prepare(`
    INSERT INTO repositories
      (id, organization_id, slug, name, description, visibility, default_branch, created_by)
    VALUES (?, ?, 'portal', 'Portal', '', 'private', 'main', ?)
  `).run(repositoryId, orgId, ownerId);
  return { config, db, ownerId, externalId, orgId, repositoryId };
}

function authCookie(db, userId) {
  const session = createSession(db, userId);
  return sessionCookie(session.token, false).split(';')[0];
}

async function listen(t, context) {
  const durationApi = createExternalAccessInvitationDurationApiHandler(context);
  const historyApi = createExternalAccessHistoryApiHandler(context);
  const reviewsApi = createExternalAccessReviewsApiHandler(context);
  const server = http.createServer(async (req, res) => {
    if (await durationApi(req, res)) return;
    if (await historyApi(req, res)) return;
    if (await reviewsApi(req, res)) return;
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

async function request(origin, route, { method = 'GET', cookie, body, requestOrigin } = {}) {
  const response = await fetch(`${origin}${route}`, {
    method,
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(requestOrigin ? { Origin: requestOrigin } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { response, payload: await response.json().catch(() => ({})) };
}

test('repository lifecycle API lists active and expiring external access', async (t) => {
  const context = setup(t);
  context.db.prepare(`
    INSERT INTO repository_collaborators
      (repository_id, user_id, permission, added_by, expires_at, access_origin,
       last_reviewed_at, next_review_at)
    VALUES (?, ?, 'write', ?, ?, 'invitation', CURRENT_TIMESTAMP, ?)
  `).run(
    context.repositoryId,
    context.externalId,
    context.ownerId,
    new Date(Date.now() + 3 * 86400000).toISOString(),
    new Date(Date.now() + 90 * 86400000).toISOString(),
  );
  const origin = await listen(t, context);
  const result = await request(origin, '/api/external-access/kuklabs/portal', {
    cookie: authCookie(context.db, context.ownerId),
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.payload.canManage, true);
  assert.equal(result.payload.organizationAdmin, true);
  assert.equal(result.payload.grants.length, 1);
  assert.equal(result.payload.grants[0].userId, context.externalId);
  assert.equal(result.payload.grants[0].permission, 'write');
  assert.equal(result.payload.grants[0].status, 'expiring');
});

test('repository Admin configures pending invitation accepted-access duration', async (t) => {
  const context = setup(t);
  const invitationId = uid('rpi');
  context.db.prepare(`
    INSERT INTO repository_invitations
      (id, repository_id, email, permission, token_hash, token_prefix, invited_by, expires_at)
    VALUES (?, ?, 'agency@example.com', 'write', ?, 'kgr_ui', ?, ?)
  `).run(invitationId, context.repositoryId, `hash-${invitationId}`, context.ownerId, new Date(Date.now() + 14 * 86400000).toISOString());
  const origin = await listen(t, context);
  const ownerCookie = authCookie(context.db, context.ownerId);
  const result = await request(origin, `/api/external-access-invitations/kuklabs/portal/${invitationId}/duration`, {
    method: 'PATCH',
    cookie: ownerCookie,
    body: { accessDurationDays: 180 },
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.payload.invitation.accessDurationDays, 180);
  assert.equal(context.db.prepare('SELECT access_duration_days AS days FROM repository_invitations WHERE id = ?').get(invitationId).days, 180);

  const crossOrigin = await request(origin, `/api/external-access-invitations/kuklabs/portal/${invitationId}/duration`, {
    method: 'PATCH',
    cookie: ownerCookie,
    requestOrigin: 'https://attacker.example',
    body: { accessDurationDays: 365 },
  });
  assert.equal(crossOrigin.response.status, 403);
  assert.equal(crossOrigin.payload.error.code, 'CSRF_BLOCKED');
});

test('accepted or revoked invitation duration cannot be changed', async (t) => {
  const context = setup(t);
  const invitationId = uid('rpi');
  context.db.prepare(`
    INSERT INTO repository_invitations
      (id, repository_id, email, permission, token_hash, token_prefix, invited_by,
       expires_at, accepted_at, accepted_by, access_duration_days)
    VALUES (?, ?, 'agency@example.com', 'read', ?, 'kgr_done', ?, ?, CURRENT_TIMESTAMP, ?, 30)
  `).run(invitationId, context.repositoryId, `hash-${invitationId}`, context.ownerId, new Date(Date.now() + 86400000).toISOString(), context.externalId);
  const origin = await listen(t, context);
  const result = await request(origin, `/api/external-access-invitations/kuklabs/portal/${invitationId}/duration`, {
    method: 'PATCH',
    cookie: authCookie(context.db, context.ownerId),
    body: { accessDurationDays: 365 },
  });
  assert.equal(result.response.status, 409);
  assert.equal(result.payload.error.code, 'REPOSITORY_INVITATION_ACCEPTED');
});
