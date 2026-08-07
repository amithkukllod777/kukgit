import { hashPassword } from './auth.mjs';
import { audit, uid } from './db.mjs';
import { queueTransactionalEmail } from './notifications.mjs';
import { hashToken, httpError, normalizeEmail, randomToken } from './security.mjs';

/**
 * Proving an address, and getting back in after forgetting a password.
 *
 * KukGit now owns its own accounts, so it owns the two flows that decide
 * whether an account system can be put in front of customers: an address has to
 * be proved before the account works, and a forgotten password has to have a
 * way back that is not "email an operator".
 *
 * The design here is deliberately not the one the Kuklabs ERP uses, and the
 * differences are the interesting part.
 *
 * **A long random token, not a six-digit code.** A code exists for places where
 * somebody types it from a phone. This is a web application and the token
 * arrives as a link, so it can be 32 random bytes — and then there is nothing
 * to brute-force, no attempt counter to get right, and no race between two
 * requests both reading `attempts = 4`.
 *
 * **`crypto.randomBytes`, never `Math.random`.** V8's `Math.random` is
 * xorshift128+ and its state is recoverable from a handful of outputs, so a
 * token drawn from it is predictable to anybody who can sample a few. That is
 * not a theoretical objection: it is why this module has no arithmetic in it.
 *
 * **Stored hashed.** The database holds `sha256(token)`. Somebody who reads the
 * table cannot use what they find, which matters because a reset token is a
 * password.
 *
 * **A reset ends every existing session.** People reset a password precisely
 * when they think somebody else has it. Leaving the intruder's session alive is
 * the one thing this flow must not do, and it is the step most implementations
 * miss.
 *
 * **The answer is the same whether or not the address is registered.** Anything
 * else turns the reset form into a way to ask "does this person have an
 * account here", which for a Git host is "does this company use us".
 */

const PURPOSES = Object.freeze(['verify_email', 'password_reset']);

export const TOKEN_LIFETIME_SECONDS = Object.freeze({
  // A day, because a verification link is often opened on a different device
  // and sometimes after the person has gone home.
  verify_email: 24 * 60 * 60,
  // An hour. A reset token is a password, and the window in which a forwarded
  // or logged email is still dangerous should be short.
  password_reset: 60 * 60,
});

/**
 * How often the same address may ask again.
 *
 * Every request sends a real email, so an unthrottled endpoint is a way to
 * bomb somebody's inbox from a form that needs no account.
 *
 * Derived from the tokens table rather than kept in memory. An in-memory
 * limiter forgets everything on deploy, which on an instance that deploys
 * often is a limiter an attacker can simply wait out.
 */
export const RESEND_INTERVAL_SECONDS = 60;

function tableColumns(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
}

