import { audit, uid } from './db.mjs';
import { httpError, normalizeEmail } from './security.mjs';

/**
 * One person, several ways in.
 *
 * KukGit is about to offer sign-in with GitHub, with Google, and by phone,
 * alongside the email and password it already has. The thing that decides
 * whether that works is not any of those flows — it is this table.
 *
 * Somebody signs up with an email, then next month clicks "Sign in with
 * GitHub". If that makes a second account, their repositories, organizations,
 * tokens and SSH keys are all attached to the first one and they are looking at
 * an empty screen. Untangling two accounts afterwards means moving ownership of
 * other people's work, and it is the kind of migration nobody enjoys twice.
 *
 * So every provider is a *link* to one KukGit user, never a user of its own.
 *
 * ## The rule that matters
 *
 * When somebody arrives from a provider and there is already a KukGit account
 * with the same address, linking them is obviously right — and is also exactly
 * how accounts get stolen.
 *
 * The attack: I sign up here as `you@yourcompany.com` and never prove it. You
 * later sign in with Google, KukGit sees a matching address, links your Google
 * identity to *my* account, and now I am signed into your repositories with the
 * password I chose.
 *
 * So an address only joins two things together when **both sides have proved
 * it**: the local account's `email_verified` is set, and the provider says the
 * address is verified on their side. GitHub and Google both report that, and
 * KukGit reads it rather than assuming it. Anything short of that gets a new
 * account, which is recoverable — a wrongly merged one is not.
 */

export const IDENTITY_PROVIDERS = Object.freeze(['github', 'google', 'phone']);

export function migrateUserIdentities(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_identities (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider TEXT NOT NULL CHECK(provider IN ('github','google','phone')),
      -- The provider's own immutable id, never their username. A GitHub login
      -- can be renamed and then taken by somebody else; the numeric id cannot.
      provider_user_id TEXT NOT NULL,
      -- Kept for display and support, and deliberately not used to match on.
      provider_login TEXT,
      email TEXT,
      linked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_used_at TEXT,
      -- One provider account signs into one KukGit account. Without this, two
      -- KukGit users could both claim the same GitHub identity and which one
      -- you got would depend on row order.
      UNIQUE(provider, provider_user_id)
    );
    -- And one link per provider per user: a person has one GitHub account here,
    -- so "sign in with GitHub" is never ambiguous in the other direction either.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_user_identities_one_per_provider
      ON user_identities(user_id, provider);
  `);
}

function assertProvider(provider) {
  const id = String(provider ?? '').trim().toLowerCase();
  if (!IDENTITY_PROVIDERS.includes(id)) {
    throw httpError(400, `Sign-in provider must be one of ${IDENTITY_PROVIDERS.join(', ')}.`, 'IDENTITY_PROVIDER_INVALID');
  }
  return id;
}

function assertSubject(providerUserId) {
  const id = String(providerUserId ?? '').trim();
  if (!id || id.length > 191) throw httpError(400, 'The sign-in provider did not identify the account.', 'IDENTITY_SUBJECT_INVALID');
  return id;
}

export function identitiesFor(db, userId) {
  return db.prepare(`
    SELECT id, provider, provider_user_id AS providerUserId, provider_login AS providerLogin,
           email, linked_at AS linkedAt, last_used_at AS lastUsedAt
    FROM user_identities WHERE user_id = ? ORDER BY provider
  `).all(userId);
}

export function findIdentity(db, { provider, providerUserId }) {
  return db.prepare(`
    SELECT id, user_id AS userId, provider, provider_user_id AS providerUserId,
           provider_login AS providerLogin, email
    FROM user_identities WHERE provider = ? AND provider_user_id = ?
  `).get(assertProvider(provider), assertSubject(providerUserId)) ?? null;
}

/**
 * Attaches a provider account to a KukGit user that is already known.
 *
 * Used when somebody who is signed in adds a second way to sign in. It is a
 * different operation from arriving *from* a provider, and it is the safe one:
 * the person has already proved who they are here.
 */
export function linkIdentity(db, {
  userId, provider, providerUserId, providerLogin = null, email = null, now = new Date(),
}) {
  const kind = assertProvider(provider);
  const subject = assertSubject(providerUserId);

  const existing = findIdentity(db, { provider: kind, providerUserId: subject });
  if (existing && existing.userId !== userId) {
    throw httpError(409, 'That account is already linked to a different KukGit user.', 'IDENTITY_ALREADY_LINKED');
  }
  const mine = db.prepare('SELECT id FROM user_identities WHERE user_id = ? AND provider = ?').get(userId, kind);
  if (mine && !existing) {
    // They already have a GitHub account linked and this is a different one.
    // Replacing it silently would take away the way they normally sign in.
    throw httpError(409, `This KukGit account already has a ${kind} account linked. Remove it first.`, 'IDENTITY_PROVIDER_TAKEN');
  }
  if (existing) return existing;

  const id = uid('idn');
  db.prepare(`
    INSERT INTO user_identities (id, user_id, provider, provider_user_id, provider_login, email, linked_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, userId, kind, subject, providerLogin ? String(providerLogin).slice(0, 191) : null,
    email ? normalizeEmail(email) : null, now.toISOString());

  audit(db, {
    userId,
    action: 'account.identity_linked',
    targetType: 'user',
    targetId: userId,
    metadata: { provider: kind, login: providerLogin ?? null },
  });
  return findIdentity(db, { provider: kind, providerUserId: subject });
}

