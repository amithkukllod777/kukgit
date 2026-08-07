import { createSession, currentUser, sessionCookie, verifyPassword } from './auth.mjs';
import { audit, uid } from './db.mjs';
import { httpError, originAllowed } from './security.mjs';
import {
  beginTwoFactorEnrolment,
  claimTwoFactorChallenge,
  confirmTwoFactorEnrolment,
  disableTwoFactor,
  regenerateRecoveryCodes,
  twoFactorStatus,
  verifyTwoFactor,
} from './two-factor.mjs';

/**
 * The routes for setting up a second factor and for finishing a sign-in with
 * one.
 *
 * Two groups, and the split matters:
 *
 * `/api/account/two-factor/*` needs a session. Somebody signed in is turning it
 * on, reading its state, or turning it off.
 *
 * `/api/auth/two-factor` has **no** session — that is the point of it. It is
 * the second half of a sign-in whose first half succeeded, and it is reached
 * with a challenge issued by `/api/auth/login` rather than with a cookie.
 *
 * ## Three things carry weight here
 *
 * **Turning it off needs a current code, not just a session.** A session is
 * enough to do most things. It is not enough to remove the control that exists
 * for the case where a session is what got stolen.
 *
 * **Starting enrolment needs the password again.** Anybody sitting at an
 * unlocked laptop could otherwise attach their own authenticator to somebody
 * else's account and lock them out of it permanently.
 *
 * **The secret and the recovery codes are returned exactly once.** There is no
 * route that reads them back. A secret an API will hand over again is a secret
 * that only protects against somebody who has not thought of asking.
 */

const MAX_BODY_BYTES = 16 * 1024;

function sendJson(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    // Recovery codes pass through these responses. A cached one is a set of
    // codes sitting in a proxy.
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    // Last, and the reason this parameter exists: finishing a sign-in sets the
    // session cookie here. Without it the second factor succeeds and nobody is
    // signed in.
    ...headers,
  });
  res.end(body);
  return true;
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw httpError(413, 'Request body is too large.', 'REQUEST_TOO_LARGE');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw httpError(400, 'Invalid JSON request body.', 'INVALID_JSON'); }
}

/**
 * Re-checks the password of somebody already signed in.
 *
 * Not the same as being signed in. An unlocked laptop is a session; it is not
 * proof that the person at it is the account's owner, and attaching a second
 * factor is exactly the change where that difference decides who keeps the
 * account.
 */
function assertPassword(db, user, password) {
  const row = db.prepare('SELECT password_hash AS hash FROM users WHERE id = ?').get(user.id);
  const stored = String(row?.hash ?? '');
  if (!stored.startsWith('scrypt$')) {
    // Signed in through a provider and has no password here. Asking for one
    // would be asking for something that does not exist.
    return;
  }
  if (!verifyPassword(String(password ?? ''), stored)) {
    throw httpError(401, 'That password is not right.', 'PASSWORD_INVALID');
  }
}

export function createTwoFactorApiHandler({ config, db }) {
  return async function twoFactorApi(req, res) {
    const url = new URL(req.url, config.baseUrl);
    const pathname = url.pathname;
    const isAccount = pathname.startsWith('/api/account/two-factor');
    const isSignIn = pathname === '/api/auth/two-factor';
    if (!isAccount && !isSignIn) return false;

    const requestId = uid('req');
    res.setHeader('X-Request-Id', requestId);
    res.setHeader('Referrer-Policy', 'no-referrer');

    try {
      // A second factor on top of a password KukGit does not hold is not a
      // second factor. In AuthKit mode the passwords and the MFA both belong to
      // Kuklabs Account, and a parallel one here would be a second lock its
      // owner does not know about.
      if (config.authMode !== 'local') throw httpError(404, 'Not found.', 'NOT_FOUND');

      if (pathname === '/api/account/two-factor' && req.method === 'GET') {
        const user = currentUser(db, req);
        if (!user) throw httpError(401, 'Sign in required.', 'AUTH_REQUIRED');
        return sendJson(res, 200, { ...twoFactorStatus(db, user.id), requestId });
      }

      if (req.method !== 'POST') throw httpError(405, 'Method not allowed.', 'METHOD_NOT_ALLOWED');
      if (!originAllowed(req, config.baseUrl)) throw httpError(403, 'Request origin is not allowed.', 'CSRF_BLOCKED');
      const body = await readJson(req);

      // Finishing a sign-in. No session — the challenge is the credential.
      if (isSignIn) {
        const userId = claimTwoFactorChallenge(db, { token: body.challenge });
        let result;
        try {
          result = verifyTwoFactor(db, config, { userId, code: body.code });
        } catch (error) {
          // The challenge has already been spent by the claim above. Say so,
          // rather than leaving somebody typing codes into a sign-in that can
          // no longer complete.
          if (error.code === 'TWO_FACTOR_CODE_INVALID') {
            throw httpError(401, 'That code is not right. Sign in again.', 'TWO_FACTOR_CODE_INVALID');
          }
          throw error;
        }
        const user = db.prepare('SELECT id, email, display_name AS displayName FROM users WHERE id = ?').get(userId);
        const session = createSession(db, userId);
        audit(db, {
          userId,
          action: 'auth.login',
          targetType: 'user',
          targetId: userId,
          metadata: { secondFactor: result.method },
        });
        return sendJson(res, 200, {
          user: { id: user.id, email: user.email, displayName: user.displayName },
          // Surfaced so the screen can tell somebody they are running low, on
          // the one occasion they are certainly paying attention.
          recoveryCodesRemaining: result.recoveryCodesRemaining,
          usedRecoveryCode: result.method === 'recovery',
          requestId,
        }, { 'Set-Cookie': sessionCookie(session.token, config.cookieSecure) });
      }

      const user = currentUser(db, req);
      if (!user) throw httpError(401, 'Sign in required.', 'AUTH_REQUIRED');

      if (pathname === '/api/account/two-factor/start') {
        assertPassword(db, user, body.password);
        const started = beginTwoFactorEnrolment(db, config, { userId: user.id, account: user.email });
        // Returned once and never readable again. There is no route that
        // hands these back.
        return sendJson(res, 200, { ...started, requestId });
      }

      if (pathname === '/api/account/two-factor/confirm') {
        return sendJson(res, 200, { ...confirmTwoFactorEnrolment(db, config, { userId: user.id, code: body.code }), requestId });
      }

      if (pathname === '/api/account/two-factor/disable') {
        return sendJson(res, 200, { ...disableTwoFactor(db, config, { userId: user.id, code: body.code }), requestId });
      }

      if (pathname === '/api/account/two-factor/recovery-codes') {
        // A current code, for the same reason disabling needs one: a fresh set
        // invalidates the printed one, which is a way to lock somebody out.
        verifyTwoFactor(db, config, { userId: user.id, code: body.code });
        return sendJson(res, 200, { recoveryCodes: regenerateRecoveryCodes(db, { userId: user.id }), requestId });
      }

      throw httpError(404, 'Not found.', 'NOT_FOUND');
    } catch (error) {
      const status = Number(error.status) || 500;
      if (status >= 500) console.error(`[${requestId}] two-factor API`, error);
      if (!res.headersSent) {
        sendJson(res, status, {
          error: {
            code: error.code || 'INTERNAL_ERROR',
            message: status >= 500 ? 'An unexpected server error occurred.' : error.message,
            requestId,
          },
        });
      } else res.end();
    }
    return true;
  };
}
