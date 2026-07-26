import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.mjs';
import { hashPassword } from '../src/auth.mjs';
import { createCollaborationApiHandler, migrateCollaboration } from '../src/collaboration.mjs';
import { loadConfig } from '../src/config.mjs';
import { openDatabase, seedCore, uid } from '../src/db.mjs';

function configFor(dataDir) {
  return loadConfig({
    dataDir,
    databasePath: path.join(dataDir, 'test.db'),
    repositoriesDir: path.join(dataDir, 'repos'),
    tempDir: path.join(dataDir, 'tmp'),
    nodeEnv: 'test',
    adminEmail: 'owner@example.com',
    adminPassword: 'secure-owner-password',
    adminName: 'Organization Owner',
  });
}

function startServer(config, db) {
  const app = createApp({ config, db });
  const collaborationApi = createCollaborationApiHandler({ config, db });
  return http.createServer(async (req, res) => {
    if (await collaborationApi(req, res)) return;
    return app(req, res);
  });
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

function createUser(db, { email, password, displayName }) {
  const id = uid('usr');
  db.prepare('INSERT INTO users (id, email, password_hash, display_name) VALUES (?, ?, ?, ?)')
    .run(id, email, hashPassword(password), displayName);
  return id;
}

test('owner invites a user, invited user accepts, and owner manages a team', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-collaboration-test-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const config = configFor(dataDir);
  const db = openDatabase(config);
  t.after(() => db.close());
  migrateCollaboration(db);
  seedCore(db, config);
  const invitedUserId = createUser(db, {
    email: 'developer@example.com',
    password: 'secure-developer-password',
    displayName: 'Developer User',
  });

  const server = startServer(config, db);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;

  const ownerCookie = await login(origin, 'owner@example.com', 'secure-owner-password');
  const createInvitation = await fetch(`${origin}/api/collaboration/orgs/kuklabs/invitations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify({ email: 'developer@example.com', role: 'developer', expiresInDays: 14 }),
  });
  assert.equal(createInvitation.status, 201);
  const invitationPayload = await createInvitation.json();
  assert.match(invitationPayload.invitation.token, /^kgi_[A-Za-z0-9_-]+$/);
  assert.match(invitationPayload.invitation.acceptanceUrl, /#\/accept-invite\?token=kgi_/);

  const organizationBeforeAcceptance = await fetch(`${origin}/api/collaboration/orgs/kuklabs`, {
    headers: { Cookie: ownerCookie },
  });
  assert.equal(organizationBeforeAcceptance.status, 200);
  const beforeData = await organizationBeforeAcceptance.json();
  assert.equal(beforeData.invitations.length, 1);
  assert.equal(beforeData.invitations[0].status, 'pending');
  assert.equal(beforeData.invitations[0].token, undefined);
  assert.equal(beforeData.invitations[0].tokenHash, undefined);

  const invitedCookie = await login(origin, 'developer@example.com', 'secure-developer-password');
  const accept = await fetch(`${origin}/api/collaboration/invitations/accept`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: invitedCookie },
    body: JSON.stringify({ token: invitationPayload.invitation.token }),
  });
  assert.equal(accept.status, 200);
  const accepted = await accept.json();
  assert.equal(accepted.invitation.organization.slug, 'kuklabs');
  assert.equal(accepted.invitation.role, 'developer');

  const membership = db.prepare(`
    SELECT role FROM org_members om JOIN organizations o ON o.id = om.organization_id
    WHERE o.slug = 'kuklabs' AND om.user_id = ?
  `).get(invitedUserId);
  assert.equal(membership.role, 'developer');

  const createTeam = await fetch(`${origin}/api/collaboration/orgs/kuklabs/teams`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify({ slug: 'platform-engineering', name: 'Platform Engineering', description: 'KukGit platform owners' }),
  });
  assert.equal(createTeam.status, 201);
  const team = (await createTeam.json()).team;

  const addMember = await fetch(`${origin}/api/collaboration/orgs/kuklabs/teams/${team.id}/members`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify({ userId: invitedUserId, role: 'member' }),
  });
  assert.equal(addMember.status, 200);

  const organizationAfterAcceptance = await fetch(`${origin}/api/collaboration/orgs/kuklabs`, {
    headers: { Cookie: ownerCookie },
  });
  const afterData = await organizationAfterAcceptance.json();
  assert.equal(afterData.members.length, 2);
  assert.equal(afterData.teams.length, 1);
  assert.equal(afterData.teams[0].members.length, 2);
  assert.equal(afterData.invitations[0].status, 'accepted');

  const auditActions = db.prepare(`
    SELECT action FROM audit_logs
    WHERE action IN ('organization_invitation.created','organization_invitation.accepted','team.created','team_member.added')
    ORDER BY rowid
  `).all().map((row) => row.action);
  assert.deepEqual(auditActions, [
    'organization_invitation.created',
    'organization_invitation.accepted',
    'team.created',
    'team_member.added',
  ]);
});

test('invitation security enforces email, admin role, expiry presets and origin', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-collaboration-security-test-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const config = configFor(dataDir);
  const db = openDatabase(config);
  t.after(() => db.close());
  migrateCollaboration(db);
  seedCore(db, config);
  const developerId = createUser(db, {
    email: 'developer@example.com',
    password: 'secure-developer-password',
    displayName: 'Developer User',
  });
  const otherId = createUser(db, {
    email: 'other@example.com',
    password: 'secure-other-password',
    displayName: 'Other User',
  });
  const orgId = db.prepare("SELECT id FROM organizations WHERE slug = 'kuklabs'").get().id;
  db.prepare('INSERT INTO org_members (organization_id, user_id, role) VALUES (?, ?, ?)')
    .run(orgId, developerId, 'developer');

  const server = startServer(config, db);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const ownerCookie = await login(origin, 'owner@example.com', 'secure-owner-password');
  const developerCookie = await login(origin, 'developer@example.com', 'secure-developer-password');
  const otherCookie = await login(origin, 'other@example.com', 'secure-other-password');

  const forbiddenInvite = await fetch(`${origin}/api/collaboration/orgs/kuklabs/invitations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: developerCookie },
    body: JSON.stringify({ email: 'other@example.com', role: 'viewer', expiresInDays: 7 }),
  });
  assert.equal(forbiddenInvite.status, 403);

  const invalidExpiry = await fetch(`${origin}/api/collaboration/orgs/kuklabs/invitations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify({ email: 'other@example.com', role: 'viewer', expiresInDays: 2 }),
  });
  assert.equal(invalidExpiry.status, 400);

  const crossOrigin = await fetch(`${origin}/api/collaboration/orgs/kuklabs/invitations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: ownerCookie, Origin: 'https://attacker.example' },
    body: JSON.stringify({ email: 'other@example.com', role: 'viewer', expiresInDays: 7 }),
  });
  assert.equal(crossOrigin.status, 403);

  const create = await fetch(`${origin}/api/collaboration/orgs/kuklabs/invitations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify({ email: 'other@example.com', role: 'viewer', expiresInDays: 7 }),
  });
  assert.equal(create.status, 201);
  const invitation = (await create.json()).invitation;

  const mismatch = await fetch(`${origin}/api/collaboration/invitations/accept`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: developerCookie },
    body: JSON.stringify({ token: invitation.token }),
  });
  assert.equal(mismatch.status, 403);

  const accepted = await fetch(`${origin}/api/collaboration/invitations/accept`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: otherCookie },
    body: JSON.stringify({ token: invitation.token }),
  });
  assert.equal(accepted.status, 200);
  const membership = db.prepare('SELECT role FROM org_members WHERE organization_id = ? AND user_id = ?').get(orgId, otherId);
  assert.equal(membership.role, 'viewer');

  const replay = await fetch(`${origin}/api/collaboration/invitations/accept`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: otherCookie },
    body: JSON.stringify({ token: invitation.token }),
  });
  assert.equal(replay.status, 409);
});
