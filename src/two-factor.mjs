import crypto from 'node:crypto';
import { audit, uid } from './db.mjs';
import { decryptSecretValue, encryptSecretValue } from './secrets-vault.mjs';
import { hashToken, httpError, randomToken, safeEqual } from './security.mjs';
import { migrateTwoFactor } from './two-factor-schema.mjs';

// Re-exported so callers have one place to import from, while the DDL itself
// lives in a file with no imports — see `two-factor-schema.mjs` for why.
export { migrateTwoFactor };

/**
 * Two-factor authentication, and the part everybody builds last.
 *
 * TOTP is the easy half: thirty-second steps, HMAC-SHA1 over the counter, six
 * digits, RFC 6238, about forty lines. The hard half is the day somebody's
 * phone goes in a river.
 *
 * A second factor with no way back is not security, it is a way to lose an
 * account — and for a Git host, losing an account can mean losing the only
 * owner of an organization and every repository in it. So recovery is built
 * here alongside the codes rather than afterwards:
 *
 *   * **Ten recovery codes, shown once, stored hashed.** They are the answer to
 *     a lost phone and they are the reason turning 2FA on is not a gamble. Each
 *     is spent by the DELETE that consumes it, so a code used twice is a code
 *     that fails the second time.
 *   * **They are shown before 2FA is switched on, not after.** Somebody who
 *     closes the tab on a "here are your codes" screen that appeared *after*
 *     enrolment already has an account they cannot recover.
 *   * **Running out is not silent.** The count comes back on every status read
 *     so the account settings screen can say it.
 *
 * ## What this deliberately does not have
 *
 * There is no operator override — no "support can turn 2FA off for you". That
 * is the feature that turns two factors into one: whoever can call support can
 * get in, and the strength of the whole thing becomes the strength of a
 * helpdesk. If somebody loses both their phone and their codes, the account is
 * recovered by the organization's owner removing them and inviting them again,
 * which is a decision with a name attached and an audit entry.
 *
 * ## Enrolment proves the clock before it trusts it
 *
 * A secret is generated, and 2FA is **not** enabled by it. It is enabled by a
 * code from that secret. A device whose clock is wrong, an app that scanned the
 * wrong QR, a copy-paste that lost a character — every one of those produces a
 * working-looking enrolment that locks its owner out at the next sign-in, and
 * every one of them is caught by asking for one code first.
 */

const DIGITS = 6;
const STEP_SECONDS = 30;
/**
 * How far out of step a device may be.
 *
 * One step either side, which is the usual answer: it forgives about a minute
 * of clock drift and costs a factor of three in guessing, against a six-digit
 * code and a rate limit. Wider windows are how people paper over a clock
 * problem they should fix.
 */
const WINDOW_STEPS = 1;
const SECRET_BYTES = 20;
const RECOVERY_CODE_COUNT = 10;
const VAULT_SCOPE = 'user-2fa';

/* ------------------------------------------------------------------- TOTP */

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32[(value << (5 - bits)) & 31];
  return output;
}

export function base32Decode(text) {
  // Padding and spacing are what people paste out of an authenticator app.
  const clean = String(text ?? '').toUpperCase().replace(/[\s=]/g, '');
  if (!clean || /[^A-Z2-7]/.test(clean)) throw httpError(400, 'That is not a valid secret.', 'TOTP_SECRET_INVALID');
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const character of clean) {
    value = (value << 5) | BASE32.indexOf(character);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** The code for one step. Exported because a test that cannot make one proves nothing. */
export function totpCode(secret, step) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.max(0, Math.floor(step))));
  const digest = crypto.createHmac('sha1', secret).update(counter).digest();
  // The offset comes from the digest itself — that is what "dynamic truncation"
  // means, and using a fixed offset instead is the classic wrong TOTP.
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = ((digest[offset] & 0x7f) << 24)
    | ((digest[offset + 1] & 0xff) << 16)
    | ((digest[offset + 2] & 0xff) << 8)
    | (digest[offset + 3] & 0xff);
  return String(binary % 10 ** DIGITS).padStart(DIGITS, '0');
}

export function currentStep(now = new Date()) {
  return Math.floor(now.getTime() / 1000 / STEP_SECONDS);
}

