import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.mjs';
import {
  createAuthKitBootstrapGuard,
  ensureAuthKitCoreOrganization,
} from '../src/authkit-bootstrap.mjs';
import {
  createAuthKitApiHandler,
  createAuthKitIdentityMiddleware,
  decryptAuthKitSecret,
  encryptAuthKitSecret,
  linkAuthKitUser,
  migrateAuthKitIdentity,
} from '../src/authkit-identity.mjs';
import { loadConfig } from '../src/config.mjs';
import { openDatabase } from '../src/db.mjs';

const identity = {
  kuklabs_user_id: '1001',
  id: 1001,
  full_name: 'Founder User',
  email: 'founder@example.com',
  phone: '+919999999999',
  email_verified: true,
  phone_verified: true,
};

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function createAuthKitMock(t) {
  const state = {
    loginCount: 0,
    refreshCount: 0,
    logoutCount: 0,
    productChecks: 0,
    meChecks: 0,
    forceAccessRefresh: false,
    denyProduct: false,
    revoked: false,
    productHeaders: [],
  };

  const server = http.createServer(async (req, res) => {
    state.productHeaders.push(req.headers['x-kuklabs-product']);
    const url = new URL(req.url, 'http://authkit.test');
    const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : {};
    const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');

    if (req.method === 'GET' && url.pathname === '/v1/auth/status') {
      return json(res, 200, { ok: true, contract: 'kuklabs-authkit-rest/1', google: { enabled: true } });
    }
    if (req.method === 'POST' && url.pathname === '/v1/auth/login') {
      state.loginCount += 1;
      if (body.identifier !== identity.email || body.password !== 'correct-password') {
        return json(res, 401, { error: true, message: 'Invalid email/mobile or password.' });
      }
      return json(res, 200, {
        access_token: 'access-1',
        refresh_token: 'refresh-1',
        token_type: 'Bearer',
        expires_in: 3600,
        user: identity,
      });
    }
    if (req.method === 'POST' && url.pathname === '/v1/auth/signup') {
      return json(res, 403, {
        error: true,
        message: 'Enter the 6-digit code.',
        status: 'otp_required',
        identifier: String(body.identifier || '').toLowerCase(),
      });
    }
    if (req.method === 'POST' && url.pathname === '/v1/auth/otp/request') {
      return json(res, 200, { success: true, status: 'otp_sent' });
    }
    if (req.method === 'POST' && url.pathname === '/v1/auth/otp/verify') {
      if (body.code !== '123456') return json(res, 400, { error: true, message: 'Invalid code.' });
      return json(res, 200, {
        access_token: 'access-otp',
        refresh_token: 'refresh-otp',
        token_type: 'Bearer',
        expires_in: 3600,
        user: identity,
      });
    }
    if (req.method === 'POST' && url.pathname === '/v1/auth/google') {
      if (body.id_token !== 'google-id-token') return json(res, 401, { error: true, message: 'Google sign-in failed.' });
      return json(res, 200, {
        access_token: 'access-google',
        refresh_token: 'refresh-google',
        token_type: 'Bearer',
        expires_in: 3600,
        user: identity,
      });
    }
    if (req.method === 'POST' && url.pathname === '/v1/auth/token/refresh') {
      state.refreshCount += 1;
      if (body.refresh_token !== 'refresh-1') return json(res, 401, { error: true, message: 'Session expired.' });
      state.forceAccessRefresh = false;
      return json(res, 200, {
        access_token: 'access-2',
        refresh_token: 'refresh-2',
        token_type: 'Bearer',
        expires_in: 3600,
        user: identity,
      });
    }
    if (req.method === 'GET' && url.pathname === '/v1/auth/me') {
      state.meChecks += 1;
      if (state.revoked || !bearer || (state.forceAccessRefresh && bearer === 'access-1')) {
        return json(res, 401, { error: true, message: 'Session expired.' });
      }
      if (!['access-1', 'access-2', 'access-otp', 'access-google'].includes(bearer)) {
        return json(res, 401, { error: true, message: 'Session expired.' });
      }
      return json(res, 200, { user: identity });
    }
    if (req.method === 'GET' && url.pathname === '/v1/auth/products/kukgit/access') {
      state.productChecks += 1;
      if (state.denyProduct) return json(res, 403, { status: 'blocked', access: false });
      return json(res, 200, { product: 'kukgit', status: 'active', access: true });
    }
    if (req.method === 'POST' && url.pathname === '/v1/auth/logout') {
      state.logoutCount += 1;
      return json(res, 200, { success: true });
    }
    return json(res, 404, { error: true, message: 'Not found.' });
  });

  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { server, state };
}

