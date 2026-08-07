import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { authenticate, hashPassword } from '../src/auth.mjs';
import { loadConfig } from '../src/config.mjs';
import { openDatabase, seedCore, uid } from '../src/db.mjs';
import { createAccountApiHandler } from '../src/account-api.mjs';
import { migrateAccountVerification, verifyEmailToken } from '../src/account-verification.mjs';
import { migrateNotifications } from '../src/notifications.mjs';
import { migrateInstanceSettings, putInstanceSetting } from '../src/instance-settings.mjs';
import { assertSignupVerified, migrateSignup, signUp, signupAvailable, signupPendingVerification } from '../src/signup.mjs';

/**
 * Making an account without an invitation and without an operator.
 *
 * Until this there was no way to do it at all — accounts came from the seed,
 * from an invitation, or from a first sign-in with GitHub or Google.
 *
 * Most of what is below is one property: **the answer is the same whichever
 * address you type.** A signup form that says "that address is taken" is a form
 * anybody can use to ask whether a person has an account here, and for a Git
 * host that is asking whether a company keeps its code here.
 */

async function workspace(t, { authMode = 'local', email = true } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-signup-'));
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
  migrateNotifications(db);
  migrateAccountVerification(db);
  migrateInstanceSettings(db);
  migrateSignup(db);
  // Where a running instance keeps it, and what makes signup available at all.
  if (email) {
    putInstanceSetting(db, config, { integration: 'email.resend', field: 'apiKey', value: 're_test_key' });
    putInstanceSetting(db, config, { integration: 'email.resend', field: 'fromAddress', value: 'noreply@kuklabs.com' });
  }

  const api = createAccountApiHandler({ config, db });
  handler = async (req, res) => { if (await api(req, res)) return; res.writeHead(404).end(); };

  const call = async (body, { originHeader = origin } = {}) => {
    const headers = { 'Content-Type': 'application/json' };
    if (originHeader) headers.Origin = originHeader;
    const response = await fetch(`${origin}/api/account/signup`, { method: 'POST', headers, body: JSON.stringify(body ?? {}) });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  };

  const ask = async () => {
    const response = await fetch(`${origin}/api/account/signup`, { method: 'GET' });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  };

  const outbox = (match) => db.prepare('SELECT to_email AS recipient, subject, text_body AS body FROM email_outbox WHERE subject LIKE ? ORDER BY rowid DESC').all(`%${match}%`);
  const userFor = (address) => db.prepare("SELECT id, email, display_name AS displayName, COALESCE(email_verified, 0) AS verified, COALESCE(auth_source, 'local') AS authSource FROM users WHERE email = ?").get(address);

  return { config, db, origin, call, ask, outbox, userFor };
}

const GOOD = { email: 'newcomer@example.com', password: 'a-real-enough-password', displayName: 'Newcomer' };

/* -------------------------------------------------- the same answer, always */

test('a new address gets an account, unverified, and a link', async (t) => {
  const space = await workspace(t);
  const response = await space.call(GOOD);

  assert.equal(response.status, 202);
  assert.equal(response.body.accepted, true);

  const user = space.userFor('newcomer@example.com');
  assert.ok(user);
  assert.equal(user.verified, 0);
  // The gate is on this, not on `email_verified` alone.
  assert.equal(user.authSource, 'signup');
  assert.equal(space.outbox('Confirm your KukGit email').length, 1);
});

test('an address that already has an account gets exactly the same answer', async (t) => {
  const space = await workspace(t);
  await space.call(GOOD);
  const before = space.userFor('newcomer@example.com').id;

  const second = await space.call({ ...GOOD, password: 'a-completely-different-one' });

  // Byte for byte. A different status, a different message, or a different
  // shape is the answer to "does this person have an account here".
  assert.equal(second.status, 202);
  assert.equal(second.body.accepted, true);
  assert.equal(second.body.message, (await space.call({ ...GOOD, email: 'nobody-else@example.com' })).body.message);

  // And nothing was touched.
  assert.equal(space.userFor('newcomer@example.com').id, before);
  assert.equal(space.db.prepare("SELECT COUNT(*) AS count FROM users WHERE email = 'newcomer@example.com'").get().count, 1);
});

