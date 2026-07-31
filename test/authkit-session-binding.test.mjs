import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { openDatabase, seedCore, uid } from '../src/db.mjs';
import {
  authKitTokenClaims,
  createAuthKitBridgeSession,
  encryptAuthKitSecret,
  migrateAuthKitIdentity,
  resolveAuthKitSid,
} from '../src/authkit-identity.mjs';
import { createAuthKitCentralSessionGuard } from '../src/authkit-session-guard.mjs';
import { hashToken } from '../src/security.mjs';
import { runWithRequestIdentity } from '../src/identity-context.mjs';

function jwt(claims) {
  const part = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'RS256', typ: 'JWT' })}.${part(claims)}.signature-not-checked`;
}

// Stands in for AuthKit's /v1/auth/sessions listing.
function authKitStub(t, handler) {
  const server = http.createServer(handler);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
}

function setup(t, authkitBaseUrl) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-sid-test-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const config = loadConfig({
    dataDir,
    databasePath: path.join(dataDir, 'kukgit.db'),
    repositoriesDir: path.join(dataDir, 'repos'),
    tempDir: path.join(dataDir, 'tmp'),
    nodeEnv: 'test',
    baseUrl: 'http://127.0.0.1:8787',
    authMode: 'authkit',
    authkitBaseUrl,
    authkitEncryptionKey: 'authkit-session-binding-test-key-long-enough',
    adminEmail: 'owner@example.com',
    adminPassword: 'secure-owner-password',
    adminName: 'Owner',
  });
  const db = openDatabase(config);
  t.after(() => db.close());
  migrateAuthKitIdentity(db);
  seedCore(db, { ...config, authMode: 'local' });
  return { config, db };
}

// Inserts a bridge session directly so a null sid — the pre-fix state — can be
// reproduced exactly.
function insertSession(db, config, { userId, sid = null }) {
  const browserToken = `tok_${uid('s')}`;
  const tokenHash = hashToken(browserToken);
  const expiresAt = new Date(Date.now() + 3600_000).toISOString();
  db.prepare(`
    INSERT INTO sessions
      (token_hash, user_id, expires_at, auth_mode, authkit_access_ciphertext,
       authkit_refresh_ciphertext, authkit_access_expires_at, authkit_refresh_expires_at, authkit_sid)
    VALUES (?, ?, ?, 'authkit', ?, ?, ?, ?, ?)
  `).run(
    tokenHash, userId, expiresAt,
    encryptAuthKitSecret(config, 'access-token', tokenHash),
    encryptAuthKitSecret(config, 'refresh-token', tokenHash),
    expiresAt, expiresAt, sid,
  );
  return { browserToken, tokenHash };
}

function guardRequest(config, db, browserToken, userId) {
  const guard = createAuthKitCentralSessionGuard({
    config, db,
    next: (req, res) => { res.writeHead(200); res.end('{"ok":true}'); return true; },
  });
  return new Promise((resolve) => {
    const server = http.createServer((req, res) =>
      runWithRequestIdentity({ mode: 'authkit', user: { id: userId } }, () => guard(req, res)));
    server.listen(0, '127.0.0.1', async () => {
      const port = server.address().port;
      const response = await fetch(`http://127.0.0.1:${port}/api/dashboard`, {
        headers: { Cookie: `kukgit_session=${browserToken}` },
      });
      const status = response.status;
      server.close(() => resolve(status));
    });
  });
}

test('the session id is read from the access-token claim when the response omits it', () => {
  // Preferred: the top-level field.
  assert.equal(resolveAuthKitSid({ sid: 'sess_direct' }, jwt({ sid: 'sess_claim' })), 'sess_direct');
  // Fallback: the claim, which is where AuthKit carries it when the envelope does not.
  assert.equal(resolveAuthKitSid({}, jwt({ sid: 'sess_claim' })), 'sess_claim');
  assert.equal(resolveAuthKitSid({}, jwt({ session_id: 'sess_alt' })), 'sess_alt');
  // Neither available: null, and the guard binds lazily instead.
  assert.equal(resolveAuthKitSid({}, jwt({ sub: 'user-only' })), null);
  assert.equal(resolveAuthKitSid({}, 'not-a-jwt'), null);
  assert.equal(authKitTokenClaims('a.!!!not-base64!!!.c'), null);
});

