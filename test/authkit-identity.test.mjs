import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.mjs';
import { hashPassword } from '../src/auth.mjs';
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
import { createSecureAuthKitLoginApiHandler } from '../src/authkit-secure-login.mjs';
import { createAuthKitCentralSessionGuard } from '../src/authkit-session-guard.mjs';
import { loadConfig } from '../src/config.mjs';
import { openDatabase, uid } from '../src/db.mjs';

const CENTRAL_USER = {
  kuklabs_user_id: 'usr_01KUKLABS_AUTHKIT_TEST',
  id: 'usr_01KUKLABS_AUTHKIT_TEST',
  full_name: 'Kuklabs Founder',
  email: 'founder@example.com',
  phone: '+919999999999',
  email_verified: true,
  phone_verified: true,
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
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

function fakeAuthKit() {
  const state = {
    loginCalls: 0,
    refreshCalls: 0,
    logoutCalls: 0,
    productCalls: 0,
    accessVersion: 1,
    activeAccess: new Set(),
    currentRefresh: '',
    sessionCurrent: true,
    productAccess: true,
    unavailable: false,
    productHeaders: [],
  };

  function issue() {
    const version = state.accessVersion++;
    const accessToken = `access-${version}`;
    const refreshToken = `krt_refresh-${version}`;
    state.activeAccess.add(accessToken);
    state.currentRefresh = refreshToken;
    state.sessionCurrent = true;
    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: 'Bearer',
      expires_in: 3600,
      user: { ...CENTRAL_USER },
    };
  }

  function bearer(req) {
    const value = String(req.headers.authorization || '');
    return value.startsWith('Bearer ') ? value.slice(7) : '';
  }

  const server = http.createServer(async (req, res) => {
    if (state.unavailable) return req.socket.destroy();
    state.productHeaders.push(String(req.headers['x-kuklabs-product'] || ''));
    const url = new URL(req.url, 'http://authkit.test');

    if (req.method === 'GET' && url.pathname === '/v1/auth/status') {
      return sendJson(res, 200, { ok: true, contract: 'kuklabs-authkit-rest/1', google: { enabled: true } });
    }

    if (req.method === 'POST' && url.pathname === '/v1/auth/login') {
      state.loginCalls += 1;
      const body = await readJson(req);
      if (body.password === 'needs-otp') {
        return sendJson(res, 403, {
          error: true,
          status: 'otp_required',
          identifier: CENTRAL_USER.email,
          message: 'Enter the 6-digit code.',
        });
      }
      if (body.password === 'unverified-password') {
        const bundle = issue();
        bundle.user.email_verified = false;
        return sendJson(res, 200, bundle);
      }
      if (body.identifier !== CENTRAL_USER.email || body.password !== 'central-password') {
        return sendJson(res, 401, { error: true, message: 'Invalid email/mobile or password.' });
      }
      return sendJson(res, 200, issue());
    }

    if (req.method === 'POST' && url.pathname === '/v1/auth/signup') {
      return sendJson(res, 403, {
        error: true,
        status: 'otp_required',
        identifier: CENTRAL_USER.email,
        message: 'Enter the 6-digit code.',
      });
    }

    if (req.method === 'POST' && url.pathname === '/v1/auth/otp/request') {
      return sendJson(res, 200, { success: true, status: 'otp_sent' });
    }

    if (req.method === 'POST' && url.pathname === '/v1/auth/otp/verify') {
      const body = await readJson(req);
      if (body.code !== '123456') return sendJson(res, 400, { error: true, message: 'Invalid code.' });
      return sendJson(res, 200, issue());
    }

    if (req.method === 'POST' && url.pathname === '/v1/auth/google') {
      const body = await readJson(req);
      if (body.id_token !== 'google-id-token') return sendJson(res, 401, { error: true, message: 'Google sign-in failed.' });
      return sendJson(res, 200, issue());
    }

    if (req.method === 'POST' && url.pathname === '/v1/auth/token/refresh') {
      state.refreshCalls += 1;
      const body = await readJson(req);
      if (!state.sessionCurrent || body.refresh_token !== state.currentRefresh) {
        return sendJson(res, 401, { error: true, message: 'Session expired.' });
      }
      return sendJson(res, 200, issue());
    }

    const accessToken = bearer(req);
    if (!state.activeAccess.has(accessToken)) {
      return sendJson(res, 401, { error: true, message: 'Session expired.' });
    }

    if (req.method === 'GET' && url.pathname === '/v1/auth/me') {
      return sendJson(res, 200, { user: { ...CENTRAL_USER } });
    }

    if (req.method === 'GET' && url.pathname === '/v1/auth/sessions') {
      return sendJson(res, 200, {
        sessions: state.sessionCurrent
          ? [{ id: '0123456789abcdef0123456789abcdef', current: true, product: 'kukgit' }]
          : [],
      });
    }

    if (req.method === 'GET' && url.pathname === '/v1/auth/products/kukgit/access') {
      state.productCalls += 1;
      return sendJson(res, 200, {
        access: state.productAccess,
        product: 'kukgit',
        status: state.productAccess ? 'active' : 'blocked',
      });
    }

    if (req.method === 'POST' && url.pathname === '/v1/auth/logout') {
      state.logoutCalls += 1;
      state.sessionCurrent = false;
      return sendJson(res, 200, { success: true });
    }

    return sendJson(res, 404, { error: true, message: 'Not found.' });
  });

  return { server, state };
}

