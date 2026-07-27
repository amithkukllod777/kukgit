import { requireUser } from './auth.mjs';
import { audit, uid } from './db.mjs';
import { requireRepositoryAccess } from './repository-access.mjs';
import { httpError, originAllowed } from './security.mjs';

const ACCESS_DAYS = new Set([7, 30, 90, 180, 365]);
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
    if (size > MAX_BODY_BYTES) throw httpError(413, 'Invitation access request is too large.', 'EXTERNAL_ACCESS_REQUEST_TOO_LARGE');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw httpError(400, 'Invalid JSON request body.', 'INVALID_JSON'); }
}

function routeMatch(pathname) {
  const match = pathname.match(/^\/api\/external-access-invitations\/([^/]+)\/([^/]+)\/([^/]+)\/duration$/);
  if (!match) return null;
  try {
    return {
      org: decodeURIComponent(match[1]),
      repo: decodeURIComponent(match[2]),
      invitationId: decodeURIComponent(match[3]),
    };
  } catch {
    throw httpError(400, 'Invalid request path.', 'INVALID_PATH');
  }
}

export function createExternalAccessInvitationDurationApiHandler({ config, db }) {
  return async function externalAccessInvitationDurationApi(req, res) {
    const url = new URL(req.url, config.baseUrl);
    const params = routeMatch(url.pathname);
    if (!params) return false;
    const requestId = uid('req');
    res.setHeader('X-Request-Id', requestId);
    res.setHeader('Referrer-Policy', 'no-referrer');
    try {
      if (!originAllowed(req, config.baseUrl)) throw httpError(403, 'Request origin is not allowed.', 'CSRF_BLOCKED');
      const user = requireUser(db, req);
      const access = requireRepositoryAccess(db, user.id, { orgSlug: params.org, repoSlug: params.repo }, 'admin');
      if (req.method !== 'PATCH') throw httpError(405, 'Use PATCH to set invitation access duration.', 'METHOD_NOT_ALLOWED');
      const body = await readJson(req);
      const accessDurationDays = Number(body.accessDurationDays ?? 90);
      if (!ACCESS_DAYS.has(accessDurationDays)) {
        throw httpError(400, 'Access duration must be 7, 30, 90, 180 or 365 days.', 'EXTERNAL_ACCESS_DURATION_INVALID');
      }
      const invitation = db.prepare(`
        SELECT id, email, permission, accepted_at AS acceptedAt, revoked_at AS revokedAt,
          expires_at AS invitationExpiresAt, access_duration_days AS accessDurationDays
        FROM repository_invitations
        WHERE id = ? AND repository_id = ?
      `).get(params.invitationId, access.repository.id);
      if (!invitation) throw httpError(404, 'Repository invitation not found.', 'REPOSITORY_INVITATION_NOT_FOUND');
      if (invitation.acceptedAt) throw httpError(409, 'Accepted invitation access duration cannot be changed.', 'REPOSITORY_INVITATION_ACCEPTED');
      if (invitation.revokedAt) throw httpError(410, 'Revoked invitation access duration cannot be changed.', 'REPOSITORY_INVITATION_REVOKED');
      const result = db.prepare(`
        UPDATE repository_invitations SET access_duration_days = ?
        WHERE id = ? AND repository_id = ? AND accepted_at IS NULL AND revoked_at IS NULL
      `).run(accessDurationDays, invitation.id, access.repository.id);
      if (!result.changes) throw httpError(409, 'Repository invitation is no longer available.', 'REPOSITORY_INVITATION_UNAVAILABLE');
      audit(db, {
        organizationId: access.repository.organizationId,
        userId: user.id,
        action: 'repository_invitation.access_duration_set',
        targetType: 'repository_invitation',
        targetId: invitation.id,
        metadata: {
          repositoryId: access.repository.id,
          email: invitation.email,
          permission: invitation.permission,
          accessDurationDays,
        },
      });
      return sendJson(res, 200, {
        invitation: {
          ...invitation,
          accessDurationDays,
        },
      });
    } catch (error) {
      const status = Number(error.status) || 500;
      if (status >= 500) console.error(`[${requestId}] external invitation duration API`, error);
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
