import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { hashPassword } from '../src/auth.mjs';
import { migrateAuthKitIdentity } from '../src/authkit-identity.mjs';
import { createSecureAuthKitLoginApiHandler } from '../src/authkit-secure-login.mjs';
import { loadConfig } from '../src/config.mjs';
import { openDatabase, uid } from '../src/db.mjs';

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

async function setup(t, { email = 'founder@example.com' } = {}) {
  const centralUser = {
    kuklabs_user_id: 'central-founder-1',
    id: 'central-founder-1',
    full_name: 'Verified Founder',
    email,
    email_verified: true,
  };
  const authkit = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://authkit.test');
    if (req.method === 'POST' && url.pathname === '/v1/auth/login') {
      const body = await readJson(req);
      if (body.password !== 'central-password') return sendJson(res, 401, { message: 'Invalid credentials.' });
      return sendJson(res, 200, {
        access_token: 'central-access-token',
        refresh_token: 'krt_central-refresh-token',
        expires_in: 3600,
        user: centralUser,
      });
    }
    if (req.method === 'GET' && url.pathname === '/v1/auth/products/kukgit/access') {
      return sendJson(res, 200, { access: true, status: 'active', product: 'kukgit' });
    }
    return sendJson(res, 404, { message: 'Not found.' });
  });
  const authkitBaseUrl = await listen(authkit);
  t.after(() => new Promise((resolve) => authkit.close(resolve)));

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-authkit-password-scrub-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const config = loadConfig({
    dataDir,
    databasePath: path.join(dataDir, 'kukgit.db'),
    repositoriesDir: path.join(dataDir, 'repos'),
    tempDir: path.join(dataDir, 'tmp'),
    baseUrl: 'http://127.0.0.1:8787',
    nodeEnv: 'test',
    authMode: 'authkit',
    authkitBaseUrl,
    authkitEncryptionKey: 'password-scrub-test-key-with-at-least-32-characters',
  });
  const db = openDatabase(config);
  t.after(() => db.close());
  migrateAuthKitIdentity(db);

  const handler = createSecureAuthKitLoginApiHandler({ config, db });
  const kukgit = http.createServer(async (req, res) => {
    if (await handler(req, res)) return;
    res.writeHead(404);
    res.end();
  });
  const origin = await listen(kukgit);
  config.baseUrl = origin;
  t.after(() => new Promise((resolve) => kukgit.close(resolve)));
  return { centralUser, config, db, origin };
}

test('verified AuthKit linking preserves product foreign keys and removes reusable local password material', async (t) => {
  const context = await setup(t);
  const userId = uid('usr');
  const orgId = uid('org');
  const repositoryId = uid('repo');
  const oldHash = hashPassword('legacy-local-password');

  context.db.prepare('INSERT INTO users (id, email, password_hash, display_name) VALUES (?, ?, ?, ?)')
    .run(userId, context.centralUser.email, oldHash, 'Legacy Founder');
  context.db.prepare("INSERT INTO organizations (id, slug, name, plan) VALUES (?, 'kuklabs', 'Kuklabs Inc.', 'founder')")
    .run(orgId);
  context.db.prepare("INSERT INTO org_members (organization_id, user_id, role) VALUES (?, ?, 'owner')")
    .run(orgId, userId);
  context.db.prepare(`
    INSERT INTO repositories
      (id, organization_id, slug, name, description, visibility, default_branch, created_by)
    VALUES (?, ?, 'authkit-demo', 'AuthKit Demo', '', 'private', 'main', ?)
  `).run(repositoryId, orgId, userId);

  const response = await fetch(`${context.origin}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: context.origin },
    body: JSON.stringify({ identifier: context.centralUser.email, password: 'central-password' }),
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.user.id, userId);
  assert.equal(payload.user.kuklabsUserId, context.centralUser.kuklabs_user_id);
  assert.equal('access_token' in payload, false);
  assert.equal('refresh_token' in payload, false);
  assert.doesNotMatch(String(response.headers.get('set-cookie')), /central-access-token|krt_central/);

  const user = context.db.prepare(`
    SELECT id, password_hash AS passwordHash, auth_source AS authSource,
      kuklabs_user_id AS centralId
    FROM users WHERE id = ?
  `).get(userId);
  assert.equal(user.passwordHash, 'authkit$managed');
  assert.notEqual(user.passwordHash, oldHash);
  assert.equal(user.authSource, 'authkit');
  assert.equal(user.centralId, context.centralUser.kuklabs_user_id);
  assert.equal(
    context.db.prepare('SELECT created_by AS createdBy FROM repositories WHERE id = ?').get(repositoryId).createdBy,
    userId,
  );
  assert.equal(
    context.db.prepare('SELECT role FROM org_members WHERE organization_id = ? AND user_id = ?').get(orgId, userId).role,
    'owner',
  );
});

test('verified flag without a central email is rejected before creating a KukGit user or session', async (t) => {
  const context = await setup(t, { email: null });
  const response = await fetch(`${context.origin}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: context.origin },
    body: JSON.stringify({ identifier: 'missing@example.com', password: 'central-password' }),
  });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, 'AUTHKIT_EMAIL_REQUIRED');
  assert.equal(context.db.prepare('SELECT COUNT(*) AS count FROM users').get().count, 0);
  assert.equal(context.db.prepare('SELECT COUNT(*) AS count FROM sessions').get().count, 0);
});
