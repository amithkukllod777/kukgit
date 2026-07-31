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
import { createExternalCollaboratorAccessPrivacyApiHandler } from '../src/external-collaborator-access-privacy.mjs';
import { createExternalCollaboratorDiscoveryApiHandler } from '../src/external-collaborator-discovery.mjs';
import { createExternalCollaboratorLifecycleGuard } from '../src/external-collaborator-lifecycle-guard.mjs';
import { authorizeGitCredential } from '../src/git-http.mjs';
import { createBareRepository, createDemoCommit } from '../src/git.mjs';
import { migrateGitLfs } from '../src/git-lfs.mjs';
import { listEmailOutbox, listNotifications, migrateNotifications } from '../src/notifications.mjs';
import {
  createRepositoryAccessApiHandler,
  createRepositoryAccessGuard,
  getEffectiveRepositoryAccess,
  migrateRepositoryAccess,
} from '../src/repository-access.mjs';
import {
  createRepositoryInvitationsApiHandler,
  migrateRepositoryInvitations,
} from '../src/repository-invitations.mjs';
import {
  createRepositoryLifecycleApiHandler,
  migrateRepositoryLifecycle,
} from '../src/repository-lifecycle.mjs';
import { authorizeLfsSshAuthentication } from '../src/ssh-lfs.mjs';
import {
  authorizeSshCommand,
  createUserSshKey,
  migrateSshKeys,
} from '../src/ssh-keys.mjs';
import { createPersonalAccessToken } from '../src/tokens.mjs';
import { migrateWebhooks } from '../src/webhooks.mjs';

function sshString(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(buffer.length);
  return Buffer.concat([length, buffer]);
}

function ed25519Key(seed = 1) {
  const blob = Buffer.concat([sshString('ssh-ed25519'), sshString(Buffer.alloc(32, seed))]);
  return `ssh-ed25519 ${blob.toString('base64')} external@example.com`;
}

async function setup(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-external-collaborators-test-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const config = loadConfig({
    dataDir,
    databasePath: path.join(dataDir, 'kukgit.db'),
    repositoriesDir: path.join(dataDir, 'repos'),
    lfsDir: path.join(dataDir, 'lfs'),
    tempDir: path.join(dataDir, 'tmp'),
    nodeEnv: 'test',
    baseUrl: 'http://127.0.0.1:8787',
    adminEmail: 'owner@example.com',
    adminPassword: 'secure-owner-password',
    adminName: 'Repository Owner',
    gitToken: 'disabled-development-token',
    webhookEncryptionKey: 'external-collaborator-webhook-key-long-enough',
    lfsAuthKey: 'external-collaborator-lfs-key-long-enough',
    smtpHost: 'smtp.test',
    smtpPort: 2525,
    smtpSecure: false,
    smtpStartTls: false,
    emailFrom: 'noreply@kukgit.test',
    emailFromName: 'KukGit',
    sshHost: 'git.kukgit.test',
    sshPort: 2222,
    sshUser: 'git',
  });
  const db = openDatabase(config);
  t.after(() => db.close());
  migrateCollaboration(db);
  migrateRepositoryAccess(db);
  migrateRepositoryInvitations(db);
  migrateNotifications(db);
  migrateWebhooks(db);
  migrateRepositoryLifecycle(db);
  migrateSshKeys(db);
  migrateGitLfs(db);
  const { userId: ownerId, orgId } = seedCore(db, config);

  const externalId = uid('usr');
  db.prepare('INSERT INTO users (id, email, password_hash, display_name) VALUES (?, ?, ?, ?)')
    .run(externalId, 'external@example.com', hashPassword('secure-external-password'), 'External Client');
  const wrongId = uid('usr');
  db.prepare('INSERT INTO users (id, email, password_hash, display_name) VALUES (?, ?, ?, ?)')
    .run(wrongId, 'wrong@example.com', hashPassword('secure-wrong-password'), 'Wrong User');

  const sharedRepositoryId = await createRepository(db, config, {
    organizationId: orgId,
    createdBy: ownerId,
    orgSlug: 'kuklabs',
    slug: 'shared-repository',
  });

  const otherOrgId = uid('org');
  db.prepare("INSERT INTO organizations (id, slug, name, plan) VALUES (?, 'otherco', 'Other Company', 'free')")
    .run(otherOrgId);
  const unrelatedRepositoryId = await createRepository(db, config, {
    organizationId: otherOrgId,
    createdBy: ownerId,
    orgSlug: 'otherco',
    slug: 'private-repository',
  });

  return {
    config,
    db,
    ownerId,
    orgId,
    externalId,
    wrongId,
    sharedRepositoryId,
    unrelatedRepositoryId,
  };
}