export function migrateAccountVerification(db) {
  // Owned here as well as by the AuthKit migration. A column that only exists
  // when another feature happens to have run is a column that is missing on
  // exactly the instance that does not use that feature.
  if (!tableColumns(db, 'users').has('email_verified')) {
    db.exec('ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0');
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS account_tokens (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      purpose TEXT NOT NULL CHECK(purpose IN ('verify_email','password_reset')),
      -- sha256 of the token. The plaintext exists in one email and nowhere else.
      token_hash TEXT NOT NULL UNIQUE,
      -- The address it was sent to, which is not always the account's current
      -- one: a verification token issued for a new address must not verify the
      -- old one if the account is edited in between.
      email TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_account_tokens_user
      ON account_tokens(user_id, purpose, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_account_tokens_expiry
      ON account_tokens(expires_at);
  `);
}

function assertPurpose(purpose) {
  const value = String(purpose ?? '');
  if (!PURPOSES.includes(value)) throw httpError(400, 'Unknown account token purpose.', 'ACCOUNT_TOKEN_PURPOSE_INVALID');
  return value;
}

function sqliteTime(date) {
  return new Date(date).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
}

function parseTime(value) {
  return Date.parse(`${String(value ?? '').replace(' ', 'T')}Z`);
}

/**
 * Whether this address asked too recently.
 *
 * Read from the last token issued rather than a counter, so it survives a
 * restart and cannot be reset by waiting for a deploy.
 */
export function throttledUntil(db, { userId, purpose, now = new Date() }) {
  const last = db.prepare(`
    SELECT created_at AS createdAt FROM account_tokens
    WHERE user_id = ? AND purpose = ? ORDER BY created_at DESC, rowid DESC LIMIT 1
  `).get(userId, purpose);
  if (!last) return null;
  const next = parseTime(last.createdAt) + RESEND_INTERVAL_SECONDS * 1000;
  return next > now.getTime() ? new Date(next) : null;
}

/**
 * Issues a token and returns the plaintext, once.
 *
 * The caller emails it. Nothing else ever sees it again — the row holds only
 * the hash — so a token that is lost is genuinely lost and a new one has to be
 * asked for.
 */
export function issueAccountToken(db, { userId, purpose, email, now = new Date() }) {
  const kind = assertPurpose(purpose);
  const address = normalizeEmail(email);
  // Any outstanding token of the same purpose stops working. Somebody who asks
  // twice should not end up with two live reset links, and the older one is the
  // one more likely to have been intercepted.
  db.prepare('DELETE FROM account_tokens WHERE user_id = ? AND purpose = ?').run(userId, kind);

  const token = randomToken(32);
  db.prepare(`
    INSERT INTO account_tokens (id, user_id, purpose, token_hash, email, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    uid('atk'),
    userId,
    kind,
    hashToken(token),
    address,
    sqliteTime(now.getTime() + TOKEN_LIFETIME_SECONDS[kind] * 1000),
    sqliteTime(now),
  );
  return token;
}

/**
 * Finds and spends a token in one step.
 *
 * Consuming and checking cannot be separated: two requests arriving with the
 * same token would both find it unused, and a reset link that works twice is a
 * reset link somebody can replay out of a mailbox.
 */
export function consumeAccountToken(db, { token, purpose, now = new Date() }) {
  const kind = assertPurpose(purpose);
  const presented = String(token ?? '');
  if (!presented) throw httpError(400, 'This link is not valid. Ask for a new one.', 'ACCOUNT_TOKEN_INVALID');

  const row = db.prepare(`
    SELECT id, user_id AS userId, email, expires_at AS expiresAt, used_at AS usedAt
    FROM account_tokens WHERE token_hash = ? AND purpose = ?
  `).get(hashToken(presented), kind);

  // One message for missing, spent and expired. Which of the three it was is
  // not something the person holding a bad link needs, and it is something
  // somebody guessing links would like.
  const invalid = () => httpError(400, 'This link has expired or has already been used. Ask for a new one.', 'ACCOUNT_TOKEN_INVALID');
  if (!row || row.usedAt) throw invalid();
  if (parseTime(row.expiresAt) <= now.getTime()) throw invalid();

  const spent = db.prepare("UPDATE account_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL")
    .run(sqliteTime(now), row.id);
  if (!spent.changes) throw invalid();

  // Single use is checked twice on purpose, and no test can tell the two apart.
  //
  // `row.usedAt` above is an early-out that saves a pointless write. The `used_at
  // IS NULL` in this statement is the one that is actually load-bearing: it is
  // what makes claiming the token atomic, so two requests arriving with the same
  // link cannot both succeed. Removing either one alone changes nothing
  // observable; removing both lets a reset link be replayed out of a mailbox.
  //
  // They cannot disagree except under a race, and SQLite's synchronous API here
  // cannot produce one in a test. So the tests prove that single use holds, and
  // this comment is why there is no test naming the second check on its own.

  return { userId: row.userId, email: row.email };
}

function findUserByEmail(db, email) {
  return db.prepare(`
    SELECT id, email, display_name AS displayName, password_hash AS passwordHash
    FROM users WHERE email = ?
  `).get(normalizeEmail(email));
}

function baseLink(config, path, token) {
  return `${String(config.baseUrl).replace(/\/$/, '')}/#/${path}?token=${encodeURIComponent(token)}`;
}

/* ------------------------------------------------------------ verification */

export function sendEmailVerification(db, config, { userId, now = new Date() }) {
  const user = db.prepare('SELECT id, email, display_name AS displayName, email_verified AS verified FROM users WHERE id = ?').get(userId);
  if (!user) throw httpError(404, 'Account not found.', 'USER_NOT_FOUND');
  if (user.verified) return { sent: false, reason: 'already verified' };

  const until = throttledUntil(db, { userId, purpose: 'verify_email', now });
  if (until) return { sent: false, reason: 'throttled', retryAfter: until.toISOString() };

  const token = issueAccountToken(db, { userId, purpose: 'verify_email', email: user.email, now });
  const link = baseLink(config, 'verify-email', token);
  queueTransactionalEmail(db, config, {
    userId,
    to: user.email,
    category: 'security',
    subject: 'Confirm your KukGit email address',
    text: `Hello ${user.displayName},\n\n`
      + `Confirm this address to finish setting up your KukGit account:\n\n${link}\n\n`
      + `The link works once and expires in 24 hours.\n\n`
      + `If you did not create a KukGit account, ignore this message — nothing was set up.\n`,
    // One outstanding verification email per token, so a retrying outbox does
    // not send the same link twice.
    dedupeKey: `verify-email:${hashToken(token)}`,
  });
  return { sent: true };
}

export function verifyEmailToken(db, { token, now = new Date() }) {
  const { userId, email } = consumeAccountToken(db, { token, purpose: 'verify_email', now });
  const user = db.prepare('SELECT id, email FROM users WHERE id = ?').get(userId);
  // The address changed after the link was sent. Verifying the *current* one on
  // the strength of a link sent to the *old* one would mark an unproved address
  // as proved.
  if (!user || normalizeEmail(user.email) !== normalizeEmail(email)) {
    throw httpError(400, 'This link was sent to a different address. Ask for a new one.', 'ACCOUNT_TOKEN_ADDRESS_CHANGED');
  }
  db.prepare('UPDATE users SET email_verified = 1 WHERE id = ?').run(userId);
  audit(db, { userId, action: 'account.email_verified', targetType: 'user', targetId: userId, metadata: {} });
  return { userId, email: user.email };
}

/* ---------------------------------------------------------------- reset */

/**
 * Starts a password reset, and says the same thing either way.
 *
 * The return value never distinguishes a registered address from an unknown
 * one. For a Git host that question is "does this company keep its code here",
 * and a form anybody can submit should not answer it.
 */
export function requestPasswordReset(db, config, { email, now = new Date() }) {
  const address = normalizeEmail(email);
  const user = findUserByEmail(db, address);
  const answer = { accepted: true };
  if (!user) return answer;
  // An account with no local password — one managed by Kuklabs Account — has no
  // password here to reset, and issuing a token would give it one.
  if (!String(user.passwordHash ?? '').startsWith('scrypt$')) return answer;
  if (throttledUntil(db, { userId: user.id, purpose: 'password_reset', now })) return answer;

  const token = issueAccountToken(db, { userId: user.id, purpose: 'password_reset', email: address, now });
  const link = baseLink(config, 'reset-password', token);
  queueTransactionalEmail(db, config, {
    userId: user.id,
    to: address,
    category: 'security',
    subject: 'Reset your KukGit password',
    text: `Hello ${user.displayName},\n\n`
      + `Use this link to choose a new KukGit password:\n\n${link}\n\n`
      + `The link works once and expires in one hour. Signing in everywhere else `
      + `will end when the password changes.\n\n`
      + `If you did not ask for this, ignore this message — your password has not changed. `
      + `Somebody knowing your email address is enough to send this, and it does not mean `
      + `anybody has access to your account.\n`,
    dedupeKey: `password-reset:${hashToken(token)}`,
  });
  return answer;
}

/**
 * Finishes a reset.
 *
 * @returns {{userId: string, sessionsEnded: number}}
 */
export function completePasswordReset(db, { token, password, now = new Date() }) {
  const { userId } = consumeAccountToken(db, { token, purpose: 'password_reset', now });
  // Hashed before anything is written, so a password the rules refuse leaves
  // the account exactly as it was — including the token, which has already been
  // spent and cannot be tried again with a better password. That is the right
  // way round: a refused attempt should cost a new link, not leave a live one.
  const hash = hashPassword(password);

  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, userId);
  // Every session, everywhere, including this browser. People reset a password
  // when they think somebody else has it; leaving that session alive is the one
  // thing this must not do.
  const ended = db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  // Any outstanding verification link is dropped too — whoever now controls the
  // password is not necessarily whoever was sent that.
  db.prepare('DELETE FROM account_tokens WHERE user_id = ?').run(userId);

  audit(db, {
    userId,
    action: 'account.password_reset',
    targetType: 'user',
    targetId: userId,
    metadata: { sessionsEnded: ended.changes },
  });
  return { userId, sessionsEnded: ended.changes };
}

/** Housekeeping. A spent or expired token is a row nobody will ever read. */
export function pruneAccountTokens(db, { now = new Date(), retentionDays = 7 } = {}) {
  const cutoff = sqliteTime(now.getTime() - retentionDays * 86_400_000);
  return db.prepare('DELETE FROM account_tokens WHERE expires_at < ? OR (used_at IS NOT NULL AND used_at < ?)')
    .run(cutoff, cutoff).changes;
}
