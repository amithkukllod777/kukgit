import { clearAuthKitSessionCookie, decryptAuthKitSecret, requestAuthKit } from './authkit-identity.mjs';
import { currentRequestIdentity } from './identity-context.mjs';
import { hashToken, parseCookies } from './security.mjs';

const PUBLIC_AUTH_ROUTES = new Set([
  '/api/health',
  '/api/auth/status',
  '/api/auth/login',
  '/api/auth/signup',
  '/api/auth/otp/request',
  '/api/auth/otp/verify',
  '/api/auth/google',
  '/api/auth/logout',
]);

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

function authKitSession(db, req) {
  const token = parseCookies(req.headers.cookie).kukgit_session;
  if (!token) return null;
  const tokenHash = hashToken(token);
  return db.prepare(`
    SELECT token_hash AS tokenHash, authkit_access_ciphertext AS accessCiphertext,
      authkit_sid AS authkitSid
    FROM sessions
    WHERE token_hash = ? AND auth_mode = 'authkit'
  `).get(tokenHash);
}

function revokeBridge(db, session) {
  if (session?.tokenHash) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(session.tokenHash);
}

export function createAuthKitCentralSessionGuard({ config, db, next }) {
  return async function authKitCentralSessionGuard(req, res) {
    if (config.authMode !== 'authkit') return next(req, res);
    const url = new URL(req.url, config.baseUrl);
    if (!url.pathname.startsWith('/api/') || PUBLIC_AUTH_ROUTES.has(url.pathname)) return next(req, res);

    const identity = currentRequestIdentity();
    if (!identity?.user) return next(req, res);
    const session = authKitSession(db, req);
    if (!session) return next(req, res);

    try {
      const accessToken = decryptAuthKitSecret(config, session.accessCiphertext, session.tokenHash);
      const { response, payload } = await requestAuthKit(config, '/v1/auth/sessions', { accessToken });
      if (response.status === 401) {
        revokeBridge(db, session);
        return sendJson(res, 401, {
          error: { code: 'AUTHKIT_SESSION_REVOKED', message: 'This Kuklabs Account session was revoked. Sign in again.' },
        }, { 'Set-Cookie': clearAuthKitSessionCookie(config) });
      }
      if (!response.ok) {
        return sendJson(res, 503, {
          error: { code: 'AUTHKIT_SESSION_CHECK_FAILED', message: 'Kuklabs Account session validation is temporarily unavailable.' },
        });
      }
      const sessions = Array.isArray(payload?.sessions) ? payload.sessions : [];
      const current = sessions.find((item) => item?.current === true);
      const matchesStoredSid = !session.authkitSid || current?.id === session.authkitSid;
      if (!current || !matchesStoredSid) {
        revokeBridge(db, session);
        return sendJson(res, 401, {
          error: { code: 'AUTHKIT_SESSION_REVOKED', message: 'This Kuklabs Account session was revoked. Sign in again.' },
        }, { 'Set-Cookie': clearAuthKitSessionCookie(config) });
      }
      return next(req, res);
    } catch (error) {
      const status = Number(error.status) || 503;
      if (status === 401) revokeBridge(db, session);
      return sendJson(res, status, {
        error: {
          code: error.code || 'AUTHKIT_SESSION_CHECK_FAILED',
          message: status >= 500 ? 'Kuklabs Account session validation is temporarily unavailable.' : error.message,
        },
      }, status === 401 ? { 'Set-Cookie': clearAuthKitSessionCookie(config) } : {});
    }
  };
}
