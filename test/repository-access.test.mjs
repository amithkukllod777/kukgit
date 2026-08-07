import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.mjs';
import { hashPassword } from '../src/auth.mjs';
import { migrateCollaboration } from '../src/collaboration.mjs';
import { loadConfig } from '../src/config.mjs';
import { openDatabase, seedCore, uid } from '../src/db.mjs';
import { authorizeGitCredential } from '../src/git-http.mjs';
import { createBareRepository } from '../src/git.mjs';
import {
  createRepositoryAccessApiHandler,
  createRepositoryAccessGuard,
  getEffectiveRepositoryAccess,
  migrateRepositoryAccess,
  permissionAtLeast,
  requireRepositoryAccess,
  requiredPermissionForRepositoryRequest,
} from '../src/repository-access.mjs';
import { createPersonalAccessToken } from '../src/tokens.mjs';

function configFor(dataDir) {
  return loadConfig({
    dataDir,
    databasePath: path.join(dataDir, 'test.db'),
    repositoriesDir: path.join(dataDir, 'repos'),
    tempDir: path.join(dataDir, 'tmp'),
    nodeEnv: 'test',
    adminEmail: 'owner@example.com',
    adminPassword: 'secure-owner-password',
    adminName: 'Repository Owner',
  });
}

function createUser(db, { email, password, displayName, organizationId, role = null }) {
  const id = uid('usr');
  db.prepare('INSERT INTO users (id, email, password_hash, display_name) VALUES (?, ?, ?, ?)')
    .run(id, email, hashPassword(password), displayName);
  if (organizationId && role) {
    db.prepare('INSERT INTO org_members (organization_id, user_id, role) VALUES (?, ?, ?)')
      .run(organizationId, id, role);
  }
  return id;
}

function createRepository(db, config, { organizationId, createdBy, slug = 'access-demo' }) {
  createBareRepository(config, 'kuklabs', slug);
  const id = uid('repo');
  db.prepare(`
    INSERT INTO repositories (id, organization_id, slug, name, description, visibility, default_branch, created_by)
    VALUES (?, ?, ?, ?, ?, 'private', 'main', ?)
  `).run(id, organizationId, slug, 'Access Demo', 'Repository access test', createdBy);
  return id;
}

