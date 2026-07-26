import { requireUser } from './auth.mjs';
import { audit, uid } from './db.mjs';
import { httpError, originAllowed } from './security.mjs';
import {
  createPersonalAccessToken,
  listPersonalAccessTokens,
  PERSONAL_ACCESS_TOKEN_SCOPES,
  revokePersonalAccessToken,
} from './tokens.mjs';

const MAX_BODY_BYTES = 64 * 1024;
const ALLOWED_EXPIRY_DAYS = new Set([7, 30, 60, 90, 180, 365]);

function sendJson(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw httpError(413, 'Request body is too large.', 'TOKEN_REQUEST_TOO_LARGE');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw httpError(400, 'Invalid JSON request body.', 'INVALID_JSON');
  }
}

function tokenIdFromPath(pathname) {
  const prefix = '/api/settings/tokens/';
  if (!pathname.startsWith(prefix)) return null;
  const value = decodeURIComponent(pathname.slice(prefix.length));
  if (!/^pat_[a-f0-9]{32}$/i.test(value)) throw httpError(400, 'Invalid personal access token identifier.', 'TOKEN_ID_INVALID');
  return value;
}

function resolveExpiry(body) {
  if (body.expiresAt) return body.expiresAt;
  const days = Number(body.expiresInDays ?? 90);
  if (!ALLOWED_EXPIRY_DAYS.has(days)) {
    throw httpError(400, 'Token expiry must be 7, 30, 60, 90, 180 or 365 days.', 'TOKEN_EXPIRY_INVALID');
  }
  return new Date(Date.now() + days * 86400000).toISOString();
}

function isTokenPath(pathname) {
  return pathname === '/api/settings/tokens' || pathname.startsWith('/api/settings/tokens/');
}

export function createTokenApiHandler({ config, db }) {
  return async function handleTokenApi(req, res) {
    const url = new URL(req.url, config.baseUrl);
    const pathname = url.pathname;
    if (!isTokenPath(pathname)) return false;

    const requestId = uid('req');
    res.setHeader('X-Request-Id', requestId);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');

    try {
      if (!originAllowed(req, config.baseUrl)) {
        throw httpError(403, 'Request origin is not allowed.', 'CSRF_BLOCKED');
      }
      const user = requireUser(db, req);

      if (req.method === 'GET' && pathname === '/api/settings/tokens') {
        return sendJson(res, 200, {
          availableScopes: PERSONAL_ACCESS_TOKEN_SCOPES,
          tokens: listPersonalAccessTokens(db, user.id),
        });
      }

      if (req.method === 'POST' && pathname === '/api/settings/tokens') {
        const body = await readJson(req);
        const created = createPersonalAccessToken(db, user.id, {
          name: body.name,
          scopes: body.scopes,
          expiresAt: resolveExpiry(body),
        });
        audit(db, {
          userId: user.id,
          action: 'personal_access_token.created',
          targetType: 'personal_access_token',
          targetId: created.id,
          metadata: { name: created.name, scopes: created.scopes, expiresAt: created.expiresAt },
        });
        return sendJson(res, 201, {
          token: created,
          warning: 'Copy this token now. KukGit will not show the full value again.',
        });
      }

      const tokenId = tokenIdFromPath(pathname);
      if (req.method === 'DELETE' && tokenId) {
        const revoked = revokePersonalAccessToken(db, user.id, tokenId);
        audit(db, {
          userId: user.id,
          action: 'personal_access_token.revoked',
          targetType: 'personal_access_token',
          targetId: revoked.id,
          metadata: { name: revoked.name, tokenPrefix: revoked.tokenPrefix },
        });
        return sendJson(res, 200, { token: revoked });
      }

      throw httpError(404, 'Token API endpoint not found.', 'NOT_FOUND');
    } catch (error) {
      const status = Number(error.status) || 500;
      if (status >= 500) console.error(`[${requestId}] token API`, error);
      if (!res.headersSent) {
        sendJson(res, status, {
          error: {
            code: error.code || 'INTERNAL_ERROR',
            message: status >= 500 ? 'An unexpected server error occurred.' : error.message,
            requestId,
          },
        });
      } else {
        res.end();
      }
    }
    return true;
  };
}
