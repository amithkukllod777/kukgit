import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { openDatabase, seedCore, uid } from '../src/db.mjs';
import { authenticate, createSession, hashPassword } from '../src/auth.mjs';
import { listEmailOutbox, migrateNotifications } from '../src/notifications.mjs';
import {
  RESEND_INTERVAL_SECONDS,
  TOKEN_LIFETIME_SECONDS,
  completePasswordReset,
  consumeAccountToken,
  issueAccountToken,
  migrateAccountVerification,
  pruneAccountTokens,
  requestPasswordReset,
  sendEmailVerification,
  throttledUntil,
  verifyEmailToken,
} from '../src/account-verification.mjs';

/**
 * Proving an address, and getting back in after forgetting a password.
 *
 * These are the two flows that decide whether an account system can be put in
 * front of customers, and both are mostly made of refusals. Almost every test
 * here is about something the flow must *not* do: not say whether an address is
 * registered, not let a link work twice, not leave an intruder's session alive
 * after the password it used has been changed.
 */

function workspace(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-verify-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const config = loadConfig({
    dataDir,
    databasePath: path.join(dataDir, 'test.db'),
    repositoriesDir: path.join(dataDir, 'repos'),
    tempDir: path.join(dataDir, 'tmp'),
    baseUrl: 'https://git.kuklabs.com',
    nodeEnv: 'test',
    adminEmail: 'founder@kuklabs.com',
    adminPassword: 'secure-test-password',
    adminName: 'Founder',
  });
  const db = openDatabase(config);
  t.after(() => db.close());
  seedCore(db, config);
  migrateNotifications(db);
  migrateAccountVerification(db);

  const person = (email, password = 'a-real-enough-password') => {
    const id = uid('usr');
    db.prepare('INSERT INTO users (id, email, password_hash, display_name) VALUES (?, ?, ?, ?)')
      .run(id, email, hashPassword(password), email.split('@')[0]);
    return id;
  };
  const outbox = () => listEmailOutbox(db).emails;
  const linkIn = (subjectMatch) => {
    const row = db.prepare('SELECT text_body AS body FROM email_outbox WHERE subject LIKE ? ORDER BY created_at DESC, rowid DESC LIMIT 1')
      .get(`%${subjectMatch}%`);
    return row ? /token=([^\s]+)/.exec(row.body)?.[1] ?? null : null;
  };

  return { config, db, person, outbox, linkIn };
}

/* ------------------------------------------------------------- the tokens */

test('a token is long, random, and stored only as a hash', async (t) => {
  const space = workspace(t);
  const userId = space.person('one@kuklabs.com');
  const token = issueAccountToken(space.db, { userId, purpose: 'verify_email', email: 'one@kuklabs.com' });

  // 32 random bytes, so there is nothing to brute-force and no attempt counter
  // to get right. A six-digit code needs both.
  assert.ok(token.length >= 40, `token was only ${token.length} characters`);
  const stored = space.db.prepare('SELECT token_hash AS hash FROM account_tokens WHERE user_id = ?').get(userId).hash;
  // Somebody who reads the table cannot use what they find. A reset token is a
  // password.
  assert.notEqual(stored, token);
  assert.match(stored, /^[0-9a-f]{64}$/);
});

test('two tokens are never the same', async (t) => {
  const space = workspace(t);
  const seen = new Set();
  for (let round = 0; round < 25; round += 1) {
    const userId = space.person(`person${round}@kuklabs.com`);
    seen.add(issueAccountToken(space.db, { userId, purpose: 'verify_email', email: `person${round}@kuklabs.com` }));
  }
  assert.equal(seen.size, 25);
});

test('asking again drops the outstanding token', async (t) => {
  const space = workspace(t);
  const userId = space.person('one@kuklabs.com');
  const first = issueAccountToken(space.db, { userId, purpose: 'password_reset', email: 'one@kuklabs.com' });
  const second = issueAccountToken(space.db, { userId, purpose: 'password_reset', email: 'one@kuklabs.com' });

  // Two live reset links is one more than anybody needs, and the older one is
  // the one more likely to have been intercepted.
  assert.throws(() => consumeAccountToken(space.db, { token: first, purpose: 'password_reset' }), { code: 'ACCOUNT_TOKEN_INVALID' });
  assert.ok(consumeAccountToken(space.db, { token: second, purpose: 'password_reset' }));
});

test('a token works once', async (t) => {
  const space = workspace(t);
  const userId = space.person('one@kuklabs.com');
  const token = issueAccountToken(space.db, { userId, purpose: 'verify_email', email: 'one@kuklabs.com' });

  assert.equal(consumeAccountToken(space.db, { token, purpose: 'verify_email' }).userId, userId);
  // A link that works twice is a link somebody can replay out of a mailbox.
  assert.throws(() => consumeAccountToken(space.db, { token, purpose: 'verify_email' }), { code: 'ACCOUNT_TOKEN_INVALID' });
});

