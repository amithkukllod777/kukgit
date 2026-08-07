import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createSession, hashPassword } from '../src/auth.mjs';
import { loadConfig } from '../src/config.mjs';
import { openDatabase, seedCore, uid } from '../src/db.mjs';
import { createAccountApiHandler } from '../src/account-api.mjs';
import { migrateAccountVerification } from '../src/account-verification.mjs';
import { migrateNotifications } from '../src/notifications.mjs';
import { migrateUserIdentities, identitiesFor, linkIdentity } from '../src/user-identities.mjs';
import { migratePhoneVerification, removeVerifiedPhone, verifyPhoneWithFirebase } from '../src/phone-verification.mjs';
import { forgetFirebaseCertificates } from '../src/firebase-identity.mjs';

/**
 * Recording that somebody controls a phone number.
 *
 * The SMS is Firebase's — KukGit never sends one and never sees the code. What
 * arrives here is an ID token, and every test below is a way of arriving with
 * the wrong one: a token for somebody else's Firebase project, a token from a
 * Google sign-in that proves nothing about a phone, a number another account
 * already holds.
 *
 * A real signing key is generated per run and a fake Google is served from
 * memory, so the signature path is genuinely exercised.
 */

const PROJECT = 'kukchat-b6402';

function authority(project = PROJECT) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-phone-cert-'));
  let certificate;
  try {
    const keyPath = path.join(dir, 'key.pem');
    fs.writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }));
    certificate = execFileSync('openssl', [
      'req', '-x509', '-new', '-key', keyPath, '-days', '1', '-subj', '/CN=securetoken.google.com', '-sha256',
    ], { encoding: 'utf8' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const kid = 'phone-key-1';

  const fetchImpl = async () => new Response(JSON.stringify({ [kid]: certificate }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' },
  });

  const seconds = Math.floor(Date.now() / 1000);
  const token = (claims = {}) => {
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify({
      aud: project,
      iss: `https://securetoken.google.com/${project}`,
      sub: 'firebase-uid-1',
      iat: seconds - 5,
      exp: seconds + 3600,
      auth_time: seconds - 5,
      phone_number: '+919999900000',
      firebase: { sign_in_provider: 'phone' },
      ...claims,
    })).toString('base64url');
    const signature = crypto.sign('RSA-SHA256', Buffer.from(`${header}.${body}`), privateKey).toString('base64url');
    return `${header}.${body}.${signature}`;
  };

  return { fetchImpl, token };
}

async function workspace(t, { firebaseProjectId = PROJECT } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-phone-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  // The module caches Google's certificates for an hour, and each test brings
  // its own signing key. Without this the second test verifies against the
  // first one's certificate and every token looks forged.
  forgetFirebaseCertificates();
  t.after(() => forgetFirebaseCertificates());

  let handler;
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
    authMode: 'local',
    firebaseProjectId,
    adminEmail: 'founder@kuklabs.com',
    adminPassword: 'secure-test-password',
    adminName: 'Founder',
  });
  const db = openDatabase(config);
  t.after(() => db.close());
  seedCore(db, config);
  migrateNotifications(db);
  migrateAccountVerification(db);
  migrateUserIdentities(db);
  migratePhoneVerification(db);

  const google = authority();
  const api = createAccountApiHandler({ config, db, fetchImpl: google.fetchImpl });
  handler = async (req, res) => { if (await api(req, res)) return; res.writeHead(404).end(); };

  const person = (email, { password = true } = {}) => {
    const id = uid('usr');
    db.prepare('INSERT INTO users (id, email, password_hash, display_name) VALUES (?, ?, ?, ?)')
      .run(id, email, password ? hashPassword('a-real-enough-password') : 'provider$github', email.split('@')[0]);
    return id;
  };

  const call = async (pathname, { body, userId, originHeader = origin } = {}) => {
    const headers = { 'Content-Type': 'application/json' };
    if (originHeader) headers.Origin = originHeader;
    if (userId) headers.Cookie = `kukgit_session=${createSession(db, userId).token}`;
    const response = await fetch(`${origin}${pathname}`, { method: 'POST', headers, body: JSON.stringify(body ?? {}) });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  };

  const verify = (userId, idToken) => verifyPhoneWithFirebase(db, config, { userId, idToken, fetchImpl: google.fetchImpl });

  return { config, db, origin, person, call, verify, google };
}

/* ------------------------------------------------------------- the happy path */