function startServer(config, db) {
  const app = createApp({ config, db });
  const accessApi = createRepositoryAccessApiHandler({ config, db });
  const guard = createRepositoryAccessGuard({ config, db, app });
  return http.createServer(async (req, res) => {
    if (await accessApi(req, res)) return;
    if (await guard(req, res)) return;
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

test('combines organization, direct and team permissions and enforces browser APIs', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-repository-access-test-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const config = configFor(dataDir);
  const db = openDatabase(config);
  t.after(() => db.close());
  migrateCollaboration(db);
  migrateRepositoryAccess(db);
  const { userId: ownerId, orgId } = seedCore(db, config);
  const viewerId = createUser(db, {
    email: 'viewer@example.com',
    password: 'secure-viewer-password',
    displayName: 'Viewer User',
    organizationId: orgId,
    role: 'viewer',
  });
  const repositoryId = createRepository(db, config, { organizationId: orgId, createdBy: ownerId });

  const teamId = uid('team');
  db.prepare(`INSERT INTO teams (id, organization_id, slug, name, description, created_by) VALUES (?, ?, ?, ?, ?, ?)`) 
    .run(teamId, orgId, 'platform', 'Platform', 'Platform developers', ownerId);
  db.prepare('INSERT INTO team_members (team_id, user_id, role, added_by) VALUES (?, ?, ?, ?)')
    .run(teamId, viewerId, 'member', ownerId);

  const server = startServer(config, db);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const ownerCookie = await login(origin, 'owner@example.com', 'secure-owner-password');
  const viewerCookie = await login(origin, 'viewer@example.com', 'secure-viewer-password');

  const baseline = getEffectiveRepositoryAccess(db, { userId: viewerId, repositoryId });
  assert.equal(baseline.permission, 'read');
  assert.ok(permissionAtLeast(baseline.permission, 'read'));
  assert.equal(permissionAtLeast(baseline.permission, 'triage'), false);

  const readRepo = await fetch(`${origin}/api/repos/kuklabs/access-demo`, { headers: { Cookie: viewerCookie } });
  assert.equal(readRepo.status, 200);

  const blockedIssue = await fetch(`${origin}/api/repos/kuklabs/access-demo/issues`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: viewerCookie },
    body: JSON.stringify({ title: 'Viewer cannot triage yet', priority: 'low' }),
  });
  assert.equal(blockedIssue.status, 403);

  const grantTriage = await fetch(`${origin}/api/repository-access/kuklabs/access-demo/collaborators`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify({ userId: viewerId, permission: 'triage' }),
  });
  assert.equal(grantTriage.status, 200);
  assert.equal(getEffectiveRepositoryAccess(db, { userId: viewerId, repositoryId }).permission, 'triage');

  const createdIssue = await fetch(`${origin}/api/repos/kuklabs/access-demo/issues`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: viewerCookie },
    body: JSON.stringify({ title: 'Triage can create issues', priority: 'medium' }),
  });
  assert.equal(createdIssue.status, 201);

  const blockedWrite = await fetch(`${origin}/api/repos/kuklabs/access-demo/files`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: viewerCookie },
    body: JSON.stringify({ branch: 'main', path: 'README.md', content: '# Test', message: 'Add README' }),
  });
  assert.equal(blockedWrite.status, 403);

  const removeDirect = await fetch(`${origin}/api/repository-access/kuklabs/access-demo/collaborators/${viewerId}`, {
    method: 'DELETE',
    headers: { Cookie: ownerCookie },
  });
  assert.equal(removeDirect.status, 200);

  const grantTeamWrite = await fetch(`${origin}/api/repository-access/kuklabs/access-demo/teams`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify({ teamId, permission: 'write' }),
  });
  assert.equal(grantTeamWrite.status, 200);
  const teamAccess = getEffectiveRepositoryAccess(db, { userId: viewerId, repositoryId });
  assert.equal(teamAccess.permission, 'write');
  assert.equal(teamAccess.sources.some((source) => source.type === 'team' && source.id === teamId), true);

  const writeToken = createPersonalAccessToken(db, viewerId, { name: 'Viewer Git', scopes: ['repo:write'] });
  const gitPush = authorizeGitCredential(db, { isProduction: true, gitToken: 'disabled' }, {
    credential: writeToken.token,
    orgSlug: 'kuklabs',
    repoSlug: 'access-demo',
    isPush: true,
  });
  assert.equal(gitPush.userId, viewerId);
  assert.equal(gitPush.repositoryPermission, 'write');

  const accessPage = await fetch(`${origin}/api/repository-access/kuklabs/access-demo`, { headers: { Cookie: viewerCookie } });
  assert.equal(accessPage.status, 200);
  const accessPayload = await accessPage.json();
  assert.equal(accessPayload.effectivePermission, 'write');
  assert.equal(accessPayload.canManage, false);
  assert.equal(accessPayload.teamGrants.length, 1);

  assert.equal(requiredPermissionForRepositoryRequest('POST', '/issues'), 'triage');
  assert.equal(requiredPermissionForRepositoryRequest('POST', '/files'), 'write');
  assert.equal(requiredPermissionForRepositoryRequest('POST', '/pulls/1/merge'), 'maintain');
});

