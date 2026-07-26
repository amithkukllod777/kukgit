import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createSession, hashPassword } from '../src/auth.mjs';
import { migrateAuthKitIdentity } from '../src/authkit-identity.mjs';
import { migrateCollaboration } from '../src/collaboration.mjs';
import { loadConfig } from '../src/config.mjs';
import { openDatabase, uid } from '../src/db.mjs';
import { runWithRequestIdentity } from '../src/identity-context.mjs';
import {
  createOrganizationOnboardingApiHandler,
  migrateOrganizationOnboarding,
} from '../src/organization-onboarding.mjs';

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

function setup(t, overrides = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-org-onboarding-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const config = loadConfig({
    dataDir,
    databasePath: path.join(dataDir, 'kukgit.db'),
    repositoriesDir: path.join(dataDir, 'repos'),
    tempDir: path.join(dataDir, 'tmp'),
    nodeEnv: 'test',
    authMode: 'local',
    organizationOwnerLimit: 3,
    ...overrides,
  });
  const db = openDatabase(config);
  t.after(() => db.close());
  migrateAuthKitIdentity(db);
  migrateCollaboration(db);
  migrateOrganizationOnboarding(db);
  return { config, db };
}

function createUser(db, {
  email = 'creator@example.com',
  displayName = 'Workspace Creator',
  authSource = 'local',
  emailVerified = authSource === 'authkit' ? 1 : 0,
  kuklabsUserId = authSource === 'authkit' ? `central-${Date.now()}-${Math.random()}` : null,
} = {}) {
  const id = uid('usr');
  db.prepare(`
    INSERT INTO users
      (id, email, password_hash, display_name, auth_source, email_verified, kuklabs_user_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, email, hashPassword('secure-user-password'), displayName, authSource, emailVerified, kuklabsUserId);
  return db.prepare(`
    SELECT id, email, display_name AS displayName, auth_source AS authSource,
      email_verified AS emailVerified, kuklabs_user_id AS kuklabsUserId
    FROM users WHERE id = ?
  `).get(id);
}

function localServer(config, db) {
  const handler = createOrganizationOnboardingApiHandler({ config, db });
  return http.createServer(async (req, res) => {
    if (await handler(req, res)) return;
    res.writeHead(404).end();
  });
}

function identityServer(config, db, user) {
  const handler = createOrganizationOnboardingApiHandler({ config, db });
  return http.createServer((req, res) => runWithRequestIdentity({ mode: 'authkit', user }, async () => {
    if (await handler(req, res)) return;
    res.writeHead(404).end();
  }));
}

async function request(origin, pathname, { method = 'GET', cookie = '', body, requestOrigin = '' } = {}) {
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (requestOrigin) headers.Origin = requestOrigin;
  const response = await fetch(`${origin}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  return { response, payload };
}

function cookieFor(db, userId) {
  const session = createSession(db, userId);
  return `kukgit_session=${session.token}`;
}

test('creates an organization atomically with Owner membership and a default Developers team', async (t) => {
  const { config, db } = setup(t);
  const user = createUser(db);
  const server = localServer(config, db);
  const origin = await listen(server);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const cookie = cookieFor(db, user.id);

  const before = await request(origin, '/api/onboarding/status', { cookie });
  assert.equal(before.response.status, 200);
  assert.equal(before.payload.organizations.length, 0);
  assert.equal(before.payload.canCreate, true);
  assert.equal(before.payload.ownerLimit, 3);

  const created = await request(origin, '/api/onboarding/organizations', {
    method: 'POST',
    cookie,
    body: {
      name: 'Example Technologies',
      slug: 'example-technologies',
      description: 'Product engineering workspace',
      website: 'https://example.com',
      companySize: '11-50',
    },
  });
  assert.equal(created.response.status, 201);
  assert.equal(created.payload.organization.slug, 'example-technologies');
  assert.equal(created.payload.organization.role, 'owner');
  assert.equal(created.payload.organization.plan, 'free');
  assert.equal(created.payload.organization.companySize, '11-50');
  assert.ok(created.payload.organization.onboardingCompletedAt);

  const organization = db.prepare(`
    SELECT id, created_by AS createdBy, website, description, company_size AS companySize
    FROM organizations WHERE slug = 'example-technologies'
  `).get();
  assert.equal(organization.createdBy, user.id);
  assert.equal(organization.website, 'https://example.com/');
  assert.equal(organization.description, 'Product engineering workspace');
  assert.equal(organization.companySize, '11-50');

  const membership = db.prepare(`
    SELECT role FROM org_members WHERE organization_id = ? AND user_id = ?
  `).get(organization.id, user.id);
  assert.equal(membership.role, 'owner');

  const team = db.prepare(`
    SELECT id, slug, name FROM teams WHERE organization_id = ?
  `).get(organization.id);
  assert.equal(team.slug, 'developers');
  assert.equal(team.name, 'Developers');
  const teamMembership = db.prepare('SELECT role FROM team_members WHERE team_id = ? AND user_id = ?')
    .get(team.id, user.id);
  assert.equal(teamMembership.role, 'maintainer');

  const audit = db.prepare(`
    SELECT metadata_json AS metadata FROM audit_logs
    WHERE action = 'organization.self_service_created' AND target_id = ?
  `).get(organization.id);
  assert.match(audit.metadata, /example-technologies/);
  assert.doesNotMatch(audit.metadata, /secure-user-password/);
});

test('protects reserved and duplicate slugs without leaving partial organization rows', async (t) => {
  const { config, db } = setup(t);
  const first = createUser(db, { email: 'first@example.com', displayName: 'First User' });
  const second = createUser(db, { email: 'second@example.com', displayName: 'Second User' });
  const server = localServer(config, db);
  const origin = await listen(server);
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const reserved = await request(origin, '/api/onboarding/organizations', {
    method: 'POST',
    cookie: cookieFor(db, first.id),
    body: { name: 'System Workspace', slug: 'kuklabs', companySize: 'solo' },
  });
  assert.equal(reserved.response.status, 409);
  assert.equal(reserved.payload.error.code, 'ORGANIZATION_SLUG_RESERVED');
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM organizations WHERE name = 'System Workspace'").get().count, 0);

  const firstCreate = await request(origin, '/api/onboarding/organizations', {
    method: 'POST',
    cookie: cookieFor(db, first.id),
    body: { name: 'Shared Name', slug: 'shared-name', companySize: 'solo' },
  });
  assert.equal(firstCreate.response.status, 201);

  const duplicate = await request(origin, '/api/onboarding/organizations', {
    method: 'POST',
    cookie: cookieFor(db, second.id),
    body: { name: 'Duplicate Name', slug: 'shared-name', companySize: '2-10' },
  });
  assert.equal(duplicate.response.status, 409);
  assert.equal(duplicate.payload.error.code, 'ORGANIZATION_SLUG_TAKEN');
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM organizations WHERE slug = 'shared-name'").get().count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM organizations WHERE name = 'Duplicate Name'").get().count, 0);
});

