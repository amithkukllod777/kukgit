import { createSession, currentUser, sessionCookie } from './auth.mjs';
import { audit, uid } from './db.mjs';
import { httpError, originAllowed } from './security.mjs';
import {
  availableOAuthProviders,
  beginOAuthSignIn,
  claimOAuthState,
  fetchOAuthProfile,
  oauthProvider,
  pruneOAuthStates,
  safeRedirect,
} from './oauth-signin.mjs';
import { identitiesFor, linkIdentity, resolveIdentitySignIn, unlinkIdentity } from './user-identities.mjs';

/**
 * The routes behind "Sign in with GitHub" and "Sign in with Google".
 *
 * `oauth-signin.mjs` knows the protocol and `user-identities.mjs` decides whose
 * account it is. This file is the part the browser touches, and it is written
 * for the fact that two of its routes are plain `GET`s the user's browser is
 * *redirected* to — no `fetch`, no custom header, no way to check an `Origin`.
 *
 * That is why the `state` exists and why it is the whole defence on the way
 * back. Everything else here follows from it:
 *
 * **Nothing in the callback URL is trusted except `code` and `state`.** Not the
 * provider name in the query, not a `redirect_to`, not a user id. Where to send
 * somebody afterwards was decided when the flow *started* and was written into
 * the row `state` unlocks. A callback that reads its destination out of the URL
 * it was handed is an open redirect wearing a login page.
 *
 * **Whether this is a sign-in or a link was also decided at the start.** If a
 * signed-in person began the flow, the row carries their user id and the
 * callback links. If nobody did, the callback signs in. The alternative — read
 * the session at callback time — means a link somebody sends you finishes
 * *their* GitHub flow against *your* session, and then they are you.
 *
 * **Errors come back as a redirect, not as JSON.** The person is in a browser
 * that has just come from GitHub; a JSON body is a dead end with no way back.
 * The reason travels as a code in the fragment, which stays in the browser and
 * never reaches a server log or a `Referer` header.
 */

/**
 * How long the browser may be told to remember nothing.
 *
 * Every response here is `no-store`. A cached 302 carrying a `Set-Cookie` is a
 * session handed to the next person on a shared machine.
 */
const NO_STORE = {
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  Pragma: 'no-cache',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
};

/**
 * The codes the sign-in screen knows how to explain.
 *
 * A fixed list, because the value goes into a URL the browser will render. An
 * error message passed through from a provider is text somebody else controls
 * arriving on our own origin.
 */
export const OAUTH_ERROR_CODES = Object.freeze([
  'access_denied',
  'state_invalid',
  'email_conflict',
  'already_linked',
  'provider_taken',
  'provider_unavailable',
  'provider_error',
  'server_error',
]);

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...NO_STORE,
  });
  res.end(body);
  return true;
}

function redirect(res, location, headers = {}) {
  res.writeHead(302, { Location: location, ...NO_STORE, ...headers });
  res.end();
  return true;
}

/**
 * Turns a thrown error into something the sign-in screen can say.
 *
 * Deliberately lossy. The person sees one of a handful of known situations;
 * the detail stays in the server log against the request id.
 */
export function oauthErrorCode(error) {
  switch (error?.code) {
    case 'OAUTH_ACCESS_DENIED':
    case 'OAUTH_NO_CODE': return 'access_denied';
    case 'OAUTH_STATE_INVALID': return 'state_invalid';
    case 'IDENTITY_EMAIL_UNVERIFIED_CONFLICT': return 'email_conflict';
    case 'IDENTITY_ALREADY_LINKED': return 'already_linked';
    case 'IDENTITY_PROVIDER_TAKEN': return 'provider_taken';
    case 'OAUTH_PROVIDER_UNAVAILABLE':
    case 'OAUTH_PROVIDER_UNKNOWN': return 'provider_unavailable';
    case 'OAUTH_PROVIDER_UNREACHABLE':
    case 'OAUTH_PROVIDER_REFUSED':
    case 'OAUTH_TOKEN_MISSING':
    case 'OAUTH_PROFILE_INVALID':
    case 'OAUTH_PROFILE_INCOMPLETE': return 'provider_error';
    default: return 'server_error';
  }
}

