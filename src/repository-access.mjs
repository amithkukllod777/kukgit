import { currentUser, requireUser } from './auth.mjs';
import { runWithRepositoryAccess } from './access-context.mjs';
import { audit, uid } from './db.mjs';
import { httpError, originAllowed } from './security.mjs';
import { recordSupportAccess, supportGrantFor } from './support-access.mjs';

export const REPOSITORY_PERMISSIONS = Object.freeze(['read', 'triage', 'write', 'maintain', 'admin']);
const PERMISSION_RANK = Object.freeze({ none: 0, read: 1, triage: 2, write: 3, maintain: 4, admin: 5 });
const ORGANIZATION_BASELINE = Object.freeze({ viewer: 'read', developer: 'write', maintainer: 'maintain', admin: 'admin', owner: 'admin' });
const MAX_BODY_BYTES = 64 * 1024;

export function migrateRepositoryAccess(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS repository_collaborators (
      repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      permission TEXT NOT NULL CHECK(permission IN ('read','triage','write','maintain','admin')),
      added_by TEXT NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (repository_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS repository_team_grants (
      repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
      team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      permission TEXT NOT NULL CHECK(permission IN ('read','triage','write','maintain','admin')),
      added_by TEXT NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (repository_id, team_id)
    );
    CREATE INDEX IF NOT EXISTS idx_repo_collaborators_user
      ON repository_collaborators(user_id, repository_id);
    CREATE INDEX IF NOT EXISTS idx_repo_team_grants_team
      ON repository_team_grants(team_id, repository_id);
  `);
}

export function permissionAtLeast(actual, required) {
  return (PERMISSION_RANK[actual] ?? 0) >= (PERMISSION_RANK[required] ?? Number.POSITIVE_INFINITY);
}

export function normalizeRepositoryPermission(value) {
  const permission = String(value ?? '').trim().toLowerCase();
  if (!REPOSITORY_PERMISSIONS.includes(permission)) {
    throw httpError(400, 'Select a valid repository permission.', 'REPOSITORY_PERMISSION_INVALID');
  }
  return permission;
}

function maxPermission(values) {
  return values.reduce((best, value) => permissionAtLeast(value, best) ? value : best, 'none');
}

// Whether this database has the abuse-disable columns. Cached only once true,
// because a column that exists does not go away — while a database that has not
// run the migration yet is asked again rather than remembered as missing.
const ABUSE_COLUMNS = new WeakSet();

function abuseColumnsPresent(db) {
  if (ABUSE_COLUMNS.has(db)) return true;
  const present = db.prepare('PRAGMA table_info(repositories)').all()
    .some((row) => String(row.name) === 'abuse_disabled_at');
  if (present) ABUSE_COLUMNS.add(db);
  return present;
}

function findRepository(db, { repositoryId, orgSlug, repoSlug }) {
  const abuse = abuseColumnsPresent(db)
    ? ', r.abuse_disabled_at AS abuseDisabledAt, r.abuse_disabled_reason AS abuseDisabledReason'
    : '';
  const columns = `r.id, r.slug, r.name, r.visibility, r.organization_id AS organizationId,
      o.slug AS orgSlug, o.name AS orgName${abuse}`;
  if (repositoryId) {
    return db.prepare(`
      SELECT ${columns}
      FROM repositories r JOIN organizations o ON o.id = r.organization_id
      WHERE r.id = ? AND r.deleted_at IS NULL
    `).get(repositoryId);
  }
  return db.prepare(`
    SELECT ${columns}
    FROM repositories r JOIN organizations o ON o.id = r.organization_id
    WHERE o.slug = ? AND r.slug = ? AND r.deleted_at IS NULL
  `).get(orgSlug, repoSlug);
}

export function getEffectiveRepositoryAccess(db, { userId, repositoryId, orgSlug, repoSlug }) {
  const repository = findRepository(db, { repositoryId, orgSlug, repoSlug });
  if (!repository) return null;

  // Disabled for abuse: nobody reads it, including its owners, until an operator
  // puts it back. Enforced here rather than per transport, because HTTP, Git and
  // LFS all resolve through this function and a check in three places is a check
  // that gets forgotten in one.
  //
  // The bytes are untouched and the flag is a single column, so reinstating is
  // one statement. That is the point: the alternative to a reversible disable is
  // either doing nothing about hosted malware or deleting somebody's work on the
  // strength of a report form.
  if (repository.abuseDisabledAt) {
    return {
      repository,
      organizationRole: null,
      permission: 'none',
      sources: [],
      isExternalCollaborator: false,
      supportAccess: null,
      disabled: { at: repository.abuseDisabledAt, reason: repository.abuseDisabledReason ?? null },
    };
  }

  const membership = db.prepare(`
    SELECT role FROM org_members WHERE organization_id = ? AND user_id = ?
  `).get(repository.organizationId, userId);
  const sources = [];
  if (membership) {
    sources.push({
      type: 'organization',
      id: repository.organizationId,
      name: repository.orgName,
      permission: ORGANIZATION_BASELINE[membership.role] ?? 'none',
      role: membership.role,
    });
  }

  const direct = db.prepare(`
    SELECT permission FROM repository_collaborators WHERE repository_id = ? AND user_id = ?
  `).get(repository.id, userId);
  if (direct) {
    sources.push({
      type: 'direct',
      id: userId,
      name: membership ? 'Direct collaborator' : 'External collaborator',
      permission: direct.permission,
      external: !membership,
    });
  }

  const teamSources = db.prepare(`
    SELECT t.id, t.slug, t.name, g.permission, tm.role AS teamRole
    FROM repository_team_grants g
    JOIN teams t ON t.id = g.team_id
    JOIN team_members tm ON tm.team_id = t.id AND tm.user_id = ?
    WHERE g.repository_id = ?
    ORDER BY t.name
  `).all(userId, repository.id);
  for (const team of teamSources) {
    sources.push({ type: 'team', id: team.id, slug: team.slug, name: team.name, permission: team.permission, teamRole: team.teamRole });
  }

  // A KukGit support operator the customer has given temporary access to. Last,
  // and always `read`: the grant exists so somebody can look at a problem, and
  // an escalation path that can also write is a way to change a customer's
  // repository with nobody in the organization having agreed to it.
  //
  // It is a *source*, not a bypass, so it shows up wherever access is explained
  // — the customer can see why a request was allowed and by whose grant.
  if (!membership) {
    const grant = supportGrantFor(db, { userId, organizationId: repository.organizationId, repositoryId: repository.id });
    if (grant) {
      recordSupportAccess(db, { grantId: grant.id, repositoryId: repository.id });
      sources.push({
        type: 'support',
        id: grant.id,
        name: `KukGit support (${grant.operatorEmail})`,
        permission: 'read',
        expiresAt: grant.expiresAt,
        reason: grant.reason,
      });
    }
  }

  return {
    repository,
    organizationRole: membership?.role ?? null,
    permission: maxPermission(sources.map((source) => source.permission)),
    sources,
    isExternalCollaborator: !membership && Boolean(direct),
    supportAccess: sources.find((source) => source.type === 'support') ?? null,
  };
}

export function requireRepositoryAccess(db, userId, reference, requiredPermission = 'read') {
  const access = getEffectiveRepositoryAccess(db, { userId, ...reference });
  if (!access?.repository) throw httpError(404, 'Repository not found.', 'REPO_NOT_FOUND');
  if (access.disabled) {
    // The reason goes to somebody who belongs to the organization and to nobody
    // else. A repository that stops working with no message is indistinguishable
    // from an outage, and its owner is the only person who can fix what caused
    // it — but "disabled for abuse" is not a fact to hand a passing stranger.
    const member = db.prepare('SELECT 1 AS found FROM org_members WHERE organization_id = ? AND user_id = ?')
      .get(access.repository.organizationId, userId);
    if (!member) throw httpError(404, 'Repository not found.', 'REPO_NOT_FOUND');
    throw httpError(403, `This repository is disabled pending an abuse review. ${access.disabled.reason ?? ''}`.trim(), 'REPOSITORY_DISABLED');
  }
  if (!permissionAtLeast(access.permission, requiredPermission)) {
    // 404 when the caller has no access at all to a repository that is not
    // public — because 403 confirms it exists, and its organization and slug
    // are in the URL that produced the answer. That is enough to enumerate
    // what a private organization owns by asking, one name at a time.
    //
    // 403 in the other two cases, deliberately. A public repository's
    // existence is public, so hiding it teaches nothing and confuses somebody
    // who can see it in a browser. And a caller who already has *some* access
    // and is missing a stronger permission has been told the repository exists
    // by the fact that they can read it — "write permission is required" is
    // the useful answer there, and "not found" would be a lie they can
    // disprove by refreshing the page.
    //
    // The same reasoning the abuse-disabled branch above already follows:
    // a fact about a private repository is not a fact to hand a stranger.
    if (access.permission === 'none' && access.repository.visibility !== 'public') {
      throw httpError(404, 'Repository not found.', 'REPO_NOT_FOUND');
    }
    throw httpError(403, `Repository ${requiredPermission} permission is required.`, 'REPOSITORY_ACCESS_DENIED');
  }
  return access;
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

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw httpError(413, 'Request body is too large.', 'REPOSITORY_ACCESS_REQUEST_TOO_LARGE');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw httpError(400, 'Invalid JSON request body.', 'INVALID_JSON');
  }
}

function routeMatch(pathname, pattern) {
  const keys = [];
  const regex = new RegExp('^' + pattern.replace(/:([A-Za-z0-9_]+)/g, (_, key) => {
    keys.push(key);
    return '([^/]+)';
  }) + '$');
  const match = pathname.match(regex);
  if (!match) return null;
  try {
    return Object.fromEntries(keys.map((key, index) => [key, decodeURIComponent(match[index + 1])]));
  } catch {
    throw httpError(400, 'Invalid request path.', 'INVALID_PATH');
  }
}

function listRepositoryAccess(db, access) {
  const repository = access.repository;
  const members = db.prepare(`
    SELECT u.id, u.email, u.display_name AS displayName, om.role AS organizationRole,
      c.permission AS directPermission
    FROM org_members om JOIN users u ON u.id = om.user_id
    LEFT JOIN repository_collaborators c ON c.repository_id = ? AND c.user_id = u.id
    WHERE om.organization_id = ?
    ORDER BY u.display_name
  `).all(repository.id, repository.organizationId);

  const collaborators = db.prepare(`
    SELECT u.id AS userId, u.email, u.display_name AS displayName,
      om.role AS organizationRole, c.permission, c.created_at AS createdAt,
      c.updated_at AS updatedAt, added.display_name AS addedByName,
      CASE WHEN om.user_id IS NULL THEN 1 ELSE 0 END AS isExternal
    FROM repository_collaborators c
    JOIN users u ON u.id = c.user_id
    LEFT JOIN org_members om ON om.organization_id = ? AND om.user_id = u.id
    JOIN users added ON added.id = c.added_by
    WHERE c.repository_id = ?
    ORDER BY isExternal DESC, u.display_name
  `).all(repository.organizationId, repository.id).map((row) => ({ ...row, isExternal: Boolean(row.isExternal) }));

  const teams = db.prepare(`
    SELECT t.id, t.slug, t.name, t.description,
      COUNT(tm.user_id) AS memberCount, g.permission AS repositoryPermission
    FROM teams t
    LEFT JOIN team_members tm ON tm.team_id = t.id
    LEFT JOIN repository_team_grants g ON g.repository_id = ? AND g.team_id = t.id
    WHERE t.organization_id = ?
    GROUP BY t.id
    ORDER BY t.name
  `).all(repository.id, repository.organizationId);

  const teamGrants = db.prepare(`
    SELECT t.id AS teamId, t.slug, t.name, g.permission,
      g.created_at AS createdAt, g.updated_at AS updatedAt,
      COUNT(tm.user_id) AS memberCount, added.display_name AS addedByName
    FROM repository_team_grants g
    JOIN teams t ON t.id = g.team_id
    LEFT JOIN team_members tm ON tm.team_id = t.id
    JOIN users added ON added.id = g.added_by
    WHERE g.repository_id = ?
    GROUP BY t.id, g.permission, g.created_at, g.updated_at, added.display_name
    ORDER BY t.name
  `).all(repository.id);

  return {
    repository,
    effectivePermission: access.permission,
    permissionSources: access.sources,
    isOrganizationMember: Boolean(access.organizationRole),
    isExternalCollaborator: Boolean(access.isExternalCollaborator),
    canManage: permissionAtLeast(access.permission, 'admin'),
    availablePermissions: REPOSITORY_PERMISSIONS,
    members,
    collaborators,
    teams,
    teamGrants,
  };
}

function requireManagement(db, user, orgSlug, repoSlug) {
  return requireRepositoryAccess(db, user.id, { orgSlug, repoSlug }, 'admin');
}

export function createRepositoryAccessApiHandler({ config, db }) {
  return async function handleRepositoryAccessApi(req, res) {
    const url = new URL(req.url, config.baseUrl);
    const pathname = url.pathname;
    if (!pathname.startsWith('/api/repository-access/')) return false;

    const requestId = uid('req');
    res.setHeader('X-Request-Id', requestId);
    res.setHeader('Referrer-Policy', 'no-referrer');

    try {
      if (!originAllowed(req, config.baseUrl)) throw httpError(403, 'Request origin is not allowed.', 'CSRF_BLOCKED');
      const user = requireUser(db, req);

      let params = routeMatch(pathname, '/api/repository-access/:org/:repo');
      if (req.method === 'GET' && params) {
        const access = requireRepositoryAccess(db, user.id, { orgSlug: params.org, repoSlug: params.repo }, 'read');
        return sendJson(res, 200, listRepositoryAccess(db, access));
      }

      params = routeMatch(pathname, '/api/repository-access/:org/:repo/collaborators');
      if (req.method === 'POST' && params) {
        const access = requireManagement(db, user, params.org, params.repo);
        const body = await readJson(req);
        const permission = normalizeRepositoryPermission(body.permission);
        const member = db.prepare(`
          SELECT u.id, u.email, u.display_name AS displayName
          FROM users u JOIN org_members om ON om.user_id = u.id
          WHERE u.id = ? AND om.organization_id = ?
        `).get(String(body.userId ?? ''), access.repository.organizationId);
        if (!member) throw httpError(404, 'Organization member not found.', 'ORG_MEMBER_NOT_FOUND');
        db.prepare(`
          INSERT INTO repository_collaborators (repository_id, user_id, permission, added_by)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(repository_id, user_id) DO UPDATE SET
            permission = excluded.permission, added_by = excluded.added_by, updated_at = CURRENT_TIMESTAMP
        `).run(access.repository.id, member.id, permission, user.id);
        audit(db, {
          organizationId: access.repository.organizationId,
          userId: user.id,
          action: 'repository_collaborator.granted',
          targetType: 'repository',
          targetId: access.repository.id,
          metadata: { repository: access.repository.slug, collaboratorId: member.id, email: member.email, permission },
        });
        return sendJson(res, 200, { collaborator: { ...member, permission, isExternal: false } });
      }

      params = routeMatch(pathname, '/api/repository-access/:org/:repo/collaborators/:userId');
      if (req.method === 'DELETE' && params) {
        const access = requireManagement(db, user, params.org, params.repo);
        const result = db.prepare('DELETE FROM repository_collaborators WHERE repository_id = ? AND user_id = ?')
          .run(access.repository.id, params.userId);
        if (!result.changes) throw httpError(404, 'Direct collaborator grant not found.', 'REPOSITORY_COLLABORATOR_NOT_FOUND');
        audit(db, {
          organizationId: access.repository.organizationId,
          userId: user.id,
          action: 'repository_collaborator.revoked',
          targetType: 'repository',
          targetId: access.repository.id,
          metadata: { repository: access.repository.slug, collaboratorId: params.userId },
        });
        return sendJson(res, 200, { revoked: true });
      }

      params = routeMatch(pathname, '/api/repository-access/:org/:repo/teams');
      if (req.method === 'POST' && params) {
        const access = requireManagement(db, user, params.org, params.repo);
        const body = await readJson(req);
        const permission = normalizeRepositoryPermission(body.permission);
        const team = db.prepare('SELECT id, slug, name FROM teams WHERE id = ? AND organization_id = ?')
          .get(String(body.teamId ?? ''), access.repository.organizationId);
        if (!team) throw httpError(404, 'Organization team not found.', 'TEAM_NOT_FOUND');
        db.prepare(`
          INSERT INTO repository_team_grants (repository_id, team_id, permission, added_by)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(repository_id, team_id) DO UPDATE SET
            permission = excluded.permission, added_by = excluded.added_by, updated_at = CURRENT_TIMESTAMP
        `).run(access.repository.id, team.id, permission, user.id);
        audit(db, {
          organizationId: access.repository.organizationId,
          userId: user.id,
          action: 'repository_team_access.granted',
          targetType: 'repository',
          targetId: access.repository.id,
          metadata: { repository: access.repository.slug, teamId: team.id, team: team.slug, permission },
        });
        return sendJson(res, 200, { teamGrant: { ...team, permission } });
      }

      params = routeMatch(pathname, '/api/repository-access/:org/:repo/teams/:teamId');
      if (req.method === 'DELETE' && params) {
        const access = requireManagement(db, user, params.org, params.repo);
        const result = db.prepare('DELETE FROM repository_team_grants WHERE repository_id = ? AND team_id = ?')
          .run(access.repository.id, params.teamId);
        if (!result.changes) throw httpError(404, 'Repository team grant not found.', 'REPOSITORY_TEAM_GRANT_NOT_FOUND');
        audit(db, {
          organizationId: access.repository.organizationId,
          userId: user.id,
          action: 'repository_team_access.revoked',
          targetType: 'repository',
          targetId: access.repository.id,
          metadata: { repository: access.repository.slug, teamId: params.teamId },
        });
        return sendJson(res, 200, { revoked: true });
      }

      throw httpError(404, 'Repository access API endpoint not found.', 'NOT_FOUND');
    } catch (error) {
      const status = Number(error.status) || 500;
      if (status >= 500) console.error(`[${requestId}] repository access API`, error);
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

function apiRepositoryRoute(pathname) {
  const match = pathname.match(/^\/api\/repos\/([^/]+)\/([^/]+)(\/.*)?$/);
  if (!match) return null;
  try {
    return { orgSlug: decodeURIComponent(match[1]), repoSlug: decodeURIComponent(match[2]), suffix: match[3] || '' };
  } catch {
    throw httpError(400, 'Invalid repository path.', 'INVALID_PATH');
  }
}

export function requiredPermissionForRepositoryRequest(method, suffix) {
  if (method === 'GET' || method === 'HEAD') return 'read';
  if (method === 'PATCH' && /^\/issues\/[^/]+$/.test(suffix)) return 'triage';
  if (method === 'POST' && suffix === '/issues') return 'triage';
  if (method === 'POST' && /^\/pulls\/[^/]+\/merge$/.test(suffix)) return 'maintain';
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return 'write';
  return 'read';
}

export function createRepositoryAccessGuard({ config, db, app }) {
  return async function repositoryAccessGuard(req, res) {
    const url = new URL(req.url, config.baseUrl);
    const route = apiRepositoryRoute(url.pathname);
    if (!route) return false;
    const user = currentUser(db, req);
    if (!user) return false;

    try {
      const requiredPermission = requiredPermissionForRepositoryRequest(req.method, route.suffix);
      const access = requireRepositoryAccess(db, user.id, route, requiredPermission);
      return runWithRepositoryAccess({
        userId: user.id,
        orgSlug: route.orgSlug,
        repoSlug: route.repoSlug,
        repositoryId: access.repository.id,
        permission: access.permission,
        requiredPermission,
        organizationRole: access.organizationRole,
        external: access.isExternalCollaborator,
        allowed: true,
      }, async () => {
        await app(req, res);
        return true;
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
