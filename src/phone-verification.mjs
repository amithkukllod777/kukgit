import { audit } from './db.mjs';
import { verifyFirebaseIdToken, phoneFromFirebaseToken } from './firebase-identity.mjs';
import { httpError } from './security.mjs';
import { identitiesFor, linkIdentity } from './user-identities.mjs';

/**
 * Recording that somebody controls a phone number.
 *
 * The SMS is Firebase's. KukGit does not send it, does not see the code, and
 * does not hold a Twilio account — the browser runs the Firebase phone flow and
 * comes back holding an ID token that says "this person answered on +91…".
 *
 * That token is the only thing this file trusts, and it trusts it only after
 * `firebase-identity.mjs` has checked Google's signature on it. The browser is
 * not a source of truth; it is the thing being verified.
 *
 * ## One number, one account
 *
 * A phone number is a recovery route and a second factor, and both of those are
 * worth nothing if two accounts can claim the same number. So the number is
 * unique across users, enforced by an index rather than by a check this code
 * could forget to run.
 *
 * The number is what is unique, **not** the Firebase uid. Those are not the
 * same thing: delete a Firebase account and sign up again with the same number
 * and the uid is new. Uniqueness on the uid would let the same number be
 * attached to a second KukGit account by anybody willing to do that.
 *
 * ## Changing your number is allowed; taking somebody else's is not
 *
 * `linkIdentity` normally refuses to replace an existing link for a provider,
 * because silently swapping the way somebody signs in is how people get locked
 * out. Phone is the exception and it is deliberate: people change numbers, they
 * are signed in when they do it, and they have just proved the new one by
 * answering an SMS on it. What is refused is the number already belonging to
 * *another* account.
 */

const PHONE_PROVIDER = 'phone';

function tableColumns(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
}

