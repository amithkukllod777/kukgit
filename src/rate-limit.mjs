// Request rate limiting for the public and authenticated surfaces.
//
// KukGit has no runtime npm dependencies and no Redis, so this is an in-process
// token bucket. That is honest about its scope: limits are per instance, not per
// cluster. Running two instances behind a load balancer doubles the effective
// allowance. The single-node caveat is documented in SECURITY.md and
// docs/DEPLOYMENT.md alongside the other per-process limitations.
//
// Token bucket rather than a fixed window: a fixed window lets a caller spend a
// full allowance at the end of one window and again at the start of the next,
// which is exactly the burst an abuse control is supposed to stop. Refill is
// lazy — computed on read — so there are no timers per key.

import { currentRequestIdentity } from './identity-context.mjs';
import { parseCookies, hashToken } from './security.mjs';

export const RATE_LIMIT_SURFACES = Object.freeze(['auth', 'api', 'git', 'invitation', 'webhook', 'abuse']);

// Buckets idle for longer than this are dropped by the sweep, so memory tracks
// active callers rather than every caller ever seen.
const IDLE_EVICTION_MS = 10 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 1000;
// Hard ceiling on tracked keys. Past this the sweep runs early; if that is not
// enough the limiter fails closed for new keys rather than growing without bound.
const MAX_TRACKED_KEYS = 50000;

export function createTokenBucketStore({ now = () => Date.now() } = {}) {
  const buckets = new Map();

  function take(key, capacity, refillPerMs, cost = 1) {
    const timestamp = now();
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { tokens: capacity, updatedAt: timestamp };
      buckets.set(key, bucket);
    } else {
      const elapsed = Math.max(0, timestamp - bucket.updatedAt);
      bucket.tokens = Math.min(capacity, bucket.tokens + elapsed * refillPerMs);
      bucket.updatedAt = timestamp;
    }

    if (bucket.tokens >= cost) {
      bucket.tokens -= cost;
      return {
        allowed: true,
        remaining: Math.floor(bucket.tokens),
        // Seconds until the bucket is full again, for the RateLimit-Reset header.
        resetSeconds: Math.ceil((capacity - bucket.tokens) / (refillPerMs * 1000)) || 0,
      };
    }

    const deficit = cost - bucket.tokens;
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: Math.max(1, Math.ceil(deficit / (refillPerMs * 1000))),
      resetSeconds: Math.ceil((capacity - bucket.tokens) / (refillPerMs * 1000)),
    };
  }

  function sweep() {
    const cutoff = now() - IDLE_EVICTION_MS;
    for (const [key, bucket] of buckets) {
      if (bucket.updatedAt < cutoff) buckets.delete(key);
    }
  }

  return {
    take,
    sweep,
    size: () => buckets.size,
    keys: () => buckets.keys(),
    clear: () => buckets.clear(),
  };
}

// Resolves the address to attribute an anonymous request to.
//
// X-Forwarded-For is attacker-controlled unless a trusted proxy overwrote it, so
// it is only consulted when KUKGIT_TRUST_PROXY is set. Reading it by default
// would let any caller forge a fresh identity per request and bypass every limit
// here. With it off behind a proxy the opposite happens — every request appears
// to come from the proxy and shares one bucket — which is why deployments that
// use the bundled nginx template must set it.
export function clientAddress(req, { trustProxy = false } = {}) {
  if (trustProxy) {
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (forwarded) return forwarded;
  }
  return req.socket?.remoteAddress || 'unknown';
}

