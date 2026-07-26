import { currentUser } from './auth.mjs';
import {
  REPOSITORY_PERMISSIONS,
  permissionAtLeast,
  requireRepositoryAccess,
} from './repository-access.mjs';
import { httpError } from './security.mjs';

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

function route(pathname) {
  const match = pathname.match(/^\/api\/repository-access\/([^/]+)\/([^/]+)$/);
  if (!match) return null;
  try {
    return { orgSlug: decodeURIComponent(match[1]), repoSlug: decodeURIComponent(match[2]) };
  } catch {
    throw httpError(400, 'Invalid repository access path.', 'INVALID_PATH');
  }
}

function externalCollaborators(db, access) {
  return db.prepare(`
    SELECT u.id AS userId, u.email, u.display_name AS displayName,
      c.permission, c.created_at AS createdAt, c.updated_at AS updatedAt,
      added.display_name AS addedByName, 1 AS isExternal
    FROM repository_collaborators c
    JOIN users u ON u.id = c.user_id
    JOIN users added ON added.id = c.added_by
    LEFT JOIN org_members om
      ON om.organization_id = ? AND om.user_id = u.id
    WHERE c.repository_id = ? AND om.user_id IS NULL
    ORDER BY u.display_name
  `).all(access.repository.organizationId, access.repository.id)
    .map((row) => ({ ...row, isExternal: true, organizationRole: null }));
}

export function createExternalCollaboratorAccessPrivacyApiHandler({ config, db }) {
  return async function externalCollaboratorAccessPrivacyApi(req, res) {
    if (req.method !== 'GET') return false;
    const url = new URL(req.url, config.baseUrl);
    const reference = route(url.pathname);
    if (!reference) return false;
    const user = currentUser(db, req);
    if (!user) return false;
    try {
      const access = requireRepositoryAccess(db, user.id, reference, 'read');
      if (!access.isExternalCollaborator) return false;
      return sendJson(res, 200, {
        repository: access.repository,
        effectivePermission: access.permission,
        permissionSources: access.sources,
        isOrganizationMember: false,
        isExternalCollaborator: true,
        canManage: permissionAtLeast(access.permission, 'admin'),
        availablePermissions: REPOSITORY_PERMISSIONS,
        members: [],
        collaborators: externalCollaborators(db, access),
        teams: [],
        teamGrants: [],
        organizationDirectoryHidden: true,
      });
    } catch (error) {
      const status = Number(error.status) || 500;
      return sendJson(res, status, {
        error: {
          code: error.code || 'INTERNAL_ERROR',
          message: status >= 500 ? 'An unexpected server error occurred.' : error.message,
        },
      });
    }
  };
}