/**
 * Whether a code is right, and which step it was for.
 *
 * Returns the step so the caller can refuse to accept the same one twice.
 * Comparison is constant-time: six digits is a small space, and a comparison
 * that returns early leaks which prefix was right.
 */
export function verifyTotp(secret, code, { now = new Date(), afterStep = null } = {}) {
  const presented = String(code ?? '').replace(/\s/g, '');
  // An early-out rather than a guard: `safeEqual` already refuses a value of
  // the wrong length, so no test can kill this line. It is here so a recovery
  // code — which arrives at the same function — costs one regex instead of
  // three HMACs.
  if (!/^\d{6}$/.test(presented)) return null;
  const step = currentStep(now);
  for (let offset = -WINDOW_STEPS; offset <= WINDOW_STEPS; offset += 1) {
    const candidate = step + offset;
    // A step already used by this account is refused even though the code is
    // arithmetically correct. Without this, anybody who sees a code has thirty
    // seconds to use it too.
    if (afterStep !== null && candidate <= afterStep) continue;
    // Constant-time, and no test can kill it: `===` on two six-digit strings
    // behaves identically. It is here because six digits is a small space and a
    // comparison that returns early tells an attacker which prefix was right.
    if (safeEqual(totpCode(secret, candidate), presented)) return candidate;
  }
  return null;
}

/**
 * The URI an authenticator app scans.
 *
 * The issuer appears twice — in the label and as a parameter — because apps
 * disagree about which one they read, and getting it wrong means every KukGit
 * account in somebody's app is called "KukGit" with no way to tell them apart.
 */
