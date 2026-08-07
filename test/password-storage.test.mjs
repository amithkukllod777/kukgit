import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { openDatabase, seedCore, uid } from '../src/db.mjs';
import {
  PASSWORD_COST,
  authenticate,
  hashPassword,
  passwordNeedsRehash,
  verifyPassword,
} from '../src/auth.mjs';

/**
 * How a password is stored, and how that can be changed later.
 *
 * KukGit is going to own its own accounts rather than borrow Kuklabs Account's,
 * so this is now the thing standing between somebody's repositories and a stolen
 * database rather than a development convenience.
 *
 * The bug this fixes is not the cost. It is that the cost was **not written
 * down**: the record was `scrypt$salt$hash` and the parameters were whatever
 * Node defaulted to that year. Raising them would have made every existing
 * password unverifiable — so the only safe move would have been to never raise
 * them, which is the same as having no plan at all.
 *
 * One thing here has no test, deliberately. `verifyPassword` compares with
 * `safeEqual` rather than `===`, and a test for that would have to measure
 * timing, which is flaky on a shared machine and would fail for reasons that
 * have nothing to do with the code. It is also the least load-bearing guard in
 * this file: the value being compared is derived from a password the attacker
 * supplied and a salt they do not have, so what leaks is not obviously useful.
 * It stays because it costs nothing, not because a test proves it.
 */

function workspace(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-password-'));
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
  return { config, db };
}