// Chooses the surface a request belongs to. Order matters: the most specific and
// most abusable surfaces are matched first.
export function surfaceForRequest(method, pathname) {
  // Liveness and readiness are never limited. A load balancer polls them
  // continuously from one address, and a `429` would tell it the instance is
  // unhealthy — the limiter would take the instance out of rotation rather than
  // protect it. Both return fixed, tiny payloads and touch no user data.
  if (pathname === '/api/health' || pathname === '/api/health/ready') return null;
  if (/^\/git\//.test(pathname)) return 'git';
  if (/^\/api\/auth\/(login|signup|otp\/request|otp\/verify|google)$/.test(pathname)) return 'auth';
  // Verification and reset belong here, not on the general API surface. Two of
  // them send real email to an address the caller names, and the general limit
  // is set for reading pages.
  if (/^\/api\/account\/(verify-email|password-reset|phone)\//.test(pathname)) return 'auth';
  // Starting and finishing a provider sign-in. `start` writes a row and
  // `callback` makes two calls out to GitHub or Google, so an unlimited loop
  // over either is both a database filling up and this instance hammering
  // somebody else's API from one address.
  if (/^\/api\/auth\/[a-z]+\/(start|callback)$/.test(pathname)) return 'auth';
  // Six digits is a small space. Without a limit here, the second factor is
  // worth about twenty minutes of guessing.
  if (pathname === '/api/auth/two-factor') return 'auth';
  if (pathname.startsWith('/api/account/two-factor')) return 'auth';
  // Before the general API surface, and before the method check, so a flood of
  // reports is limited whichever verb it arrives with.
  if (pathname === '/api/abuse/reports') return 'abuse';
  if (method === 'POST' || method === 'PATCH' || method === 'PUT') {
    if (/^\/api\/collaboration\/orgs\/[^/]+\/invitations/.test(pathname)) return 'invitation';
    if (/^\/api\/repository-invitations\//.test(pathname)) return 'invitation';
    if (/^\/api\/webhooks\//.test(pathname)) return 'webhook';
  }
  if (pathname.startsWith('/api/')) return 'api';
  return null;
}

// Identity for the bucket key. An authenticated caller is limited as a person, so
// one abusive account cannot be masked by rotating source addresses, and a shared
// office address does not throttle everyone behind it. Anonymous callers fall
// back to the address.
function identityKey(req, config) {
  const identity = currentRequestIdentity();
  if (identity?.user?.id) return `user:${identity.user.id}`;

  // Git HTTP and SSH-issued flows bypass the identity middleware, but they do
  // carry a credential. Key on a hash of it so distinct tokens get distinct
  // buckets without the secret ever entering the key space.
  const authorization = String(req.headers.authorization || '');
  if (authorization.startsWith('Basic ') || authorization.startsWith('Bearer ')) {
    return `cred:${hashToken(authorization).slice(0, 32)}`;
  }
  const session = parseCookies(req.headers.cookie).kukgit_session;
  if (session) return `sess:${hashToken(session).slice(0, 32)}`;

  return `ip:${clientAddress(req, { trustProxy: config.rateLimitTrustProxy })}`;
}

function sendTooManyRequests(res, { surface, retryAfterSeconds, limit, resetSeconds }) {
  const body = JSON.stringify({
    error: {
      code: 'RATE_LIMITED',
      message: 'Too many requests. Slow down and retry shortly.',
      surface,
      retryAfterSeconds,
    },
  });
  res.writeHead(429, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'Retry-After': String(retryAfterSeconds),
    'RateLimit-Limit': String(limit),
    'RateLimit-Remaining': '0',
    'RateLimit-Reset': String(resetSeconds),
  });
  res.end(body);
  return true;
}

export function createRateLimitGuard({ config, next, store = createTokenBucketStore() }) {
  const limits = config.rateLimits;
  let sweepTimer = null;
  if (config.rateLimitEnabled) {
    sweepTimer = setInterval(() => store.sweep(), SWEEP_INTERVAL_MS);
    sweepTimer.unref?.();
  }

  async function rateLimitGuard(req, res) {
    if (!config.rateLimitEnabled) return next(req, res);

    let pathname;
    try {
      pathname = new URL(req.url, config.baseUrl).pathname;
    } catch {
      return next(req, res);
    }

    const surface = surfaceForRequest(String(req.method || 'GET').toUpperCase(), pathname);
    if (!surface) return next(req, res);

    const limit = limits[surface];
    if (!limit || limit.perMinute <= 0) return next(req, res);

    // Bound memory before adding a key rather than after.
    if (store.size() >= MAX_TRACKED_KEYS) store.sweep();

    const key = `${surface}:${identityKey(req, config)}`;
    const refillPerMs = limit.perMinute / 60000;
    const result = store.take(key, limit.burst, refillPerMs);

    if (!result.allowed) {
      return sendTooManyRequests(res, {
        surface,
        retryAfterSeconds: result.retryAfterSeconds,
        limit: limit.perMinute,
        resetSeconds: result.resetSeconds,
      });
    }

    res.setHeader('RateLimit-Limit', String(limit.perMinute));
    res.setHeader('RateLimit-Remaining', String(result.remaining));
    res.setHeader('RateLimit-Reset', String(result.resetSeconds));
    return next(req, res);
  }

  rateLimitGuard.stop = () => {
    if (sweepTimer) clearInterval(sweepTimer);
  };
  rateLimitGuard.store = store;
  return rateLimitGuard;
}