export function otpauthUri({ secret, account, issuer = 'KukGit' }) {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const parameters = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${parameters.toString()}`;
}

/* --------------------------------------------------------- recovery codes */

/**
 * Ten codes, in a shape somebody can read off paper.
 *
 * `crypto.randomBytes`, never `Math.random` — V8's is xorshift128+ and its
 * state is recoverable from a handful of outputs, so codes generated with it
 * are predictable from codes already used.
 *
 * The alphabet excludes the characters people mistype off a printout: no O/0,
 * no I/1/l. A recovery code that fails because of the font it was printed in
 * is a recovery code that does not work.
 */
const RECOVERY_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function generateRecoveryCode() {
  const characters = [];
  // Rejection sampling, so every character is equally likely. `% length` on a
  // byte favours the front of a 31-character alphabet by about 2%.
  while (characters.length < 10) {
    const byte = crypto.randomBytes(1)[0];
    if (byte >= 256 - (256 % RECOVERY_ALPHABET.length)) continue;
    characters.push(RECOVERY_ALPHABET[byte % RECOVERY_ALPHABET.length]);
  }
  return `${characters.slice(0, 5).join('')}-${characters.slice(5).join('')}`;
}

function normalizeRecoveryCode(value) {
  return String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function issueRecoveryCodes(db, userId) {
  db.prepare('DELETE FROM user_recovery_codes WHERE user_id = ?').run(userId);
  const codes = [];
  const insert = db.prepare('INSERT INTO user_recovery_codes (id, user_id, code_hash) VALUES (?, ?, ?)');
  while (codes.length < RECOVERY_CODE_COUNT) {
    const code = generateRecoveryCode();
    if (codes.includes(code)) continue;
    insert.run(uid('rcv'), userId, hashToken(normalizeRecoveryCode(code)));
    codes.push(code);
  }
  return codes;
}

/* ------------------------------------------------------------- enrolment */

export function twoFactorStatus(db, userId) {
  const row = db.prepare('SELECT confirmed_at AS confirmedAt FROM user_two_factor WHERE user_id = ?').get(userId);
  const remaining = db.prepare('SELECT COUNT(*) AS count FROM user_recovery_codes WHERE user_id = ?').get(userId).count;
  return {
    enabled: Boolean(row?.confirmedAt),
    pending: Boolean(row) && !row.confirmedAt,
    // Said out loud so a screen can warn before the last one is spent, rather
    // than after.
    recoveryCodesRemaining: Number(remaining),
  };
}

export function twoFactorEnabled(db, userId) {
  return twoFactorStatus(db, userId).enabled;
}

/**
 * Starts enrolment. Does **not** turn anything on.
 *
 * Returns the secret and the recovery codes, both shown once. The codes come
 * now rather than after confirmation on purpose: somebody who closes the tab on
 * a screen shown afterwards has an account they cannot recover, and the codes
 * are useless until 2FA is actually on anyway.
 */
export function beginTwoFactorEnrolment(db, config, { userId, account, now = new Date() }) {
  const existing = db.prepare('SELECT confirmed_at AS confirmedAt FROM user_two_factor WHERE user_id = ?').get(userId);
  if (existing?.confirmedAt) {
    throw httpError(409, 'Two-factor authentication is already on for this account.', 'TWO_FACTOR_ALREADY_ON');
  }

  const secret = crypto.randomBytes(SECRET_BYTES);
  const encoded = base32Encode(secret);
  db.prepare(`
    INSERT INTO user_two_factor (user_id, secret_ciphertext, confirmed_at, last_step, created_at)
    VALUES (?, ?, NULL, NULL, ?)
    ON CONFLICT(user_id) DO UPDATE SET secret_ciphertext = excluded.secret_ciphertext,
      confirmed_at = NULL, last_step = NULL, created_at = excluded.created_at
  `).run(
    userId,
    encryptSecretValue(config, encoded, { scope: VAULT_SCOPE, scopeId: userId, name: 'totp' }),
    now.toISOString(),
  );
  const recoveryCodes = issueRecoveryCodes(db, userId);

  return {
    secret: encoded,
    otpauthUri: otpauthUri({ secret: encoded, account }),
    recoveryCodes,
  };
}

function loadSecret(db, config, userId) {
  const row = db.prepare('SELECT secret_ciphertext AS ciphertext, confirmed_at AS confirmedAt, last_step AS lastStep FROM user_two_factor WHERE user_id = ?').get(userId);
  if (!row) return null;
  return {
    secret: base32Decode(decryptSecretValue(config, row.ciphertext, { scope: VAULT_SCOPE, scopeId: userId, name: 'totp' })),
    confirmedAt: row.confirmedAt,
    lastStep: row.lastStep === null || row.lastStep === undefined ? null : Number(row.lastStep),
  };
}

/**
 * Turns it on, on the strength of one working code.
 *
 * The code is what proves the app has the right secret and the device's clock
 * agrees with this server. Enabling without it produces an enrolment that looks
 * fine and locks its owner out at the next sign-in.
 */
export function confirmTwoFactorEnrolment(db, config, { userId, code, now = new Date() }) {
  const record = loadSecret(db, config, userId);
  if (!record) throw httpError(404, 'Start setting up two-factor authentication first.', 'TWO_FACTOR_NOT_STARTED');
  if (record.confirmedAt) throw httpError(409, 'Two-factor authentication is already on for this account.', 'TWO_FACTOR_ALREADY_ON');

  const step = verifyTotp(record.secret, code, { now });
  if (step === null) throw httpError(400, 'That code is not right. Check your authenticator app and try again.', 'TWO_FACTOR_CODE_INVALID');

  db.prepare('UPDATE user_two_factor SET confirmed_at = ?, last_step = ? WHERE user_id = ?')
    .run(now.toISOString(), step, userId);
  audit(db, { userId, action: 'account.two_factor_enabled', targetType: 'user', targetId: userId, metadata: {} });
  return twoFactorStatus(db, userId);
}

/**
 * Checks a code at sign-in, or a recovery code instead.
 *
 * @returns {{method: 'totp'|'recovery', recoveryCodesRemaining: number}}
 */
export function verifyTwoFactor(db, config, { userId, code, now = new Date() }) {
  const record = loadSecret(db, config, userId);
  if (!record?.confirmedAt) throw httpError(400, 'Two-factor authentication is not on for this account.', 'TWO_FACTOR_NOT_ENABLED');

  const step = verifyTotp(record.secret, code, { now, afterStep: record.lastStep });
  if (step !== null) {
    db.prepare('UPDATE user_two_factor SET last_step = ? WHERE user_id = ?').run(step, userId);
    return { method: 'totp', recoveryCodesRemaining: twoFactorStatus(db, userId).recoveryCodesRemaining };
  }

  // Not a code — perhaps a recovery code. Spent by the delete, so one that
  // works works exactly once.
  const normalized = normalizeRecoveryCode(code);
  if (normalized.length >= 8) {
    const spent = db.prepare('DELETE FROM user_recovery_codes WHERE user_id = ? AND code_hash = ?')
      .run(userId, hashToken(normalized));
    if (spent.changes) {
      const remaining = twoFactorStatus(db, userId).recoveryCodesRemaining;
      audit(db, {
        userId,
        action: 'account.two_factor_recovery_used',
        targetType: 'user',
        targetId: userId,
        // Worth an audit entry on its own: a recovery code being used is either
        // somebody who lost a phone or somebody who found a printout.
        metadata: { remaining },
      });
      return { method: 'recovery', recoveryCodesRemaining: remaining };
    }
  }

  throw httpError(401, 'That code is not right.', 'TWO_FACTOR_CODE_INVALID');
}

/** A fresh set, which invalidates every code printed before. */
export function regenerateRecoveryCodes(db, { userId }) {
  if (!twoFactorEnabled(db, userId)) {
    throw httpError(400, 'Two-factor authentication is not on for this account.', 'TWO_FACTOR_NOT_ENABLED');
  }
  const codes = issueRecoveryCodes(db, userId);
  audit(db, { userId, action: 'account.recovery_codes_regenerated', targetType: 'user', targetId: userId, metadata: {} });
  return codes;
}

/**
 * Turns it off, on the strength of a current code.
 *
 * Requiring the code is the point. A session is enough to do most things; it is
 * not enough to remove the thing that protects the account when a session is
 * what got stolen. A recovery code works here too — somebody whose phone is
 * gone must be able to turn it off and set it up again.
 */
export function disableTwoFactor(db, config, { userId, code, now = new Date() }) {
  verifyTwoFactor(db, config, { userId, code, now });
  db.prepare('DELETE FROM user_two_factor WHERE user_id = ?').run(userId);
  db.prepare('DELETE FROM user_recovery_codes WHERE user_id = ?').run(userId);
  audit(db, { userId, action: 'account.two_factor_disabled', targetType: 'user', targetId: userId, metadata: {} });
  return { enabled: false };
}

/* ------------------------------------------------------------ the sign-in gap */

/**
 * How long somebody has to reach their phone.
 *
 * Five minutes. Long enough to find an app and read six digits, short enough
 * that a challenge left in a closed laptop is not a way in tomorrow.
 */
export const CHALLENGE_SECONDS = 5 * 60;

/**
 * Issued when the password was right and the second factor is still owed.
 *
 * Carries no privileges of its own: it is a name for "somebody proved this
 * account's password five minutes ago" and nothing else. Stored hashed, like
 * every other credential here, because a challenge readable in the database is
 * a sign-in somebody can finish.
 */
export function startTwoFactorChallenge(db, { userId, now = new Date() }) {
  const token = randomToken(32);
  db.prepare('DELETE FROM two_factor_challenges WHERE expires_at < ?').run(now.toISOString());
  db.prepare('INSERT INTO two_factor_challenges (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
    .run(hashToken(token), userId, new Date(now.getTime() + CHALLENGE_SECONDS * 1000).toISOString());
  return token;
}

/**
 * Spends a challenge, exactly once.
 *
 * The delete is the check. Read-then-delete leaves a window in which the same
 * challenge finishes two sign-ins.
 */
export function claimTwoFactorChallenge(db, { token, now = new Date() }) {
  const invalid = () => httpError(401, 'This sign-in has expired. Start again.', 'TWO_FACTOR_CHALLENGE_INVALID');
  const presented = String(token ?? '');
  if (!presented) throw invalid();
  const hash = hashToken(presented);
  const row = db.prepare('SELECT user_id AS userId, expires_at AS expiresAt FROM two_factor_challenges WHERE token_hash = ?').get(hash);
  const removed = db.prepare('DELETE FROM two_factor_challenges WHERE token_hash = ?').run(hash);
  if (!row || !removed.changes) throw invalid();
  if (Date.parse(row.expiresAt) <= now.getTime()) throw invalid();
  return row.userId;
}
