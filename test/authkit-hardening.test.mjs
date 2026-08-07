import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.mjs';
import { ensureAuthKitCoreOrganization } from '../src/authkit-bootstrap.mjs';
import {
  createAuthKitApiHandler,
  createAuthKitIdentityMiddleware,
  migrateAuthKitIdentity,
} from '../src/authkit-identity.mjs';
import { createSecureAuthKitLoginApiHandler } from '../src/authkit-secure-login.mjs';
import { createAuthKitCentralSessionGuard } from '../src/authkit-session-guard.mjs';
import { loadConfig } from '../src/config.mjs';
import { openDatabase } from '../src/db.mjs';

const verifiedUser = {
  kuklabs_user_id: 'central-1001',
  id: 'central-1001',
  full_name: 'Verified Founder',
  email: 'verified@example.com',
  email_verified: true,
};

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function createAuthKitMock(t) {
  const state = {
    user: verifiedUser,
    productAccess: true,
    currentSession: true,
    accessToken: 'access-token',
    refreshToken: 'krt_refresh-token',
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://authkit.test');
    const body = req.method === 'POST' ? await readJson(req) : {};
    const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');

    if (url.pathname === '/v1/auth/status') {
      return sendJson(res, 200, { ok: true, contract: 'kuklabs-authkit-rest/1', google: { enabled: false } });
    }
    if (req.method === 'POST' && url.pathname === '/v1/auth/login') {
      if (body.password !== 'correct-password') return sendJson(res, 401, { message: 'Invalid credentials.' });
      return sendJson(res, 200, {
        access_token: state.accessToken,
        refresh_token: state.refreshToken,
        expires_in: 3600,
        user: state.user,
      });
    }
    if (req.method === 'GET' && url.pathname === '/v1/auth/me') {
      if (bearer !== state.accessToken) return sendJson(res, 401, { message: 'Session expired.' });
      return sendJson(res, 200, { user: state.user });
    }
    if (req.method === 'GET' && url.pathname === '/v1/auth/products/kukgit/access') {
      if (bearer !== state.accessToken) return sendJson(res, 401, { message: 'Session expired.' });
      return sendJson(res, state.productAccess ? 200 : 403, {
        access: state.productAccess,
        product: 'kukgit',
        status: state.productAccess ? 'active' : 'blocked',
      });
    }
    if (req.method === 'GET' && url.pathname === '/v1/auth/sessions') {
      if (bearer !== state.accessToken) return sendJson(res, 401, { message: 'Session expired.' });
      return sendJson(res, 200, {
        sessions: state.currentSession ? [{ id: 'sid-current', product: 'kukgit', current: true }] : [],
      });
    }
    if (req.method === 'POST' && url.pathname === '/v1/auth/logout') {
      return sendJson(res, 200, { success: true });
    }
    return sendJson(res, 404, { message: 'Not found.' });
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { server, state };
}

function createContext(t, authkitBaseUrl) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-authkit-hardening-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const config = loadConfig({
    dataDir,
    databasePath: path.join(dataDir, 'kukgit.db'),
    repositoriesDir: path.join(dataDir, 'repos'),
    tempDir: path.join(dataDir, 'tmp'),
    nodeEnv: 'test',
    authMode: 'authkit',
    authkitBaseUrl,
    authkitEncryptionKey: 'hardening-test-encryption-key-with-at-least-32-characters',
    // These tests are about what KukGit does when it asks AuthKit. The
    // revalidation window exists so that most requests do not ask, and it is
    // covered on its own in authkit-session-window.test.mjs.
    authkitSessionCheckSeconds: 0,
    adminEmail: verifiedUser.email,
  });
  const db = openDatabase(config);
  t.after(() => db.close());
  migrateAuthKitIdentity(db);
  ensureAuthKitCoreOrganization(db);

  const app = createApp({ config, db });
  const secureLogin = createSecureAuthKitLoginApiHandler({ config, db });
  const authApi = createAuthKitApiHandler({ config, db });
  const dispatch = async (req, res) => {
    if (await secureLogin(req, res)) return;
    if (await authApi(req, res)) return;
    return app(req, res);
  };
  const centralSession = createAuthKitCentralSessionGuard({ config, db, next: dispatch });
  const identity = createAuthKitIdentityMiddleware({ config, db, next: centralSession });
  const server = http.createServer(identity);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { config, db, server };
}

