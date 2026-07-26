import { currentUser } from './auth.mjs';
import { getEffectiveRepositoryAccess } from './repository-access.mjs';

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

function accessibleRepositoryRows(db, userId) {
  return db.prepare(`
    SELECT r.*, o.slug AS org_slug, o.name AS org_name,
      om.role AS organization_role, c.permission AS direct_permission,
      CASE WHEN om.user_id IS NULL AND c.user_id IS NOT NULL THEN 1 ELSE 0 END AS is_external
    FROM repositories r
    JOIN organizations o ON o.id = r.organization_id
    LEFT JOIN org_members om ON om.organization_id = o.id AND om.user_id = ?
    LEFT JOIN repository_collaborators c ON c.repository_id = r.id AND c.user_id = ?
    WHERE r.deleted_at IS NULL AND (om.user_id IS NOT NULL OR c.user_id IS NOT NULL)
    ORDER BY r.updated_at DESC
  `).all(userId, userId);
}

function repositoryDto(config, db, userId, row) {
  const access = getEffectiveRepositoryAccess(db, { userId, repositoryId: row.id });
  return {
    id: row.id,
    orgSlug: row.org_slug,
    orgName: row.org_name,
    slug: row.slug,
    name: row.name,
    description: row.description,
    visibility: row.visibility,
    defaultBranch: row.default_branch,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    cloneUrl: `${config.baseUrl}/git/${row.org_slug}/${row.slug}.git`,
    permission: access?.permission ?? 'none',
    organizationRole: access?.organizationRole ?? null,
    isExternalCollaborator: Boolean(access?.isExternalCollaborator),
  };
}

function placeholders(values) {
  return values.map(() => '?').join(',') || "''";
}

export function createExternalCollaboratorDiscoveryApiHandler({ config, db }) {
  return async function externalCollaboratorDiscoveryApi(req, res) {
    if (req.method !== 'GET') return false;
    const url = new URL(req.url, config.baseUrl);
    if (!['/api/dashboard', '/api/repos', '/api/issues', '/api/pulls'].includes(url.pathname)) return false;
    const user = currentUser(db, req);
    if (!user) return false;
    const rows = accessibleRepositoryRows(db, user.id);
    const repositories = rows.map((row) => repositoryDto(config, db, user.id, row));
    const repoIds = rows.map((row) => row.id);
    const marks = placeholders(repoIds);

    if (url.pathname === '/api/repos') return sendJson(res, 200, { repositories });

    if (url.pathname === '/api/issues') {
      const issues = repoIds.length ? db.prepare(`
        SELECT i.number, i.title, i.status, i.priority, i.created_at AS createdAt,
          r.slug AS repoSlug, o.slug AS orgSlug
        FROM issues i
        JOIN repositories r ON r.id = i.repository_id
        JOIN organizations o ON o.id = r.organization_id
        WHERE i.repository_id IN (${marks})
        ORDER BY i.created_at DESC LIMIT 100
      `).all(...repoIds) : [];
      return sendJson(res, 200, { issues });
    }

    if (url.pathname === '/api/pulls') {
      const pullRequests = repoIds.length ? db.prepare(`
        SELECT p.number, p.title, p.status, p.base_branch AS baseBranch,
          p.head_branch AS headBranch, p.created_at AS createdAt,
          r.slug AS repoSlug, o.slug AS orgSlug
        FROM pull_requests p
        JOIN repositories r ON r.id = p.repository_id
        JOIN organizations o ON o.id = r.organization_id
        WHERE p.repository_id IN (${marks})
        ORDER BY p.created_at DESC LIMIT 100
      `).all(...repoIds) : [];
      return sendJson(res, 200, { pullRequests });
    }

    const openIssues = repoIds.length
      ? Number(db.prepare(`SELECT COUNT(*) AS count FROM issues WHERE status = 'open' AND repository_id IN (${marks})`).get(...repoIds).count)
      : 0;
    const openPulls = repoIds.length
      ? Number(db.prepare(`SELECT COUNT(*) AS count FROM pull_requests WHERE status = 'open' AND repository_id IN (${marks})`).get(...repoIds).count)
      : 0;
    const latestAnalyses = repoIds.length ? db.prepare(`
      SELECT a.score FROM analyses a
      JOIN (
        SELECT repository_id, MAX(created_at) AS latest
        FROM analyses WHERE repository_id IN (${marks}) GROUP BY repository_id
      ) latest ON latest.repository_id = a.repository_id AND latest.latest = a.created_at
    `).all(...repoIds) : [];
    const aiHealth = latestAnalyses.length
      ? Math.round(latestAnalyses.reduce((sum, row) => sum + Number(row.score), 0) / latestAnalyses.length)
      : null;

    const directRepositoryIds = rows.filter((row) => row.is_external).map((row) => row.id);
    const memberOrganizationIds = db.prepare('SELECT organization_id AS id FROM org_members WHERE user_id = ?').all(user.id).map((row) => row.id);
    const activityConditions = [];
    const activityValues = [];
    if (memberOrganizationIds.length) {
      activityConditions.push(`a.organization_id IN (${placeholders(memberOrganizationIds)})`);
      activityValues.push(...memberOrganizationIds);
    }
    if (directRepositoryIds.length) {
      activityConditions.push(`(a.target_type = 'repository' AND a.target_id IN (${placeholders(directRepositoryIds)}))`);
      activityValues.push(...directRepositoryIds);
    }
    const activity = activityConditions.length ? db.prepare(`
      SELECT a.action, a.target_type AS targetType, a.target_id AS targetId,
        a.metadata_json AS metadataJson, a.created_at AS createdAt,
        o.name AS organizationName, u.display_name AS userName
      FROM audit_logs a
      LEFT JOIN organizations o ON o.id = a.organization_id
      LEFT JOIN users u ON u.id = a.user_id
      WHERE ${activityConditions.join(' OR ')}
      ORDER BY a.created_at DESC LIMIT 12
    `).all(...activityValues).map((row) => {
      let metadata = {};
      try { metadata = JSON.parse(row.metadataJson || '{}'); } catch {}
      return { ...row, metadata, metadataJson: undefined };
    }) : [];

    return sendJson(res, 200, {
      metrics: {
        repositories: repositories.length,
        openIssues,
        openPulls,
        aiHealth,
      },
      repositories: repositories.slice(0, 8),
      activity,
    });
  };
}