test('a bridge created without a top-level sid still binds to the token claim', async (t) => {
  const base = await authKitStub(t, (req, res) => {
    // Product-access preflight.
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ access: true, entitled: true, allowed: true }));
  });
  const { config, db } = setup(t, base);

  const created = await createAuthKitBridgeSession(db, config, {
    user: { id: 'kuk_1', email: 'owner@example.com', full_name: 'Owner', email_verified: true },
    access_token: jwt({ sid: 'sess_from_claim' }),
    refresh_token: 'refresh',
    expires_in: 3600,
  });

  const stored = db.prepare('SELECT authkit_sid AS sid FROM sessions WHERE token_hash = ?')
    .get(hashToken(created.browserToken));
  assert.equal(stored.sid, 'sess_from_claim', 'sid must be derived rather than left null');
});

test('a null sid is adopted on first validation instead of skipping the check forever', async (t) => {
  const base = await authKitStub(t, (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ sessions: [{ id: 'sess_device_a', current: true }] }));
  });
  const { config, db } = setup(t, base);
  const userId = db.prepare('SELECT id FROM users LIMIT 1').get().id;
  const { browserToken, tokenHash } = insertSession(db, config, { userId, sid: null });

  assert.equal(await guardRequest(config, db, browserToken, userId), 200);

  const stored = db.prepare('SELECT authkit_sid AS sid FROM sessions WHERE token_hash = ?').get(tokenHash);
  assert.equal(stored.sid, 'sess_device_a', 'the guard must bind the reported session id');
});

test('once bound, a different current device session revokes the bridge', async (t) => {
  // AuthKit reports a live session, but a different one than this bridge was
  // bound to — the exact case a null sid used to let through.
  const base = await authKitStub(t, (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ sessions: [{ id: 'sess_other_device', current: true }] }));
  });
  const { config, db } = setup(t, base);
  const userId = db.prepare('SELECT id FROM users LIMIT 1').get().id;
  const { browserToken, tokenHash } = insertSession(db, config, { userId, sid: 'sess_device_a' });

  assert.equal(await guardRequest(config, db, browserToken, userId), 401);
  const stored = db.prepare('SELECT token_hash FROM sessions WHERE token_hash = ?').get(tokenHash);
  assert.equal(stored, undefined, 'the local bridge must be removed');
});

test('no live session at all still revokes', async (t) => {
  const base = await authKitStub(t, (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ sessions: [] }));
  });
  const { config, db } = setup(t, base);
  const userId = db.prepare('SELECT id FROM users LIMIT 1').get().id;
  const { browserToken } = insertSession(db, config, { userId, sid: null });

  assert.equal(await guardRequest(config, db, browserToken, userId), 401);
});

test('an AuthKit outage fails closed rather than allowing the request through', async (t) => {
  // The validation endpoint is unavailable. A protected request must not be
  // served on the assumption that the session is probably still fine.
  const base = await authKitStub(t, (req, res) => {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end('{"error":"upstream unavailable"}');
  });
  const { config, db } = setup(t, base);
  const userId = db.prepare('SELECT id FROM users LIMIT 1').get().id;
  const { browserToken, tokenHash } = insertSession(db, config, { userId, sid: 'sess_device_a' });

  assert.equal(await guardRequest(config, db, browserToken, userId), 503);

  // An outage must not be mistaken for a revocation — the bridge survives so the
  // user is not signed out by a transient upstream failure.
  const stored = db.prepare('SELECT token_hash FROM sessions WHERE token_hash = ?').get(tokenHash);
  assert.ok(stored, 'a transient outage must not delete the session');
});
