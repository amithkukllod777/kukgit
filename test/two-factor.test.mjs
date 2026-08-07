import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createSession, hashPassword } from '../src/auth.mjs';
import { loadConfig } from '../src/config.mjs';
import { openDatabase, seedCore, uid } from '../src/db.mjs';
import { createApp } from '../src/app.mjs';
import { migrateSecrets } from '../src/secrets-vault.mjs';
import { createTwoFactorApiHandler } from '../src/two-factor-api.mjs';
import {
  base32Decode,
  base32Encode,
  currentStep,
  generateRecoveryCode,
  migrateTwoFactor,
  otpauthUri,
  totpCode,
  verifyTotp,
  verifyTwoFactor,
} from '../src/two-factor.mjs';

/**
 * A second factor, and the day the phone goes in a river.
 *
 * The TOTP arithmetic is checked against RFC 6238's own published vector, so a
 * subtly wrong implementation — a fixed truncation offset, the wrong step size
 * — fails here rather than in somebody's authenticator app.
 *
 * Everything else is about the two ways 2FA goes wrong in practice. It locks
 * out the person it was protecting, or it is not really a second factor because
 * something else can turn it off.
 */

const PASSWORD = 'a-real-enough-password';

/**
 * A code for the step after this one.
 *
 * Confirming enrolment spends the code it was confirmed with, so a sign-in in
 * the same thirty seconds cannot reuse it — which is correct, and means a test
 * that signs in immediately has to move on a step. A real person waits.
 */
const nextCode = (secret) => totpCode(secret, currentStep() + 1);

async function workspace(t, { authMode = 'local' } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-2fa-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

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
    authMode,
    ...(authMode === 'authkit'
      ? { authkitBaseUrl: 'https://auth.kuklabs.com', authkitEncryptionKey: 'a'.repeat(40) }
      : {}),
    adminEmail: 'founder@kuklabs.com',
    adminPassword: 'secure-test-password',
    adminName: 'Founder',
    secretsEncryptionKey: 'k'.repeat(48),
  });
  const db = openDatabase(config);
  t.after(() => db.close());
  seedCore(db, { ...config, authMode: 'local' });
  migrateSecrets(db);
  migrateTwoFactor(db);

  const api = createTwoFactorApiHandler({ config, db });
  const app = createApp({ config, db });
  handler = async (req, res) => { if (await api(req, res)) return; await app(req, res); };

  const person = (email = 'owner@kuklabs.com', { password = true } = {}) => {
    const id = uid('usr');
    db.prepare('INSERT INTO users (id, email, password_hash, display_name) VALUES (?, ?, ?, ?)')
      .run(id, email, password ? hashPassword(PASSWORD) : 'provider$github', email.split('@')[0]);
    return id;
  };

  const call = async (pathname, { body, userId, method = 'POST', originHeader = origin } = {}) => {
    const headers = { 'Content-Type': 'application/json' };
    if (originHeader) headers.Origin = originHeader;
    if (userId) headers.Cookie = `kukgit_session=${createSession(db, userId).token}`;
    const response = await fetch(`${origin}${pathname}`, {
      method, headers, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
    });
    return {
      status: response.status,
      setCookie: response.headers.get('set-cookie'),
      cacheControl: response.headers.get('cache-control'),
      body: await response.json().catch(() => ({})),
    };
  };

  /** Turns 2FA on for somebody and hands back what they would have written down. */
  const enrol = async (userId) => {
    const started = await call('/api/account/two-factor/start', { body: { password: PASSWORD }, userId });
    assert.equal(started.status, 200, JSON.stringify(started.body));
    const secret = base32Decode(started.body.secret);
    const confirmed = await call('/api/account/two-factor/confirm', {
      body: { code: totpCode(secret, currentStep()) }, userId,
    });
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
    return { secret, recoveryCodes: started.body.recoveryCodes };
  };

  return { config, db, origin, person, call, enrol };
}

/* -------------------------------------------------------------- the maths */