function setupKukGit(t, authkitBaseUrl) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-authkit-test-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const config = loadConfig({
    dataDir,
    databasePath: path.join(dataDir, 'kukgit.db'),
    repositoriesDir: path.join(dataDir, 'repos'),
    tempDir: path.join(dataDir, 'tmp'),
    baseUrl: 'http://localhost:8787',
    nodeEnv: 'test',
    authMode: 'authkit',
    authkitBaseUrl,
    authkitProductId: 'kukgit',
    authkitEncryptionKey: 'authkit-test-encryption-key-with-more-than-32-characters',
    authkitTimeoutMs: 1500,
    authkitRefreshTtlDays: 60,
    adminEmail: CENTRAL_USER.email,
    adminName: CENTRAL_USER.full_name,
  });
  const db = openDatabase(config);
  t.after(() => db.close());
  migrateAuthKitIdentity(db);
  const organization = ensureAuthKitCoreOrganization(db);

  const localUserId = uid('usr');
  db.prepare(`
    INSERT INTO users (id, email, password_hash, display_name)
    VALUES (?, ?, ?, ?)
  `).run(localUserId, CENTRAL_USER.email, hashPassword('old-local-password'), 'Legacy Founder');
  db.prepare(`
    INSERT INTO org_members (organization_id, user_id, role)
    VALUES (?, ?, 'owner')
  `).run(organization.id, localUserId);
  const repositoryId = uid('repo');
  db.prepare(`
    INSERT INTO repositories
      (id, organization_id, slug, name, description, visibility, default_branch, created_by)
    VALUES (?, ?, 'identity-demo', 'Identity Demo', '', 'private', 'main', ?)
  `).run(repositoryId, organization.id, localUserId);

  const app = createApp({ config, db });
  const secureLogin = createSecureAuthKitLoginApiHandler({ config, db });
  const authApi = createAuthKitApiHandler({ config, db });
  const dispatch = async (req, res) => {
    if (await secureLogin(req, res)) return;
    if (await authApi(req, res)) return;
    return app(req, res);
  };
  const bootstrapped = createAuthKitBootstrapGuard({ config, db, next: dispatch });
  const centrallyGuarded = createAuthKitCentralSessionGuard({ config, db, next: bootstrapped });
  const identity = createAuthKitIdentityMiddleware({ config, db, next: centrallyGuarded });
  const server = http.createServer(identity);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { config, db, server, localUserId, repositoryId };
}

