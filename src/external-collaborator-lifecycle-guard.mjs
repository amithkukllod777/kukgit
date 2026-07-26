import { requireUser } from './auth.mjs';
import { uid } from './db.mjs';
import { httpError, originAllowed } from './security.mjs';

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

function highRiskRoute(pathname, method) {
  if (method !== 'POST') return null;
  const match = pathname.match(/^\/api\/repository-lifecycle\/([^/]+)\/([^/]+)\/(transfer|trash)$/);
  if (!match) return null;
  try {
    return {
      orgSlug: decodeURIComponent(match[1]),
      repoSlug: decodeURIComponent(match[2]),
      action: match[3],
    };
  } catch {
    throw httpError(400, 'Invalid repository lifecycle path.', 'INVALID_PATH');
  }
}

export function createExternalCollaboratorLifecycleGuard({ config, db }) {
  return async function externalCollaboratorLifecycleGuard(req, res) {
    const url = new URL(req.url, config.baseUrl);
    const route = highRiskRoute(url.pathname, String(req.method || 'GET').toUpperCase());
    if (!route) return false;
    const requestId = uid('req');
    res.setHeader('X-Request-Id', requestId);
    try {
      if (!originAllowed(req, config.baseUrl)) throw httpError(403, 'Request origin is not allowed.', 'CSRF_BLOCKED');
      const user = requireUser(db, req);
      const membership = db.prepare(`
        SELECT om.role
        FROM organizations o
        JOIN org_members om ON om.organization_id = o.id
        WHERE o.slug = ? AND om.user_id = ?
      `).get(route.orgSlug, user.id);
      if (!membership || !['owner', 'admin'].includes(membership.role)) {
        throw httpError(
          403,
          `Organization Admin or Owner membership is required to ${route.action === 'transfer' ? 'transfer' : 'move'} this repository${route.action === 'trash' ? ' to Trash' : ''}.`,
          'ORGANIZATION_ADMIN_REQUIRED',
        );
      }
      return false;
    } catch (error) {
      const status = Number(error.status) || 500;
      if (status >= 500) console.error(`[${requestId}] external lifecycle authority`, error);
      return sendJson(res, status, {
        error: {
          code: error.code || 'INTERNAL_ERROR',
          message: status >= 500 ? 'An unexpected server error occurred.' : error.message,
          requestId,
        },
      });
    }
  };
}