test('the person who owns the address is told somebody tried', async (t) => {
  const space = await workspace(t);
  await space.call(GOOD);
  await space.call(GOOD);

  const warning = space.outbox('tried to sign up');
  assert.equal(warning.length, 1);
  assert.equal(warning[0].recipient, 'newcomer@example.com');
  // It has to say that nothing happened, or it reads as a breach notice.
  assert.match(warning[0].body, /nothing was created/);
  assert.match(warning[0].body, /does not mean anybody has access/);
});

test('a weak password is refused whether or not the address exists', async (t) => {
  const space = await workspace(t);
  await space.call(GOOD);

  const forNew = await space.call({ ...GOOD, email: 'someone-new@example.com', password: 'short' });
  const forExisting = await space.call({ ...GOOD, password: 'short' });
  // Same failure for both. If the rules ran after the lookup, the shape of the
  // error would answer the question this endpoint refuses to answer.
  assert.equal(forNew.status, forExisting.status);
  assert.equal(forNew.body.error.message, forExisting.body.error.message);
  assert.match(forNew.body.error.message, /at least 10 characters/);
});

test('an address that is not one is refused', async (t) => {
  const space = await workspace(t);
  for (const email of ['', 'not-an-address', 'no@domain', 'two@@at.com', `${'x'.repeat(200)}@example.com`]) {
    const response = await space.call({ ...GOOD, email });
    assert.equal(response.status, 400, email);
  }
});

test('the address is stored in one shape', async (t) => {
  const space = await workspace(t);
  await space.call({ ...GOOD, email: '  NewComer@Example.COM ' });
  assert.ok(space.userFor('newcomer@example.com'), 'normalised on the way in');

  // And the same address in another case is the same account, not a second one.
  await space.call({ ...GOOD, email: 'NEWCOMER@example.com' });
  assert.equal(space.db.prepare('SELECT COUNT(*) AS count FROM users').get().count, 2, 'founder plus one');
});

test('a name is asked for, not guessed from the address', async (t) => {
  const space = await workspace(t);
  // It used to fall back to the part before the `@`. A display name is what
  // everybody else in an organization sees next to a commit, a review and a
  // pull request, and `info`, `devops2` or `a.kukllod` is not one.
  for (const displayName of [undefined, '', '   ']) {
    const response = await space.call({ email: 'quiet@example.com', password: 'a-real-enough-password', displayName });
    assert.equal(response.status, 400, JSON.stringify(displayName));
    assert.equal(response.body.error.code, 'SIGNUP_NAME_REQUIRED');
  }
  assert.equal(space.db.prepare('SELECT COUNT(*) AS count FROM users').get().count, 1, 'only the founder');
});

test('the name is refused before the address is looked up', async (t) => {
  const space = await workspace(t);
  await space.call(GOOD);
  // Same failure for an address that exists and one that does not — otherwise
  // the shape of the error answers the question this endpoint refuses to.
  const forNew = await space.call({ email: 'someone-new@example.com', password: 'a-real-enough-password', displayName: '' });
  const forExisting = await space.call({ ...GOOD, displayName: '' });
  assert.equal(forNew.status, forExisting.status);
  assert.equal(forNew.body.error.message, forExisting.body.error.message);
});

test('surrounding and repeated whitespace in a name is tidied, not refused', async (t) => {
  const space = await workspace(t);
  await space.call({ ...GOOD, displayName: '  Amith   Kukllod  ' });
  assert.equal(space.userFor('newcomer@example.com').displayName, 'Amith Kukllod');
});

test('a name longer than the column is refused rather than truncated', async (t) => {
  const space = await workspace(t);
  const response = await space.call({ ...GOOD, displayName: 'x'.repeat(192) });
  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, 'SIGNUP_NAME_INVALID');
});

/* ------------------------------------------------------- what it does not do */