/**
 * Removes a way of signing in.
 *
 * Refused when it is the last one and there is no password, because an account
 * nobody can sign into is an account nobody can delete or transfer either.
 */
export function unlinkIdentity(db, { userId, provider }) {
  const kind = assertProvider(provider);
  const user = db.prepare('SELECT password_hash AS passwordHash FROM users WHERE id = ?').get(userId);
  if (!user) throw httpError(404, 'Account not found.', 'USER_NOT_FOUND');

  const links = identitiesFor(db, userId);
  const hasPassword = String(user.passwordHash ?? '').startsWith('scrypt$');
  if (!hasPassword && links.length <= 1) {
    throw httpError(
      409,
      'This is the only way into this account. Set a password first, or link another provider.',
      'IDENTITY_LAST_METHOD',
    );
  }

  const removed = db.prepare('DELETE FROM user_identities WHERE user_id = ? AND provider = ?').run(userId, kind);
  if (!removed.changes) return false;
  audit(db, {
    userId,
    action: 'account.identity_unlinked',
    targetType: 'user',
    targetId: userId,
    metadata: { provider: kind },
  });
  return true;
}

/**
 * Somebody has just come back from a provider. Work out who they are here.
 *
 * @param {object} profile what the provider said — already verified by the
 *   caller against the provider, never taken from the browser
 * @returns {{userId: string, outcome: 'signed-in'|'linked'|'created'}}
 */
export function resolveIdentitySignIn(db, {
  provider,
  providerUserId,
  providerLogin = null,
  email = null,
  emailVerified = false,
  displayName = null,
  now = new Date(),
  createUser,
}) {
  const kind = assertProvider(provider);
  const subject = assertSubject(providerUserId);

  // 1. Seen before. Nothing to decide.
  const known = findIdentity(db, { provider: kind, providerUserId: subject });
  if (known) {
    db.prepare('UPDATE user_identities SET last_used_at = ?, provider_login = ?, email = ? WHERE id = ?')
      .run(now.toISOString(), providerLogin ? String(providerLogin).slice(0, 191) : null,
        email ? normalizeEmail(email) : null, known.id);
    return { userId: known.userId, outcome: 'signed-in' };
  }

  const address = email ? normalizeEmail(email) : null;
  const local = address
    ? db.prepare('SELECT id, email_verified AS verified FROM users WHERE email = ?').get(address)
    : null;

  if (local) {
    // 2. An account with this address exists. Joining them needs *both* sides
    // to have proved the address — see the note at the top of this file. One
    // side alone is how somebody who signed up with your address, and never
    // proved it, ends up owning your account the moment you use Google.
    if (!emailVerified || !local.verified) {
      throw httpError(
        409,
        'An account already uses that email address. Sign in with your password and link this provider from your account settings.',
        'IDENTITY_EMAIL_UNVERIFIED_CONFLICT',
      );
    }
    linkIdentity(db, { userId: local.id, provider: kind, providerUserId: subject, providerLogin, email: address, now });
    db.prepare('UPDATE user_identities SET last_used_at = ? WHERE user_id = ? AND provider = ?')
      .run(now.toISOString(), local.id, kind);
    return { userId: local.id, outcome: 'linked' };
  }

  // 3. Nobody here yet. The caller creates the account, because what a new
  // KukGit user needs — a slug, an organization, a plan — is not this module's
  // business.
  if (typeof createUser !== 'function') throw httpError(500, 'No way to create an account.', 'IDENTITY_CREATE_UNAVAILABLE');
  const userId = createUser({
    email: address,
    emailVerified: Boolean(emailVerified && address),
    displayName: displayName || providerLogin || (address ? address.split('@')[0] : kind),
    provider: kind,
  });
  if (!userId) throw httpError(500, 'The account could not be created.', 'IDENTITY_CREATE_FAILED');

  linkIdentity(db, { userId, provider: kind, providerUserId: subject, providerLogin, email: address, now });
  db.prepare('UPDATE user_identities SET last_used_at = ? WHERE user_id = ? AND provider = ?')
    .run(now.toISOString(), userId, kind);
  return { userId, outcome: 'created' };
}