async function createRepository(db, config, { organizationId, createdBy, orgSlug, slug }) {
  const id = uid('repo');
  createBareRepository(config, orgSlug, slug);
  db.prepare(`
    INSERT INTO repositories
      (id, organization_id, slug, name, description, visibility, default_branch, created_by)
    VALUES (?, ?, ?, ?, ?, 'private', 'main', ?)
  `).run(id, organizationId, slug, slug, `${slug} test repository`, createdBy);
  await createDemoCommit(config, orgSlug, slug);
  return id;
}

function startServer(context) {
  const { config, db } = context;
  const app = createApp({ config, db });
  const discovery = createExternalCollaboratorDiscoveryApiHandler({ config, db });
  const invitations = createRepositoryInvitationsApiHandler({ config, db });
  const lifecycleAuthority = createExternalCollaboratorLifecycleGuard({ config, db });
  const lifecycle = createRepositoryLifecycleApiHandler({ config, db });
  const privacy = createExternalCollaboratorAccessPrivacyApiHandler({ config, db });
  const accessApi = createRepositoryAccessApiHandler({ config, db });
  const guard = createRepositoryAccessGuard({ config, db, app });
  return http.createServer(async (req, res) => {
    if (await discovery(req, res)) return;
    if (await invitations(req, res)) return;
    if (await lifecycleAuthority(req, res)) return;
    if (await lifecycle(req, res)) return;
    if (await privacy(req, res)) return;
    if (await accessApi(req, res)) return;
    if (await guard(req, res)) return;
    return app(req, res);
  });
}