test('the codes match RFC 6238, so a wrong implementation fails here and not in somebody app', async () => {
  const secret = Buffer.from('12345678901234567890');
  // The published vector. A fixed truncation offset instead of the dynamic one
  // produces plausible six-digit codes that no authenticator agrees with.
  assert.equal(totpCode(secret, Math.floor(59 / 30)), '287082');
  assert.equal(totpCode(secret, Math.floor(1111111109 / 30)), '081804');
  assert.equal(totpCode(secret, Math.floor(1234567890 / 30)), '005924');
});

test('base32 survives a round trip, including what people paste', async () => {
  const secret = Buffer.from('12345678901234567890');
  const encoded = base32Encode(secret);
  assert.equal(base32Decode(encoded).toString(), secret.toString());
  // Spaces and padding are what an authenticator app shows and a person copies.
  assert.equal(base32Decode(`${encoded.slice(0, 4)} ${encoded.slice(4)}==`).toString(), secret.toString());
  assert.throws(() => base32Decode('not-base-32!'), { code: 'TOTP_SECRET_INVALID' });
});

test('a code from a minute ago or a minute ahead still works, two minutes does not', async () => {
  const secret = Buffer.from('12345678901234567890');
  const now = new Date('2026-08-07T12:00:00Z');
  const step = currentStep(now);

  assert.equal(verifyTotp(secret, totpCode(secret, step), { now }), step);
  // One step either side: about a minute of clock drift forgiven, which is the
  // difference between working and a support ticket nobody can reproduce.
  assert.equal(verifyTotp(secret, totpCode(secret, step - 1), { now }), step - 1);
  assert.equal(verifyTotp(secret, totpCode(secret, step + 1), { now }), step + 1);
  assert.equal(verifyTotp(secret, totpCode(secret, step - 3), { now }), null);
  assert.equal(verifyTotp(secret, '000000', { now: new Date(0) }) === null, true);
  assert.equal(verifyTotp(secret, 'abcdef', { now }), null);
});

test('the URI names the issuer twice, because apps disagree about which one they read', async () => {
  const uri = otpauthUri({ secret: 'ABCDEFGH', account: 'amit@kuklabs.com' });
  assert.match(uri, /^otpauth:\/\/totp\/KukGit%3Aamit%40kuklabs\.com\?/);
  const parameters = new URLSearchParams(uri.split('?')[1]);
  assert.equal(parameters.get('issuer'), 'KukGit');
  assert.equal(parameters.get('digits'), '6');
  assert.equal(parameters.get('period'), '30');
});

test('recovery codes avoid the characters people mistype off paper', async () => {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const code = generateRecoveryCode();
    assert.match(code, /^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
    // No O/0 and no I/1/L. A code that fails because of the font it was
    // printed in is a code that does not work.
    assert.ok(!/[OI1L0]/.test(code), code);
  }
});

/* ------------------------------------------------------------- enrolment */

test('generating a secret does not turn anything on', async (t) => {
  const space = await workspace(t);
  const owner = space.person();

  const started = await space.call('/api/account/two-factor/start', { body: { password: PASSWORD }, userId: owner });
  assert.equal(started.status, 200);
  assert.ok(started.body.secret);

  const status = await space.call('/api/account/two-factor', { method: 'GET', userId: owner });
  // A wrong clock, a mis-scanned QR, a copy-paste that lost a character —
  // every one produces a working-looking enrolment that locks its owner out at
  // the next sign-in, and every one is caught by asking for one code first.
  assert.equal(status.body.enabled, false);
  assert.equal(status.body.pending, true);
});

test('the recovery codes arrive before it is switched on, not after', async (t) => {
  const space = await workspace(t);
  const owner = space.person();

  const started = await space.call('/api/account/two-factor/start', { body: { password: PASSWORD }, userId: owner });
  // Somebody who closes the tab on a screen shown *after* enrolment already has
  // an account they cannot recover.
  assert.equal(started.body.recoveryCodes.length, 10);
  assert.equal(new Set(started.body.recoveryCodes).size, 10);
  assert.match(started.cacheControl, /no-store/);
});

test('a wrong code does not enable it', async (t) => {
  const space = await workspace(t);
  const owner = space.person();
  await space.call('/api/account/two-factor/start', { body: { password: PASSWORD }, userId: owner });

  const refused = await space.call('/api/account/two-factor/confirm', { body: { code: '000000' }, userId: owner });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.error.code, 'TWO_FACTOR_CODE_INVALID');
  assert.equal((await space.call('/api/account/two-factor', { method: 'GET', userId: owner })).body.enabled, false);
});