test('signing up does not sign anybody in', async (t) => {
  const space = await workspace(t);
  const response = await fetch(`${space.origin}/api/account/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: space.origin },
    body: JSON.stringify(GOOD),
  });
  // A response carrying a session could only be given to one of the two cases,
  // and which one you got would be the answer.
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal((await response.json()).user, undefined);
});

test('the password works once the address is proved, and the account is ordinary after that', async (t) => {
  const space = await workspace(t);
  await space.call(GOOD);
  const user = space.userFor('newcomer@example.com');

  assert.equal(signupPendingVerification(space.db, user.id), true);
  assert.throws(() => assertSignupVerified(space.db, user.id, 'create an organization'), { code: 'SIGNUP_VERIFICATION_REQUIRED' });

  const token = /token=([^\s]+)/.exec(space.outbox('Confirm your KukGit email')[0].body)[1];
  verifyEmailToken(space.db, { token });

  assert.equal(signupPendingVerification(space.db, user.id), false);
  assert.doesNotThrow(() => assertSignupVerified(space.db, user.id));
  // The password chosen at signup is the password.
  assert.equal(authenticate(space.db, 'newcomer@example.com', GOOD.password).id, user.id);
});

test('accounts that predate this are not caught by the rule', async (t) => {
  const space = await workspace(t);
  // The founder, made by the seed, with an address an operator chose and no
  // verification. Applying the rule to accounts like this would lock every
  // existing user out of creating anything — an outage, not a migration.
  const founder = space.userFor('founder@kuklabs.com');
  assert.equal(founder.verified, 0);
  assert.equal(founder.authSource, 'local');
  assert.equal(signupPendingVerification(space.db, founder.id), false);
  assert.doesNotThrow(() => assertSignupVerified(space.db, founder.id));
});

/* ------------------------------------------------------------- the shape */

test('signup is absent where no mail sender is configured', async (t) => {
  const space = await workspace(t, { email: false });
  // A form that appears to succeed and produces an account nobody can finish
  // setting up is worse than no form.
  assert.equal((await space.call(GOOD)).status, 404);
  assert.equal(space.db.prepare('SELECT COUNT(*) AS count FROM users').get().count, 1, 'only the founder');
});

test('signup is absent where Kuklabs Account owns the accounts', async (t) => {
  const space = await workspace(t, { authMode: 'authkit' });
  assert.equal((await space.call(GOOD)).status, 404);
});

test('signup is checked for origin like every other state change', async (t) => {
  const space = await workspace(t);
  const blocked = await space.call(GOOD, { originHeader: 'https://evil.example' });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.error.code, 'CSRF_BLOCKED');
  assert.equal(space.db.prepare('SELECT COUNT(*) AS count FROM users').get().count, 1);
});

test('called twice, it answers the same both times', async (t) => {
  const space = await workspace(t);
  const first = signUp(space.db, space.config, GOOD);
  const second = signUp(space.db, space.config, GOOD);
  assert.deepEqual(first, { accepted: true });
  assert.deepEqual(second, { accepted: true });
  // This does *not* reach the unique-violation branch — the second call finds
  // the row and returns before the insert. That branch needs two requests
  // interleaved between the lookup and the write, which SQLite's synchronous
  // API here cannot produce, so no test kills it. It is there because losing
  // that race must give the same answer as everybody else rather than a 500
  // that says the address is taken.
});

/* ------------------------------------------- what the sign-in screen may ask */

test('the sign-in screen can ask whether there is a signup here at all', async (t) => {
  const space = await workspace(t);
  const answer = await space.ask();
  assert.equal(answer.status, 200);
  assert.equal(answer.body.available, true);
  // No session, no origin header — this is asked by a page rendered before
  // anybody has signed in, exactly like the provider buttons.
  assert.equal(space.db.prepare('SELECT COUNT(*) AS count FROM users').get().count, 1, 'asking creates nothing');
});

test('asking says nothing about any account', async (t) => {
  const space = await workspace(t);
  await space.call(GOOD);
  // Whatever else it grows, it must never grow a field that varies with who
  // has an account here. This is the assertion that notices.
  assert.deepEqual(Object.keys((await space.ask()).body).sort(), ['available', 'requestId']);
});

test('where signup is not offered, asking gets the same 404 as posting', async (t) => {
  for (const options of [{ email: false }, { authMode: 'authkit' }]) {
    const space = await workspace(t, options);
    // Absent rather than `{available:false}`: a route that answers "no" is a
    // route, and the screen has the same amount to draw either way.
    assert.equal((await space.ask()).status, 404, JSON.stringify(options));
  }
});

test('the question is a GET and nothing else is', async (t) => {
  const space = await workspace(t);
  for (const method of ['PUT', 'DELETE', 'PATCH']) {
    const response = await fetch(`${space.origin}/api/account/signup`, { method, headers: { Origin: space.origin } });
    assert.equal(response.status, 405, method);
  }
  // And the GET does not reach the writing path — it takes no body and makes
  // no account.
  await space.ask();
  assert.equal(space.db.prepare('SELECT COUNT(*) AS count FROM users').get().count, 1);
});

test('an instance is offered signup only when it can actually do it', async (t) => {
  const space = await workspace(t);
  // Checked directly, because the route has its own gate and would hide a
  // mistake in this one.
  assert.equal(signupAvailable(space.config, { emailConfigured: true }), true);
  assert.equal(signupAvailable(space.config, { emailConfigured: false }), false);
  assert.equal(signupAvailable({ ...space.config, authMode: 'authkit' }, { emailConfigured: true }), false);
});

test('a leftover password on an account since moved to Kuklabs Account does not work', async (t) => {
  const space = await workspace(t);
  const moved = uid('usr');
  // The case the auth_source check is really for: an account that had a local
  // password and was later linked to Kuklabs Account. The hash is scrubbed on
  // linking, but a check that relied on the hash being unusable would be
  // trusting that scrub to have run everywhere, forever.
  space.db.prepare("INSERT INTO users (id, email, password_hash, display_name, auth_source) VALUES (?, 'moved@kuklabs.com', ?, 'Moved', 'authkit')")
    .run(moved, hashPassword('the-old-local-password'));
  assert.throws(() => authenticate(space.db, 'moved@kuklabs.com', 'the-old-local-password'), { code: 'INVALID_CREDENTIALS' });
});

test('an account made by signup can sign in, and one managed elsewhere cannot', async (t) => {
  const space = await workspace(t);
  await space.call(GOOD);

  // The bug this catches: `authenticate` refused anything whose `auth_source`
  // was not exactly 'local', so every self-service signup was an account that
  // could never sign in — with a real password hash sitting right there.
  assert.ok(authenticate(space.db, 'newcomer@example.com', GOOD.password));

  // And the reason that check exists is untouched: an AuthKit-managed account
  // has a sentinel where its hash should be, so a password means nothing.
  const managed = uid('usr');
  space.db.prepare("INSERT INTO users (id, email, password_hash, display_name, auth_source) VALUES (?, 'managed@kuklabs.com', 'authkit$managed', 'Managed', 'authkit')").run(managed);
  assert.throws(() => authenticate(space.db, 'managed@kuklabs.com', 'anything-at-all'), { code: 'INVALID_CREDENTIALS' });
});

test('the gate does not break a database that predates it', async (t) => {
  const space = await workspace(t);
  const founder = space.userFor('founder@kuklabs.com');
  // A database from before these columns existed. Asking for a column that is
  // not there is not a refusal, it is a 500 — and it landed on every
  // organization anybody tried to create.
  space.db.exec('PRAGMA writable_schema = ON');
  const bare = new Set(['auth_source', 'email_verified']);
  const remaining = space.db.prepare('PRAGMA table_info(users)').all()
    .map((row) => row.name).filter((name) => !bare.has(name));
  space.db.exec(`
    PRAGMA writable_schema = OFF;
    CREATE TABLE users_old AS SELECT ${remaining.join(', ')} FROM users;
    DROP TABLE users;
    ALTER TABLE users_old RENAME TO users;
  `);

  assert.equal(signupPendingVerification(space.db, founder.id), false);
  assert.doesNotThrow(() => assertSignupVerified(space.db, founder.id, 'create an organization'));
});