test('a phone sign-in token records the number against the account', async (t) => {
  const space = await workspace(t);
  const owner = space.person('owner@kuklabs.com');

  const result = await space.verify(owner, space.google.token());
  assert.equal(result.phone, '+919999900000');
  assert.equal(result.changed, false);

  const row = space.db.prepare('SELECT phone, phone_verified_at AS verifiedAt FROM users WHERE id = ?').get(owner);
  assert.equal(row.phone, '+919999900000');
  assert.ok(row.verifiedAt);

  const linked = identitiesFor(space.db, owner).find((identity) => identity.provider === 'phone');
  assert.equal(linked.providerUserId, 'firebase-uid-1');
  assert.equal(linked.providerLogin, '+919999900000');
});

test('the number is kept off the audit trail', async (t) => {
  const space = await workspace(t);
  const owner = space.person('owner@kuklabs.com');
  await space.verify(owner, space.google.token());

  const entry = space.db.prepare("SELECT metadata_json AS metadata FROM audit_logs WHERE action = 'account.phone_verified'").get();
  assert.ok(entry, 'the verification is audited');
  // An audit log is read by more people than the account's owner expects, and
  // the number is already on the account for anybody who genuinely needs it.
  assert.ok(!entry.metadata.includes('9999900000'));
});

/* ----------------------------------------------------------------- refusals */

test('a token for another Firebase project is refused', async (t) => {
  const space = await workspace(t);
  const owner = space.person('owner@kuklabs.com');
  const elsewhere = authority('someone-elses-project');

  // A real, correctly signed Google token — just not for this project. Without
  // the `aud` check it signs its holder in here.
  await assert.rejects(
    verifyPhoneWithFirebase(space.db, space.config, {
      userId: owner, idToken: elsewhere.token({ aud: 'someone-elses-project' }), fetchImpl: elsewhere.fetchImpl,
    }),
    { code: 'FIREBASE_TOKEN_INVALID' },
  );
  assert.equal(space.db.prepare('SELECT phone FROM users WHERE id = ?').get(owner).phone, null);
});

test('a Google sign-in through the same project does not prove a phone', async (t) => {
  const space = await workspace(t);
  const owner = space.person('owner@kuklabs.com');

  await assert.rejects(
    space.verify(owner, space.google.token({ firebase: { sign_in_provider: 'google.com' }, phone_number: '+919999900000' })),
    { code: 'FIREBASE_NOT_PHONE_SIGN_IN' },
  );
  assert.equal(space.db.prepare('SELECT phone FROM users WHERE id = ?').get(owner).phone, null);
});

test('a number another account already holds is refused', async (t) => {
  const space = await workspace(t);
  const first = space.person('first@kuklabs.com');
  const second = space.person('second@kuklabs.com');

  await space.verify(first, space.google.token());
  await assert.rejects(
    // Same number, a different Firebase account — which is what deleting a
    // Firebase account and signing up again produces.
    space.verify(second, space.google.token({ sub: 'firebase-uid-2' })),
    { code: 'PHONE_ALREADY_IN_USE' },
  );
  assert.equal(space.db.prepare('SELECT phone FROM users WHERE id = ?').get(second).phone, null);
  // And nothing left behind. A `user_identities` row pointing at an account
  // whose `phone` is null would then block that person from linking the number
  // they actually hold.
  assert.deepEqual(identitiesFor(space.db, second), []);
});

test('the database refuses a duplicate number even if the check is bypassed', async (t) => {
  const space = await workspace(t);
  const first = space.person('first@kuklabs.com');
  const second = space.person('second@kuklabs.com');
  await space.verify(first, space.google.token());

  // The index is the real guard: a check in application code races with another
  // request claiming the same number at the same moment.
  assert.throws(
    () => space.db.prepare('UPDATE users SET phone = ? WHERE id = ?').run('+919999900000', second),
    /UNIQUE/,
  );
});

/* ------------------------------------------------------------ changing it */

test('somebody who changed their number can record the new one', async (t) => {
  const space = await workspace(t);
  const owner = space.person('owner@kuklabs.com');
  await space.verify(owner, space.google.token());

  const result = await space.verify(owner, space.google.token({ sub: 'firebase-uid-9', phone_number: '+919999911111' }));
  assert.equal(result.phone, '+919999911111');
  assert.equal(result.changed, true);

  // One link, not two. People change numbers, they are signed in when they do
  // it, and they just answered an SMS on the new one.
  const links = identitiesFor(space.db, owner).filter((identity) => identity.provider === 'phone');
  assert.equal(links.length, 1);
  assert.equal(links[0].providerLogin, '+919999911111');
  assert.equal(space.db.prepare('SELECT phone FROM users WHERE id = ?').get(owner).phone, '+919999911111');
});

/* -------------------------------------------------------------- removing */

