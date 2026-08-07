import fs from 'node:fs';
import path from 'node:path';
import { currentUser } from './auth.mjs';
import { uid } from './db.mjs';
import { httpError } from './security.mjs';
import { phoneVerificationConfigured } from './phone-verification.mjs';

/**
 * Phone verification on a page of its own, so the application keeps its
 * Content-Security-Policy.
 *
 * Firebase phone auth in a browser is not optional about what it loads: the SDK
 * comes from `gstatic.com`, the reCAPTCHA challenge comes from `google.com` and
 * runs in an iframe, and the sign-in itself talks to `identitytoolkit` and
 * `securetoken`. KukGit's policy is `script-src 'self'` with no frames and no
 * outbound connections, and widening that would widen it **everywhere** — on
 * the sign-in page, on every repository page, for every customer, whether or
 * not anybody ever verifies a number.
 *
 * A CSP is per document. So this is a different document: one small page, whose
 * policy names exactly the hosts Firebase needs and nothing else, reached from
 * account settings and left again immediately afterwards. The application's own
 * policy is untouched.
 *
 * That is the whole reason this file exists. It is more moving parts than a
 * screen inside the app, and it buys back the one property that is hard to get
 * again once it is gone.
 *
 * **The page is not trusted.** It runs third-party code, so what it produces —
 * a Firebase ID token — is checked by `firebase-identity.mjs` against Google's
 * signature before anything is recorded. Nothing on this page decides who
 * anybody is.
 */

/** Pinned. An SDK URL that floats is third-party code that changes without a deploy. */
export const FIREBASE_SDK_VERSION = '10.12.5';

/**
 * The policy for this one page.
 *
 * Every entry is here because Firebase phone auth does not work without it:
 *
 *   * `gstatic.com` — the SDK modules
 *   * `google.com` in `script-src` and `frame-src` — reCAPTCHA, which renders
 *     in an iframe and is not optional for phone auth
 *   * `identitytoolkit` and `securetoken` — sending the code and exchanging it
 *   * the project's own auth domain — Firebase's sign-in helper iframe
 *
 * There is no `'unsafe-inline'` in `script-src`: the page's own code is a file,
 * so the policy stays meaningful.
 */
export function phoneVerifyCsp(config) {
  const authDomain = String(config.firebaseAuthDomain || '').trim();
  const frames = ['https://www.google.com', 'https://recaptcha.google.com'];
  if (authDomain) frames.push(`https://${authDomain}`);
  return [
    "default-src 'none'",
    "script-src 'self' https://www.gstatic.com https://www.google.com https://apis.google.com",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https://www.gstatic.com",
    "connect-src 'self' https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://www.googleapis.com",
    `frame-src ${frames.join(' ')}`,
    "base-uri 'none'",
    // The page posts with `fetch`; a form that could submit anywhere is not
    // something it needs.
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

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

/**
 * Serves the page and the handful of public values it needs to start Firebase.
 *
 * `/account/phone`             the document, with its own policy
 * /account/phone/app.js        its script, same policy
 * /api/account/phone/config    apiKey, authDomain, projectId
 *
 * All three need a session. The values are public — a Firebase web API key is
 * in every browser bundle Google ships — but there is no reason to hand a
 * stranger a page that starts sending SMS.
 */
export function createPhoneVerifyPageHandler({ config, db }) {
  const pages = {
    '/account/phone': { file: 'phone-verify.html', type: 'text/html; charset=utf-8' },
    '/account/phone/app.js': { file: 'phone-verify.js', type: 'text/javascript; charset=utf-8' },
  };

  return async function phoneVerifyPage(req, res) {
    const url = new URL(req.url, config.baseUrl);
    const pathname = url.pathname;
    const page = pages[pathname];
    if (!page && pathname !== '/api/account/phone/config') return false;

    const requestId = uid('req');
    res.setHeader('X-Request-Id', requestId);
    res.setHeader('Referrer-Policy', 'no-referrer');

    try {
      // Absent, not refused, where no Firebase project is set. An instance that
      // cannot do this should look like one that never offered it.
      if (config.authMode !== 'local' || !phoneVerificationConfigured(config)) {
        throw httpError(404, 'Not found.', 'NOT_FOUND');
      }
      if (req.method !== 'GET') throw httpError(405, 'Method not allowed.', 'METHOD_NOT_ALLOWED');
      const user = currentUser(db, req);
      if (!user) {
        if (!page) throw httpError(401, 'Sign in required.', 'AUTH_REQUIRED');
        // A person following a bookmark. Send them to sign in rather than
        // showing a page that cannot work.
        res.writeHead(302, { Location: '/#/', 'Cache-Control': 'no-store' });
        res.end();
        return true;
      }

      if (!page) {
        return sendJson(res, 200, {
          projectId: config.firebaseProjectId,
          apiKey: config.firebaseApiKey,
          authDomain: config.firebaseAuthDomain,
          sdkVersion: FIREBASE_SDK_VERSION,
          requestId,
        });
      }

      const target = path.join(config.publicDir, page.file);
      if (!fs.existsSync(target)) throw httpError(404, 'Not found.', 'NOT_FOUND');
      const body = fs.readFileSync(target);
      res.writeHead(200, {
        'Content-Type': page.type,
        'Content-Length': body.length,
        // Set here rather than inherited. This is the only document in KukGit
        // allowed to load anything from another host, and the widening must not
        // reach a page that did not ask for it.
        'Content-Security-Policy': phoneVerifyCsp(config),
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'Cache-Control': 'no-cache',
      });
      res.end(body);
      return true;
    } catch (error) {
      const status = Number(error.status) || 500;
      if (status >= 500) console.error(`[${requestId}] phone verify page`, error);
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
