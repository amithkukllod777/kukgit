import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { openDatabase, seedCore, uid } from '../src/db.mjs';
import { authenticate, createSession, hashPassword } from '../src/auth.mjs';
import { migrateNotifications } from '../src/notifications.mjs';
import { migrateAccountVerification } from '../src/account-verification.mjs';
import { createAccountApiHandler } from '../src/account-api.mjs';
import { surfaceForRequest } from '../src/rate-limit.mjs';

/**
 * The four endpoints, from outside.
 *
 * Three are open to anybody, which is unavoidable — somebody who has forgotten
 * their password cannot sign in to ask for a reset. So every test here is
 * written from the position of a caller who is not the account's owner and is
 * trying to learn something or change something they should not.
 */

async function workspace(t, { authMode = 'local' } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-account-api-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  const node = http.createServer((req, res) => handler(req, res));
  await new Promise((resolve) => node.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => node.close(resolve)));
  const origin = `http://127.0.0.1:${node.address().port}`;

  const config = loadConfig({
    dataDir,
    databasePath: path.join(dataDir, 'test.db'),
    repositoriesDir: path.join(dataDir, 'repos'),
    tempDir: path.join(dataDir, 'tmp'),
    baseUrl: origin,
    nodeEnv: 'test',
    authMode,
    ...(authMode === 'authkit'
      ? { authkitBaseUrl: 'https://auth.kuklabs.com', authkitEncryptionKey: 'a'.repeat(40) }
      : {}),
    adminEmail: 'founder@kuklabs.com',
    adminPassword: 'secure-test-password',
    adminName: 'Founder',
  });
  const db = openDatabase(config);
  t.after(() => db.close());
  seedCore(db, { ...config, authMode: 'local' });
  migrateNotifications(db);
  migrateAccountVerification(db);

  const api = createAccountApiHandler({ config, db });
  let handler = async (req, res) => { if (await api(req, res)) return; res.writeHead(404).end(); };

  const person = (email, password = 'a-real-enough-password') => {
    const id = uid('usr');
    db.prepare('INSERT INTO users (id, email, password_hash, display_name) VALUES (?, ?, ?, ?)')
      .run(id, email, hashPassword(password), email.split('@')[0]);
    return id;
  };
  const call = async (pathname, { body, userId, originHeader = origin, method = 'POST' } = {}) => {
    const headers = { 'Content-Type': 'application/json' };
    if (originHeader) headers.Origin = originHeader;
    if (userId) headers.Cookie = `kukgit_session=${createSession(db, userId).token}`;
    const response = await fetch(`${origin}${pathname}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  };
  const tokenIn = (subjectMatch) => {
    const row = db.prepare('SELECT text_body AS body FROM email_outbox WHERE subject LIKE ? ORDER BY rowid DESC LIMIT 1').get(`%${subjectMatch}%`);
    return row ? /token=([^\s]+)/.exec(row.body)?.[1] ?? null : null;
  };

  return { config, db, origin, person, call, tokenIn };
}

/* ------------------------------------------------------------- the shape */

test('these routes are limited like sign-in, not like reading a page', async () => {
  // Two of them send real email to an address the caller names.
  for (const pathname of [
    '/api/account/password-reset/request',
    '/api/account/password-reset/complete',
    '/api/account/verify-email/send',
    '/api/account/verify-email/confirm',
  ]) {
    assert.equal(surfaceForRequest('POST', pathname), 'auth', pathname);
  }
});

test('everything is POST and same-origin', async (t) => {
  const space = await workspace(t);
  space.person('one@kuklabs.com');

  assert.equal((await space.call('/api/account/password-reset/request', { method: 'GET' })).status, 405);
  const crossOrigin = await space.call('/api/account/password-reset/request', {
    body: { email: 'one@kuklabs.com' },
    originHeader: 'https://evil.example',
  });
  assert.equal(crossOrigin.status, 403);
  assert.equal(crossOrigin.body.error.code, 'CSRF_BLOCKED');
  assert.equal(space.db.prepare('SELECT COUNT(*) AS n FROM email_outbox').get().n, 0);
});

test('in AuthKit mode the routes are absent, not refused', async (t) => {
  const space = await workspace(t, { authMode: 'authkit' });
  const response = await space.call('/api/account/password-reset/request', { body: { email: 'one@kuklabs.com' } });

  // 404 rather than 403: when Kuklabs Account owns the passwords, a KukGit
  // reset endpoint that quietly worked would be a second way into an account
  // its owner does not know exists. Answering 403 would say it is there.
  assert.equal(response.status, 404);
});

test('an unknown path under the prefix is a 404', async (t) => {
  const space = await workspace(t);
  assert.equal((await space.call('/api/account/something-else', { body: {} })).status, 404);
});

/* -------------------------------------------------------------- the reset */

test('a reset request answers the same for a real address and an invented one', async (t) => {
  const space = await workspace(t);
  space.person('one@kuklabs.com');

  const known = await space.call('/api/account/password-reset/request', { body: { email: 'one@kuklabs.com' } });
  const unknown = await space.call('/api/account/password-reset/request', { body: { email: 'nobody@example.com' } });

  assert.equal(known.status, 202);
  assert.equal(unknown.status, 202);
  // Byte for byte, apart from the request id. "Is this address registered" is
  // "does this company keep its code here", and this form is open to anybody.
  assert.deepEqual({ ...known.body, requestId: null }, { ...unknown.body, requestId: null });
  assert.match(known.body.message, /^If that address/);
  assert.equal(space.db.prepare('SELECT COUNT(*) AS n FROM email_outbox').get().n, 1);
});

test('the reset link works once and signs every device out', async (t) => {
  const space = await workspace(t);
  const userId = space.person('one@kuklabs.com');
  createSession(space.db, userId);
  createSession(space.db, userId);

  await space.call('/api/account/password-reset/request', { body: { email: 'one@kuklabs.com' } });
  const token = space.tokenIn('Reset your KukGit password');

  const done = await space.call('/api/account/password-reset/complete', { body: { token, password: 'a-brand-new-password' } });
  assert.equal(done.status, 200);
  assert.equal(done.body.sessionsEnded, 2);
  // Surprising and important, so it is said rather than left to be noticed.
  assert.match(done.body.message, /signed out/);
  assert.equal(space.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?').get(userId).n, 0);
  assert.equal(authenticate(space.db, 'one@kuklabs.com', 'a-brand-new-password').id, userId);

  const replay = await space.call('/api/account/password-reset/complete', { body: { token, password: 'yet-another-password' } });
  assert.equal(replay.status, 400);
  assert.equal(replay.body.error.code, 'ACCOUNT_TOKEN_INVALID');
});

test('a guessed or missing token is refused without saying which', async (t) => {
  const space = await workspace(t);
  space.person('one@kuklabs.com');

  const messages = new Set();
  for (const token of ['not-a-real-token', '', undefined]) {
    const response = await space.call('/api/account/password-reset/complete', { body: { token, password: 'a-brand-new-password' } });
    assert.equal(response.status, 400);
    messages.add(response.body.error.code);
  }
  assert.deepEqual([...messages], ['ACCOUNT_TOKEN_INVALID']);
});

test('a password the rules refuse does not change anything', async (t) => {
  const space = await workspace(t);
  const userId = space.person('one@kuklabs.com');
  await space.call('/api/account/password-reset/request', { body: { email: 'one@kuklabs.com' } });

  const short = await space.call('/api/account/password-reset/complete', {
    body: { token: space.tokenIn('Reset your KukGit password'), password: 'short' },
  });
  assert.equal(short.status, 400);
  assert.equal(authenticate(space.db, 'one@kuklabs.com', 'a-real-enough-password').id, userId);
});

/* --------------------------------------------------------- verifying email */

test('resending a verification needs a session, and sends to that account', async (t) => {
  const space = await workspace(t);
  const userId = space.person('one@kuklabs.com');

  const anonymous = await space.call('/api/account/verify-email/send', { body: {} });
  assert.equal(anonymous.status, 401);
  assert.equal(space.db.prepare('SELECT COUNT(*) AS n FROM email_outbox').get().n, 0);

  const signedIn = await space.call('/api/account/verify-email/send', { body: {}, userId });
  assert.equal(signedIn.status, 202);
  // It takes no address from the request, so it cannot be used to send mail to
  // somebody the caller does not already control.
  assert.equal(space.db.prepare('SELECT to_email AS email FROM email_outbox ORDER BY rowid DESC LIMIT 1').get().email, 'one@kuklabs.com');
});

test('confirming needs no session, because the link arrives in a mailbox', async (t) => {
  const space = await workspace(t);
  const userId = space.person('one@kuklabs.com');
  await space.call('/api/account/verify-email/send', { body: {}, userId });

  const confirmed = await space.call('/api/account/verify-email/confirm', { body: { token: space.tokenIn('Confirm your KukGit email') } });
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.body.verified, true);
  assert.equal(space.db.prepare('SELECT email_verified AS verified FROM users WHERE id = ?').get(userId).verified, 1);
});

test('a second request inside the window sends nothing more', async (t) => {
  const space = await workspace(t);
  const userId = space.person('one@kuklabs.com');
  await space.call('/api/account/verify-email/send', { body: {}, userId });
  const again = await space.call('/api/account/verify-email/send', { body: {}, userId });

  assert.equal(again.status, 202);
  assert.equal(again.body.sent, false);
  assert.equal(space.db.prepare('SELECT COUNT(*) AS n FROM email_outbox').get().n, 1);
});

test('an oversized body is refused before it is parsed', async (t) => {
  const space = await workspace(t);
  const response = await fetch(`${space.origin}/api/account/password-reset/request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: space.origin },
    body: JSON.stringify({ email: 'a@b.com', padding: 'x'.repeat(32 * 1024) }),
  });
  assert.equal(response.status, 413);
});
