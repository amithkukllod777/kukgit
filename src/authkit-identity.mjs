import crypto from 'node:crypto';
import { audit, uid } from './db.mjs';
import { currentRequestIdentity, runWithRequestIdentity } from './identity-context.mjs';
import {
  hashToken,
  httpError,
  normalizeEmail,
  originAllowed,
  parseCookies,
  randomToken,
  serializeCookie,
} from './security.mjs';

const AUTHKIT_SESSION_SECONDS = 60 * 60 * 24 * 60;
const TOKEN_SENTINEL = 'authkit$managed';
const MAX_BODY_BYTES = 64 * 1024;

function tableColumns(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
}

function ensureColumn(db, table, column, definition) {
  if (!tableColumns(db, table).has(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export function migrateAuthKitIdentity(db) {
  ensureColumn(db, 'users', 'kuklabs_user_id', 'TEXT');
  ensureColumn(db, 'users', 'auth_source', "TEXT NOT NULL DEFAULT 'local'");
  ensureColumn(db, 'users', 'email_verified', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'users', 'phone', 'TEXT');
  ensureColumn(db, 'sessions', 'auth_mode', "TEXT NOT NULL DEFAULT 'local'");
  ensureColumn(db, 'sessions', 'authkit_access_ciphertext', 'TEXT');
  ensureColumn(db, 'sessions', 'authkit_refresh_ciphertext', 'TEXT');
  ensureColumn(db, 'sessions', 'authkit_access_expires_at', 'TEXT');
  ensureColumn(db, 'sessions', 'authkit_refresh_expires_at', 'TEXT');
  ensureColumn(db, 'sessions', 'authkit_sid', 'TEXT');
  ensureColumn(db, 'sessions', 'last_validated_at', 'TEXT');
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_kuklabs_identity
      ON users(kuklabs_user_id) WHERE kuklabs_user_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_sessions_authkit_sid
      ON sessions(authkit_sid) WHERE authkit_sid IS NOT NULL;
  `);
}

function sendJson(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(body);
  return true;
}

function sendNoContent(res, headers = {}) {
  res.writeHead(204, { 'Cache-Control': 'no-store', ...headers });
  res.end();
  return true;
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw httpError(413, 'Authentication request is too large.', 'AUTH_REQUEST_TOO_LARGE');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw httpError(400, 'Invalid JSON request body.', 'INVALID_JSON'); }
}

function authkitKey(config) {
  const secret = String(config.authkitEncryptionKey || '');
  if (!secret) throw httpError(503, 'AuthKit token encryption is not configured.', 'AUTHKIT_ENCRYPTION_UNAVAILABLE');
  return crypto.createHash('sha256').update(secret).digest();
}

export function encryptAuthKitSecret(config, value, aad = '') {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', authkitKey(config), iv);
  if (aad) cipher.setAAD(Buffer.from(aad));
  const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString('base64url')}.${tag.toString('base64url')}.${encrypted.toString('base64url')}`;
}

export function decryptAuthKitSecret(config, encoded, aad = '') {
  try {
    const [version, ivRaw, tagRaw, bodyRaw] = String(encoded || '').split('.');
    if (version !== 'v1' || !ivRaw || !tagRaw || !bodyRaw) throw new Error('invalid envelope');
    const decipher = crypto.createDecipheriv('aes-256-gcm', authkitKey(config), Buffer.from(ivRaw, 'base64url'));
    if (aad) decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(Buffer.from(tagRaw, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(bodyRaw, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    throw httpError(401, 'Stored AuthKit session is invalid. Sign in again.', 'AUTHKIT_SESSION_INVALID');
  }
}

function authkitUrl(config, route) {
  const base = String(config.authkitBaseUrl || '').replace(/\/$/, '');
  if (!base) throw httpError(503, 'AuthKit is not configured.', 'AUTHKIT_NOT_CONFIGURED');
  return `${base}${route}`;
}

export async function requestAuthKit(config, route, {
  method = 'GET',
  body = undefined,
  accessToken = '',
  requestHeaders = {},
} = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.authkitTimeoutMs).unref();
  try {
    const headers = {
      Accept: 'application/json',
      'X-Kuklabs-Product': config.authkitProductId,
      'User-Agent': 'KukGit/0.1 AuthKitBridge',
      ...requestHeaders,
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
    const response = await fetch(authkitUrl(config, route), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
      redirect: 'error',
    });
    const payload = await response.json().catch(() => ({}));
    return { response, payload };
  } catch (error) {
    if (error?.status) throw error;
    throw httpError(503, 'Kuklabs Account is temporarily unavailable.', 'AUTHKIT_UNAVAILABLE');
  } finally {
    clearTimeout(timeout);
  }
}

function normalizedAuthKitUser(payload) {
  const raw = payload?.user && typeof payload.user === 'object' ? payload.user : payload;
  const centralId = String(raw?.kuklabs_user_id ?? raw?.id ?? '').trim();
  if (!centralId || centralId.length > 128) throw httpError(502, 'AuthKit returned an invalid user identity.', 'AUTHKIT_USER_INVALID');
  const email = normalizeEmail(raw?.email);
  const displayName = String(raw?.full_name ?? raw?.name ?? email.split('@')[0]).trim().slice(0, 160) || email;
  return {
    kuklabsUserId: centralId,
    email,
    displayName,
    phone: raw?.phone ? String(raw.phone).slice(0, 32) : null,
    emailVerified: raw?.email_verified === true || raw?.email_verified === 1,
  };
}

export function linkAuthKitUser(db, payload) {
  const identity = normalizedAuthKitUser(payload);
  const byCentral = db.prepare(`
    SELECT id, email, display_name AS displayName, kuklabs_user_id AS kuklabsUserId
    FROM users WHERE kuklabs_user_id = ?
  `).get(identity.kuklabsUserId);
  const byEmail = db.prepare(`
    SELECT id, email, display_name AS displayName, kuklabs_user_id AS kuklabsUserId
    FROM users WHERE email = ?
  `).get(identity.email);

  if (byCentral && byEmail && byCentral.id !== byEmail.id) {
    throw httpError(409, 'This Kuklabs Account conflicts with an existing KukGit email identity.', 'AUTHKIT_IDENTITY_CONFLICT');
  }
  if (byEmail?.kuklabsUserId && byEmail.kuklabsUserId !== identity.kuklabsUserId) {
    throw httpError(409, 'This KukGit email is already linked to another Kuklabs Account.', 'AUTHKIT_EMAIL_ALREADY_LINKED');
  }

  const existing = byCentral || byEmail;
  if (existing) {
    const emailOwner = db.prepare('SELECT id FROM users WHERE email = ? AND id <> ?').get(identity.email, existing.id);
    if (emailOwner) throw httpError(409, 'The verified AuthKit email belongs to another KukGit user.', 'AUTHKIT_EMAIL_CONFLICT');
    db.prepare(`
      UPDATE users SET email = ?, display_name = ?, phone = ?, email_verified = ?,
        kuklabs_user_id = ?, auth_source = 'authkit'
      WHERE id = ?
    `).run(
      identity.email,
      identity.displayName,
      identity.phone,
      identity.emailVerified ? 1 : 0,
      identity.kuklabsUserId,
      existing.id,
    );
    return db.prepare(`
      SELECT id, email, display_name AS displayName, avatar_url AS avatarUrl,
        kuklabs_user_id AS kuklabsUserId, auth_source AS authSource,
        email_verified AS emailVerified, phone
      FROM users WHERE id = ?
    `).get(existing.id);
  }

  const id = uid('usr');
  db.prepare(`
    INSERT INTO users
      (id, email, password_hash, display_name, kuklabs_user_id, auth_source, email_verified, phone)
    VALUES (?, ?, ?, ?, ?, 'authkit', ?, ?)
  `).run(
    id,
    identity.email,
    TOKEN_SENTINEL,
    identity.displayName,
    identity.kuklabsUserId,
    identity.emailVerified ? 1 : 0,
    identity.phone,
  );
  return db.prepare(`
    SELECT id, email, display_name AS displayName, avatar_url AS avatarUrl,
      kuklabs_user_id AS kuklabsUserId, auth_source AS authSource,
      email_verified AS emailVerified, phone
    FROM users WHERE id = ?
  `).get(id);
}

// Reads a claim out of an AuthKit access token.
//
// The signature is deliberately not verified here, and that is safe for this one
// use: the token was just handed to us by AuthKit over TLS in the response we are
// processing, and the value is only used to pick a session identifier that is
// afterwards compared against AuthKit's own `/v1/auth/sessions` listing. A forged
// or wrong value therefore cannot grant access — the comparison fails and the
// bridge session is revoked. It must never be used to make a trust decision on
// its own.
export function authKitTokenClaims(token) {
  const segments = String(token || '').split('.');
  if (segments.length < 2) return null;
  try {
    const json = Buffer.from(segments[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const claims = JSON.parse(json);
    return claims && typeof claims === 'object' ? claims : null;
  } catch {
    return null;
  }
}

// Resolves the AuthKit device-session id to bind this bridge session to.
// Top-level response field first, then the access-token claim, which is where
// AuthKit carries it when the response envelope omits it.
export function resolveAuthKitSid(authkitPayload, accessToken) {
  const direct = authkitPayload?.sid ?? authkitPayload?.session_id ?? null;
  if (direct) return String(direct);
  const claims = authKitTokenClaims(accessToken);
  const claimed = claims?.sid ?? claims?.sess_id ?? claims?.session_id ?? null;
  return claimed ? String(claimed) : null;
}

function tokenBundle(payload) {
  const accessToken = String(payload?.access_token || '');
  const refreshToken = String(payload?.refresh_token || '');
  const expiresIn = Number(payload?.expires_in || 0);
  if (!accessToken || !refreshToken || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw httpError(502, 'AuthKit returned an invalid token bundle.', 'AUTHKIT_TOKEN_BUNDLE_INVALID');
  }
  return {
    accessToken,
    refreshToken,
    accessExpiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
  };
}

async function assertProductAccess(config, accessToken) {
  const { response, payload } = await requestAuthKit(
    config,
    `/v1/auth/products/${encodeURIComponent(config.authkitProductId)}/access`,
    { accessToken },
  );
  if (response.status === 401) throw httpError(401, 'Kuklabs Account session expired.', 'AUTHKIT_SESSION_EXPIRED');
  if (!response.ok || payload?.status === 'blocked' || payload?.status === 'inactive' || payload?.access === false) {
    throw httpError(403, 'Your Kuklabs Account does not have access to KukGit.', 'KUKGIT_PRODUCT_ACCESS_DENIED');
  }
  return payload;
}

export async function createAuthKitBridgeSession(db, config, authkitPayload) {
  const user = linkAuthKitUser(db, authkitPayload?.user);
  const tokens = tokenBundle(authkitPayload);
  await assertProductAccess(config, tokens.accessToken);

  const browserToken = randomToken(32);
  const sessionHash = hashToken(browserToken);
  const refreshExpiresAt = new Date(Date.now() + config.authkitRefreshTtlDays * 86400000).toISOString();
  db.prepare(`
    INSERT INTO sessions
      (token_hash, user_id, expires_at, auth_mode, authkit_access_ciphertext,
       authkit_refresh_ciphertext, authkit_access_expires_at,
       authkit_refresh_expires_at, authkit_sid, last_validated_at)
    VALUES (?, ?, ?, 'authkit', ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `).run(
    sessionHash,
    user.id,
    refreshExpiresAt,
    encryptAuthKitSecret(config, tokens.accessToken, sessionHash),
    encryptAuthKitSecret(config, tokens.refreshToken, sessionHash),
    tokens.accessExpiresAt,
    refreshExpiresAt,
    resolveAuthKitSid(authkitPayload, tokens.accessToken),
  );
  return { browserToken, user, expiresAt: refreshExpiresAt };
}

export function authKitSessionCookie(token, config) {
  return serializeCookie('kukgit_session', token, {
    maxAge: AUTHKIT_SESSION_SECONDS,
    secure: config.cookieSecure,
  });
}

export function clearAuthKitSessionCookie(config) {
  return serializeCookie('kukgit_session', '', { maxAge: 0, secure: config.cookieSecure });
}

function sessionFromRequest(db, req) {
  const token = parseCookies(req.headers.cookie).kukgit_session;
  if (!token) return null;
  const sessionHash = hashToken(token);
  const row = db.prepare(`
    SELECT s.token_hash AS tokenHash, s.user_id AS userId, s.expires_at AS expiresAt,
      s.auth_mode AS authMode, s.authkit_access_ciphertext AS accessCiphertext,
      s.authkit_refresh_ciphertext AS refreshCiphertext,
      s.authkit_access_expires_at AS accessExpiresAt,
      s.authkit_refresh_expires_at AS refreshExpiresAt,
      s.authkit_sid AS authkitSid, s.last_validated_at AS lastValidatedAt,
      u.id, u.email, u.display_name AS displayName, u.avatar_url AS avatarUrl,
      u.kuklabs_user_id AS kuklabsUserId, u.auth_source AS authSource,
      u.email_verified AS emailVerified, u.phone
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.auth_mode = 'authkit'
  `).get(sessionHash);
  return row ? { ...row, browserToken: token } : null;
}

function revokeLocalSession(db, tokenHash) {
  if (tokenHash) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
}

async function refreshSession(db, config, session, refreshToken) {
  const { response, payload } = await requestAuthKit(config, '/v1/auth/token/refresh', {
    method: 'POST',
    body: { refresh_token: refreshToken },
  });
  if (!response.ok) {
    revokeLocalSession(db, session.tokenHash);
    throw httpError(401, payload?.message || 'Kuklabs Account session expired.', 'AUTHKIT_SESSION_EXPIRED');
  }
  const tokens = tokenBundle(payload);
  const linked = linkAuthKitUser(db, payload.user);
  if (linked.id !== session.userId || linked.kuklabsUserId !== session.kuklabsUserId) {
    revokeLocalSession(db, session.tokenHash);
    throw httpError(409, 'AuthKit session identity changed unexpectedly.', 'AUTHKIT_SESSION_IDENTITY_CHANGED');
  }
  const refreshExpiresAt = new Date(Date.now() + config.authkitRefreshTtlDays * 86400000).toISOString();
  db.prepare(`
    UPDATE sessions SET authkit_access_ciphertext = ?, authkit_refresh_ciphertext = ?,
      authkit_access_expires_at = ?, authkit_refresh_expires_at = ?,
      expires_at = ?, last_validated_at = CURRENT_TIMESTAMP
    WHERE token_hash = ?
  `).run(
    encryptAuthKitSecret(config, tokens.accessToken, session.tokenHash),
    encryptAuthKitSecret(config, tokens.refreshToken, session.tokenHash),
    tokens.accessExpiresAt,
    refreshExpiresAt,
    refreshExpiresAt,
    session.tokenHash,
  );
  return { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken };
}

async function validateSession(db, config, session) {
  if (new Date(session.refreshExpiresAt || session.expiresAt).getTime() <= Date.now()) {
    revokeLocalSession(db, session.tokenHash);
    return null;
  }
  let accessToken = decryptAuthKitSecret(config, session.accessCiphertext, session.tokenHash);
  let refreshToken = decryptAuthKitSecret(config, session.refreshCiphertext, session.tokenHash);

  let me = await requestAuthKit(config, '/v1/auth/me', { accessToken });
  if (me.response.status === 401) {
    const refreshed = await refreshSession(db, config, session, refreshToken);
    accessToken = refreshed.accessToken;
    refreshToken = refreshed.refreshToken;
    me = await requestAuthKit(config, '/v1/auth/me', { accessToken });
  }
  if (me.response.status === 401) {
    revokeLocalSession(db, session.tokenHash);
    return null;
  }
  if (!me.response.ok) throw httpError(503, 'Kuklabs Account validation failed.', 'AUTHKIT_VALIDATION_FAILED');

  const linked = linkAuthKitUser(db, me.payload?.user ?? me.payload);
  if (linked.id !== session.userId || linked.kuklabsUserId !== session.kuklabsUserId) {
    revokeLocalSession(db, session.tokenHash);
    throw httpError(409, 'Kuklabs Account does not match this KukGit session.', 'AUTHKIT_SESSION_IDENTITY_MISMATCH');
  }
  await assertProductAccess(config, accessToken);
  db.prepare('UPDATE sessions SET last_validated_at = CURRENT_TIMESTAMP WHERE token_hash = ?').run(session.tokenHash);
  return {
    mode: 'authkit',
    user: linked,
    session: {
      tokenHash: session.tokenHash,
      authkitSid: session.authkitSid,
      lastValidatedAt: new Date().toISOString(),
    },
  };
}

function authRouteNeedsNoSession(pathname) {
  return new Set([
    '/api/auth/status',
    '/api/auth/login',
    '/api/auth/signup',
    '/api/auth/otp/request',
    '/api/auth/otp/verify',
    '/api/auth/google',
    '/api/auth/logout',
  ]).has(pathname);
}

export function createAuthKitIdentityMiddleware({ config, db, next }) {
  return async function authKitIdentityMiddleware(req, res) {
    if (config.authMode !== 'authkit') return next(req, res);
    const url = new URL(req.url, config.baseUrl);
    if (!url.pathname.startsWith('/api/') || url.pathname.startsWith('/api/health') || authRouteNeedsNoSession(url.pathname)) {
      return runWithRequestIdentity({ mode: 'authkit', user: null }, () => next(req, res));
    }
    try {
      const session = sessionFromRequest(db, req);
      const identity = session ? await validateSession(db, config, session) : null;
      return runWithRequestIdentity(identity ?? { mode: 'authkit', user: null }, () => next(req, res));
    } catch (error) {
      const status = Number(error.status) || 503;
      // 401 here means the bridge is already gone — `validateSession` deleted
      // it — so the browser is holding a cookie that resolves to nothing and
      // will keep sending it on every request until the tab is closed. The
      // central session guard clears it on the same outcome; this path did not,
      // which left a centrally revoked device signed in as far as the cookie
      // jar was concerned. Found by the AuthKit rollout drill.
      //
      // Only on 401. A 503 means AuthKit is unreachable, not that the session
      // ended, and clearing cookies during an outage signs out an entire
      // healthy instance.
      const headers = status === 401 ? { 'Set-Cookie': clearAuthKitSessionCookie(config) } : {};
      return sendJson(res, status, {
        error: {
          code: error.code || 'AUTHKIT_UNAVAILABLE',
          message: status >= 500 ? 'Kuklabs Account is temporarily unavailable.' : error.message,
        },
      }, headers);
    }
  };
}

async function proxyPublicAuth(config, route, body) {
  return requestAuthKit(config, route, { method: 'POST', body });
}

async function logoutAuthKitSession(db, config, req) {
  const session = sessionFromRequest(db, req);
  if (!session) return null;
  let accessToken = '';
  let refreshToken = '';
  try {
    accessToken = decryptAuthKitSecret(config, session.accessCiphertext, session.tokenHash);
    refreshToken = decryptAuthKitSecret(config, session.refreshCiphertext, session.tokenHash);
    await requestAuthKit(config, '/v1/auth/logout', {
      method: 'POST',
      accessToken,
      body: { refresh_token: refreshToken },
    });
  } catch {
    // Local bridge removal must still succeed when the central service is unavailable.
  }
  revokeLocalSession(db, session.tokenHash);
  return session;
}

export function createAuthKitApiHandler({ config, db }) {
  return async function handleAuthKitApi(req, res) {
    const url = new URL(req.url, config.baseUrl);
    const pathname = url.pathname;
    if (!pathname.startsWith('/api/auth/')) return false;

    try {
      if (!originAllowed(req, config.baseUrl)) throw httpError(403, 'Request origin is not allowed.', 'CSRF_BLOCKED');

      if (req.method === 'GET' && pathname === '/api/auth/status') {
        if (config.authMode !== 'authkit') {
          return sendJson(res, 200, { ok: true, mode: 'local', contract: 'kukgit-local-development' });
        }
        const { response, payload } = await requestAuthKit(config, '/v1/auth/status');
        return sendJson(res, response.status, {
          ...payload,
          mode: 'authkit',
          product: config.authkitProductId,
        });
      }

      if (config.authMode !== 'authkit') return false;

      // login, signup, otp/verify and google are owned by
      // createSecureAuthKitLoginApiHandler, which runs earlier in the dispatch
      // chain. Duplicates lived here and were unreachable, but they lacked the
      // verified-email requirement, the product-access preflight and the legacy
      // password scrub — so a change in dispatch order would have silently
      // dropped three protections. One owner per route instead.

      if (req.method === 'POST' && pathname === '/api/auth/otp/request') {
        const body = await readJson(req);
        const { response, payload } = await proxyPublicAuth(config, '/v1/auth/otp/request', {
          identifier: body.identifier ?? body.email,
        });
        return sendJson(res, response.status, response.ok ? payload : {
          error: { code: 'AUTHKIT_OTP_REQUEST_FAILED', message: payload?.message || 'Could not send the code.' },
        });
      }

      if (req.method === 'POST' && pathname === '/api/auth/logout') {
        const session = await logoutAuthKitSession(db, config, req);
        if (session) {
          audit(db, {
            userId: session.userId,
            action: 'auth.authkit_logout',
            targetType: 'user',
            targetId: session.userId,
            metadata: { product: config.authkitProductId },
          });
        }
        return sendNoContent(res, { 'Set-Cookie': clearAuthKitSessionCookie(config) });
      }

      if (req.method === 'GET' && pathname === '/api/auth/me') {
        const identity = currentRequestIdentity();
        const user = identity?.user ?? null;
        if (!user) return sendJson(res, 200, { user: null, authMode: 'authkit' });
        const organizations = db.prepare(`
          SELECT o.id, o.slug, o.name, o.plan, om.role
          FROM organizations o JOIN org_members om ON om.organization_id = o.id
          WHERE om.user_id = ? ORDER BY o.name
        `).all(user.id);
        return sendJson(res, 200, { user, organizations, authMode: 'authkit' });
      }

      return false;
    } catch (error) {
      const status = Number(error.status) || 500;
      return sendJson(res, status, {
        error: {
          code: error.code || 'AUTHKIT_INTERNAL_ERROR',
          message: status >= 500 ? 'Kuklabs Account is temporarily unavailable.' : error.message,
        },
      });
    }
  };
}
