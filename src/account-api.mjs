import { currentUser } from './auth.mjs';
import { uid } from './db.mjs';
import { httpError, originAllowed } from './security.mjs';
import {
  completePasswordReset,
  requestPasswordReset,
  sendEmailVerification,
  verifyEmailToken,
} from './account-verification.mjs';
import {
  phoneVerificationConfigured,
  removeVerifiedPhone,
  verifyPhoneWithFirebase,
} from './phone-verification.mjs';

/**
 * The four endpoints behind proving an address and resetting a password.
 *
 * Three of them are open to anybody, which is unavoidable: somebody who has
 * forgotten their password cannot sign in to ask for a reset, and somebody
 * clicking a link out of their inbox has no session yet. So each one is written
 * assuming the caller is hostile.
 *
 * **They answer the same way whether or not the account exists.** The reset
 * request always returns 202. For a Git host, "is this address registered" is
 * "does this company keep its code here", and a form anybody can submit must
 * not answer it. That is why there is no 404 on this path.
 *
 * **They are on the `auth` rate-limit surface, not the general API one.** Two
 * of them send real email, and the general limit is set for reading pages.
 *
 * **They are not mounted at all in AuthKit mode.** When Kuklabs Account owns
 * the passwords, a KukGit reset endpoint that quietly worked would be a second
 * way into an account that its owner does not know exists.
 */

const MAX_BODY_BYTES = 16 * 1024;

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
  return true;
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw httpError(413, 'Request body is too large.', 'ACCOUNT_REQUEST_TOO_LARGE');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw httpError(400, 'Invalid JSON request body.', 'INVALID_JSON'); }
}

export function createAccountApiHandler({ config, db, fetchImpl = undefined }) {
  return async function accountApi(req, res) {
    const url = new URL(req.url, config.baseUrl);
    const pathname = url.pathname;
    if (!pathname.startsWith('/api/account/')) return false;

    const requestId = uid('req');
    res.setHeader('X-Request-Id', requestId);
    res.setHeader('Referrer-Policy', 'no-referrer');

    try {
      // Not merely refused — absent. An endpoint that answers 403 tells somebody
      // it exists and might work on another instance.
      if (config.authMode !== 'local') throw httpError(404, 'Not found.', 'NOT_FOUND');
      if (req.method !== 'POST') throw httpError(405, 'Method not allowed.', 'METHOD_NOT_ALLOWED');
      if (!originAllowed(req, config.baseUrl)) throw httpError(403, 'Request origin is not allowed.', 'CSRF_BLOCKED');

      const body = await readJson(req);

      if (pathname === '/api/account/verify-email/send') {
        // The one route here that needs a session: it resends to whoever is
        // signed in, so it cannot be used to send mail to an address the caller
        // does not already control.
        const user = currentUser(db, req);
        if (!user) throw httpError(401, 'Sign in required.', 'AUTH_REQUIRED');
        const result = sendEmailVerification(db, config, { userId: user.id });
        return sendJson(res, 202, { ...result, requestId });
      }

      if (pathname === '/api/account/verify-email/confirm') {
        const result = verifyEmailToken(db, { token: body.token });
        return sendJson(res, 200, { verified: true, email: result.email, requestId });
      }

      if (pathname === '/api/account/password-reset/request') {
        requestPasswordReset(db, config, { email: body.email });
        // 202 always, and the message says "if". No branch, no timing that
        // differs enough to matter, and nothing in the body that varies.
        return sendJson(res, 202, {
          accepted: true,
          message: 'If that address has a KukGit account, a reset link is on its way.',
          requestId,
        });
      }

      // Adding a number is a change to how an account can be recovered, so it
      // needs a session — the Firebase token proves a *number*, never who is
      // asking. Absent rather than refused where no Firebase project is set.
      if (pathname === '/api/account/phone/verify' || pathname === '/api/account/phone/remove') {
        if (!phoneVerificationConfigured(config)) throw httpError(404, 'Not found.', 'NOT_FOUND');
        const user = currentUser(db, req);
        if (!user) throw httpError(401, 'Sign in required.', 'AUTH_REQUIRED');
        if (pathname === '/api/account/phone/remove') {
          const removed = removeVerifiedPhone(db, { userId: user.id });
          return sendJson(res, 200, { ...removed, requestId });
        }
        const result = await verifyPhoneWithFirebase(db, config, {
          userId: user.id,
          idToken: body.idToken,
          ...(fetchImpl ? { fetchImpl } : {}),
        });
        return sendJson(res, 200, { verified: true, ...result, requestId });
      }

      if (pathname === '/api/account/password-reset/complete') {
        const result = completePasswordReset(db, { token: body.token, password: body.password });
        return sendJson(res, 200, {
          reset: true,
          // Said out loud, because it is surprising and it matters: every
          // device that was signed in has been signed out.
          sessionsEnded: result.sessionsEnded,
          message: 'Password changed. Every signed-in device has been signed out.',
          requestId,
        });
      }

      throw httpError(404, 'Not found.', 'NOT_FOUND');
    } catch (error) {
      const status = Number(error.status) || 500;
      if (status >= 500) console.error(`[${requestId}] account API`, error);
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
