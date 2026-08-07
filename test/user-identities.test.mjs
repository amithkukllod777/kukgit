import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { openDatabase, seedCore, uid } from '../src/db.mjs';
import { hashPassword } from '../src/auth.mjs';
import {
  IDENTITY_PROVIDERS,
  findIdentity,
  identitiesFor,
  linkIdentity,
  migrateUserIdentities,
  resolveIdentitySignIn,
  unlinkIdentity,
} from '../src/user-identities.mjs';

/**
 * One person, several ways in.
 *
 * Most of this file is one question asked from different angles: when somebody
 * arrives from GitHub or Google and there is already a KukGit account with the
 * same address, is that the same person?
 *
 * Getting it wrong in one direction makes a duplicate account, and the customer
 * stares at an empty screen while their repositories sit under the other one.
 * Getting it wrong in the other direction hands somebody else's account away.
 * The second is not recoverable, so the rule is deliberately strict and the
 * tests are mostly about refusing.
 */

function workspace(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-identities-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const config = loadConfig({
    dataDir,
    databasePath: path.join(dataDir, 'test.db'),
    repositoriesDir: path.join(dataDir, 'repos'),
    tempDir: path.join(dataDir, 'tmp'),
    nodeEnv: 'test',
    adminEmail: 'founder@kuklabs.com',
    adminPassword: 'secure-test-password',
    adminName: 'Founder',
  });
  const db = openDatabase(config);
  t.after(() => db.close());
  seedCore(db, config);
  if (!new Set(db.prepare('PRAGMA table_info(users)').all().map((row) => row.name)).has('email_verified')) {
    db.exec('ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0');
  }
  migrateUserIdentities(db);

  const person = ({ email, verified = false, password = 'a-real-enough-password' }) => {
    const id = uid('usr');
    db.prepare('INSERT INTO users (id, email, password_hash, display_name, email_verified) VALUES (?, ?, ?, ?, ?)')
      .run(id, email, password ? hashPassword(password) : 'authkit$managed', email.split('@')[0], verified ? 1 : 0);
    return id;
  };

  const created = [];
  const createUser = (profile) => {
    created.push(profile);
    const id = uid('usr');
    db.prepare('INSERT INTO users (id, email, password_hash, display_name, email_verified) VALUES (?, ?, ?, ?, ?)')
      .run(id, profile.email ?? `${id}@placeholder.invalid`, 'authkit$managed', profile.displayName, profile.emailVerified ? 1 : 0);
    return id;
  };

  const arrive = (overrides = {}) => resolveIdentitySignIn(db, {
    provider: 'github',
    providerUserId: '4242',
    providerLogin: 'octocat',
    email: 'octocat@example.com',
    emailVerified: true,
    displayName: 'Octo Cat',
    createUser,
    ...overrides,
  });

  return { config, db, person, createUser, created, arrive };
}

/* ------------------------------------------------------------- the shape */

test('a provider account belongs to exactly one KukGit user', async (t) => {
  const space = workspace(t);
  const first = space.person({ email: 'one@kuklabs.com' });
  const second = space.person({ email: 'two@kuklabs.com' });
  linkIdentity(space.db, { userId: first, provider: 'github', providerUserId: '4242', providerLogin: 'octocat' });

  // Without this, two KukGit users could both claim the same GitHub account and
  // which one you signed into would depend on row order.
  assert.throws(
    () => linkIdentity(space.db, { userId: second, provider: 'github', providerUserId: '4242' }),
    { code: 'IDENTITY_ALREADY_LINKED' },
  );
});

test('a KukGit user has at most one account per provider', async (t) => {
  const space = workspace(t);
  const userId = space.person({ email: 'one@kuklabs.com' });
  linkIdentity(space.db, { userId, provider: 'github', providerUserId: '4242', providerLogin: 'octocat' });

  // Replacing it silently would take away the way they normally sign in.
  assert.throws(
    () => linkIdentity(space.db, { userId, provider: 'github', providerUserId: '9999', providerLogin: 'somebody-else' }),
    { code: 'IDENTITY_PROVIDER_TAKEN' },
  );
  assert.equal(identitiesFor(space.db, userId).length, 1);
});