test('starting enrolment needs the password again, not just a session', async (t) => {
  const space = await workspace(t);
  const owner = space.person();

  const refused = await space.call('/api/account/two-factor/start', { body: { password: 'not-it' }, userId: owner });
  // Anybody at an unlocked laptop could otherwise attach their own
  // authenticator to this account and lock its owner out permanently.
  assert.equal(refused.status, 401);
  assert.equal(refused.body.error.code, 'PASSWORD_INVALID');
});

test('the secret is stored encrypted, not readable in the database', async (t) => {
  const space = await workspace(t);
  const owner = space.person();
  const started = await space.call('/api/account/two-factor/start', { body: { password: PASSWORD }, userId: owner });

  const stored = space.db.prepare('SELECT secret_ciphertext AS ciphertext FROM user_two_factor WHERE user_id = ?').get(owner).ciphertext;
  // A database backup is a file that leaves the building. A TOTP secret in it
  // is a second factor somebody else can compute.
  assert.ok(!stored.includes(started.body.secret));
  assert.match(stored, /^v1\./);
});

test('recovery codes are stored hashed', async (t) => {
  const space = await workspace(t);
  const owner = space.person();
  const started = await space.call('/api/account/two-factor/start', { body: { password: PASSWORD }, userId: owner });

  const hashes = space.db.prepare('SELECT code_hash AS hash FROM user_recovery_codes WHERE user_id = ?').all(owner);
  assert.equal(hashes.length, 10);
  for (const code of started.body.recoveryCodes) {
    // Stored readable, these are ten passwords in a table.
    assert.ok(!hashes.some((row) => row.hash.includes(code.replace('-', ''))), code);
  }
});

/* --------------------------------------------------------------- signing in */

test('a password alone does not sign in an account with 2FA on', async (t) => {
  const space = await workspace(t);
  const owner = space.person();
  const { secret } = await space.enrol(owner);

  const first = await space.call('/api/auth/login', { body: { email: 'owner@kuklabs.com', password: PASSWORD } });
  assert.equal(first.status, 200);
  assert.equal(first.body.twoFactorRequired, true);
  // Nothing that resembles a session. The challenge names an account whose
  // password was proved; it grants nothing on its own.
  assert.equal(first.setCookie, null);
  assert.ok(first.body.challenge);
  assert.equal(first.body.user, undefined);

  const second = await space.call('/api/auth/two-factor', {
    body: { challenge: first.body.challenge, code: nextCode(secret) },
  });
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.match(second.setCookie, /kukgit_session=/);
  assert.equal(second.body.user.email, 'owner@kuklabs.com');
});

test('a challenge is spent once, whatever the outcome', async (t) => {
  const space = await workspace(t);
  const owner = space.person();
  const { secret } = await space.enrol(owner);
  const first = await space.call('/api/auth/login', { body: { email: 'owner@kuklabs.com', password: PASSWORD } });

  const done = await space.call('/api/auth/two-factor', {
    body: { challenge: first.body.challenge, code: nextCode(secret) },
  });
  assert.equal(done.status, 200);

  const replay = await space.call('/api/auth/two-factor', {
    body: { challenge: first.body.challenge, code: nextCode(secret) },
  });
  // Spent by the delete that claimed it. Read-then-delete leaves a window in
  // which the same challenge finishes two sign-ins.
  assert.equal(replay.status, 401);
  assert.equal(replay.body.error.code, 'TWO_FACTOR_CHALLENGE_INVALID');
  assert.equal(replay.setCookie, null);
});

test('a challenge somebody made up signs nobody in', async (t) => {
  const space = await workspace(t);
  const owner = space.person();
  const { secret } = await space.enrol(owner);

  const forged = await space.call('/api/auth/two-factor', {
    body: { challenge: 'made-up', code: nextCode(secret) },
  });
  assert.equal(forged.status, 401);
  assert.equal(forged.setCookie, null);
});

