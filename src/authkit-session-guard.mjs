import { clearAuthKitSessionCookie, decryptAuthKitSecret, requestAuthKit, withinSessionCheckWindow } from './authkit-identity.mjs';
import { currentRequestIdentity } from './identity-context.mjs';
import { hashToken, parseCookies } from './security.mjs';

const PUBLIC_AUTH_ROUTES = new Set([
  '/api/health',
  '/api/health/ready',
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
      authkit_sid AS authkitSid, last_validated_at AS lastValidatedAt
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

    // The identity middleware ran first and, inside the revalidation window,
    // answered without touching AuthKit. Asking `/v1/auth/sessions` here anyway
    // would put the instance straight back over the twenty-requests-a-minute
    // limit that window exists to stay under.
    if (withinSessionCheckWindow(config, session)) return next(req, res);

    try {
      const accessToken = decryptAuthKitSecret(config, session.accessCiphertext, session.tokenHash);
      const { response, payload } = await requestAuthKit(config, '/v1/auth/sessions', { accessToken });
      if (response.status === 401) {
        revokeBridge(db, session);
        return sendJson(res, 401, {
          error: { code: 'AUTHKIT_SESSION_REVOKED', message: 'This Kuklabs Account session was revoked. Sign in again.' },
        }, { 'Set-Cookie': clearAuthKitSessionCookie(config) });
      }
      if (response.status === 429) {
        // Rate limited, not refused. The bridge stays exactly as it was and the
        // cookie is untouched — the alternative is emptying every browser on
        // the instance because one busy minute used the shared bucket.
        return sendJson(res, 503, {
          error: { code: 'AUTHKIT_RATE_LIMITED', message: 'Kuklabs Account is rate limiting this instance. Try again shortly.' },
        }, { 'Retry-After': String(response.headers.get('Retry-After') ?? 30) });
      }
      if (!response.ok) {
        return sendJson(res, 503, {
          error: { code: 'AUTHKIT_SESSION_CHECK_FAILED', message: 'Kuklabs Account session validation is temporarily unavailable.' },
        });
      }
      const sessions = Array.isArray(payload?.sessions) ? payload.sessions : [];
      const current = sessions.find((item) => item?.current === true);

      // Bind the bridge to a specific AuthKit device session.
      //
      // Previously a null `authkit_sid` skipped this comparison outright, which
      // silently downgraded "this exact device session is still live" to "the
      // account has some live session" — so revoking the device that created this
      // bridge did not end it as long as the user was signed in anywhere. Rather
      // than skip, adopt the id AuthKit reports on the first validation and
      // enforce it exactly from then on. That closes the hole for sessions
      // created before the id could be derived, without forcing everyone to sign
      // in again.
      if (current?.id && !session.authkitSid) {
        db.prepare('UPDATE sessions SET authkit_sid = ? WHERE token_hash = ? AND authkit_sid IS NULL')
          .run(String(current.id), session.tokenHash);
        session.authkitSid = String(current.id);
      }
      const matchesStoredSid = !session.authkitSid || current?.id === session.authkitSid;
      // A live session that AuthKit does not mark `current` is not the same as
      // a revoked one. AuthKit computes `current` by comparing the token's `sid`
      // claim, and a token minted by a path that carries no `sid` marks nothing
      // current while still returning the full list — so an empty answer is the
      // only shape that means "this device is gone".
      const listedByStoredSid = session.authkitSid
        && sessions.some((item) => String(item?.id ?? '') === session.authkitSid);
      if ((!current && !listedByStoredSid) || (current && !matchesStoredSid)) {
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
