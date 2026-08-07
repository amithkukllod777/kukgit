import { hashPassword } from './auth.mjs';
import { audit, uid } from './db.mjs';
import { httpError, normalizeEmail } from './security.mjs';
import { sendEmailVerification } from './account-verification.mjs';
import { queueTransactionalEmail } from './notifications.mjs';

/**
 * Making an account, without an invitation and without an operator.
 *
 * Until now there was no way to do this at all: accounts came from the seed,
 * from an organization invitation, or from a first sign-in with GitHub or
 * Google. An outside developer with an email address and a password had no
 * door. This is the door.
 *
 * ## The answer is the same whichever address you type
 *
 * A signup form that says "that address is taken" is a form anybody can use to
 * ask whether a person has an account here — and for a Git host, that is asking
 * whether a company keeps its code here. So nothing is created for an address
 * that already exists, nothing is refused, and the response is identical either
 * way. What differs is the email: a new address gets a verification link, and an
 * existing one gets a note saying somebody tried to sign up and that they
 * already have an account.
 *
 * That note matters on its own. It is how the real owner of an address learns
 * that somebody is probing it.
 *
 * ## Signing up does not sign you in
 *
 * No session is returned. The account exists, unverified, and the way to use it
 * is the link in the email. This is also what makes the identical-response rule
 * possible: a response carrying a session could only be given to one of the two
 * cases, and which one you got would be the answer.
 *
 * ## What an unverified account may do
 *
 * Sign in, and look around. Not create an organization, and not create a
 * repository — see `signupPendingVerification`. The gate is on
 * `auth_source = 'signup'` rather than on `email_verified` alone, deliberately:
 * accounts that predate this had their address chosen by an operator or a
 * provider, and locking every one of them out to introduce a rule is not a
 * migration, it is an outage.
 *
 * ## It is absent where it cannot work
 *
 * Signup that cannot send a verification email produces accounts nobody can
 * finish setting up, and a form that silently does nothing. Where no mail
 * sender is configured, the route is not there.
 */

const MAX_DISPLAY_NAME = 191;

/**
 * The two columns this depends on, ensured here rather than assumed.
 *
 * Both already exist on an instance that has run the AuthKit migration, and
 * both are meaningless to AuthKit on an instance that never will. Depending on
 * somebody else's migration for a column your own feature reads is how a
 * feature works on the machines where it was written and throws on the rest.
 */
export function migrateSignup(db) {
  const columns = new Set(db.prepare('PRAGMA table_info(users)').all().map((row) => row.name));
  if (!columns.has('email_verified')) db.exec('ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0');
  if (!columns.has('auth_source')) db.exec("ALTER TABLE users ADD COLUMN auth_source TEXT NOT NULL DEFAULT 'local'");
}

export const SIGNUP_SOURCE = 'signup';

/** The one message this endpoint gives, whatever happened. */
export const SIGNUP_ACCEPTED = 'Check your inbox — if that address can be used, a link to finish setting up is on its way.';

function assertEmail(value) {
  const email = normalizeEmail(value ?? '');
  // Deliberately loose. An address is proved by the link arriving, not by a
  // regular expression, and every strict pattern refuses somebody's real
  // address.
  if (!email || !/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(email) || email.length > 191) {
    throw httpError(400, 'That does not look like an email address.', 'SIGNUP_EMAIL_INVALID');
  }
  return email;
}

/**
 * Asked for, not inferred.
 *
 * This used to fall back to the part of the address before the `@`, which is
 * how a repository page fills up with `a.kukllod`, `devops2` and `info` — a
 * display name is what everybody else in an organization sees next to a commit,
 * a review and a pull request, and an address is not one. Somebody who does not
 * want to give their real name can type anything; what they cannot do is skip
 * the question and have the address answer it.
 *
 * Refused before the address is looked up, like every other check here, so the
 * shape of the failure does not depend on whether the account exists.
 */
function assertDisplayName(value) {
  const name = String(value ?? '').trim().replace(/\s+/g, ' ');
  if (!name) throw httpError(400, 'Tell us what to call you.', 'SIGNUP_NAME_REQUIRED');
  if (name.length > MAX_DISPLAY_NAME) throw httpError(400, 'That name is too long.', 'SIGNUP_NAME_INVALID');
  return name;
}

