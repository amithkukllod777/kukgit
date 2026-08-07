import crypto from 'node:crypto';
import { currentRequestIdentity } from './identity-context.mjs';
import { hashToken, normalizeEmail, parseCookies, randomToken, safeEqual, serializeCookie, httpError } from './security.mjs';

const SESSION_SECONDS = 60 * 60 * 24 * 14;
const schemaCache = new WeakMap();

function authSchema(db) {
  let cached = schemaCache.get(db);
  if (cached) return cached;
  const sessionColumns = new Set(db.prepare('PRAGMA table_info(sessions)').all().map((row) => row.name));
  const userColumns = new Set(db.prepare('PRAGMA table_info(users)').all().map((row) => row.name));
  cached = {
    sessionAuthMode: sessionColumns.has('auth_mode'),
    userAuthSource: userColumns.has('auth_source'),
  };
  schemaCache.set(db, cached);
  return cached;
}

/**
 * What a password costs to guess.
 *
 * `N` doubles the memory *and* the time; `r` sets how much memory each unit is.
 * At r=8 the working set is `128 * N * r` bytes — 32 MB here — and the whole
 * point of scrypt is that memory is what makes a GPU farm expensive.
 *
 * 32768 rather than Node's default 16384: twice the memory hardness for about a
 * quarter more time (233 ms against 188 ms on the machine this was measured on).
 * 65536 was measured too and is 480 ms and 64 MB per hash, which is too much to
 * spend on a login endpoint that several people can hit at once.
 *
 * `maxmem` has to be passed explicitly. Node's default ceiling is 32 MB and this
 * working set is 33.5 MB, so without it every hash throws — which is exactly the
 * kind of thing that looks like "logins are broken" in production and nothing at
 * all in a test.
 */
export const PASSWORD_COST = Object.freeze({ N: 32768, r: 8, p: 1 });
const KEY_BYTES = 64;

// What the first version of this used: Node's defaults, with nothing recorded.
const LEGACY_COST = Object.freeze({ N: 16384, r: 8, p: 1 });

function scryptOptions({ N, r, p }) {
  return { N, r, p, maxmem: 256 * N * r };
}

function derive(password, salt, cost) {
  return crypto.scryptSync(String(password), salt, KEY_BYTES, scryptOptions(cost));
}

/**
 * Splits a stored record into its parameters.
 *
 * The original format was `scrypt$salt$hash` — the cost was whatever Node
 * happened to default to, and nothing wrote it down. That means raising the
 * cost would have made every existing password unverifiable, so the parameters
 * are recorded now and a record without them is read as the old defaults.
 */
function decodePassword(encoded) {
  const parts = String(encoded ?? '').split('$');
  if (parts[0] !== 'scrypt') return null;
  if (parts.length === 3) return { cost: LEGACY_COST, salt: parts[1], hash: parts[2], legacy: true };
  if (parts.length === 4) {
    const cost = {};
    for (const pair of parts[1].split(',')) {
      const [key, value] = pair.split('=');
      cost[key] = Number(value);
    }
    if (![cost.N, cost.r, cost.p].every((value) => Number.isInteger(value) && value > 0)) return null;
    return { cost, salt: parts[2], hash: parts[3], legacy: false };
  }
  return null;
}

export function hashPassword(password) {
  const value = String(password ?? '');
  if (value.length < 10) throw httpError(400, 'Password must be at least 10 characters.');
  const salt = crypto.randomBytes(16);
  const hash = derive(value, salt, PASSWORD_COST);
  const { N, r, p } = PASSWORD_COST;
  return `scrypt$N=${N},r=${r},p=${p}$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

export function verifyPassword(password, encoded) {
  try {
    const record = decodePassword(encoded);
    if (!record) return false;
    const actual = derive(password, Buffer.from(record.salt, 'base64url'), record.cost);
    return safeEqual(actual, Buffer.from(record.hash, 'base64url'));
  } catch {
    return false;
  }
}

/**
 * Whether a stored password should be written again at the current cost.
 *
 * Raising the cost only protects people who sign in afterwards, and only if
 * something actually rewrites their record. A cost that goes up and never
 * reaches an existing account is a change to the documentation.
 */
export function passwordNeedsRehash(encoded) {
  const record = decodePassword(encoded);
  if (!record) return false;
  return record.legacy
    || record.cost.N < PASSWORD_COST.N
    || record.cost.r < PASSWORD_COST.r
    || record.cost.p < PASSWORD_COST.p;
}

export function createSession(db, userId) {
  const token = randomToken();
  const expiresAt = new Date(Date.now() + SESSION_SECONDS * 1000).toISOString();
  if (authSchema(db).sessionAuthMode) {
    db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at, auth_mode) VALUES (?, ?, ?, 'local')")
      .run(hashToken(token), userId, expiresAt);
  } else {
    db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(hashToken(token), userId, expiresAt);
  }
  return { token, expiresAt };
}

export function destroySession(db, req) {
  const token = parseCookies(req.headers.cookie).kukgit_session;
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
}

export function sessionCookie(token, secure) {
  return serializeCookie('kukgit_session', token, { maxAge: SESSION_SECONDS, secure });
}

export function clearSessionCookie(secure) {
  return serializeCookie('kukgit_session', '', { maxAge: 0, secure });
}

export function currentUser(db, req) {
  const requestIdentity = currentRequestIdentity();
  if (requestIdentity?.resolved) return requestIdentity.user;

  const cookies = parseCookies(req.headers.cookie);
  const token = cookies.kukgit_session;
  if (!token) return null;
  const authModeCondition = authSchema(db).sessionAuthMode ? "AND s.auth_mode = 'local'" : '';
  const row = db.prepare(`
    SELECT u.id, u.email, u.display_name AS displayName, s.expires_at AS expiresAt
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? ${authModeCondition}
  `).get(hashToken(token));
  if (!row) return null;
  if (new Date(row.expiresAt).getTime() <= Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
    return null;
  }
  return row;
}

export function requireUser(db, req) {
  const user = currentUser(db, req);
  if (!user) throw httpError(401, 'Sign in to continue.', 'AUTH_REQUIRED');
  return user;
}

/**
 * The sources whose passwords KukGit itself holds.
 *
 * A list rather than `=== 'local'`, and a list rather than `!== 'authkit'`. The
 * check exists because an AuthKit-managed account has a sentinel where its hash
 * should be, so checking a password against it is meaningless — but written as
 * "must be local" it also refused self-service signups, which do have a real
 * hash here. That bug shipped as far as a test.
 *
 * Fail-closed is kept: a source nobody has added to this list cannot sign in
 * with a password, which is the right answer for a value this code has never
 * seen.
 */
const LOCAL_PASSWORD_SOURCES = new Set(['local', 'signup']);

export function authenticate(db, email, password) {
  const normalized = normalizeEmail(email);
  const authSourceColumn = authSchema(db).userAuthSource ? ', auth_source AS authSource' : '';
  const user = db.prepare(`
    SELECT id, email, display_name AS displayName, password_hash AS passwordHash${authSourceColumn}
    FROM users WHERE email = ?
  `).get(normalized);
  if (!user || (user.authSource && !LOCAL_PASSWORD_SOURCES.has(user.authSource)) || !verifyPassword(password, user.passwordHash)) {
    throw httpError(401, 'Incorrect email or password.', 'INVALID_CREDENTIALS');
  }
  // Signing in is the only moment the plaintext is available, so it is the only
  // moment an old record can be rewritten at the current cost. Nobody is asked
  // to do anything and nothing about the session changes.
  if (passwordNeedsRehash(user.passwordHash)) {
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), user.id);
  }
  return user;
}