test('a number can be removed when there is another way in', async (t) => {
  const space = await workspace(t);
  const owner = space.person('owner@kuklabs.com');
  await space.verify(owner, space.google.token());

  assert.deepEqual(removeVerifiedPhone(space.db, { userId: owner }), { removed: true });
  assert.equal(space.db.prepare('SELECT phone FROM users WHERE id = ?').get(owner).phone, null);
  assert.equal(identitiesFor(space.db, owner).length, 0);
  // Removing again is not an error; it is already gone.
  assert.deepEqual(removeVerifiedPhone(space.db, { userId: owner }), { removed: false });
});

test('removing the only way into an account is refused', async (t) => {
  const space = await workspace(t);
  const owner = space.person('phone-only@kuklabs.com', { password: false });
  await space.verify(owner, space.google.token());

  assert.throws(() => removeVerifiedPhone(space.db, { userId: owner }), { code: 'IDENTITY_LAST_METHOD' });
  assert.equal(space.db.prepare('SELECT phone FROM users WHERE id = ?').get(owner).phone, '+919999900000');
});

test('a linked provider counts as another way in', async (t) => {
  const space = await workspace(t);
  const owner = space.person('no-password@kuklabs.com', { password: false });
  await space.verify(owner, space.google.token());
  linkIdentity(space.db, { userId: owner, provider: 'github', providerUserId: '4242', providerLogin: 'octocat' });

  assert.deepEqual(removeVerifiedPhone(space.db, { userId: owner }), { removed: true });
});

/* ------------------------------------------------------------- the routes */

test('the routes need a session, because a token proves a number and not who is asking', async (t) => {
  const space = await workspace(t);
  const owner = space.person('owner@kuklabs.com');

  assert.equal((await space.call('/api/account/phone/verify', { body: { idToken: space.google.token() } })).status, 401);
  assert.equal((await space.call('/api/account/phone/remove')).status, 401);

  const done = await space.call('/api/account/phone/verify', { body: { idToken: space.google.token() }, userId: owner });
  assert.equal(done.status, 200);
  assert.equal(done.body.phone, '+919999900000');
});

test('the routes are checked for origin like every other state change', async (t) => {
  const space = await workspace(t);
  const owner = space.person('owner@kuklabs.com');

  const blocked = await space.call('/api/account/phone/verify', {
    body: { idToken: space.google.token() }, userId: owner, originHeader: 'https://evil.example',
  });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.error.code, 'CSRF_BLOCKED');
});

test('an instance with no Firebase project does not have these routes at all', async (t) => {
  const space = await workspace(t, { firebaseProjectId: '' });
  const owner = space.person('owner@kuklabs.com');

  for (const pathname of ['/api/account/phone/verify', '/api/account/phone/remove']) {
    const response = await space.call(pathname, { body: {}, userId: owner });
    // 404, not 503: an instance that cannot do this should look like one that
    // never offered it, rather than one that is broken.
    assert.equal(response.status, 404, pathname);
  }
});

test('a rubbish token is a 401 with nothing recorded', async (t) => {
  const space = await workspace(t);
  const owner = space.person('owner@kuklabs.com');

  const response = await space.call('/api/account/phone/verify', { body: { idToken: 'not.a.token' }, userId: owner });
  assert.equal(response.status, 401);
  assert.equal(space.db.prepare('SELECT phone FROM users WHERE id = ?').get(owner).phone, null);
});

test('the number goes on the signed-in account, not on one named in the body', async (t) => {
  const space = await workspace(t);
  const owner = space.person('owner@kuklabs.com');
  const somebodyElse = space.person('victim@kuklabs.com');

  const done = await space.call('/api/account/phone/verify', {
    body: { idToken: space.google.token(), userId: somebodyElse },
    userId: owner,
  });

  assert.equal(done.status, 200);
  // The token proves a number. It says nothing about who is asking, and a
  // request that could name the account would let anybody attach their own
  // number — and with it their own recovery route — to somebody else's.
  assert.equal(space.db.prepare('SELECT phone FROM users WHERE id = ?').get(owner).phone, '+919999900000');
  assert.equal(space.db.prepare('SELECT phone FROM users WHERE id = ?').get(somebodyElse).phone, null);
});

test('called directly with no Firebase project, this is absent rather than broken', async (t) => {
  const space = await workspace(t, { firebaseProjectId: '' });
  const owner = space.person('owner@kuklabs.com');

  // The routes gate too, but a future caller that forgets should get the same
  // answer: an instance that never offered this, not one that is misconfigured.
  await assert.rejects(
    verifyPhoneWithFirebase(space.db, space.config, { userId: owner, idToken: space.google.token(), fetchImpl: space.google.fetchImpl }),
    { code: 'NOT_FOUND' },
  );
});
