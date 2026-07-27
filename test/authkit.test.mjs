import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { currentUser } from '../src/auth.mjs';
import { createAuthKitBootstrapGuard, ensureAuthKitCoreOrganization } from '../src/authkit-bootstrap.mjs';
import {
  createAuthKitApiHandler,
  createAuthKitIdentityMiddleware,
  decryptAuthKitSecret,
  linkAuthKitUser,
  migrateAuthKitIdentity,
} from '../src/authkit-identity.mjs';
import { createSecureAuthKitLoginApiHandler } from '../src/authkit-secure-login.mjs';
import { createAuthKitCentralSessionGuard } from '../src/authkit-session-guard.mjs';
import { loadConfig } from '../src/config.mjs';
import { openDatabase, uid } from '../src/db.mjs';

function json(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...headers });
  res.end(body);
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

function createFakeAuthKit(t) {
  const state = {
    access: 'access-1',
    refresh: 'refresh-1',
    sessionActive: true,
    unavailable: false,
    productHeaders: [],
    refreshCount: 0,
    logoutCount: 0,
  };
  const user = {
    kuklabs_user_id: 'usr_01KUKLABS_AUTHKIT_TEST',
    id: 'usr_01KUKLABS_AUTHKIT_TEST',
    full_name: 'Central Developer',
    email: 'central@example.com',
    phone: '+919999999999',
    email_verified: true,
    phone_verified: true,
  };
  const server = http.createServer(async (req, res) => {
    state.productHeaders.push(req.headers['x-kuklabs-product']);
    if (state.unavailable) return req.socket.destroy();
    const url = new URL(req.url, 'http://authkit.test');
    const bearer = String(req.headers.authorization || '').replace(/^Bearer /, '');
    if (req.method === 'GET' && url.pathname === '/v1/auth/status') {
      return json(res, 200, { ok: true, contract: 'kuklabs-authkit-rest/1', google: { enabled: false } });
    }
    if (req.method === 'POST' && url.pathname === '/v1/auth/login') {
      const body = await readJson(req);
      if (body.password !== 'central-password') return json(res, 401, { error: true, message: 'Invalid email/mobile or password.' });
      return json(res, 200, {
        access_token: state.access,
        refresh_token: state.refresh,
        token_type: 'Bearer',
        expires_in: 60,
        user,
      });
    }
    if (req.method === 'POST' && url.pathname === '/v1/auth/signup') {
      return json(res, 403, { error: true, status: 'otp_required', identifier: 'central@example.com', message: 'Enter the code.' });
    }
    if (req.method === 'POST' && url.pathname === '/v1/auth/otp/request') {
      return json(res, 200, { success: true, status: 'otp_sent' });
    }
    if (req.method === 'POST' && url.pathname === '/v1/auth/otp/verify') {
      return json(res, 200, { access_token: state.access, refresh_token: state.refresh, expires_in: 60, user });
    }
    if (req.method === 'GET' && url.pathname === '/v1/auth/products/kukgit/access') {
      if (bearer !== state.access) return json(res, 401, { message: 'expired' });
      return json(res, 200, { access: true, status: 'active', product: 'kukgit' });
    }
    if (req.method === 'GET' && url.pathname === '/v1/auth/me') {
      if (bearer !== state.access) return json(res, 401, { message: 'expired' });
      return json(res, 200, { user });
    }
    if (req.method === 'POST' && url.pathname === '/v1/auth/token/refresh') {
      const body = await readJson(req);
      if (body.refresh_token !== state.refresh || !state.sessionActive) return json(res, 401, { message: 'Session expired.' });
      state.refreshCount += 1;
      state.access = `access-${state.refreshCount + 1}`;
      state.refresh = `refresh-${state.refreshCount + 1}`;
      return json(res, 200, { access_token: state.access, refresh_token: state.refresh, expires_in: 60, user });
    }
    if (req.method === 'GET' && url.pathname === '/v1/auth/sessions') {
      if (bearer !== state.access || !state.sessionActive) return json(res, 401, { message: 'revoked' });
      return json(res, 200, { sessions: [{ id: 'central-session', current: true }] });
    }
    if (req.method === 'POST' && url.pathname === '/v1/auth/logout') {
      state.logoutCount += 1;
      state.sessionActive = false;
      return json(res, 200, { success: true });
    }
    return json(res, 404, { message: 'not found' });
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { server, state, user };
}

async function setup(t) {
  const fake = createFakeAuthKit(t);
  const authkitOrigin = await listen(fake.server);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-authkit-test-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const config = loadConfig({
    dataDir,
    databasePath: path.join(dataDir, 'kukgit.db'),
    repositoriesDir: path.join(dataDir, 'repos'),
    tempDir: path.join(dataDir, 'tmp'),
    nodeEnv: 'test',
    baseUrl: 'http://127.0.0.1:8787',
    authMode: 'authkit',
    authkitBaseUrl: authkitOrigin,
    authkitProductId: 'kukgit',
    authkitEncryptionKey: 'authkit-test-encryption-key-with-more-than-32-characters',
    authkitTimeoutMs: 2000,
    authkitRefreshTtlDays: 60,
    adminEmail: 'central@example.com',
    cookieSecure: false,
  });
  const db = openDatabase(config);
  t.after(() => db.close());
  migrateAuthKitIdentity(db);
  ensureAuthKitCoreOrganization(db);

  const secureLogin = createSecureAuthKitLoginApiHandler({ config, db });
  const authApi = createAuthKitApiHandler({ config, db });
  const app = async (req, res) => {
    if (await secureLogin(req, res)) return;
    if (await authApi(req, res)) return;
    const url = new URL(req.url, config.baseUrl);
    if (url.pathname === '/api/protected') {
      const user = currentUser(db, req);
      return user ? json(res, 200, { user }) : json(res, 401, { error: { code: 'AUTH_REQUIRED' } });
    }
    return json(res, 404, { error: { code: 'NOT_FOUND' } });
  };
  const bootstrap = createAuthKitBootstrapGuard({ config, db, next: app });
  const central = createAuthKitCentralSessionGuard({ config, db, next: bootstrap });
  const identity = createAuthKitIdentityMiddleware({ config, db, next: central });
  const server = http.createServer(identity);
  const origin = await listen(server);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  config.baseUrl = origin;
  return { ...fake, config, db, origin };
}

async function login(context, originHeader = null) {
  return fetch(`${context.origin}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(originHeader ? { Origin: originHeader } : {}) },
    body: JSON.stringify({ identifier: 'central@example.com', password: 'central-password' }),
  });
}

test('links verified central identity, stores encrypted tokens and bootstraps founder ownership', async (t) => {
  const context = await setup(t);
  const response = await login(context);
  assert.equal(response.status, 200);
  const cookie = response.headers.get('set-cookie').split(';')[0];
  assert.match(cookie, /^kukgit_session=/);

  const local = context.db.prepare(`
    SELECT id, email, password_hash AS passwordHash, kuklabs_user_id AS kuklabsUserId,
      auth_source AS authSource, email_verified AS emailVerified
    FROM users WHERE email = 'central@example.com'
  `).get();
  assert.equal(local.kuklabsUserId, context.user.kuklabs_user_id);
  assert.equal(local.authSource, 'authkit');
  assert.equal(local.emailVerified, 1);
  assert.equal(local.passwordHash, 'authkit$managed');

  const membership = context.db.prepare(`
    SELECT om.role FROM org_members om JOIN organizations o ON o.id = om.organization_id
    WHERE o.slug = 'kuklabs' AND om.user_id = ?
  `).get(local.id);
  assert.equal(membership.role, 'owner');

  const session = context.db.prepare(`
    SELECT token_hash AS tokenHash, authkit_access_ciphertext AS accessCiphertext,
      authkit_refresh_ciphertext AS refreshCiphertext
    FROM sessions WHERE user_id = ? AND auth_mode = 'authkit'
  `).get(local.id);
  assert.notEqual(session.accessCiphertext, context.state.access);
  assert.notEqual(session.refreshCiphertext, context.state.refresh);
  assert.equal(decryptAuthKitSecret(context.config, session.accessCiphertext, session.tokenHash), context.state.access);
  assert.equal(decryptAuthKitSecret(context.config, session.refreshCiphertext, session.tokenHash), context.state.refresh);

  const me = await fetch(`${context.origin}/api/auth/me`, { headers: { Cookie: cookie } });
  assert.equal(me.status, 200);
  const payload = await me.json();
  assert.equal(payload.user.kuklabsUserId, context.user.kuklabs_user_id);
  assert.equal(payload.organizations[0].role, 'owner');
  assert.equal(context.state.productHeaders.every((value) => value === 'kukgit'), true);
});

test('rotates refresh tokens, fails closed during outage and revokes centrally invalid sessions', async (t) => {
  const context = await setup(t);
  const loginResponse = await login(context);
  const cookie = loginResponse.headers.get('set-cookie').split(';')[0];

  context.state.access = 'access-rotated-remotely';
  const refreshed = await fetch(`${context.origin}/api/protected`, { headers: { Cookie: cookie } });
  assert.equal(refreshed.status, 200);
  assert.equal(context.state.refreshCount, 1);

  context.state.unavailable = true;
  const unavailable = await fetch(`${context.origin}/api/protected`, { headers: { Cookie: cookie } });
  assert.equal(unavailable.status, 503);
  assert.equal((await unavailable.json()).error.code, 'AUTHKIT_UNAVAILABLE');
  context.state.unavailable = false;

  context.state.sessionActive = false;
  const revoked = await fetch(`${context.origin}/api/protected`, { headers: { Cookie: cookie } });
  assert.equal(revoked.status, 401);
  assert.match(revoked.headers.get('set-cookie') || '', /Max-Age=0/);
  assert.equal(context.db.prepare("SELECT COUNT(*) AS count FROM sessions WHERE auth_mode = 'authkit'").get().count, 0);
});

test('logout revokes central session, clears local bridge and same-origin checks block cross-site login', async (t) => {
  const context = await setup(t);
  const blocked = await login(context, 'https://attacker.example');
  assert.equal(blocked.status, 403);
  assert.equal((await blocked.json()).error.code, 'CSRF_BLOCKED');

  const loginResponse = await login(context);
  const cookie = loginResponse.headers.get('set-cookie').split(';')[0];
  const logout = await fetch(`${context.origin}/api/auth/logout`, { method: 'POST', headers: { Cookie: cookie } });
  assert.equal(logout.status, 204);
  assert.equal(context.state.logoutCount, 1);
  assert.equal(context.db.prepare("SELECT COUNT(*) AS count FROM sessions WHERE auth_mode = 'authkit'").get().count, 0);
  assert.match(logout.headers.get('set-cookie') || '', /Max-Age=0/);
});

test('identity linking rejects duplicate central IDs and email collisions', async (t) => {
  const context = await setup(t);
  linkAuthKitUser(context.db, context.user);
  const otherId = uid('usr');
  context.db.prepare(`
    INSERT INTO users (id, email, password_hash, display_name, kuklabs_user_id, auth_source, email_verified)
    VALUES (?, ?, 'authkit$managed', 'Other', ?, 'authkit', 1)
  `).run(otherId, 'other@example.com', 'usr_OTHER_CENTRAL');
  assert.throws(() => linkAuthKitUser(context.db, {
    ...context.user,
    kuklabs_user_id: 'usr_OTHER_CENTRAL',
  }), (error) => error.code === 'AUTHKIT_IDENTITY_CONFLICT');
});

test('production configuration never permits local password authentication mode', () => {
  assert.throws(() => loadConfig({
    nodeEnv: 'production',
    authMode: 'local',
    baseUrl: 'https://git.kuklabs.com',
  }), /Production KukGit must use One Kuklabs Account\/AuthKit/);
});
