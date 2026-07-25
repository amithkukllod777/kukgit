import crypto from 'node:crypto';
import { hashToken, normalizeEmail, parseCookies, randomToken, safeEqual, serializeCookie, httpError } from './security.mjs';

const SESSION_SECONDS = 60 * 60 * 24 * 14;

export function hashPassword(password) {
  const value = String(password ?? '');
  if (value.length < 10) throw httpError(400, 'Password must be at least 10 characters.');
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(value, salt, 64);
  return `scrypt$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

export function verifyPassword(password, encoded) {
  try {
    const [scheme, saltRaw, hashRaw] = String(encoded).split('$');
    if (scheme !== 'scrypt') return false;
    const actual = crypto.scryptSync(String(password), Buffer.from(saltRaw, 'base64url'), 64);
    return safeEqual(actual, Buffer.from(hashRaw, 'base64url'));
  } catch {
    return false;
  }
}

export function createSession(db, userId) {
  const token = randomToken();
  const expiresAt = new Date(Date.now() + SESSION_SECONDS * 1000).toISOString();
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(hashToken(token), userId, expiresAt);
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
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies.kukgit_session;
  if (!token) return null;
  const row = db.prepare(`
    SELECT u.id, u.email, u.display_name AS displayName, s.expires_at AS expiresAt
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ?
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

export function authenticate(db, email, password) {
  const normalized = normalizeEmail(email);
  const user = db.prepare('SELECT id, email, display_name AS displayName, password_hash AS passwordHash FROM users WHERE email = ?').get(normalized);
  if (!user || !verifyPassword(password, user.passwordHash)) throw httpError(401, 'Incorrect email or password.', 'INVALID_CREDENTIALS');
  return user;
}