export function migratePhoneVerification(db) {
  const columns = tableColumns(db, 'users');
  if (!columns.has('phone')) db.exec('ALTER TABLE users ADD COLUMN phone TEXT');
  if (!columns.has('phone_verified_at')) db.exec('ALTER TABLE users ADD COLUMN phone_verified_at TEXT');
  // Partial, because SQLite counts every NULL as distinct — a plain unique
  // index would allow the duplicate it looks like it prevents only by accident,
  // and would forbid a second account with no number at all on some engines.
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone_unique
      ON users(phone) WHERE phone IS NOT NULL
  `);
}

/** Whether this instance can offer phone verification at all. */
export function phoneVerificationConfigured(config) {
  return Boolean(String(config?.firebaseProjectId ?? '').trim());
}

export function phoneStatus(db, userId) {
  const row = db.prepare('SELECT phone, phone_verified_at AS verifiedAt FROM users WHERE id = ?').get(userId);
  if (!row) throw httpError(404, 'Account not found.', 'USER_NOT_FOUND');
  return { phone: row.phone ?? null, verifiedAt: row.verifiedAt ?? null };
}

/**
 * Verifies a Firebase ID token and records the number against this account.
 *
 * @param {string} userId the person who is signed in — never taken from the
 *   token. The token proves a number, not who is asking.
 */
export async function verifyPhoneWithFirebase(db, config, {
  userId, idToken, now = new Date(), fetchImpl = undefined,
}) {
  if (!phoneVerificationConfigured(config)) {
    throw httpError(404, 'Not found.', 'NOT_FOUND');
  }
  const verified = await verifyFirebaseIdToken(idToken, {
    projectId: config.firebaseProjectId,
    now,
    ...(fetchImpl ? { fetchImpl } : {}),
  });
  const { subject, phoneNumber } = phoneFromFirebaseToken(verified);

  // The index below is the guard that cannot be bypassed; this is the one that
  // does not depend on reading an error message. No test kills this line on its
  // own — the index and the rollback produce the same refusal without it — and
  // it stays because the fallback matches on the wording of a driver error, and
  // SQLite and PostgreSQL word it differently.
  const owner = db.prepare('SELECT id FROM users WHERE phone = ? AND id <> ?').get(phoneNumber, userId);
  if (owner) {
    // Said without confirming anything: the caller learns their attempt failed,
    // not who holds the number.
    throw httpError(409, 'That number is already in use on another account.', 'PHONE_ALREADY_IN_USE');
  }

  const existing = identitiesFor(db, userId).find((identity) => identity.provider === PHONE_PROVIDER);

  // The link and the column are one change. Written separately, a number that
  // the index refuses leaves the `user_identities` row behind — a phone
  // identity pointing at an account whose `phone` is null, which then blocks
  // the person from linking the number they actually hold.
  db.exec('BEGIN IMMEDIATE');
  try {
    if (existing && existing.providerUserId !== subject) {
      // Replacing, not stacking. See the note at the top: people change
      // numbers, this person is signed in, and they have just answered an SMS
      // on the new one. `linkIdentity` would refuse, and refusing here would
      // mean nobody can ever update a number they no longer have.
      db.prepare('DELETE FROM user_identities WHERE user_id = ? AND provider = ?').run(userId, PHONE_PROVIDER);
    }
    linkIdentity(db, {
      userId,
      provider: PHONE_PROVIDER,
      providerUserId: subject,
      providerLogin: phoneNumber,
      now,
    });
    db.prepare('UPDATE users SET phone = ?, phone_verified_at = ? WHERE id = ?')
      .run(phoneNumber, now.toISOString(), userId);
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back by the failure */ }
    // The index is the real guard. The check above races with another request
    // claiming the same number, and losing that race must be the same refusal
    // rather than a 500.
    //
    // No test names this branch on its own: reaching it needs two requests
    // interleaved between the check and the write, and SQLite's synchronous API
    // here cannot produce that. What the tests prove is that the index exists
    // and that a duplicate is refused.
    if (/UNIQUE|duplicate key/i.test(String(error.message))) {
      throw httpError(409, 'That number is already in use on another account.', 'PHONE_ALREADY_IN_USE');
    }
    throw error;
  }

  audit(db, {
    userId,
    action: 'account.phone_verified',
    targetType: 'user',
    targetId: userId,
    // The number is not written into the audit metadata. An audit log is read
    // by more people than the account's owner would expect, and the number is
    // already on the account for anybody who genuinely needs it.
    metadata: { changed: Boolean(existing) },
  });
  return { phone: phoneNumber, verifiedAt: now.toISOString(), changed: Boolean(existing) };
}

/**
 * Removes a verified number.
 *
 * Refused when it is the only way into the account, for the same reason
 * `unlinkIdentity` refuses: an account nobody can sign into is an account
 * nobody can delete or transfer either.
 */
export function removeVerifiedPhone(db, { userId, now = new Date() }) {
  const user = db.prepare('SELECT phone, password_hash AS passwordHash FROM users WHERE id = ?').get(userId);
  if (!user) throw httpError(404, 'Account not found.', 'USER_NOT_FOUND');
  if (!user.phone) return { removed: false };

  const links = identitiesFor(db, userId);
  const hasPassword = String(user.passwordHash ?? '').startsWith('scrypt$');
  const otherProviders = links.filter((identity) => identity.provider !== PHONE_PROVIDER);
  if (!hasPassword && !otherProviders.length) {
    throw httpError(
      409,
      'This is the only way into this account. Set a password first, or link another provider.',
      'IDENTITY_LAST_METHOD',
    );
  }

  db.prepare('DELETE FROM user_identities WHERE user_id = ? AND provider = ?').run(userId, PHONE_PROVIDER);
  db.prepare('UPDATE users SET phone = NULL, phone_verified_at = NULL WHERE id = ?').run(userId);
  audit(db, {
    userId,
    action: 'account.phone_removed',
    targetType: 'user',
    targetId: userId,
    metadata: { at: now.toISOString() },
  });
  return { removed: true };
}