/** Whether this instance can offer signup at all. */
export function signupAvailable(config, { emailConfigured }) {
  return config.authMode === 'local' && Boolean(emailConfigured);
}

/**
 * Whether this account still owes proof of its address.
 *
 * Only self-service signups. An account made by an operator or by a provider
 * sign-in is not waiting on anything.
 */
export function signupPendingVerification(db, userId) {
  // Read the columns first. A database that predates them cannot contain a
  // self-service signup, so the answer is no — and asking for a column that is
  // not there turns a gate into a 500 on every organization anybody creates.
  // That is what happened: the query shipped with `COALESCE`, which handles a
  // null and not a missing column.
  const columns = new Set(db.prepare('PRAGMA table_info(users)').all().map((row) => row.name));
  if (!columns.has('auth_source') || !columns.has('email_verified')) return false;

  const row = db.prepare(`
    SELECT COALESCE(auth_source, 'local') AS authSource, COALESCE(email_verified, 0) AS verified
    FROM users WHERE id = ?
  `).get(userId);
  if (!row) return false;
  return row.authSource === SIGNUP_SOURCE && !row.verified;
}

/** Refuses the things an unproved address must not be able to do. */
export function assertSignupVerified(db, userId, what = 'do that') {
  if (!signupPendingVerification(db, userId)) return;
  throw httpError(
    403,
    `Confirm your email address before you ${what}. The link was sent when you signed up — ask for another from your account settings.`,
    'SIGNUP_VERIFICATION_REQUIRED',
  );
}

/**
 * Tells somebody who already has an account that somebody tried to make another.
 *
 * Sent instead of creating anything. It is the half of the identical-response
 * rule that is not a lie: the caller learns nothing, and the person who owns
 * the address learns something they should know.
 */
function warnExistingAccount(db, config, user) {
  queueTransactionalEmail(db, config, {
    userId: user.id,
    to: user.email,
    category: 'security',
    subject: 'Somebody tried to sign up with your KukGit address',
    text: `Hello ${user.displayName},\n\n`
      + `Somebody just tried to create a KukGit account with this address. You already have one, `
      + `so nothing was created and nothing about your account has changed.\n\n`
      + `If that was you, sign in instead — and use the password reset link on the sign-in page if `
      + `you cannot remember your password.\n\n`
      + `If it was not you, there is nothing you need to do. Knowing an email address is enough to `
      + `trigger this message, and it does not mean anybody has access to anything.\n`,
    // One per attempt per day is enough to be useful and not enough to be a way
    // of mailbombing somebody by submitting a form repeatedly.
    dedupeKey: `signup-exists:${user.id}:${new Date().toISOString().slice(0, 10)}`,
  });
}

/**
 * @returns {{accepted: true}} — the same value for every caller, always.
 */
export function signUp(db, config, { email, password, displayName, now = new Date() }) {
  const address = assertEmail(email);
  const name = assertDisplayName(displayName);
  // Hashed before the address is looked up, so a password the rules refuse is
  // refused whether or not the address exists — otherwise the shape of the
  // failure answers the question this endpoint refuses to answer.
  const passwordHash = hashPassword(password);

  const existing = db.prepare('SELECT id, email, display_name AS displayName FROM users WHERE email = ?').get(address);
  if (existing) {
    warnExistingAccount(db, config, existing);
    return { accepted: true };
  }

  const id = uid('usr');
  const columns = new Set(db.prepare('PRAGMA table_info(users)').all().map((row) => row.name));
  const fields = ['id', 'email', 'password_hash', 'display_name'];
  const values = [id, address, passwordHash, name];
  if (columns.has('email_verified')) { fields.push('email_verified'); values.push(0); }
  if (columns.has('auth_source')) { fields.push('auth_source'); values.push(SIGNUP_SOURCE); }

  try {
    db.prepare(`INSERT INTO users (${fields.join(', ')}) VALUES (${fields.map(() => '?').join(', ')})`).run(...values);
  } catch (error) {
    // Two signups for the same new address in the same instant. The second one
    // gets the same answer as every other caller rather than a 500 that says
    // the address is taken.
    if (/UNIQUE|duplicate key/i.test(String(error.message))) return { accepted: true };
    throw error;
  }

  audit(db, {
    userId: id,
    action: 'account.signed_up',
    targetType: 'user',
    targetId: id,
    metadata: {},
  });
  sendEmailVerification(db, config, { userId: id, now });
  return { accepted: true };
}