test('the same code cannot be used twice inside its own thirty seconds', async (t) => {
  const space = await workspace(t);
  const owner = space.person();
  const { secret } = await space.enrol(owner);
  const code = nextCode(secret);

  const first = await space.call('/api/auth/login', { body: { email: 'owner@kuklabs.com', password: PASSWORD } });
  assert.equal((await space.call('/api/auth/two-factor', { body: { challenge: first.body.challenge, code } })).status, 200);

  const second = await space.call('/api/auth/login', { body: { email: 'owner@kuklabs.com', password: PASSWORD } });
  const replay = await space.call('/api/auth/two-factor', { body: { challenge: second.body.challenge, code } });
  // Anybody who sees a code over somebody's shoulder otherwise has thirty
  // seconds to use it themselves.
  assert.equal(replay.status, 401);
});

test('an account without 2FA signs in the way it always did', async (t) => {
  const space = await workspace(t);
  space.person('plain@kuklabs.com');

  const done = await space.call('/api/auth/login', { body: { email: 'plain@kuklabs.com', password: PASSWORD } });
  assert.equal(done.status, 200);
  assert.match(done.setCookie, /kukgit_session=/);
  assert.equal(done.body.twoFactorRequired, undefined);
});

/* ---------------------------------------------------------------- recovery */

test('a recovery code gets somebody in when the phone is gone', async (t) => {
  const space = await workspace(t);
  const owner = space.person();
  const { recoveryCodes } = await space.enrol(owner);
  const first = await space.call('/api/auth/login', { body: { email: 'owner@kuklabs.com', password: PASSWORD } });

  const done = await space.call('/api/auth/two-factor', {
    body: { challenge: first.body.challenge, code: recoveryCodes[0] },
  });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.match(done.setCookie, /kukgit_session=/);
  assert.equal(done.body.usedRecoveryCode, true);
  // Said out loud on the one occasion somebody is certainly paying attention.
  assert.equal(done.body.recoveryCodesRemaining, 9);
});

test('a recovery code works once', async (t) => {
  const space = await workspace(t);
  const owner = space.person();
  const { recoveryCodes } = await space.enrol(owner);

  for (const expected of [200, 401]) {
    const login = await space.call('/api/auth/login', { body: { email: 'owner@kuklabs.com', password: PASSWORD } });
    const done = await space.call('/api/auth/two-factor', {
      body: { challenge: login.body.challenge, code: recoveryCodes[0] },
    });
    assert.equal(done.status, expected);
  }
});

test('a recovery code from one account does not work on another', async (t) => {
  const space = await workspace(t);
  const mine = space.person('mine@kuklabs.com');
  const yours = space.person('yours@kuklabs.com');
  const theirs = await space.enrol(yours);
  await space.enrol(mine);

  const login = await space.call('/api/auth/login', { body: { email: 'mine@kuklabs.com', password: PASSWORD } });
  const done = await space.call('/api/auth/two-factor', {
    body: { challenge: login.body.challenge, code: theirs.recoveryCodes[0] },
  });
  assert.equal(done.status, 401);
  // And it is still theirs to use.
  assert.equal(space.db.prepare('SELECT COUNT(*) AS count FROM user_recovery_codes WHERE user_id = ?').get(yours).count, 10);
});

test('a fresh set replaces the printed one, and needs a code to ask for', async (t) => {
  const space = await workspace(t);
  const owner = space.person();
  const { secret, recoveryCodes } = await space.enrol(owner);

  const refused = await space.call('/api/account/two-factor/recovery-codes', { body: { code: '000000' }, userId: owner });
  assert.equal(refused.status, 401);

  const fresh = await space.call('/api/account/two-factor/recovery-codes', {
    body: { code: nextCode(secret) }, userId: owner,
  });
  assert.equal(fresh.status, 200);
  assert.equal(fresh.body.recoveryCodes.length, 10);
  assert.equal(fresh.body.recoveryCodes.some((code) => recoveryCodes.includes(code)), false);

  const login = await space.call('/api/auth/login', { body: { email: 'owner@kuklabs.com', password: PASSWORD } });
  // The old printout is paper now.
  assert.equal((await space.call('/api/auth/two-factor', {
    body: { challenge: login.body.challenge, code: recoveryCodes[0] },
  })).status, 401);
});

