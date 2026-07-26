import {
  authKitSessionCookie,
  createAuthKitBridgeSession,
  requestAuthKit,
} from './authkit-identity.mjs';
import { audit, uid } from './db.mjs';
import { httpError, originAllowed } from './security.mjs';

const MAX_BODY_BYTES = 64 * 1024;
const AUTH_ROUTES = new Map([
  ['/api/auth/login', '/v1/auth/login'],
  ['/api/auth/signup', '/v1/auth/signup'],
  ['/api/auth/otp/verify', '/v1/auth/otp/verify'],
  ['/api/auth/google', '/v1/auth/google'],
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

function upstreamBody(pathname, body) {
  if (pathname === '/api/auth/login') {
    return { identifier: body.identifier ?? body.email, password: body.password };
  }
  if (pathname === '/api/auth/signup') {
    return {
      full_name: body.full_name ?? body.fullName,
      identifier: body.identifier ?? body.email,
      phone: body.phone,
      password: body.password,
    };
  }
  if (pathname === '/api/auth/otp/verify') {
    return { identifier: body.identifier ?? body.email, code: body.code ?? body.otp };
  }
  return { id_token: body.id_token ?? body.idToken };
}

function verifiedUser(payload) {
  const user = payload?.user;
  if (!user || typeof user !== 'object') {
    throw httpError(502, 'AuthKit returned an invalid user identity.', 'AUTHKIT_USER_INVALID');
  }
  if (user.email_verified !== true && user.email_verified !== 1) {
    throw httpError(403, 'Verify your Kuklabs Account email before using KukGit.', 'AUTHKIT_EMAIL_NOT_VERIFIED');
  }
  return user;
}

async function preflightProductAccess(config, accessToken) {
  const { response, payload } = await requestAuthKit(
    config,
    `/v1/auth/products/${encodeURIComponent(config.authkitProductId)}/access`,
    { accessToken },
  );
  if (response.status === 401) {
    throw httpError(401, 'Kuklabs Account session expired.', 'AUTHKIT_SESSION_EXPIRED');
  }
  if (!response.ok || payload?.access === false || ['blocked', 'inactive', 'suspended'].includes(payload?.status)) {
    throw httpError(403, 'Your Kuklabs Account does not have access to KukGit.', 'KUKGIT_PRODUCT_ACCESS_DENIED');
  }
}

function upstreamError(response, payload) {
  const code = payload?.status === 'otp_required' ? 'OTP_REQUIRED' : 'AUTHKIT_REQUEST_FAILED';
  return {
    status: response.status,
    payload: {
      error: { code, message: payload?.message || 'Kuklabs Account request failed.' },
      status: payload?.status,
      identifier: payload?.identifier,
    },
  };
}

export function createSecureAuthKitLoginApiHandler({ config, db }) {
  return async function secureAuthKitLoginApi(req, res) {
    if (config.authMode !== 'authkit' || req.method !== 'POST') return false;
    const url = new URL(req.url, config.baseUrl);
    const upstreamRoute = AUTH_ROUTES.get(url.pathname);
    if (!upstreamRoute) return false;

    const requestId = uid('req');
    res.setHeader('X-Request-Id', requestId);
    res.setHeader('Referrer-Policy', 'no-referrer');

    try {
      if (!originAllowed(req, config.baseUrl)) {
        throw httpError(403, 'Request origin is not allowed.', 'CSRF_BLOCKED');
      }
      const body = await readJson(req);
      const { response, payload } = await requestAuthKit(config, upstreamRoute, {
        method: 'POST',
        body: upstreamBody(url.pathname, body),
      });
      if (!response.ok) {
        const upstream = upstreamError(response, payload);
        return sendJson(res, upstream.status, upstream.payload);
      }

      verifiedUser(payload);
      const accessToken = String(payload?.access_token || '');
      if (!accessToken) throw httpError(502, 'AuthKit returned an invalid token bundle.', 'AUTHKIT_TOKEN_BUNDLE_INVALID');
      await preflightProductAccess(config, accessToken);

      const session = await createAuthKitBridgeSession(db, config, payload);
      audit(db, {
        userId: session.user.id,
        action: 'auth.authkit_login',
        targetType: 'user',
        targetId: session.user.id,
        metadata: {
          product: config.authkitProductId,
          kuklabsUserId: session.user.kuklabsUserId,
          method: url.pathname.split('/').at(-1),
        },
      });
      return sendJson(res, 200, { user: session.user, authMode: 'authkit' }, {
        'Set-Cookie': authKitSessionCookie(session.browserToken, config),
      });
    } catch (error) {
      const status = Number(error.status) || 500;
      return sendJson(res, status, {
        error: {
          code: error.code || 'AUTHKIT_INTERNAL_ERROR',
          message: status >= 500 ? 'Kuklabs Account is temporarily unavailable.' : error.message,
          requestId,
        },
      });
    }
  };
}
