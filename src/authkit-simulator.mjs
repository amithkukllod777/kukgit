import crypto from 'node:crypto';
import http from 'node:http';

/**
 * A standing-in Kuklabs AuthKit, faithful enough to rehearse against.
 *
 * [ONE_KUKLABS_ACCOUNT.md](../docs/ONE_KUKLABS_ACCOUNT.md) ends with a rollout
 * checklist that says to "verify OTP, password, Google, refresh, session and
 * product-access flows in staging". There has never been a staging AuthKit to
 * verify them against, so that line has been open since it was written — and
 * the unit tests around identity call the handlers directly, which proves the
 * handlers and not the round trip.
 *
 * This is the thing to point at. It speaks `kuklabs-authkit-rest/1` over real
 * HTTP and it is deliberately *not* a permissive test double:
 *
 *   * access tokens expire on a clock, so refresh has to actually happen
 *   * refresh tokens rotate, and **replaying a spent one kills the whole device
 *     session** — which is what a real identity provider does, and the only way
 *     to find out whether KukGit ever replays one
 *   * device sessions are real rows that can be revoked one at a time
 *   * `offline` makes every route fail, so failing closed can be observed
 *     rather than asserted
 *
 * It is a simulator, not a mock: nothing here knows what the test wants. Where
 * the real service's behaviour is unknown, this refuses rather than guesses,
 * because a stand-in that is more forgiving than production is a stand-in that
 * certifies a bug.
 *
 * **It is not an identity provider.** Passwords are compared in plain text and
 * OTP codes are fixed. It exists to be talked to, never to hold an account.
 */

const CONTRACT = 'kuklabs-authkit-rest/1';

/**
 * The live service returns three different messages behind one status.
 *
 * "Sign in required." with no header, "Session expired. Please sign in again."
 * for a bad or expired token, "Account not found." for a valid token whose user
 * is gone. Anything distinguishing them has to match on the message, so the
 * stand-in has to produce all three.
 */
function bearerRefusal(bearer, resolved) {
  if (!bearer) return 'Sign in required.';
  if (resolved?.reason === 'missing-user') return 'Account not found. Please sign in again.';
  return 'Session expired. Please sign in again.';
}

function base64url(value) {
  return Buffer.from(value).toString('base64').replace(/=+$/, '').replaceAll('+', '-').replaceAll('/', '_');
}

/**
 * An access token shaped like the real one: three dot-separated segments with
 * the device-session id in the claims.
 *
 * The shape matters. `resolveAuthKitSid` reads the id from the response
 * envelope when it is there and from the token claims when it is not, and a
 * stand-in that only ever put it in the envelope would leave the second path —
 * the one production actually uses — unexercised.
 */
function issueAccessToken({ sid, subject, ttlSeconds }) {
  const header = base64url(JSON.stringify({ alg: 'none', typ: 'JWT' }));
  const claims = {
    sub: String(subject),
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
    // Unique per issuance. `exp` has one-second resolution, so without this two
    // tokens minted in the same second are byte-identical — and a rotation
    // check comparing them would pass while nothing rotated.
    jti: crypto.randomBytes(8).toString('hex'),
    sid,
  };
  // Not signed, and it says so. Anything that verified this signature would be
  // verifying nothing; KukGit does not, and should not start because a
  // simulator made it look possible.
  return `${header}.${base64url(JSON.stringify(claims))}.unsigned-simulator`;
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 256 * 1024) throw new Error('AuthKit simulator: request body too large.');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { return {}; }
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

export const SIMULATOR_DEFAULTS = Object.freeze({
  productId: 'kukgit',
  // The live service's default: AUTHKIT_ACCESS_TTL_HOURS = 24.
  accessTtlSeconds: 86_400,
  refreshTtlDays: 60,
  otpCode: '123456',
  googleIdToken: 'simulator-google-id-token',
  // `/v1/auth/*` on the live service: twenty requests a minute, per source IP,
  // in-memory per process. KukGit calls it server-to-server, so every user of
  // an instance shares one bucket.
  rateLimitPerMinute: 20,
});