test('enforces the configured organization ownership limit', async (t) => {
  const { config, db } = setup(t, { organizationOwnerLimit: 1 });
  const user = createUser(db);
  const server = localServer(config, db);
  const origin = await listen(server);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const cookie = cookieFor(db, user.id);

  const first = await request(origin, '/api/onboarding/organizations', {
    method: 'POST', cookie,
    body: { name: 'First Workspace', slug: 'first-workspace', companySize: 'solo' },
  });
  assert.equal(first.response.status, 201);

  const status = await request(origin, '/api/onboarding/status', { cookie });
  assert.equal(status.payload.ownerCount, 1);
  assert.equal(status.payload.canCreate, false);

  const second = await request(origin, '/api/onboarding/organizations', {
    method: 'POST', cookie,
    body: { name: 'Second Workspace', slug: 'second-workspace', companySize: 'solo' },
  });
  assert.equal(second.response.status, 403);
  assert.equal(second.payload.error.code, 'ORGANIZATION_OWNER_LIMIT_REACHED');
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM organizations WHERE slug = 'second-workspace'").get().count, 0);
});

test('requires verified central identity and same-origin writes', async (t) => {
  const { config, db } = setup(t);
  const unverified = createUser(db, {
    email: 'unverified@example.com',
    authSource: 'authkit',
    emailVerified: 0,
  });
  const unverifiedServer = identityServer(config, db, unverified);
  const unverifiedOrigin = await listen(unverifiedServer);
  t.after(() => new Promise((resolve) => unverifiedServer.close(resolve)));

  const denied = await request(unverifiedOrigin, '/api/onboarding/organizations', {
    method: 'POST',
    body: { name: 'Unverified Workspace', slug: 'unverified-workspace', companySize: 'solo' },
  });
  assert.equal(denied.response.status, 403);
  assert.equal(denied.payload.error.code, 'ORGANIZATION_VERIFIED_EMAIL_REQUIRED');

  const verified = createUser(db, {
    email: 'verified@example.com',
    authSource: 'authkit',
    emailVerified: 1,
  });
  const verifiedServer = identityServer(config, db, verified);
  const verifiedOrigin = await listen(verifiedServer);
  t.after(() => new Promise((resolve) => verifiedServer.close(resolve)));

  const csrf = await request(verifiedOrigin, '/api/onboarding/organizations', {
    method: 'POST',
    requestOrigin: 'https://attacker.example',
    body: { name: 'Attack Workspace', slug: 'attack-workspace', companySize: 'solo' },
  });
  assert.equal(csrf.response.status, 403);
  assert.equal(csrf.payload.error.code, 'CSRF_BLOCKED');

  const invalidWebsite = await request(verifiedOrigin, '/api/onboarding/organizations', {
    method: 'POST',
    body: { name: 'HTTP Workspace', slug: 'http-workspace', website: 'http://example.com', companySize: 'solo' },
  });
  assert.equal(invalidWebsite.response.status, 400);
  assert.equal(invalidWebsite.payload.error.code, 'ORGANIZATION_WEBSITE_HTTPS_REQUIRED');
});

test('slug availability reports taken and available workspace names', async (t) => {
  const { config, db } = setup(t);
  const user = createUser(db);
  const server = localServer(config, db);
  const origin = await listen(server);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const cookie = cookieFor(db, user.id);

  const available = await request(origin, '/api/onboarding/organizations/slug/new-company', { cookie });
  assert.equal(available.response.status, 200);
  assert.equal(available.payload.available, true);

  await request(origin, '/api/onboarding/organizations', {
    method: 'POST', cookie,
    body: { name: 'New Company', slug: 'new-company', companySize: 'solo' },
  });
  const taken = await request(origin, '/api/onboarding/organizations/slug/new-company', { cookie });
  assert.equal(taken.response.status, 200);
  assert.equal(taken.payload.available, false);
  assert.equal(taken.payload.reason, 'taken');
});