test('linking the same account twice is not an error', async (t) => {
  const space = workspace(t);
  const userId = space.person({ email: 'one@kuklabs.com' });
  const first = linkIdentity(space.db, { userId, provider: 'github', providerUserId: '4242' });
  const again = linkIdentity(space.db, { userId, provider: 'github', providerUserId: '4242' });
  assert.equal(first.id, again.id);
});

test('the provider is matched on its id, never on the username', async (t) => {
  const space = workspace(t);
  const userId = space.person({ email: 'one@kuklabs.com' });
  linkIdentity(space.db, { userId, provider: 'github', providerUserId: '4242', providerLogin: 'octocat' });

  // A GitHub login can be renamed and the old name taken by somebody else. The
  // numeric id cannot, so that is what the row is keyed on.
  space.arrive({ providerUserId: '4242', providerLogin: 'renamed-since' });
  assert.equal(findIdentity(space.db, { provider: 'github', providerUserId: '4242' }).userId, userId);
  assert.equal(findIdentity(space.db, { provider: 'github', providerUserId: '4242' }).providerLogin, 'renamed-since');
});

test('an unknown provider or a missing id is refused', async (t) => {
  const space = workspace(t);
  const userId = space.person({ email: 'one@kuklabs.com' });
  assert.throws(() => linkIdentity(space.db, { userId, provider: 'facebook', providerUserId: '1' }), { code: 'IDENTITY_PROVIDER_INVALID' });
  assert.throws(() => linkIdentity(space.db, { userId, provider: 'github', providerUserId: '' }), { code: 'IDENTITY_SUBJECT_INVALID' });
  assert.deepEqual([...IDENTITY_PROVIDERS], ['github', 'google', 'phone']);
});

test('deleting the account takes its links with it', async (t) => {
  const space = workspace(t);
  const userId = space.person({ email: 'one@kuklabs.com' });
  linkIdentity(space.db, { userId, provider: 'github', providerUserId: '4242' });
  space.db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  assert.equal(space.db.prepare('SELECT COUNT(*) AS n FROM user_identities').get().n, 0);
});

/* --------------------------------------------------- arriving from GitHub */

test('a returning visitor signs into the account they already have', async (t) => {
  const space = workspace(t);
  const userId = space.person({ email: 'one@kuklabs.com' });
  linkIdentity(space.db, { userId, provider: 'github', providerUserId: '4242' });

  const result = space.arrive();
  assert.deepEqual(result, { userId, outcome: 'signed-in' });
  assert.deepEqual(space.created, [], 'a second account was created for somebody already known');
});

test('a first-time visitor with no matching address gets a new account', async (t) => {
  const space = workspace(t);
  const result = space.arrive();

  assert.equal(result.outcome, 'created');
  assert.equal(space.created.length, 1);
  assert.deepEqual(space.created[0], {
    email: 'octocat@example.com',
    emailVerified: true,
    displayName: 'Octo Cat',
    provider: 'github',
  });
  assert.equal(identitiesFor(space.db, result.userId).length, 1);
});

test('a proved address on both sides joins the two together', async (t) => {
  const space = workspace(t);
  const userId = space.person({ email: 'octocat@example.com', verified: true });

  // The case this whole module exists for: somebody signed up with an email in
  // March and clicks "Sign in with GitHub" in June. One account, not two.
  const result = space.arrive();
  assert.deepEqual(result, { userId, outcome: 'linked' });
  assert.deepEqual(space.created, []);
});

/* ------------------------------------------ the takeover this refuses */

test('an unproved local address does not let a provider claim the account', async (t) => {
  const space = workspace(t);
  // I sign up here as your address and never prove it.
  const attacker = space.person({ email: 'victim@company.com', verified: false });

  // You later arrive from GitHub, having proved that address to GitHub.
  assert.throws(
    () => space.arrive({ email: 'victim@company.com', emailVerified: true }),
    { code: 'IDENTITY_EMAIL_UNVERIFIED_CONFLICT' },
  );
  // Nothing was linked, so I am not signed into your account and you are not
  // signed into mine.
  assert.deepEqual(identitiesFor(space.db, attacker), []);
  assert.deepEqual(space.created, []);
});

