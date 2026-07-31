import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createSession } from '../src/auth.mjs';
import { migrateCollaboration } from '../src/collaboration.mjs';
import { loadConfig } from '../src/config.mjs';
import { openDatabase, seedCore, uid } from '../src/db.mjs';
import { createBareRepository } from '../src/git.mjs';
import { migrateRepositoryAccess } from '../src/repository-access.mjs';
import { migrateRepositoryLifecycle } from '../src/repository-lifecycle.mjs';
import {
  createSecretsApiHandler,
  decryptSecretValue,
  deleteSecret,
  listSecrets,
  maskSecrets,
  migrateSecrets,
  normalizeSecretName,
  putSecret,
  resolveSecrets,
  SECRET_LIMITS,
} from '../src/secrets-vault.mjs';

function setup(t, overrides = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-secrets-test-'));
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
    secretsEncryptionKey: 'kukgit-secrets-vault-test-key-long-enough',
    ...overrides,
  });
  fs.mkdirSync(config.repositoriesDir, { recursive: true });
  const db = openDatabase(config);
  t.after(() => db.close());
  migrateCollaboration(db);
  migrateRepositoryAccess(db);
  migrateRepositoryLifecycle(db);
  migrateSecrets(db);
  const { userId, orgId } = seedCore(db, config);

  const repositoryId = uid('repo');
  createBareRepository(config, 'kuklabs', 'app');
  db.prepare(`
    INSERT INTO repositories (id, organization_id, slug, name, description, visibility, default_branch, created_by)
    VALUES (?, ?, 'app', 'App', '', 'private', 'main', ?)
  `).run(repositoryId, orgId, userId);

  return { config, db, userId, orgId, repositoryId };
}

function addUser(db, email, displayName = 'Member') {
  const id = uid('usr');
  db.prepare("INSERT INTO users (id, email, password_hash, display_name) VALUES (?, ?, 'x$y', ?)").run(id, email, displayName);
  return id;
}