test('a token expires', async (t) => {
  const space = workspace(t);
  const userId = space.person('one@kuklabs.com');
  const token = issueAccountToken(space.db, { userId, purpose: 'password_reset', email: 'one@kuklabs.com' });
  const after = new Date(Date.now() + (TOKEN_LIFETIME_SECONDS.password_reset + 5) * 1000);

  assert.throws(() => consumeAccountToken(space.db, { token, purpose: 'password_reset', now: after }), { code: 'ACCOUNT_TOKEN_INVALID' });
  // An hour for a reset, a day for a verification: a reset token is a password
  // and the window in which a forwarded email is dangerous should be short.
  assert.ok(TOKEN_LIFETIME_SECONDS.password_reset < TOKEN_LIFETIME_SECONDS.verify_email);
});

test('a token cannot be spent for the wrong purpose', async (t) => {
  const space = workspace(t);
  const userId = space.person('one@kuklabs.com');
  const token = issueAccountToken(space.db, { userId, purpose: 'verify_email', email: 'one@kuklabs.com' });

  // Otherwise a verification link — which lives for a day and is often
  // forwarded — would set a password.
  assert.throws(() => consumeAccountToken(space.db, { token, purpose: 'password_reset' }), { code: 'ACCOUNT_TOKEN_INVALID' });
});

test('missing, spent and expired all say the same thing', async (t) => {
  const space = workspace(t);
  const userId = space.person('one@kuklabs.com');
  const token = issueAccountToken(space.db, { userId, purpose: 'verify_email', email: 'one@kuklabs.com' });
  consumeAccountToken(space.db, { token, purpose: 'verify_email' });

  const messages = new Set();
  for (const candidate of [token, 'never-existed', '']) {
    try { consumeAccountToken(space.db, { token: candidate, purpose: 'verify_email' }); }
    catch (error) { messages.add(error.message.replace('This link is not valid. Ask for a new one.', 'This link has expired or has already been used. Ask for a new one.')); }
  }
  // Which of the three it was is not something the holder of a bad link needs,
  // and is something somebody guessing links would like.
  assert.equal(messages.size, 1, [...messages].join(' | '));
});

test('deleting the account takes its tokens with it', async (t) => {
  const space = workspace(t);
  const userId = space.person('one@kuklabs.com');
  issueAccountToken(space.db, { userId, purpose: 'password_reset', email: 'one@kuklabs.com' });
  space.db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  assert.equal(space.db.prepare('SELECT COUNT(*) AS n FROM account_tokens').get().n, 0);
});

/* ------------------------------------------------------- verifying email */

test('verification emails a link and marks the address proved', async (t) => {
  const space = workspace(t);
  const userId = space.person('one@kuklabs.com');

  assert.deepEqual(sendEmailVerification(space.db, space.config, { userId }), { sent: true });
  const queued = space.outbox();
  assert.equal(queued.length, 1);
  assert.equal(queued[0].toEmail, 'one@kuklabs.com');
  // `security` rather than a mutable category: an account cannot be finished
  // without this, so it is not something to be quietly turned off.
  assert.equal(queued[0].category, 'security');

  const token = space.linkIn('Confirm your KukGit email');
  assert.ok(token, 'no link was emailed');
  assert.equal(space.db.prepare('SELECT email_verified AS verified FROM users WHERE id = ?').get(userId).verified, 0);

  verifyEmailToken(space.db, { token });
  assert.equal(space.db.prepare('SELECT email_verified AS verified FROM users WHERE id = ?').get(userId).verified, 1);
});