async function request(origin, pathname, { method = 'GET', cookie = '', body } = {}) {
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${origin}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = response.status === 204 ? null : await response.json().catch(() => ({}));
  return { response, payload };
}

test('secure login refuses an unverified central email before creating a KukGit identity', async (t) => {
  const mock = createAuthKitMock(t);
  const authkitBaseUrl = await listen(mock.server);
  const context = createContext(t, authkitBaseUrl);
  const origin = await listen(context.server);
  mock.state.user = { ...verifiedUser, email_verified: false };

  const login = await request(origin, '/api/auth/login', {
    method: 'POST',
    body: { identifier: verifiedUser.email, password: 'correct-password' },
  });
  assert.equal(login.response.status, 403);
  assert.equal(login.payload.error.code, 'AUTHKIT_EMAIL_NOT_VERIFIED');
  assert.equal(context.db.prepare('SELECT COUNT(*) AS count FROM users').get().count, 0);
  assert.equal(context.db.prepare('SELECT COUNT(*) AS count FROM sessions').get().count, 0);
});

test('product-access preflight blocks identity linking and session creation', async (t) => {
  const mock = createAuthKitMock(t);
  const authkitBaseUrl = await listen(mock.server);
  const context = createContext(t, authkitBaseUrl);
  const origin = await listen(context.server);
  mock.state.productAccess = false;

  const login = await request(origin, '/api/auth/login', {
    method: 'POST',
    body: { identifier: verifiedUser.email, password: 'correct-password' },
  });
  assert.equal(login.response.status, 403);
  assert.equal(login.payload.error.code, 'KUKGIT_PRODUCT_ACCESS_DENIED');
  assert.equal(context.db.prepare('SELECT COUNT(*) AS count FROM users').get().count, 0);
  assert.equal(context.db.prepare('SELECT COUNT(*) AS count FROM sessions').get().count, 0);
});

test('central device-session revocation immediately removes the local browser bridge', async (t) => {
  const mock = createAuthKitMock(t);
  const authkitBaseUrl = await listen(mock.server);
  const context = createContext(t, authkitBaseUrl);
  const origin = await listen(context.server);

  const login = await request(origin, '/api/auth/login', {
    method: 'POST',
    body: { identifier: verifiedUser.email, password: 'correct-password' },
  });
  assert.equal(login.response.status, 200);
  const cookie = login.response.headers.get('set-cookie').split(';')[0];

  const active = await request(origin, '/api/auth/me', { cookie });
  assert.equal(active.response.status, 200);
  assert.equal(active.payload.user.kuklabsUserId, verifiedUser.kuklabs_user_id);

  mock.state.currentSession = false;
  const revoked = await request(origin, '/api/auth/me', { cookie });
  assert.equal(revoked.response.status, 401);
  assert.equal(revoked.payload.error.code, 'AUTHKIT_SESSION_REVOKED');
  assert.equal(context.db.prepare('SELECT COUNT(*) AS count FROM sessions').get().count, 0);
  assert.match(revoked.response.headers.get('set-cookie'), /Max-Age=0/);
});

test('AuthKit production configuration requires HTTPS and valid bounded identifiers', () => {
  assert.throws(() => loadConfig({
    nodeEnv: 'production',
    authMode: 'authkit',
    authkitBaseUrl: 'http://auth.kuklabs.com',
    authkitEncryptionKey: 'hardening-test-encryption-key-with-at-least-32-characters',
  }), /must use HTTPS/);

  assert.throws(() => loadConfig({
    nodeEnv: 'test',
    authMode: 'authkit',
    authkitBaseUrl: 'https://user:pass@auth.example.test',
    authkitEncryptionKey: 'hardening-test-encryption-key-with-at-least-32-characters',
  }), /must not contain embedded credentials/);

  assert.throws(() => loadConfig({
    nodeEnv: 'test',
    authMode: 'authkit',
    authkitBaseUrl: 'https://auth.example.test',
    authkitProductId: 'INVALID PRODUCT',
    authkitEncryptionKey: 'hardening-test-encryption-key-with-at-least-32-characters',
  }), /KUKGIT_AUTHKIT_PRODUCT_ID/);
});