test('an unproved provider address does not claim a local account either', async (t) => {
  const space = workspace(t);
  const userId = space.person({ email: 'octocat@example.com', verified: true });

  // The provider knows the address but has not confirmed the person owns it.
  assert.throws(
    () => space.arrive({ emailVerified: false }),
    { code: 'IDENTITY_EMAIL_UNVERIFIED_CONFLICT' },
  );
  assert.deepEqual(identitiesFor(space.db, userId), []);
});

test('the refusal says what to do instead', async (t) => {
  const space = workspace(t);
  space.person({ email: 'octocat@example.com', verified: false });
  try {
    space.arrive();
    assert.fail('it linked');
  } catch (error) {
    // A dead end here means a support ticket. Signing in with the password and
    // linking from settings is safe, because that proves both sides.
    assert.match(error.message, /Sign in with your password and link this provider/);
    assert.equal(error.status, 409);
  }
});

test('a provider that reports no address at all still gets an account', async (t) => {
  const space = workspace(t);
  // GitHub users can hide their email. That is not a reason to refuse them.
  const result = space.arrive({ email: null, emailVerified: false });
  assert.equal(result.outcome, 'created');
  assert.equal(space.created[0].email, null);
  assert.equal(space.created[0].emailVerified, false);
  assert.equal(space.created[0].displayName, 'Octo Cat');
});

/* ----------------------------------------------------------- unlinking */

test('the last way into an account cannot be removed', async (t) => {
  const space = workspace(t);
  const result = space.arrive();
  // Created from GitHub, so there is no password. Removing the link would leave
  // an account nobody can sign into — and therefore nobody can delete or
  // transfer either.
  assert.throws(() => unlinkIdentity(space.db, { userId: result.userId, provider: 'github' }), { code: 'IDENTITY_LAST_METHOD' });
  assert.equal(identitiesFor(space.db, result.userId).length, 1);
});

test('a link can be removed when a password or another provider remains', async (t) => {
  const space = workspace(t);
  const withPassword = space.person({ email: 'one@kuklabs.com' });
  linkIdentity(space.db, { userId: withPassword, provider: 'github', providerUserId: '4242' });
  assert.equal(unlinkIdentity(space.db, { userId: withPassword, provider: 'github' }), true);
  assert.deepEqual(identitiesFor(space.db, withPassword), []);

  const noPassword = space.person({ email: 'two@kuklabs.com', password: null });
  linkIdentity(space.db, { userId: noPassword, provider: 'github', providerUserId: '5252' });
  linkIdentity(space.db, { userId: noPassword, provider: 'google', providerUserId: 'g-1' });
  assert.equal(unlinkIdentity(space.db, { userId: noPassword, provider: 'github' }), true);
  assert.equal(identitiesFor(space.db, noPassword).length, 1);
});

test('removing a link that is not there is not an error', async (t) => {
  const space = workspace(t);
  const userId = space.person({ email: 'one@kuklabs.com' });
  assert.equal(unlinkIdentity(space.db, { userId, provider: 'google' }), false);
});

test('linking and unlinking are both audited', async (t) => {
  const space = workspace(t);
  const userId = space.person({ email: 'one@kuklabs.com' });
  linkIdentity(space.db, { userId, provider: 'github', providerUserId: '4242', providerLogin: 'octocat' });
  unlinkIdentity(space.db, { userId, provider: 'github' });

  const actions = space.db.prepare("SELECT action FROM audit_logs WHERE action LIKE 'account.identity%'").all().map((row) => row.action);
  assert.deepEqual(actions, ['account.identity_linked', 'account.identity_unlinked']);
});

test('signing in records when, so an unused link can be noticed', async (t) => {
  const space = workspace(t);
  const result = space.arrive();
  const [link] = identitiesFor(space.db, result.userId);
  assert.ok(link.lastUsedAt, 'nothing recorded that it was used');
  assert.ok(Date.parse(link.linkedAt) <= Date.parse(link.lastUsedAt));
});