function appServer(config, db) {
  const app = createApp({ config, db });
  const authApi = createAuthKitApiHandler({ config, db });
  const dispatch = async (req, res) => {
    if (await authApi(req, res)) return;
    return app(req, res);
  };
  const bootstrap = createAuthKitBootstrapGuard({ config, db, next: dispatch });
  const identityMiddleware = createAuthKitIdentityMiddleware({ config, db, next: bootstrap });
  return http.createServer(identityMiddleware);
}

async function request(origin, pathname, { method = 'GET', cookie = '', body, originHeader = '' } = {}) {
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (originHeader) headers.Origin = originHeader;
  const response = await fetch(`${origin}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = response.status === 204 ? null : await response.json().catch(() => ({}));
  return { response, payload };
}

function setupDatabase(t, authkitBaseUrl) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-authkit-test-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const config = loadConfig({
    dataDir,
    databasePath: path.join(dataDir, 'kukgit.db'),
    repositoriesDir: path.join(dataDir, 'repos'),
    tempDir: path.join(dataDir, 'tmp'),
    nodeEnv: 'test',
    authMode: 'authkit',
    authkitBaseUrl,
    authkitEncryptionKey: 'authkit-test-encryption-key-with-more-than-32-characters',
    authkitTimeoutMs: 2000,
    adminEmail: identity.email,
    adminPassword: 'unused-production-password',
    adminName: identity.full_name,
  });
  const db = openDatabase(config);
  t.after(() => db.close());
  migrateAuthKitIdentity(db);
  ensureAuthKitCoreOrganization(db);
  return { config, db };
}

test('AuthKit login links the central identity, encrypts tokens and validates every protected request', async (t) => {
  const mock = createAuthKitMock(t);
  const authkitBaseUrl = await listen(mock.server);
  const { config, db } = setupDatabase(t, authkitBaseUrl);
  const server = appServer(config, db);
  const origin = await listen(server);
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const status = await request(origin, '/api/auth/status');
  assert.equal(status.response.status, 200);
  assert.equal(status.payload.mode, 'authkit');
  assert.equal(status.payload.contract, 'kuklabs-authkit-rest/1');

  const login = await request(origin, '/api/auth/login', {
    method: 'POST',
    body: { identifier: identity.email, password: 'correct-password' },
  });
  assert.equal(login.response.status, 200);
  assert.equal(login.payload.user.kuklabsUserId, identity.kuklabs_user_id);
  const cookie = login.response.headers.get('set-cookie').split(';')[0];
  assert.match(cookie, /^kukgit_session=/);

  const user = db.prepare(`
    SELECT id, email, password_hash AS passwordHash, kuklabs_user_id AS kuklabsUserId,
      auth_source AS authSource, email_verified AS emailVerified
    FROM users
  `).get();
  assert.equal(user.email, identity.email);
  assert.equal(user.kuklabsUserId, identity.kuklabs_user_id);
  assert.equal(user.authSource, 'authkit');
  assert.equal(user.emailVerified, 1);
  assert.equal(user.passwordHash, 'authkit$managed');

  const stored = db.prepare(`
    SELECT token_hash AS tokenHash, authkit_access_ciphertext AS accessCiphertext,
      authkit_refresh_ciphertext AS refreshCiphertext, auth_mode AS authMode
    FROM sessions
  `).get();
  assert.equal(stored.authMode, 'authkit');
  assert.doesNotMatch(stored.accessCiphertext, /access-1/);
  assert.doesNotMatch(stored.refreshCiphertext, /refresh-1/);
  assert.equal(decryptAuthKitSecret(config, stored.accessCiphertext, stored.tokenHash), 'access-1');
  assert.equal(decryptAuthKitSecret(config, stored.refreshCiphertext, stored.tokenHash), 'refresh-1');

  const me = await request(origin, '/api/auth/me', { cookie });
  assert.equal(me.response.status, 200);
  assert.equal(me.payload.user.id, user.id);
  assert.equal(me.payload.user.kuklabsUserId, identity.kuklabs_user_id);
  assert.equal(me.payload.organizations[0].role, 'owner');
  assert.ok(mock.state.meChecks >= 1);
  assert.ok(mock.state.productChecks >= 2);
  assert.equal(mock.state.productHeaders.every((header) => header === 'kukgit'), true);

  const audit = db.prepare("SELECT metadata_json AS metadata FROM audit_logs WHERE action = 'auth.authkit_login'").get();
  assert.match(audit.metadata, /1001/);
  assert.doesNotMatch(audit.metadata, /access-|refresh-/);
});

test('AuthKit access expiry rotates refresh tokens and product denial fails closed', async (t) => {
  const mock = createAuthKitMock(t);
  const authkitBaseUrl = await listen(mock.server);
  const { config, db } = setupDatabase(t, authkitBaseUrl);
  const server = appServer(config, db);
  const origin = await listen(server);
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const login = await request(origin, '/api/auth/login', {
    method: 'POST',
    body: { identifier: identity.email, password: 'correct-password' },
  });
  const cookie = login.response.headers.get('set-cookie').split(';')[0];
  mock.state.forceAccessRefresh = true;

  const refreshedMe = await request(origin, '/api/auth/me', { cookie });
  assert.equal(refreshedMe.response.status, 200);
  assert.equal(mock.state.refreshCount, 1);
  const session = db.prepare(`
    SELECT token_hash AS tokenHash, authkit_access_ciphertext AS accessCiphertext,
      authkit_refresh_ciphertext AS refreshCiphertext FROM sessions
  `).get();
  assert.equal(decryptAuthKitSecret(config, session.accessCiphertext, session.tokenHash), 'access-2');
  assert.equal(decryptAuthKitSecret(config, session.refreshCiphertext, session.tokenHash), 'refresh-2');

  mock.state.denyProduct = true;
  const denied = await request(origin, '/api/auth/me', { cookie });
  assert.equal(denied.response.status, 403);
  assert.equal(denied.payload.error.code, 'KUKGIT_PRODUCT_ACCESS_DENIED');
});

test('AuthKit signup OTP, Google, logout and CSRF routes preserve the central contract', async (t) => {
  const mock = createAuthKitMock(t);
  const authkitBaseUrl = await listen(mock.server);
  const { config, db } = setupDatabase(t, authkitBaseUrl);
  const server = appServer(config, db);
  const origin = await listen(server);
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const signup = await request(origin, '/api/auth/signup', {
    method: 'POST',
    body: { full_name: 'Founder User', identifier: identity.email, password: 'correct-password' },
  });
  assert.equal(signup.response.status, 403);
  assert.equal(signup.payload.error.code, 'OTP_REQUIRED');
  assert.equal(signup.payload.identifier, identity.email);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM users').get().count, 0);

  const resend = await request(origin, '/api/auth/otp/request', {
    method: 'POST', body: { identifier: identity.email },
  });
  assert.equal(resend.response.status, 200);

  const otp = await request(origin, '/api/auth/otp/verify', {
    method: 'POST', body: { identifier: identity.email, code: '123456' },
  });
  assert.equal(otp.response.status, 200);
  const otpCookie = otp.response.headers.get('set-cookie').split(';')[0];

  const logout = await request(origin, '/api/auth/logout', { method: 'POST', cookie: otpCookie, body: {} });
  assert.equal(logout.response.status, 204);
  assert.equal(mock.state.logoutCount, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sessions').get().count, 0);

  const google = await request(origin, '/api/auth/google', {
    method: 'POST', body: { id_token: 'google-id-token' },
  });
  assert.equal(google.response.status, 200);

  const csrf = await request(origin, '/api/auth/login', {
    method: 'POST',
    originHeader: 'https://attacker.example',
    body: { identifier: identity.email, password: 'correct-password' },
  });
  assert.equal(csrf.response.status, 403);
  assert.equal(csrf.payload.error.code, 'CSRF_BLOCKED');
});

test('identity linking rejects duplicate central IDs and token encryption is authenticated', (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-authkit-link-test-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const config = loadConfig({
    dataDir,
    databasePath: path.join(dataDir, 'kukgit.db'),
    nodeEnv: 'test',
    authMode: 'authkit',
    authkitBaseUrl: 'https://auth.example.test',
    authkitEncryptionKey: 'authkit-test-encryption-key-with-more-than-32-characters',
  });
  const db = openDatabase(config);
  t.after(() => db.close());
  migrateAuthKitIdentity(db);

  const linked = linkAuthKitUser(db, identity);
  assert.equal(linked.kuklabsUserId, '1001');
  assert.throws(() => linkAuthKitUser(db, { ...identity, kuklabs_user_id: '2002' }), (error) => error.code === 'AUTHKIT_EMAIL_ALREADY_LINKED');

  const envelope = encryptAuthKitSecret(config, 'secret-token', 'session-aad');
  assert.equal(decryptAuthKitSecret(config, envelope, 'session-aad'), 'secret-token');
  assert.throws(() => decryptAuthKitSecret(config, envelope, 'different-aad'), (error) => error.code === 'AUTHKIT_SESSION_INVALID');
});

test('production defaults to AuthKit and refuses independent local password auth', () => {
  assert.throws(() => loadConfig({
    nodeEnv: 'production',
    authMode: 'local',
    allowLocalAuthInProduction: false,
  }), /Local KukGit password authentication is disabled/);

  assert.throws(() => loadConfig({
    nodeEnv: 'production',
    authMode: 'authkit',
    authkitBaseUrl: '',
    authkitEncryptionKey: 'authkit-test-encryption-key-with-more-than-32-characters',
  }), /KUKGIT_AUTHKIT_BASE_URL/);
});