async function signIn(origin, password = 'central-password', extraHeaders = {}) {
  return fetch(`${origin}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
    body: JSON.stringify({ identifier: CENTRAL_USER.email, password }),
  });
}

test('production configuration requires central AuthKit and HTTPS', () => {
  assert.throws(
    () => loadConfig({ nodeEnv: 'production', authMode: 'local' }),
    /disabled in production/i,
  );
  assert.throws(
    () => loadConfig({
      nodeEnv: 'production',
      authMode: 'authkit',
      authkitBaseUrl: 'http://auth.kuklabs.test',
      authkitEncryptionKey: 'x'.repeat(40),
    }),
    /HTTPS in production/i,
  );
  const config = loadConfig({
    nodeEnv: 'production',
    authMode: 'authkit',
    authkitBaseUrl: 'https://auth.kuklabs.com',
    authkitEncryptionKey: 'x'.repeat(40),
    cookieSecure: true,
  });
  assert.equal(config.authMode, 'authkit');
  assert.equal(config.authkitProductId, 'kukgit');
});

test('links a verified central identity to the existing KukGit product user without changing foreign keys', (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-authkit-link-test-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const config = loadConfig({ dataDir, databasePath: path.join(dataDir, 'test.db'), nodeEnv: 'test' });
  const db = openDatabase(config);
  t.after(() => db.close());
  migrateAuthKitIdentity(db);

  const localUserId = uid('usr');
  db.prepare('INSERT INTO users (id, email, password_hash, display_name) VALUES (?, ?, ?, ?)')
    .run(localUserId, CENTRAL_USER.email, hashPassword('legacy-local-password'), 'Legacy Name');

  const linked = linkAuthKitUser(db, CENTRAL_USER);
  assert.equal(linked.id, localUserId);
  assert.equal(linked.kuklabsUserId, CENTRAL_USER.kuklabs_user_id);
  assert.equal(linked.authSource, 'authkit');
  assert.throws(
    () => linkAuthKitUser(db, { ...CENTRAL_USER, kuklabs_user_id: 'usr_DIFFERENT_CENTRAL_ID', id: 'usr_DIFFERENT_CENTRAL_ID' }),
    (error) => error.code === 'AUTHKIT_EMAIL_ALREADY_LINKED',
  );

  const envelope = encryptAuthKitSecret({ authkitEncryptionKey: 'x'.repeat(40) }, 'central-token', 'session-aad');
  assert.equal(decryptAuthKitSecret({ authkitEncryptionKey: 'x'.repeat(40) }, envelope, 'session-aad'), 'central-token');
  assert.throws(
    () => decryptAuthKitSecret({ authkitEncryptionKey: 'x'.repeat(40) }, envelope, 'wrong-aad'),
    (error) => error.code === 'AUTHKIT_SESSION_INVALID',
  );
});

test('uses AuthKit login, encrypted server-side tokens, refresh rotation and central revocation', async (t) => {
  const authkit = fakeAuthKit();
  const authkitOrigin = await listen(authkit.server);
  t.after(() => new Promise((resolve) => authkit.server.close(resolve)));
  const kukgit = setupKukGit(t, authkitOrigin);
  const origin = await listen(kukgit.server);

  const login = await signIn(origin);
  assert.equal(login.status, 200);
  const setCookie = login.headers.get('set-cookie');
  assert.match(setCookie, /kukgit_session=/);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/);
  assert.doesNotMatch(setCookie, /access-/);
  assert.doesNotMatch(setCookie, /krt_refresh-/);
  const cookie = setCookie.split(';')[0];

  const user = kukgit.db.prepare(`
    SELECT id, kuklabs_user_id AS kuklabsUserId, auth_source AS authSource,
      email_verified AS emailVerified, password_hash AS passwordHash
    FROM users WHERE email = ?
  `).get(CENTRAL_USER.email);
  assert.equal(user.id, kukgit.localUserId);
  assert.equal(user.kuklabsUserId, CENTRAL_USER.kuklabs_user_id);
  assert.equal(user.authSource, 'authkit');
  assert.equal(user.emailVerified, 1);
  assert.notEqual(user.passwordHash, 'central-password');
  assert.equal(
    kukgit.db.prepare('SELECT created_by AS createdBy FROM repositories WHERE id = ?').get(kukgit.repositoryId).createdBy,
    kukgit.localUserId,
  );

  const sessionBefore = kukgit.db.prepare(`
    SELECT token_hash AS tokenHash, authkit_access_ciphertext AS accessCiphertext,
      authkit_refresh_ciphertext AS refreshCiphertext
    FROM sessions WHERE user_id = ?
  `).get(kukgit.localUserId);
  assert.ok(sessionBefore.accessCiphertext.startsWith('v1.'));
  assert.ok(sessionBefore.refreshCiphertext.startsWith('v1.'));
  assert.doesNotMatch(sessionBefore.accessCiphertext, /access-/);
  assert.doesNotMatch(sessionBefore.refreshCiphertext, /krt_refresh-/);
  assert.equal(decryptAuthKitSecret(kukgit.config, sessionBefore.accessCiphertext, sessionBefore.tokenHash), 'access-1');

  const me = await fetch(`${origin}/api/auth/me`, { headers: { Cookie: cookie } });
  assert.equal(me.status, 200);
  const mePayload = await me.json();
  assert.equal(mePayload.user.kuklabsUserId, CENTRAL_USER.kuklabs_user_id);
  assert.equal(mePayload.organizations[0].role, 'owner');
  assert.equal(authkit.state.productHeaders.every((value) => value === 'kukgit'), true);

  authkit.state.activeAccess.delete('access-1');
  const repositories = await fetch(`${origin}/api/repos`, { headers: { Cookie: cookie } });
  assert.equal(repositories.status, 200);
  assert.equal((await repositories.json()).repositories.length, 1);
  assert.equal(authkit.state.refreshCalls, 1);
  const sessionAfter = kukgit.db.prepare(`
    SELECT token_hash AS tokenHash, authkit_access_ciphertext AS accessCiphertext,
      authkit_refresh_ciphertext AS refreshCiphertext
    FROM sessions WHERE user_id = ?
  `).get(kukgit.localUserId);
  assert.equal(decryptAuthKitSecret(kukgit.config, sessionAfter.accessCiphertext, sessionAfter.tokenHash), 'access-2');
  assert.equal(decryptAuthKitSecret(kukgit.config, sessionAfter.refreshCiphertext, sessionAfter.tokenHash), 'krt_refresh-2');

  authkit.state.sessionCurrent = false;
  const revoked = await fetch(`${origin}/api/repos`, { headers: { Cookie: cookie } });
  assert.equal(revoked.status, 401);
  assert.equal((await revoked.json()).error.code, 'AUTHKIT_SESSION_REVOKED');
  assert.equal(kukgit.db.prepare('SELECT COUNT(*) AS count FROM sessions').get().count, 0);
});

test('maps OTP requirements, rejects unverified identities and blocks cross-origin login', async (t) => {
  const authkit = fakeAuthKit();
  const authkitOrigin = await listen(authkit.server);
  t.after(() => new Promise((resolve) => authkit.server.close(resolve)));
  const kukgit = setupKukGit(t, authkitOrigin);
  const origin = await listen(kukgit.server);

  const crossOrigin = await signIn(origin, 'central-password', { Origin: 'https://attacker.example' });
  assert.equal(crossOrigin.status, 403);
  assert.equal((await crossOrigin.json()).error.code, 'CSRF_BLOCKED');
  assert.equal(authkit.state.loginCalls, 0);

  const otp = await signIn(origin, 'needs-otp');
  assert.equal(otp.status, 403);
  const otpPayload = await otp.json();
  assert.equal(otpPayload.error.code, 'OTP_REQUIRED');
  assert.equal(otpPayload.identifier, CENTRAL_USER.email);

  const unverified = await signIn(origin, 'unverified-password');
  assert.equal(unverified.status, 403);
  assert.equal((await unverified.json()).error.code, 'AUTHKIT_EMAIL_NOT_VERIFIED');
  assert.equal(kukgit.db.prepare('SELECT COUNT(*) AS count FROM sessions').get().count, 0);

  const localPassword = await signIn(origin, 'old-local-password');
  assert.equal(localPassword.status, 401);
  assert.equal(kukgit.db.prepare('SELECT COUNT(*) AS count FROM sessions').get().count, 0);
});

test('fails closed during an AuthKit outage and revokes central session on logout', async (t) => {
  const authkit = fakeAuthKit();
  const authkitOrigin = await listen(authkit.server);
  t.after(() => new Promise((resolve) => authkit.server.close(resolve)));
  const kukgit = setupKukGit(t, authkitOrigin);
  const origin = await listen(kukgit.server);

  const login = await signIn(origin);
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  authkit.state.unavailable = true;
  const unavailable = await fetch(`${origin}/api/repos`, { headers: { Cookie: cookie } });
  assert.equal(unavailable.status, 503);
  assert.equal((await unavailable.json()).error.code, 'AUTHKIT_UNAVAILABLE');

  authkit.state.unavailable = false;
  const logout = await fetch(`${origin}/api/auth/logout`, {
    method: 'POST',
    headers: { Cookie: cookie, Origin: 'http://localhost:8787' },
  });
  assert.equal(logout.status, 204);
  assert.equal(authkit.state.logoutCalls, 1);
  assert.equal(kukgit.db.prepare('SELECT COUNT(*) AS count FROM sessions').get().count, 0);
  assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
});