async function listen(t, context) {
  const server = startServer(context);
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

async function patchPermission(origin, ownerCookie, userId, permission) {
  const response = await fetch(`${origin}/api/repository-invitations/kuklabs/shared-repository/collaborators/${userId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify({ permission }),
  });
  assert.equal(response.status, 200);
  return response.json();
}

test('external invitation grants only one repository across browser, Git, SSH and LFS transports', async (t) => {
  const context = await setup(t);
  const origin = await listen(t, context);
  const ownerCookie = await login(origin, 'owner@example.com', 'secure-owner-password');
  const externalCookie = await login(origin, 'external@example.com', 'secure-external-password');
  const wrongCookie = await login(origin, 'wrong@example.com', 'secure-wrong-password');

  const create = await fetch(`${origin}/api/repository-invitations/kuklabs/shared-repository`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify({ email: 'external@example.com', permission: 'write', expiresInDays: 14 }),
  });
  assert.equal(create.status, 201);
  const invitation = (await create.json()).invitation;
  assert.match(invitation.token, /^kgr_/);
  assert.match(invitation.acceptanceUrl, /accept-repo-invite/);
  assert.equal(listEmailOutbox(context.db).emails.some((email) => email.toEmail === 'external@example.com'), true);
  assert.equal(listNotifications(context.db, context.externalId).unreadCount, 1);

  const wrongAcceptance = await fetch(`${origin}/api/repository-invitations/accept`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: wrongCookie },
    body: JSON.stringify({ token: invitation.token }),
  });
  assert.equal(wrongAcceptance.status, 403);
  assert.equal(wrongAcceptance.headers.get('content-type').startsWith('application/json'), true);

  const accept = await fetch(`${origin}/api/repository-invitations/accept`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: externalCookie },
    body: JSON.stringify({ token: invitation.token }),
  });
  assert.equal(accept.status, 200);
  const accepted = (await accept.json()).result;
  assert.equal(accepted.permission, 'write');
  assert.equal(accepted.repository.slug, 'shared-repository');

  const replay = await fetch(`${origin}/api/repository-invitations/accept`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: externalCookie },
    body: JSON.stringify({ token: invitation.token }),
  });
  assert.equal(replay.status, 409);
  assert.equal(context.db.prepare('SELECT COUNT(*) AS count FROM org_members WHERE user_id = ?').get(context.externalId).count, 0);

  const effective = getEffectiveRepositoryAccess(context.db, {
    userId: context.externalId,
    repositoryId: context.sharedRepositoryId,
  });
  assert.equal(effective.permission, 'write');
  assert.equal(effective.isExternalCollaborator, true);
  assert.equal(effective.organizationRole, null);

  const me = await fetch(`${origin}/api/auth/me`, { headers: { Cookie: externalCookie } });
  assert.equal(me.status, 200);
  assert.deepEqual((await me.json()).organizations, []);

  const repositories = await fetch(`${origin}/api/repos`, { headers: { Cookie: externalCookie } });
  assert.equal(repositories.status, 200);
  const repositoryPayload = await repositories.json();
  assert.deepEqual(repositoryPayload.repositories.map((repository) => `${repository.orgSlug}/${repository.slug}`), ['kuklabs/shared-repository']);
  assert.equal(repositoryPayload.repositories[0].isExternalCollaborator, true);
  assert.equal(repositoryPayload.repositories[0].permission, 'write');

  const dashboard = await fetch(`${origin}/api/dashboard`, { headers: { Cookie: externalCookie } });
  assert.equal(dashboard.status, 200);
  assert.equal((await dashboard.json()).metrics.repositories, 1);

  const sharedRead = await fetch(`${origin}/api/repos/kuklabs/shared-repository`, { headers: { Cookie: externalCookie } });
  assert.equal(sharedRead.status, 200);
  const unrelatedRead = await fetch(`${origin}/api/repos/otherco/private-repository`, { headers: { Cookie: externalCookie } });
  assert.equal(unrelatedRead.status, 403);

  const issue = await fetch(`${origin}/api/repos/kuklabs/shared-repository/issues`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: externalCookie },
    body: JSON.stringify({ title: 'External collaborator issue', priority: 'medium' }),
  });
  assert.equal(issue.status, 201);
  const globalIssues = await fetch(`${origin}/api/issues`, { headers: { Cookie: externalCookie } });
  assert.equal((await globalIssues.json()).issues.length, 1);

  const privateAccessPage = await fetch(`${origin}/api/repository-access/kuklabs/shared-repository`, { headers: { Cookie: externalCookie } });
  assert.equal(privateAccessPage.status, 200);
  const privateAccess = await privateAccessPage.json();
  assert.equal(privateAccess.organizationDirectoryHidden, true);
  assert.deepEqual(privateAccess.members, []);
  assert.deepEqual(privateAccess.teams, []);
  assert.deepEqual(privateAccess.teamGrants, []);
  assert.equal(privateAccess.collaborators.every((collaborator) => collaborator.isExternal), true);

  const token = createPersonalAccessToken(context.db, context.externalId, {
    name: 'External developer',
    scopes: ['repo:read', 'repo:write'],
  });
  const fetchAuth = authorizeGitCredential(context.db, { isProduction: true, gitToken: 'disabled' }, {
    credential: token.token,
    orgSlug: 'kuklabs',
    repoSlug: 'shared-repository',
    isPush: false,
  });
  assert.equal(fetchAuth.userId, context.externalId);
  assert.equal(fetchAuth.repositoryPermission, 'write');
  assert.equal(authorizeGitCredential(context.db, { isProduction: true, gitToken: 'disabled' }, {
    credential: token.token,
    orgSlug: 'otherco',
    repoSlug: 'private-repository',
    isPush: false,
  }), null);

  const sshKey = createUserSshKey(context.db, context.externalId, {
    title: 'External laptop',
    publicKey: ed25519Key(61),
  });
  const sshPush = authorizeSshCommand(context.db, context.config, {
    keyKind: 'user',
    keyId: sshKey.id,
    originalCommand: "git-receive-pack 'kuklabs/shared-repository.git'",
  });
  assert.equal(sshPush.actor.permission, 'write');

  const lfsUpload = authorizeLfsSshAuthentication(context.db, {
    keyKind: 'user',
    keyId: sshKey.id,
    originalCommand: "git-lfs-authenticate 'kuklabs/shared-repository.git' upload",
  });
  assert.equal(lfsUpload.actor.permission, 'write');

  await patchPermission(origin, ownerCookie, context.externalId, 'read');
  const blockedIssue = await fetch(`${origin}/api/repos/kuklabs/shared-repository/issues`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: externalCookie },
    body: JSON.stringify({ title: 'Read access cannot triage' }),
  });
  assert.equal(blockedIssue.status, 403);
  assert.equal(authorizeGitCredential(context.db, { isProduction: true, gitToken: 'disabled' }, {
    credential: token.token,
    orgSlug: 'kuklabs',
    repoSlug: 'shared-repository',
    isPush: true,
  }), null);
  assert.throws(() => authorizeSshCommand(context.db, context.config, {
    keyKind: 'user',
    keyId: sshKey.id,
    originalCommand: "git-receive-pack 'kuklabs/shared-repository.git'",
  }), (error) => error.code === 'REPOSITORY_ACCESS_DENIED');
  assert.throws(() => authorizeLfsSshAuthentication(context.db, {
    keyKind: 'user',
    keyId: sshKey.id,
    originalCommand: "git-lfs-authenticate 'kuklabs/shared-repository.git' upload",
  }), (error) => error.code === 'REPOSITORY_ACCESS_DENIED');
  assert.equal(authorizeSshCommand(context.db, context.config, {
    keyKind: 'user', keyId: sshKey.id,
    originalCommand: "git-upload-pack 'kuklabs/shared-repository.git'",
  }).command.write, false);
  assert.equal(authorizeLfsSshAuthentication(context.db, {
    keyKind: 'user', keyId: sshKey.id,
    originalCommand: "git-lfs-authenticate 'kuklabs/shared-repository.git' download",
  }).command.operation, 'download');

  await patchPermission(origin, ownerCookie, context.externalId, 'admin');
  const archive = await fetch(`${origin}/api/repository-lifecycle/kuklabs/shared-repository/archive`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: externalCookie }, body: '{}',
  });
  assert.equal(archive.status, 200);
  const transfer = await fetch(`${origin}/api/repository-lifecycle/kuklabs/shared-repository/transfer`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: externalCookie },
    body: JSON.stringify({ targetOrgSlug: 'otherco' }),
  });
  assert.equal(transfer.status, 403);
  assert.equal((await transfer.json()).error.code, 'ORGANIZATION_ADMIN_REQUIRED');
  const trash = await fetch(`${origin}/api/repository-lifecycle/kuklabs/shared-repository/trash`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: externalCookie },
    body: JSON.stringify({ confirmation: 'kuklabs/shared-repository' }),
  });
  assert.equal(trash.status, 403);
  const unarchive = await fetch(`${origin}/api/repository-lifecycle/kuklabs/shared-repository/archive`, {
    method: 'DELETE', headers: { Cookie: externalCookie },
  });
  assert.equal(unarchive.status, 200);

  const auditJson = context.db.prepare(`
    SELECT GROUP_CONCAT(metadata_json, '\n') AS metadata
    FROM audit_logs WHERE action LIKE 'repository_invitation.%'
  `).get().metadata || '';
  assert.doesNotMatch(auditJson, /kgr_/);
  assert.doesNotMatch(auditJson, new RegExp(invitation.token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  const remove = await fetch(`${origin}/api/repository-access/kuklabs/shared-repository/collaborators/${context.externalId}`, {
    method: 'DELETE', headers: { Cookie: ownerCookie },
  });
  assert.equal(remove.status, 200);
  const repositoriesAfterRemoval = await fetch(`${origin}/api/repos`, { headers: { Cookie: externalCookie } });
  assert.deepEqual((await repositoriesAfterRemoval.json()).repositories, []);
  assert.equal((await fetch(`${origin}/api/repos/kuklabs/shared-repository`, { headers: { Cookie: externalCookie } })).status, 403);
});

test('repository invitations enforce revoke, expiry, resend, permissions and CSRF', async (t) => {
  const context = await setup(t);
  const origin = await listen(t, context);
  const ownerCookie = await login(origin, 'owner@example.com', 'secure-owner-password');
  const externalCookie = await login(origin, 'external@example.com', 'secure-external-password');
  const wrongCookie = await login(origin, 'wrong@example.com', 'secure-wrong-password');

  const csrf = await fetch(`${origin}/api/repository-invitations/kuklabs/shared-repository`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: ownerCookie, Origin: 'https://attacker.example' },
    body: JSON.stringify({ email: 'external@example.com', permission: 'read' }),
  });
  assert.equal(csrf.status, 403);

  const forbidden = await fetch(`${origin}/api/repository-invitations/kuklabs/shared-repository`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: wrongCookie },
    body: JSON.stringify({ email: 'external@example.com', permission: 'read' }),
  });
  assert.equal(forbidden.status, 403);

  const create = await fetch(`${origin}/api/repository-invitations/kuklabs/shared-repository`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify({ email: 'external@example.com', permission: 'triage', expiresInDays: 7 }),
  });
  const original = (await create.json()).invitation;
  const revoke = await fetch(`${origin}/api/repository-invitations/kuklabs/shared-repository/${original.id}/revoke`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie }, body: '{}',
  });
  assert.equal(revoke.status, 200);
  const revokedAccept = await fetch(`${origin}/api/repository-invitations/accept`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: externalCookie },
    body: JSON.stringify({ token: original.token }),
  });
  assert.equal(revokedAccept.status, 410);

  const resend = await fetch(`${origin}/api/repository-invitations/kuklabs/shared-repository/${original.id}/resend`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify({ expiresInDays: 30 }),
  });
  assert.equal(resend.status, 201);
  const replacement = (await resend.json()).invitation;
  assert.notEqual(replacement.id, original.id);
  assert.notEqual(replacement.token, original.token);
  assert.equal(context.db.prepare('SELECT revoked_at AS revokedAt FROM repository_invitations WHERE id = ?').get(original.id).revokedAt !== null, true);

  context.db.prepare("UPDATE repository_invitations SET expires_at = datetime('now', '-1 minute') WHERE id = ?")
    .run(replacement.id);
  const expiredAccept = await fetch(`${origin}/api/repository-invitations/accept`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: externalCookie },
    body: JSON.stringify({ token: replacement.token }),
  });
  assert.equal(expiredAccept.status, 410);

  const list = await fetch(`${origin}/api/repository-invitations/kuklabs/shared-repository`, { headers: { Cookie: ownerCookie } });
  assert.equal(list.status, 200);
  const invitations = (await list.json()).invitations;
  assert.equal(invitations.some((invitation) => invitation.status === 'expired'), true);
  assert.equal(invitations.some((invitation) => invitation.status === 'revoked'), true);

  const metadata = context.db.prepare(`
    SELECT GROUP_CONCAT(metadata_json, '\n') AS metadata
    FROM audit_logs WHERE action LIKE 'repository_invitation.%'
  `).get().metadata || '';
  assert.doesNotMatch(metadata, /kgr_/);
  assert.doesNotMatch(metadata, new RegExp(replacement.token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});