/**
 * Where to send somebody when it did not work.
 *
 * The reason goes in the fragment, never the query. A fragment is not sent to
 * the server and does not appear in a `Referer`, so a failed sign-in does not
 * leave a trail of "this address is already taken" in somebody's access log.
 */
function failureLocation(provider, code) {
  return `/#/sign-in?error=${encodeURIComponent(code)}&provider=${encodeURIComponent(provider)}`;
}

/**
 * Creates the KukGit account behind a first-time provider sign-in.
 *
 * Only the user. No organization: joining or creating one is a decision with a
 * name, a slug and a plan attached, and it belongs to the onboarding screen
 * rather than to a redirect somebody is halfway through. A user with no
 * organization is the state onboarding already knows how to handle.
 *
 * `password_hash` gets a sentinel that cannot be a scrypt record, so
 * `verifyPassword` can never match it and `unlinkIdentity` correctly sees an
 * account with no password. Somebody who signs up with GitHub and later wants a
 * password sets one through the reset flow, which proves the address first.
 */
export function createUserFromProvider(db, { email, emailVerified, displayName, provider }) {
  if (!email) {
    // Both providers are asked for an address and both give one when the person
    // has any. Nothing here can proceed without it: with no address there is no
    // way to reach the account's owner, and no way to recover it later.
    throw httpError(422, 'That account has no email address we can use.', 'OAUTH_PROFILE_INCOMPLETE');
  }
  const id = uid('usr');
  const columns = new Set(db.prepare('PRAGMA table_info(users)').all().map((row) => row.name));
  const fields = ['id', 'email', 'password_hash', 'display_name'];
  const values = [id, email, `provider$${provider}`, String(displayName || email.split('@')[0]).slice(0, 191)];
  if (columns.has('email_verified')) {
    fields.push('email_verified');
    values.push(emailVerified ? 1 : 0);
  }
  if (columns.has('auth_source')) {
    fields.push('auth_source');
    values.push('local');
  }
  db.prepare(`INSERT INTO users (${fields.join(', ')}) VALUES (${fields.map(() => '?').join(', ')})`).run(...values);
  audit(db, {
    userId: id,
    action: 'account.created_via_provider',
    targetType: 'user',
    targetId: id,
    metadata: { provider },
  });
  return id;
}