/* -------------------------------------------------------------- turning off */

test('turning it off needs a current code, not just a session', async (t) => {
  const space = await workspace(t);
  const owner = space.person();
  const { secret } = await space.enrol(owner);

  const refused = await space.call('/api/account/two-factor/disable', { body: { code: '000000' }, userId: owner });
  // A session is enough to do most things. It is not enough to remove the
  // control that exists for the case where a session is what got stolen.
  assert.equal(refused.status, 401);
  assert.equal((await space.call('/api/account/two-factor', { method: 'GET', userId: owner })).body.enabled, true);

  const done = await space.call('/api/account/two-factor/disable', {
    body: { code: nextCode(secret) }, userId: owner,
  });
  assert.equal(done.status, 200);
  const status = await space.call('/api/account/two-factor', { method: 'GET', userId: owner });
  assert.equal(status.body.enabled, false);
  assert.equal(status.body.recoveryCodesRemaining, 0);
});

test('somebody whose phone is gone can turn it off with a recovery code', async (t) => {
  const space = await workspace(t);
  const owner = space.person();
  const { recoveryCodes } = await space.enrol(owner);

  const done = await space.call('/api/account/two-factor/disable', { body: { code: recoveryCodes[0] }, userId: owner });
  // Otherwise a lost phone means an account with a second factor nobody can
  // satisfy and nobody can remove.
  assert.equal(done.status, 200);
  assert.equal((await space.call('/api/account/two-factor', { method: 'GET', userId: owner })).body.enabled, false);
});

/* ----------------------------------------------------------------- shape */

test('these routes are checked for origin and need a session', async (t) => {
  const space = await workspace(t);
  const owner = space.person();

  assert.equal((await space.call('/api/account/two-factor/start', { body: { password: PASSWORD } })).status, 401);
  const crossSite = await space.call('/api/account/two-factor/start', {
    body: { password: PASSWORD }, userId: owner, originHeader: 'https://evil.example',
  });
  assert.equal(crossSite.status, 403);
  assert.equal(crossSite.body.error.code, 'CSRF_BLOCKED');
});

test('nothing here answers when Kuklabs Account owns the passwords', async (t) => {
  const space = await workspace(t, { authMode: 'authkit' });
  const owner = space.person();
  // A second lock on a door somebody else owns is a lock its owner does not
  // know about.
  for (const pathname of ['/api/account/two-factor', '/api/account/two-factor/start', '/api/auth/two-factor']) {
    const response = await space.call(pathname, { body: {}, userId: owner, method: 'POST' });
    assert.equal(response.status, 404, pathname);
  }
});

test('there is no route that reads the secret or the codes back', async (t) => {
  const space = await workspace(t);
  const owner = space.person();
  await space.enrol(owner);

  const status = await space.call('/api/account/two-factor', { method: 'GET', userId: owner });
  // A secret an API hands over again only protects against somebody who has
  // not thought of asking.
  assert.deepEqual(Object.keys(status.body).sort(), ['enabled', 'pending', 'recoveryCodesRemaining', 'requestId']);
});

test('an enrolment nobody confirmed is not a second factor', async (t) => {
  const space = await workspace(t);
  const owner = space.person();
  const started = await space.call('/api/account/two-factor/start', { body: { password: PASSWORD }, userId: owner });
  const secret = base32Decode(started.body.secret);

  // The secret exists and the recovery codes were handed over, but nothing was
  // ever proved. Treating that as enabled means a half-finished setup somebody
  // abandoned can be used to satisfy a check, and a code from it can turn off
  // a factor that was never on.
  assert.throws(
    () => verifyTwoFactor(space.db, space.config, { userId: owner, code: nextCode(secret) }),
    { code: 'TWO_FACTOR_NOT_ENABLED' },
  );
  assert.throws(
    () => verifyTwoFactor(space.db, space.config, { userId: owner, code: started.body.recoveryCodes[0] }),
    { code: 'TWO_FACTOR_NOT_ENABLED' },
  );

  // And a password still signs in — 2FA is not on.
  const login = await space.call('/api/auth/login', { body: { email: 'owner@kuklabs.com', password: PASSWORD } });
  assert.match(login.setCookie, /kukgit_session=/);
});