async function request(context, pathname, { method = 'GET', cookie = '', body } = {}) {
  const handler = createSecretsApiHandler({ config: context.config, db: context.db });
  const server = http.createServer(async (req, res) => {
    if (await handler(req, res)) return;
    res.writeHead(404); res.end('{}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${pathname}`, {
      method,
      headers: {
        ...(cookie ? { Cookie: cookie } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, payload: text ? JSON.parse(text) : null, raw: text };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('a stored secret is encrypted at rest and never readable through the API', async (t) => {
  const context = setup(t);
  const cookie = `kukgit_session=${createSession(context.db, context.userId).token}`;

  const created = await request(context, '/api/secrets/orgs/kuklabs/DEPLOY_TOKEN', {
    method: 'PUT', cookie, body: { value: 'super-secret-value-12345' },
  });
  assert.equal(created.status, 201);
  assert.equal(created.payload.created, true);
  // The value is not echoed back, not even to the caller who just supplied it.
  assert.doesNotMatch(created.raw, /super-secret-value/);

  const stored = context.db.prepare('SELECT ciphertext, value_bytes AS bytes FROM secrets WHERE name = ?').get('DEPLOY_TOKEN');
  assert.doesNotMatch(stored.ciphertext, /super-secret-value/);
  assert.equal(stored.bytes, 24);

  const listed = await request(context, '/api/secrets/orgs/kuklabs', { cookie });
  assert.equal(listed.status, 200);
  assert.equal(listed.payload.secrets[0].name, 'DEPLOY_TOKEN');
  assert.doesNotMatch(listed.raw, /super-secret-value/);
  assert.equal(listed.payload.secrets[0].ciphertext, undefined, 'the ciphertext is not exposed either');
  // A truncated digest: enough to confirm a rotation happened, far too little to
  // recover the value from.
  assert.equal(listed.payload.secrets[0].digest.length, 12);

  // There is simply no route that returns a value.
  const attempted = await request(context, '/api/secrets/orgs/kuklabs/DEPLOY_TOKEN', { cookie });
  assert.equal(attempted.status, 404);
});

test('the ciphertext is bound to its scope and name', (t) => {
  const { config, db, orgId, repositoryId } = setup(t);
  putSecret(db, config, { scope: 'organization', scopeId: orgId, name: 'TOKEN', value: 'org-value' });
  const row = db.prepare('SELECT ciphertext FROM secrets WHERE name = ?').get('TOKEN');

  assert.equal(decryptSecretValue(config, row.ciphertext, { scope: 'organization', scopeId: orgId, name: 'TOKEN' }), 'org-value');

  // Copying a row into another scope, or renaming it, must not silently make it
  // a different secret.
  for (const wrong of [
    { scope: 'repository', scopeId: repositoryId, name: 'TOKEN' },
    { scope: 'organization', scopeId: 'org_other', name: 'TOKEN' },
    { scope: 'organization', scopeId: orgId, name: 'OTHER' },
  ]) {
    assert.throws(() => decryptSecretValue(config, row.ciphertext, wrong), (error) => error.code === 'SECRET_DECRYPTION_FAILED');
  }
});

test('an instance without a dedicated vault key fails closed', (t) => {
  const { db, orgId } = setup(t);
  const unconfigured = { secretsEncryptionKey: '' };
  assert.throws(
    () => putSecret(db, unconfigured, { scope: 'organization', scopeId: orgId, name: 'TOKEN', value: 'x' }),
    (error) => error.code === 'SECRETS_VAULT_UNAVAILABLE' && error.status === 503,
  );
  // A short key is not silently accepted either.
  assert.throws(
    () => putSecret(db, { secretsEncryptionKey: 'too-short' }, { scope: 'organization', scopeId: orgId, name: 'TOKEN', value: 'x' }),
    (error) => error.code === 'SECRETS_VAULT_UNAVAILABLE',
  );
});

test('a repository secret shadows an organization secret of the same name', (t) => {
  const { config, db, orgId, repositoryId } = setup(t);
  putSecret(db, config, { scope: 'organization', scopeId: orgId, name: 'TOKEN', value: 'organization-value' });
  putSecret(db, config, { scope: 'organization', scopeId: orgId, name: 'SHARED', value: 'inherited-value' });
  putSecret(db, config, { scope: 'repository', scopeId: repositoryId, name: 'TOKEN', value: 'repository-value' });

  const resolved = resolveSecrets(db, config, { organizationId: orgId, repositoryId });
  const byName = new Map(resolved.map((entry) => [entry.name, entry]));
  assert.equal(byName.get('TOKEN').value, 'repository-value');
  assert.equal(byName.get('TOKEN').scope, 'repository');
  // The organization keeps its default for every other repository.
  assert.equal(byName.get('SHARED').value, 'inherited-value');

  // Without a repository, only the organization scope resolves.
  const orgOnly = resolveSecrets(db, config, { organizationId: orgId });
  assert.equal(orgOnly.find((entry) => entry.name === 'TOKEN').value, 'organization-value');

  // A job asks for the names it declares, and gets nothing else.
  const narrowed = resolveSecrets(db, config, { organizationId: orgId, repositoryId, names: ['SHARED'] });
  assert.deepEqual(narrowed.map((entry) => entry.name), ['SHARED']);
});

test('resolving a secret records that it was used', (t) => {
  const { config, db, orgId } = setup(t);
  putSecret(db, config, { scope: 'organization', scopeId: orgId, name: 'TOKEN', value: 'value' });
  assert.equal(db.prepare('SELECT last_used_at AS at FROM secrets WHERE name = ?').get('TOKEN').at, null);

  resolveSecrets(db, config, { organizationId: orgId });
  assert.ok(db.prepare('SELECT last_used_at AS at FROM secrets WHERE name = ?').get('TOKEN').at, 'use must be recorded');
});

test('secret names are validated and the runner namespace is reserved', () => {
  assert.equal(normalizeSecretName('  DEPLOY_TOKEN  '), 'DEPLOY_TOKEN');
  for (const name of ['', '1TOKEN', 'my-token', 'my token', 'TOKEN!', 'a'.repeat(SECRET_LIMITS.maxNameLength + 1)]) {
    assert.throws(() => normalizeSecretName(name), (error) => error.status === 400, `'${name}' must be refused`);
  }
  // A secret able to take one of these names could impersonate the runner's own
  // environment to every step in a job.
  for (const name of ['GITHUB_TOKEN', 'KUKGIT_ANYTHING', 'RUNNER_TEMP']) {
    assert.throws(() => normalizeSecretName(name), (error) => error.code === 'SECRET_NAME_RESERVED');
  }
});

test('values are bounded and a scope cannot hold unlimited secrets', (t) => {
  const { config, db, orgId } = setup(t);
  assert.throws(
    () => putSecret(db, config, { scope: 'organization', scopeId: orgId, name: 'BIG', value: 'x'.repeat(SECRET_LIMITS.maxValueBytes + 1) }),
    (error) => error.code === 'SECRET_VALUE_TOO_LARGE' && error.status === 413,
  );
  assert.throws(
    () => putSecret(db, config, { scope: 'organization', scopeId: orgId, name: 'EMPTY', value: '' }),
    (error) => error.code === 'SECRET_VALUE_INVALID',
  );
  assert.throws(
    () => putSecret(db, config, { scope: 'organization', scopeId: orgId, name: 'NUMERIC', value: 42 }),
    (error) => error.code === 'SECRET_VALUE_INVALID',
  );

  for (let index = 0; index < SECRET_LIMITS.maxPerScope; index += 1) {
    putSecret(db, config, { scope: 'organization', scopeId: orgId, name: `SECRET_${index}`, value: 'value' });
  }
  assert.throws(
    () => putSecret(db, config, { scope: 'organization', scopeId: orgId, name: 'ONE_TOO_MANY', value: 'value' }),
    (error) => error.code === 'SECRET_LIMIT_REACHED',
  );
  // Replacing an existing secret is never blocked by the limit.
  assert.equal(putSecret(db, config, { scope: 'organization', scopeId: orgId, name: 'SECRET_0', value: 'rotated' }).created, false);
});

test('rotation replaces the value and the digest changes', (t) => {
  const { config, db, orgId } = setup(t);
  putSecret(db, config, { scope: 'organization', scopeId: orgId, name: 'TOKEN', value: 'first-value' });
  const before = listSecrets(db, { scope: 'organization', scopeId: orgId })[0];

  const rotated = putSecret(db, config, { scope: 'organization', scopeId: orgId, name: 'TOKEN', value: 'second-value' });
  assert.equal(rotated.created, false);
  const after = listSecrets(db, { scope: 'organization', scopeId: orgId })[0];
  assert.notEqual(after.digest, before.digest, 'a rotation must be visible without reading the value');
  assert.equal(resolveSecrets(db, config, { organizationId: orgId })[0].value, 'second-value');

  deleteSecret(db, { scope: 'organization', scopeId: orgId, name: 'TOKEN' });
  assert.deepEqual(listSecrets(db, { scope: 'organization', scopeId: orgId }), []);
  assert.throws(() => deleteSecret(db, { scope: 'organization', scopeId: orgId, name: 'TOKEN' }), (error) => error.code === 'SECRET_NOT_FOUND');
});

test('organization secrets require organization Admin, not repository access', async (t) => {
  const context = setup(t);
  const outsider = addUser(context.db, 'outsider@example.com');
  const developer = addUser(context.db, 'developer@example.com');
  context.db.prepare('INSERT INTO org_members (organization_id, user_id, role) VALUES (?, ?, ?)')
    .run(context.orgId, developer, 'developer');

  for (const [userId, label] of [[outsider, 'a non-member'], [developer, 'a developer']]) {
    const cookie = `kukgit_session=${createSession(context.db, userId).token}`;
    const response = await request(context, '/api/secrets/orgs/kuklabs/TOKEN', {
      method: 'PUT', cookie, body: { value: 'attempted-value' },
    });
    assert.equal(response.status, 403, `${label} must be refused`);
    assert.equal(response.payload.error.code, 'ORGANIZATION_ACCESS_DENIED');
  }
  assert.equal(context.db.prepare('SELECT COUNT(*) AS count FROM secrets').get().count, 0);

  // An admin succeeds.
  const admin = addUser(context.db, 'admin@example.com');
  context.db.prepare('INSERT INTO org_members (organization_id, user_id, role) VALUES (?, ?, ?)')
    .run(context.orgId, admin, 'admin');
  const allowed = await request(context, '/api/secrets/orgs/kuklabs/TOKEN', {
    method: 'PUT', cookie: `kukgit_session=${createSession(context.db, admin).token}`, body: { value: 'admin-value' },
  });
  assert.equal(allowed.status, 201);
});

test('repository secrets require repository Admin', async (t) => {
  const context = setup(t);
  const collaborator = addUser(context.db, 'collab@example.com');
  context.db.prepare(`
    INSERT INTO repository_collaborators (repository_id, user_id, permission, added_by)
    VALUES (?, ?, 'write', ?)
  `).run(context.repositoryId, collaborator, context.userId);

  const writeCookie = `kukgit_session=${createSession(context.db, collaborator).token}`;
  const refused = await request(context, '/api/secrets/repos/kuklabs/app/TOKEN', {
    method: 'PUT', cookie: writeCookie, body: { value: 'value' },
  });
  assert.equal(refused.status, 403);
  assert.equal(refused.payload.error.code, 'REPOSITORY_ACCESS_DENIED');

  const listRefused = await request(context, '/api/secrets/repos/kuklabs/app', { cookie: writeCookie });
  assert.equal(listRefused.status, 403);

  const ownerCookie = `kukgit_session=${createSession(context.db, context.userId).token}`;
  assert.equal((await request(context, '/api/secrets/repos/kuklabs/app/TOKEN', {
    method: 'PUT', cookie: ownerCookie, body: { value: 'repository-value' },
  })).status, 201);
});

test('a repository listing shows inherited organization names without their values', async (t) => {
  const context = setup(t);
  const cookie = `kukgit_session=${createSession(context.db, context.userId).token}`;
  putSecret(context.db, context.config, { scope: 'organization', scopeId: context.orgId, name: 'ORG_TOKEN', value: 'inherited-value' });
  putSecret(context.db, context.config, { scope: 'repository', scopeId: context.repositoryId, name: 'REPO_TOKEN', value: 'repository-value' });

  const listed = await request(context, '/api/secrets/repos/kuklabs/app', { cookie });
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.payload.secrets.map((secret) => secret.name), ['REPO_TOKEN']);
  // Showing that an inherited value exists prevents an unexplained value in a
  // build from looking like a bug.
  assert.deepEqual(listed.payload.inherited, ['ORG_TOKEN']);
  assert.doesNotMatch(listed.raw, /inherited-value|repository-value/);
});

test('anonymous callers and cross-origin writes are refused', async (t) => {
  const context = setup(t);
  const anonymous = await request(context, '/api/secrets/orgs/kuklabs', {});
  assert.equal(anonymous.status, 401);
  assert.doesNotMatch(anonymous.raw, /secrets/);
});

test('the audit trail records the name but never the value', async (t) => {
  const context = setup(t);
  const cookie = `kukgit_session=${createSession(context.db, context.userId).token}`;
  await request(context, '/api/secrets/orgs/kuklabs/DEPLOY_TOKEN', { method: 'PUT', cookie, body: { value: 'audited-secret-value' } });
  await request(context, '/api/secrets/orgs/kuklabs/DEPLOY_TOKEN', { method: 'PUT', cookie, body: { value: 'rotated-secret-value' } });
  const removed = await request(context, '/api/secrets/orgs/kuklabs/DEPLOY_TOKEN', { method: 'DELETE', cookie });
  assert.equal(removed.status, 204);

  // Compared as a set: audit timestamps have second granularity, so insertion
  // order is not recoverable from the row and is not what this test is about.
  const events = context.db.prepare("SELECT action, metadata_json AS metadata FROM audit_logs WHERE action LIKE 'secret.%'").all();
  assert.deepEqual(events.map((event) => event.action).sort(), ['secret.created', 'secret.deleted', 'secret.updated']);
  for (const event of events) {
    assert.match(event.metadata, /DEPLOY_TOKEN/);
    assert.doesNotMatch(event.metadata, /audited-secret-value|rotated-secret-value/);
  }
});

test('masking replaces values in text but does not turn a log into asterisks', () => {
  assert.equal(maskSecrets('token=abcdef1234 done', ['abcdef1234']), 'token=*** done');
  assert.equal(maskSecrets('a-b-a', ['a-b-a', 'a-b']), '***');

  // A very short value would match ordinary text everywhere; masking it would
  // hide more than it protects.
  assert.equal(maskSecrets('the cat sat on the mat', ['cat']), 'the cat sat on the mat');
  assert.equal(maskSecrets('nothing here', []), 'nothing here');
  assert.equal(maskSecrets(null, ['x'.repeat(10)]), '');
});