export function createOAuthApiHandler({ config, db, fetchImpl = undefined }) {
  return async function oauthApi(req, res) {
    const url = new URL(req.url, config.baseUrl);
    const pathname = url.pathname;
    if (!pathname.startsWith('/api/auth/')) return false;

    // Three routes, and a fourth for the identities a signed-in person has.
    // Anything else under `/api/auth/` belongs to another handler and is left
    // for it — this one must not answer 404 for somebody else's route.
    const flow = /^\/api\/auth\/([a-z]+)\/(start|callback)$/.exec(pathname);
    const isProviders = pathname === '/api/auth/providers';
    const isIdentities = pathname === '/api/auth/identities';
    const unlink = /^\/api\/auth\/identities\/([a-z]+)$/.exec(pathname);
    if (!flow && !isProviders && !isIdentities && !unlink) return false;

    const requestId = uid('req');
    res.setHeader('X-Request-Id', requestId);

    try {
      // Signing in with a provider is signing in *here*. When Kuklabs Account
      // owns the sessions, a second door that quietly worked would be a way in
      // its owner does not know about. Absent, not refused — a 403 tells a
      // stranger the route exists.
      if (config.authMode !== 'local') throw httpError(404, 'Not found.', 'NOT_FOUND');

      if (isProviders) {
        if (req.method !== 'GET') throw httpError(405, 'Method not allowed.', 'METHOD_NOT_ALLOWED');
        // Public on purpose: the sign-in screen has to render before anybody is
        // signed in, and it says only which buttons this instance can offer.
        return sendJson(res, 200, { providers: availableOAuthProviders(db, config), requestId });
      }

      if (isIdentities) {
        if (req.method !== 'GET') throw httpError(405, 'Method not allowed.', 'METHOD_NOT_ALLOWED');
        const user = currentUser(db, req);
        if (!user) throw httpError(401, 'Sign in required.', 'AUTH_REQUIRED');
        return sendJson(res, 200, { identities: identitiesFor(db, user.id), requestId });
      }

      if (unlink) {
        if (req.method !== 'DELETE') throw httpError(405, 'Method not allowed.', 'METHOD_NOT_ALLOWED');
        // A state-changing call the browser makes itself, so it gets the same
        // origin check as every other one.
        if (!originAllowed(req, config.baseUrl)) throw httpError(403, 'Request origin is not allowed.', 'CSRF_BLOCKED');
        const user = currentUser(db, req);
        if (!user) throw httpError(401, 'Sign in required.', 'AUTH_REQUIRED');
        const removed = unlinkIdentity(db, { userId: user.id, provider: unlink[1] });
        return sendJson(res, 200, { removed, requestId });
      }

      const [, providerName, action] = flow;
      if (req.method !== 'GET') throw httpError(405, 'Method not allowed.', 'METHOD_NOT_ALLOWED');

      if (action === 'start') {
        // Whoever is signed in *now* decides whether this is a link or a fresh
        // sign-in, and the answer is written into the state row. Reading it at
        // callback time instead is the login-CSRF this table exists to stop.
        const user = currentUser(db, req);
        const { url: authorize } = beginOAuthSignIn(db, config, {
          provider: providerName,
          linkUserId: user ? user.id : null,
          redirectTo: url.searchParams.get('redirect_to'),
        });
        // Cheap, and it keeps abandoned flows from accumulating without a job
        // to run. Every start is somebody who might not come back.
        pruneOAuthStates(db);
        return redirect(res, authorize);
      }

      // The callback. From here on, failures redirect.
      const known = oauthProvider(providerName);
      try {
        // The provider says so when somebody presses "Cancel". It is not an
        // error worth logging, and the state is spent below either way.
        const denied = url.searchParams.get('error');
        const code = url.searchParams.get('code');
        const claim = claimOAuthState(db, { provider: known.id, state: url.searchParams.get('state') });
        if (denied || !code) {
          throw httpError(400, 'Sign-in was cancelled.', denied === 'access_denied' ? 'OAUTH_ACCESS_DENIED' : 'OAUTH_NO_CODE');
        }

        const profile = await fetchOAuthProfile(db, config, { provider: known.id, code, fetchImpl });

        if (claim.linkUserId) {
          // Adding a second way in for somebody who is already here. Their
          // session is untouched: they were already signed in, and re-issuing
          // one would only widen what this route can do.
          linkIdentity(db, {
            userId: claim.linkUserId,
            provider: known.id,
            providerUserId: profile.providerUserId,
            providerLogin: profile.providerLogin,
            email: profile.email,
          });
          return redirect(res, `/${claim.redirectTo}`);
        }

        const { userId, outcome } = resolveIdentitySignIn(db, {
          provider: known.id,
          providerUserId: profile.providerUserId,
          providerLogin: profile.providerLogin,
          email: profile.email,
          emailVerified: profile.emailVerified,
          displayName: profile.displayName,
          createUser: (details) => createUserFromProvider(db, details),
        });

        const session = createSession(db, userId);
        audit(db, {
          userId,
          action: 'account.signed_in',
          targetType: 'user',
          targetId: userId,
          metadata: { provider: known.id, outcome },
        });
        return redirect(res, `/${claim.redirectTo}`, {
          'Set-Cookie': sessionCookie(session.token, config.cookieSecure),
        });
      } catch (error) {
        const status = Number(error.status) || 500;
        if (status >= 500) console.error(`[${requestId}] oauth callback`, error);
        return redirect(res, failureLocation(known.id, oauthErrorCode(error)));
      }
    } catch (error) {
      const status = Number(error.status) || 500;
      if (status >= 500) console.error(`[${requestId}] oauth API`, error);
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