test('repository access management requires admin permission and same-origin writes', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-repository-access-security-test-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const config = configFor(dataDir);
  const db = openDatabase(config);
  t.after(() => db.close());
  migrateCollaboration(db);
  migrateRepositoryAccess(db);
  const { userId: ownerId, orgId } = seedCore(db, config);
  const developerId = createUser(db, {
    email: 'developer@example.com',
    password: 'secure-developer-password',
    displayName: 'Developer User',
    organizationId: orgId,
    role: 'developer',
  });
  const outsiderId = createUser(db, {
    email: 'outsider@example.com',
    password: 'secure-outsider-password',
    displayName: 'Outsider User',
  });
  createRepository(db, config, { organizationId: orgId, createdBy: ownerId, slug: 'security-demo' });

  const server = startServer(config, db);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const ownerCookie = await login(origin, 'owner@example.com', 'secure-owner-password');
  const developerCookie = await login(origin, 'developer@example.com', 'secure-developer-password');

  const forbidden = await fetch(`${origin}/api/repository-access/kuklabs/security-demo/collaborators`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: developerCookie },
    body: JSON.stringify({ userId: developerId, permission: 'admin' }),
  });
  assert.equal(forbidden.status, 403);

  const crossOrigin = await fetch(`${origin}/api/repository-access/kuklabs/security-demo/collaborators`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: ownerCookie, Origin: 'https://attacker.example' },
    body: JSON.stringify({ userId: developerId, permission: 'write' }),
  });
  assert.equal(crossOrigin.status, 403);

  const invalidPermission = await fetch(`${origin}/api/repository-access/kuklabs/security-demo/collaborators`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify({ userId: developerId, permission: 'super-admin' }),
  });
  assert.equal(invalidPermission.status, 400);

  const outsiderGrant = await fetch(`${origin}/api/repository-access/kuklabs/security-demo/collaborators`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify({ userId: outsiderId, permission: 'read' }),
  });
  assert.equal(outsiderGrant.status, 404);

  const auditActions = db.prepare(`
    SELECT action FROM audit_logs
    WHERE action LIKE 'repository_collaborator.%' OR action LIKE 'repository_team_access.%'
    ORDER BY rowid
  `).all().map((row) => row.action);
  assert.deepEqual(auditActions, []);
});

/** A private repository, its owner, and nobody else. */
function privateWorkspace(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-access-visibility-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const config = configFor(dataDir);
  const db = openDatabase(config);
  t.after(() => db.close());
  migrateCollaboration(db);
  migrateRepositoryAccess(db);
  const { userId: ownerId, orgId } = seedCore(db, config);
  const repositoryId = createRepository(db, config, { organizationId: orgId, createdBy: ownerId, slug: 'secret-plans' });
  return { config, db, orgId, ownerId, repositoryId };
}

test('a private repository does not confirm its own existence to a stranger', async (t) => {
  const { db } = privateWorkspace(t);
  const stranger = createUser(db, { email: 'stranger@example.com', password: 'secure-stranger-password', displayName: 'Stranger' });

  // 403 would say "you may not read kuklabs/secret-plans", and the name is in
  // the URL that produced it — enough to enumerate what a private organization
  // owns, one guess at a time.
  assert.throws(
    () => requireRepositoryAccess(db, stranger, { orgSlug: 'kuklabs', repoSlug: 'secret-plans' }, 'read'),
    (error) => error.status === 404 && error.code === 'REPO_NOT_FOUND',
  );
});

test('a public repository still says why, because its existence is public', async (t) => {
  const { db, repositoryId } = privateWorkspace(t);
  const stranger = createUser(db, { email: 'stranger@example.com', password: 'secure-stranger-password', displayName: 'Stranger' });
  db.prepare("UPDATE repositories SET visibility = 'public' WHERE id = ?").run(repositoryId);

  // Hiding a repository somebody can already see in a browser teaches nothing
  // and confuses everybody.
  assert.throws(
    () => requireRepositoryAccess(db, stranger, { orgSlug: 'kuklabs', repoSlug: 'secret-plans' }, 'write'),
    (error) => error.status === 403 && error.code === 'REPOSITORY_ACCESS_DENIED',
  );
});

test('somebody who can read but not write is told which permission is missing', async (t) => {
  const { db, orgId } = privateWorkspace(t);
  createUser(db, {
    email: 'reader@example.com',
    password: 'secure-reader-password',
    displayName: 'Reader',
    organizationId: orgId,
    role: 'viewer',
  });
  const reader = db.prepare("SELECT id FROM users WHERE email = 'reader@example.com'").get().id;

  // They already know it exists — they can read it. "Not found" here would be
  // a lie they could disprove by refreshing the page.
  assert.throws(
    () => requireRepositoryAccess(db, reader, { orgSlug: 'kuklabs', repoSlug: 'secret-plans' }, 'write'),
    (error) => error.status === 403 && /write permission is required/.test(error.message),
  );
});