test('the link points at this instance and carries the token', async (t) => {
  const space = workspace(t);
  const userId = space.person('one@kuklabs.com');
  sendEmailVerification(space.db, space.config, { userId });
  const body = space.db.prepare('SELECT text_body AS body FROM email_outbox ORDER BY rowid DESC LIMIT 1').get().body;
  assert.match(body, /https:\/\/git\.kuklabs\.com\/#\/verify-email\?token=/);
});

test('an already verified address is not emailed again', async (t) => {
  const space = workspace(t);
  const userId = space.person('one@kuklabs.com');
  space.db.prepare('UPDATE users SET email_verified = 1 WHERE id = ?').run(userId);

  assert.deepEqual(sendEmailVerification(space.db, space.config, { userId }), { sent: false, reason: 'already verified' });
  assert.deepEqual(space.outbox(), []);
});

test('asking twice in a minute sends one email', async (t) => {
  const space = workspace(t);
  const userId = space.person('one@kuklabs.com');
  sendEmailVerification(space.db, space.config, { userId });
  const again = sendEmailVerification(space.db, space.config, { userId });

  // Every request sends a real email, so an unthrottled endpoint is a way to
  // bomb an inbox from a form that needs no account.
  assert.equal(again.sent, false);
  assert.equal(again.reason, 'throttled');
  assert.equal(space.outbox().length, 1);

  const later = new Date(Date.now() + (RESEND_INTERVAL_SECONDS + 5) * 1000);
  assert.equal(sendEmailVerification(space.db, space.config, { userId, now: later }).sent, true);
});

test('the throttle survives a restart, because it is not held in memory', async (t) => {
  const space = workspace(t);
  const userId = space.person('one@kuklabs.com');
  sendEmailVerification(space.db, space.config, { userId });

  // Read from the tokens table. An in-memory limiter forgets everything on
  // deploy, which on an instance that deploys often is a limiter somebody can
  // wait out.
  assert.ok(throttledUntil(space.db, { userId, purpose: 'verify_email' }) instanceof Date);
});

test('a link sent to an address that has since changed does not verify the new one', async (t) => {
  const space = workspace(t);
  const userId = space.person('old@kuklabs.com');
  sendEmailVerification(space.db, space.config, { userId });
  const token = space.linkIn('Confirm your KukGit email');

  space.db.prepare('UPDATE users SET email = ? WHERE id = ?').run('new@kuklabs.com', userId);
  // Otherwise proving control of the old address proves control of the new one.
  assert.throws(() => verifyEmailToken(space.db, { token }), { code: 'ACCOUNT_TOKEN_ADDRESS_CHANGED' });
  assert.equal(space.db.prepare('SELECT email_verified AS verified FROM users WHERE id = ?').get(userId).verified, 0);
});

/* ----------------------------------------------------- resetting a password */

test('a reset ends every session, everywhere', async (t) => {
  const space = workspace(t);
  const userId = space.person('one@kuklabs.com');
  createSession(space.db, userId);
  createSession(space.db, userId);
  assert.equal(space.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?').get(userId).n, 2);

  requestPasswordReset(space.db, space.config, { email: 'one@kuklabs.com' });
  const token = space.linkIn('Reset your KukGit password');
  const result = completePasswordReset(space.db, { token, password: 'a-brand-new-password' });

  // People reset a password when they think somebody else has it. Leaving that
  // session alive is the one thing this flow must not do.
  assert.equal(result.sessionsEnded, 2);
  assert.equal(space.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?').get(userId).n, 0);
  assert.equal(authenticate(space.db, 'one@kuklabs.com', 'a-brand-new-password').id, userId);
  assert.throws(() => authenticate(space.db, 'one@kuklabs.com', 'a-real-enough-password'), { code: 'INVALID_CREDENTIALS' });
});

test('somebody else\'s sessions are untouched', async (t) => {
  const space = workspace(t);
  const userId = space.person('one@kuklabs.com');
  const other = space.person('two@kuklabs.com');
  createSession(space.db, userId);
  createSession(space.db, other);

  requestPasswordReset(space.db, space.config, { email: 'one@kuklabs.com' });
  completePasswordReset(space.db, { token: space.linkIn('Reset your KukGit password'), password: 'a-brand-new-password' });

  assert.equal(space.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?').get(other).n, 1);
  assert.equal(authenticate(space.db, 'two@kuklabs.com', 'a-real-enough-password').id, other);
});

test('an unknown address gets the same answer as a known one', async (t) => {
  const space = workspace(t);
  space.person('one@kuklabs.com');

  const known = requestPasswordReset(space.db, space.config, { email: 'one@kuklabs.com' });
  const unknown = requestPasswordReset(space.db, space.config, { email: 'nobody@example.com' });

  // For a Git host, "is this address registered" is "does this company keep its
  // code here". A form anybody can submit should not answer it.
  assert.deepEqual(known, unknown);
  // And nothing was sent to the address that does not exist.
  assert.equal(space.outbox().length, 1);
  assert.equal(space.outbox()[0].toEmail, 'one@kuklabs.com');
});

test('a throttled request also looks identical', async (t) => {
  const space = workspace(t);
  space.person('one@kuklabs.com');
  requestPasswordReset(space.db, space.config, { email: 'one@kuklabs.com' });

  // A different answer on the second attempt would say "this one is real".
  assert.deepEqual(
    requestPasswordReset(space.db, space.config, { email: 'one@kuklabs.com' }),
    requestPasswordReset(space.db, space.config, { email: 'nobody@example.com' }),
  );
  assert.equal(space.outbox().length, 1);
});

test('an account managed by Kuklabs Account is not given a local password', async (t) => {
  const space = workspace(t);
  const userId = uid('usr');
  space.db.prepare("INSERT INTO users (id, email, password_hash, display_name) VALUES (?, 'central@kuklabs.com', 'authkit$managed', 'Central')").run(userId);

  const answer = requestPasswordReset(space.db, space.config, { email: 'central@kuklabs.com' });
  // Same answer as always — but there is no local password to reset, and
  // issuing a token would quietly create one.
  assert.deepEqual(answer, { accepted: true });
  assert.deepEqual(space.outbox(), []);
  assert.equal(space.db.prepare('SELECT COUNT(*) AS n FROM account_tokens').get().n, 0);
});

test('a refused password costs the link rather than leaving it live', async (t) => {
  const space = workspace(t);
  const userId = space.person('one@kuklabs.com');
  requestPasswordReset(space.db, space.config, { email: 'one@kuklabs.com' });
  const token = space.linkIn('Reset your KukGit password');

  assert.throws(() => completePasswordReset(space.db, { token, password: 'short' }), { status: 400 });
  // The token was already spent, so a rejected attempt needs a new link. That
  // is the right way round — a live token left behind is the thing worth
  // avoiding.
  assert.throws(() => completePasswordReset(space.db, { token, password: 'a-brand-new-password' }), { code: 'ACCOUNT_TOKEN_INVALID' });
  assert.equal(authenticate(space.db, 'one@kuklabs.com', 'a-real-enough-password').id, userId);
});

test('resetting drops any outstanding verification link too', async (t) => {
  const space = workspace(t);
  const userId = space.person('one@kuklabs.com');
  sendEmailVerification(space.db, space.config, { userId });
  const verification = space.linkIn('Confirm your KukGit email');

  requestPasswordReset(space.db, space.config, { email: 'one@kuklabs.com' });
  completePasswordReset(space.db, { token: space.linkIn('Reset your KukGit password'), password: 'a-brand-new-password' });

  // Whoever controls the password now is not necessarily whoever was sent that.
  assert.throws(() => verifyEmailToken(space.db, { token: verification }), { code: 'ACCOUNT_TOKEN_INVALID' });
});

test('the reset email says what to do if you did not ask for it', async (t) => {
  const space = workspace(t);
  space.person('one@kuklabs.com');
  requestPasswordReset(space.db, space.config, { email: 'one@kuklabs.com' });
  const body = space.db.prepare('SELECT text_body AS body FROM email_outbox ORDER BY rowid DESC LIMIT 1').get().body;

  // Somebody who gets one of these unexpectedly should not conclude they have
  // been broken into — anybody who knows the address can cause this.
  assert.match(body, /your password has not changed/);
  assert.match(body, /does not mean\s+anybody has access/);
});

test('both flows are audited', async (t) => {
  const space = workspace(t);
  const userId = space.person('one@kuklabs.com');
  sendEmailVerification(space.db, space.config, { userId });
  verifyEmailToken(space.db, { token: space.linkIn('Confirm your KukGit email') });
  requestPasswordReset(space.db, space.config, { email: 'one@kuklabs.com' });
  completePasswordReset(space.db, { token: space.linkIn('Reset your KukGit password'), password: 'a-brand-new-password' });

  const actions = space.db.prepare("SELECT action FROM audit_logs WHERE action LIKE 'account.%'").all().map((row) => row.action);
  assert.deepEqual(actions.sort(), ['account.email_verified', 'account.password_reset']);
});

test('housekeeping removes only what nobody can read', async (t) => {
  const space = workspace(t);
  const userId = space.person('one@kuklabs.com');
  const live = issueAccountToken(space.db, { userId, purpose: 'verify_email', email: 'one@kuklabs.com' });
  const other = space.person('two@kuklabs.com');
  issueAccountToken(space.db, { userId: other, purpose: 'password_reset', email: 'two@kuklabs.com' });

  const muchLater = new Date(Date.now() + 30 * 86_400_000);
  assert.equal(pruneAccountTokens(space.db, { now: muchLater }), 2);
  assert.equal(pruneAccountTokens(space.db, {}), 0);
  // And a live token is left alone by a prune run today.
  const fresh = issueAccountToken(space.db, { userId, purpose: 'verify_email', email: 'one@kuklabs.com' });
  assert.equal(pruneAccountTokens(space.db, {}), 0);
  assert.ok(consumeAccountToken(space.db, { token: fresh, purpose: 'verify_email' }));
  assert.notEqual(fresh, live);
});