/** The record the first version of this code wrote: no parameters at all. */
function legacyRecord(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64);
  return `scrypt$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

test('the record carries the parameters it was made with', async () => {
  const encoded = hashPassword('a-real-enough-password');
  const [scheme, params, salt, hash] = encoded.split('$');
  assert.equal(scheme, 'scrypt');
  // Without this, raising the cost breaks every password already stored.
  assert.equal(params, `N=${PASSWORD_COST.N},r=${PASSWORD_COST.r},p=${PASSWORD_COST.p}`);
  assert.ok(salt.length >= 20 && hash.length >= 80);
});

test('the cost is above the default it used to inherit', async () => {
  // 32768 rather than Node's 16384: twice the memory hardness, and memory is
  // what makes guessing at scale expensive.
  assert.ok(PASSWORD_COST.N >= 32768, 'the work factor went down');
  assert.equal(PASSWORD_COST.r, 8);
});

test('a hash at this cost does not throw on Node default memory limits', async () => {
  // The working set is 128 * N * r = 33.5 MB and Node's default ceiling is
  // 32 MB, so `maxmem` has to be passed. Forgetting it looks like "logins are
  // broken" in production and like nothing at all anywhere else.
  assert.doesNotThrow(() => hashPassword('another-real-password'));
  const encoded = hashPassword('another-real-password');
  assert.equal(verifyPassword('another-real-password', encoded), true);
});

test('the right password verifies and a wrong one does not', async () => {
  const encoded = hashPassword('correct-horse-battery');
  assert.equal(verifyPassword('correct-horse-battery', encoded), true);
  assert.equal(verifyPassword('correct-horse-batteri', encoded), false);
  assert.equal(verifyPassword('', encoded), false);
});

test('a record written by the old code still verifies', async () => {
  const encoded = legacyRecord('an-older-password');
  // Everybody who already has an account has one of these. Reading it as the
  // old defaults is what makes raising the cost possible at all.
  assert.equal(verifyPassword('an-older-password', encoded), true);
  assert.equal(verifyPassword('not-that-password', encoded), false);
});

test('a damaged or foreign record is refused rather than crashing', async () => {
  for (const encoded of [
    '',
    'scrypt',
    'scrypt$onlyonepart',
    'scrypt$N=x,r=y,p=z$c2FsdA$aGFzaA',
    'scrypt$N=0,r=8,p=1$c2FsdA$aGFzaA',
    'bcrypt$2b$12$abcdefghijklmnop',
    'authkit$managed',
    null,
    undefined,
  ]) {
    assert.equal(verifyPassword('anything', encoded), false, `${encoded} was accepted`);
    assert.equal(passwordNeedsRehash(encoded), false, `${encoded} asked to be rewritten`);
  }
});

test('a short password is refused where it is set, not where it is checked', async () => {
  assert.throws(() => hashPassword('short'), { status: 400 });
  assert.throws(() => hashPassword(''), { status: 400 });
  assert.doesNotThrow(() => hashPassword('exactly-10'));
});

test('an old record asks to be rewritten and a current one does not', async () => {
  assert.equal(passwordNeedsRehash(legacyRecord('x-password')), true);
  assert.equal(passwordNeedsRehash(hashPassword('x-password')), false);
  // A record stronger than the current setting is left alone — downgrading
  // somebody's password on sign-in would be the opposite of the point.
  assert.equal(passwordNeedsRehash(`scrypt$N=${PASSWORD_COST.N * 2},r=8,p=1$c2FsdA$aGFzaA`), false);
});

test('signing in rewrites an old record at the current cost', async (t) => {
  const space = workspace(t);
  const id = uid('usr');
  space.db.prepare("INSERT INTO users (id, email, password_hash, display_name) VALUES (?, ?, ?, 'Old')")
    .run(id, 'old@kuklabs.com', legacyRecord('an-older-password'));

  const before = space.db.prepare('SELECT password_hash AS hash FROM users WHERE id = ?').get(id).hash;
  assert.equal(before.split('$').length, 3, 'the fixture was not in the old format');

  const user = authenticate(space.db, 'old@kuklabs.com', 'an-older-password');
  assert.equal(user.id, id);

  // Signing in is the only moment the plaintext exists, so it is the only
  // moment this can happen. A cost that goes up and never reaches an existing
  // account is a change to the documentation.
  const after = space.db.prepare('SELECT password_hash AS hash FROM users WHERE id = ?').get(id).hash;
  assert.ok(after.startsWith(`scrypt$N=${PASSWORD_COST.N},r=${PASSWORD_COST.r},p=${PASSWORD_COST.p}$`), after);
  assert.notEqual(after, before);
  // And the password still works afterwards, which is the part that would ruin
  // somebody's day if it did not.
  assert.equal(authenticate(space.db, 'old@kuklabs.com', 'an-older-password').id, id);
});

test('a failed sign-in rewrites nothing', async (t) => {
  const space = workspace(t);
  const id = uid('usr');
  const original = legacyRecord('an-older-password');
  space.db.prepare("INSERT INTO users (id, email, password_hash, display_name) VALUES (?, ?, ?, 'Old')")
    .run(id, 'old@kuklabs.com', original);

  assert.throws(() => authenticate(space.db, 'old@kuklabs.com', 'the-wrong-password'), { code: 'INVALID_CREDENTIALS' });
  assert.equal(space.db.prepare('SELECT password_hash AS hash FROM users WHERE id = ?').get(id).hash, original);
});

test('an AuthKit-managed account is never rewritten by a password attempt', async (t) => {
  const space = workspace(t);
  const id = uid('usr');
  // `authkit$managed` is the sentinel that means "this account has no local
  // password". Rewriting it would quietly give somebody one.
  space.db.prepare("INSERT INTO users (id, email, password_hash, display_name) VALUES (?, ?, 'authkit$managed', 'Central')")
    .run(id, 'central@kuklabs.com');

  assert.throws(() => authenticate(space.db, 'central@kuklabs.com', 'authkit$managed'), { code: 'INVALID_CREDENTIALS' });
  assert.equal(space.db.prepare('SELECT password_hash AS hash FROM users WHERE id = ?').get(id).hash, 'authkit$managed');
});

test('two accounts with the same password have different records', async () => {
  // Per-password salt, so a stolen table cannot be sorted into "these hundred
  // people all used the same password" and cracked once.
  const first = hashPassword('the-same-password');
  const second = hashPassword('the-same-password');
  assert.notEqual(first, second);
  assert.equal(verifyPassword('the-same-password', first), true);
  assert.equal(verifyPassword('the-same-password', second), true);
});