/**
 * @param {object} [options]
 * @param {Array<{email: string, password: string, name?: string, kuklabsUserId?: string}>} [options.accounts]
 */
export function createAuthKitSimulator(options = {}) {
  const settings = { ...SIMULATOR_DEFAULTS, ...options };
  const accounts = new Map();
  const sessions = new Map();       // sid -> { sid, userId, accessToken, accessExpiresAt, refreshToken, revokedAt, userAgent }
  const spentRefreshTokens = new Map(); // token -> sid, so replay can be recognised rather than merely refused
  const calls = [];
  const state = {
    offline: false,
    productAccess: 'active',
    missingProductHeader: [],
    rateLimited: 0,
  };

  // One bucket, because the live limiter keys on source IP and KukGit talks to
  // it server-to-server: every user of an instance is the same IP.
  const window = [];
  function rateLimitExceeded(nowMs) {
    if (!settings.rateLimitPerMinute) return false;
    while (window.length && nowMs - window[0] >= 60_000) window.shift();
    if (window.length >= settings.rateLimitPerMinute) return true;
    window.push(nowMs);
    return false;
  }

  let nextUserId = 1001;
  for (const account of options.accounts ?? [{ email: 'founder@kuklabs.com', password: 'simulator-password', name: 'Founder' }]) {
    const id = nextUserId;
    nextUserId += 1;
    accounts.set(String(account.email).trim().toLowerCase(), {
      id,
      kuklabs_user_id: account.kuklabsUserId ?? String(id),
      full_name: account.name ?? 'Simulator User',
      email: String(account.email).trim().toLowerCase(),
      email_verified: true,
      phone: null,
      phone_verified: false,
      password: account.password,
    });
  }

  function publicUser(account) {
    const { password, ...rest } = account;
    return rest;
  }

  function openSession(account) {
    const sid = `sess_${crypto.randomBytes(9).toString('hex')}`;
    const session = {
      sid,
      userId: account.id,
      email: account.email,
      accessToken: issueAccessToken({ sid, subject: account.id, ttlSeconds: settings.accessTtlSeconds }),
      accessExpiresAt: Date.now() + settings.accessTtlSeconds * 1000,
      refreshToken: `rt_${crypto.randomBytes(18).toString('hex')}`,
      refreshExpiresAt: Date.now() + settings.refreshTtlDays * 86400 * 1000,
      revokedAt: null,
      createdAt: new Date().toISOString(),
    };
    sessions.set(sid, session);
    return {
      body: {
        access_token: session.accessToken,
        refresh_token: session.refreshToken,
        token_type: 'Bearer',
        expires_in: settings.accessTtlSeconds,
        user: publicUser(account),
        // No top-level `sid`, on any route. The live service carries it only in
        // the access token's claims — so the claims path is the one KukGit
        // actually depends on, and a stand-in that also put it in the envelope
        // would leave that path unexercised.
      },
      session,
    };
  }

  function sessionForAccessToken(token) {
    if (!token) return null;
    for (const session of sessions.values()) {
      if (session.accessToken !== token) continue;
      if (session.revokedAt) return { session, reason: 'revoked' };
      if (session.accessExpiresAt <= Date.now()) return { session, reason: 'expired' };
      return { session, reason: null };
    }
    return null;
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://authkit.simulator');
    const product = req.headers['x-kuklabs-product'];
    calls.push({ method: req.method, path: url.pathname, product: product ?? null });
    // Every AuthKit request must name the product. A provider that answered
    // without it would let a bug that drops the header go unnoticed until a
    // second product existed.
    if (!product) {
      state.missingProductHeader.push(`${req.method} ${url.pathname}`);
      return json(res, 400, { error: true, message: 'X-Kuklabs-Product is required.' });
    }

    if (state.offline) {
      // What an unreachable identity provider looks like from the other side:
      // the socket answers, the service does not.
      return json(res, 503, { error: true, message: 'AuthKit is unavailable.' });
    }

    if (rateLimitExceeded(Date.now())) {
      state.rateLimited += 1;
      // A different body shape from every other error on this service: `error`
      // is a string here rather than `true` beside a `message`. Anything
      // parsing the envelope has to survive that.
      res.setHeader('Retry-After', '60');
      return json(res, 429, { error: 'Too many requests. Please try again later.' });
    }

    const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : {};
    const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();

    if (req.method === 'GET' && url.pathname === '/v1/auth/status') {
      return json(res, 200, { ok: true, contract: CONTRACT, google: { enabled: true } });
    }

    if (req.method === 'POST' && url.pathname === '/v1/auth/login') {
      const account = accounts.get(String(body.identifier ?? '').trim().toLowerCase());
      if (!account || account.password !== body.password) {
        return json(res, 401, { error: true, message: 'Invalid email/mobile or password.' });
      }
      return json(res, 200, openSession(account).body);
    }

    if (req.method === 'POST' && url.pathname === '/v1/auth/signup') {
      // A real signup is never complete in one call: the address has to be
      // proved before an account exists.
      return json(res, 403, {
        error: true,
        status: 'otp_required',
        message: 'Enter the 6-digit code.',
        identifier: String(body.identifier ?? '').trim().toLowerCase(),
      });
    }

    if (req.method === 'POST' && url.pathname === '/v1/auth/otp/request') {
      return json(res, 200, { success: true, status: 'otp_sent' });
    }

    if (req.method === 'POST' && url.pathname === '/v1/auth/otp/verify') {
      if (String(body.code ?? '') !== settings.otpCode) {
        return json(res, 400, { error: true, message: 'Invalid code.' });
      }
      const email = String(body.identifier ?? '').trim().toLowerCase();
      let account = accounts.get(email);
      if (!account) {
        if (!email.includes('@')) return json(res, 400, { error: true, message: 'Invalid identifier.' });
        const id = nextUserId;
        nextUserId += 1;
        account = {
          id,
          kuklabs_user_id: String(id),
          full_name: String(body.full_name ?? 'Simulator User'),
          email,
          email_verified: true,
          phone: null,
          phone_verified: false,
          password: null,
        };
        accounts.set(email, account);
      }
      // Signup completes without an envelope `sid`, so the claims path that
      // production depends on is the one under test here.
      return json(res, 200, openSession(account).body);
    }

    if (req.method === 'POST' && url.pathname === '/v1/auth/google') {
      if (String(body.id_token ?? '') !== settings.googleIdToken) {
        return json(res, 401, { error: true, message: 'Google sign-in failed.' });
      }
      const email = String(body.email ?? [...accounts.keys()][0] ?? '').trim().toLowerCase();
      const account = accounts.get(email);
      if (!account) return json(res, 401, { error: true, message: 'Google sign-in failed.' });
      return json(res, 200, openSession(account).body);
    }

    if (req.method === 'POST' && url.pathname === '/v1/auth/token/refresh') {
      const presented = String(body.refresh_token ?? '');
      const replayed = spentRefreshTokens.get(presented);
      if (replayed) {
        // Refresh-token reuse. The token was valid once, so either it leaked or
        // something is replaying it — and a provider that quietly issued a new
        // pair would turn a theft into a permanent one. The whole device
        // session dies.
        const session = sessions.get(replayed);
        if (session) session.revokedAt = new Date().toISOString();
        return json(res, 401, { error: true, message: 'Refresh token reuse detected. Sign in again.' });
      }
      const session = [...sessions.values()].find((item) => item.refreshToken === presented);
      if (!session || session.revokedAt || session.refreshExpiresAt <= Date.now()) {
        return json(res, 401, { error: true, message: 'Session expired.' });
      }
      const account = [...accounts.values()].find((item) => item.id === session.userId);
      spentRefreshTokens.set(session.refreshToken, session.sid);
      session.accessToken = issueAccessToken({ sid: session.sid, subject: session.userId, ttlSeconds: settings.accessTtlSeconds });
      session.accessExpiresAt = Date.now() + settings.accessTtlSeconds * 1000;
      session.refreshToken = `rt_${crypto.randomBytes(18).toString('hex')}`;
      return json(res, 200, {
        access_token: session.accessToken,
        refresh_token: session.refreshToken,
        token_type: 'Bearer',
        expires_in: settings.accessTtlSeconds,
        user: publicUser(account),
      });
    }

    const resolved = sessionForAccessToken(bearer);

    if (req.method === 'GET' && url.pathname === '/v1/auth/me') {
      if (!resolved || resolved.reason) return json(res, 401, { error: true, message: bearerRefusal(bearer, resolved) });
      const account = [...accounts.values()].find((item) => item.id === resolved.session.userId);
      return json(res, 200, { user: publicUser(account) });
    }

    if (req.method === 'GET' && url.pathname === '/v1/auth/sessions') {
      if (!resolved || resolved.reason) return json(res, 401, { error: true, message: bearerRefusal(bearer, resolved) });
      const live = [...sessions.values()].filter((item) => !item.revokedAt && item.userId === resolved.session.userId);
      return json(res, 200, {
        sessions: live.map((item) => ({
          id: item.sid,
          current: item.sid === resolved.session.sid,
          created_at: item.createdAt,
          user_agent: 'simulator',
        })),
      });
    }

    if (req.method === 'GET' && url.pathname === `/v1/auth/products/${settings.productId}/access`) {
      if (!resolved || resolved.reason) return json(res, 401, { error: true, message: 'Session expired.' });
      // 200 with `access: false`, not 403. The live service answers this way,
      // and KukGit reads the field rather than the status — a stand-in that
      // returned 403 would let a bug in that reading pass unnoticed.
      if (state.productAccess !== 'active') {
        return json(res, 200, { product: settings.productId, status: state.productAccess, access: false });
      }
      return json(res, 200, { product: settings.productId, status: 'active', access: true });
    }

    if (req.method === 'POST' && url.pathname === '/v1/auth/logout') {
      if (resolved?.session) resolved.session.revokedAt = new Date().toISOString();
      return json(res, 200, { success: true });
    }

    return json(res, 404, { error: true, message: 'Not found.' });
  });

  return {
    server,
    settings,
    state,
    calls,
    accounts,

    async listen(port = 0, host = '127.0.0.1') {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, resolve);
      });
      return `http://${host}:${server.address().port}`;
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },

    /**
     * Ages every live access token so the next protected call has to refresh.
     *
     * The token is re-issued with a past `exp` as well as the bookkeeping being
     * moved. A real expired access token *says* it is expired, and anything
     * reading the claims locally — which is how KukGit avoids spending one of
     * twenty requests a minute — has to be able to tell.
     */
    expireAccessTokens() {
      for (const session of sessions.values()) {
        session.accessExpiresAt = Date.now() - 1000;
        session.accessToken = issueAccessToken({ sid: session.sid, subject: session.userId, ttlSeconds: -60 });
      }
    },
    /** What "sign this device out" does on the other side. */
    revokeSession(sid) {
      const session = sessions.get(sid);
      if (session) session.revokedAt = new Date().toISOString();
      return Boolean(session);
    },
    revokeAllSessions() {
      for (const session of sessions.values()) session.revokedAt = new Date().toISOString();
    },
    liveSessions() {
      return [...sessions.values()].filter((session) => !session.revokedAt).map((session) => ({ sid: session.sid, email: session.email }));
    },
    /** The current refresh token for a session, so replay can be rehearsed. */
    refreshTokenFor(sid) {
      return sessions.get(sid)?.refreshToken ?? null;
    },
    setProductAccess(status) { state.productAccess = status; },
    setOffline(offline) { state.offline = Boolean(offline); },
    /** Fills the bucket, so the next request is refused with a 429. */
    exhaustRateLimit() {
      const nowMs = Date.now();
      window.length = 0;
      for (let index = 0; index < (settings.rateLimitPerMinute || 0); index += 1) window.push(nowMs);
    },
    clearRateLimit() { window.length = 0; },
  };
}
