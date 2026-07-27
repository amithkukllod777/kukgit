import { requireUser } from './auth.mjs';
import { audit, orgAccess, uid } from './db.mjs';
import { createNotification, migrateNotifications } from './notifications.mjs';
import { requireRepositoryAccess } from './repository-access.mjs';
import { httpError, originAllowed } from './security.mjs';

const MAX_BODY_BYTES = 64 * 1024;
const RENEWAL_DAYS = new Set([7, 30, 90, 180, 365]);

function tableColumns(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
}

function ensureColumn(db, table, column, definition) {
  if (!tableColumns(db, table).has(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export function migrateExternalAccessExpiryGuard(db) {
  ensureColumn(db, 'repository_collaborators', 'expires_at', 'TEXT');
  ensureColumn(db, 'repository_collaborators', 'access_origin', "TEXT NOT NULL DEFAULT 'direct'");
  ensureColumn(db, 'repository_collaborators', 'invitation_id', 'TEXT');
  ensureColumn(db, 'repository_collaborators', 'last_reviewed_at', 'TEXT');
  ensureColumn(db, 'repository_collaborators', 'next_review_at', 'TEXT');
  ensureColumn(db, 'repository_invitations', 'access_duration_days', 'INTEGER');
  db.exec(`
    CREATE TABLE IF NOT EXISTS external_access_grant_history (
      id TEXT PRIMARY KEY,
      repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      permission TEXT NOT NULL,
      expires_at TEXT,
      access_origin TEXT NOT NULL DEFAULT 'direct',
      invitation_id TEXT,
      archived_reason TEXT NOT NULL CHECK(archived_reason IN ('expired','revoked','replaced')),
      archived_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      archived_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      restored_at TEXT,
      restored_by TEXT REFERENCES users(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_external_access_history_repo_user
      ON external_access_grant_history(repository_id, user_id, archived_at DESC);

    CREATE TRIGGER IF NOT EXISTS trg_external_invitation_grant_insert
    AFTER INSERT ON repository_collaborators
    WHEN NEW.expires_at IS NULL AND EXISTS (
      SELECT 1 FROM repository_invitations i
      JOIN repositories r ON r.id = i.repository_id
      LEFT JOIN org_members om ON om.organization_id = r.organization_id AND om.user_id = NEW.user_id
      WHERE i.repository_id = NEW.repository_id AND i.accepted_by = NEW.user_id
        AND i.accepted_at IS NOT NULL AND om.user_id IS NULL
      ORDER BY i.accepted_at DESC LIMIT 1
    )
    BEGIN
      UPDATE repository_collaborators
      SET expires_at = (
          SELECT datetime(i.accepted_at, '+' || COALESCE(i.access_duration_days, 90) || ' days')
          FROM repository_invitations i
          WHERE i.repository_id = NEW.repository_id AND i.accepted_by = NEW.user_id
          ORDER BY i.accepted_at DESC LIMIT 1
        ),
        access_origin = 'invitation',
        invitation_id = (
          SELECT i.id FROM repository_invitations i
          WHERE i.repository_id = NEW.repository_id AND i.accepted_by = NEW.user_id
          ORDER BY i.accepted_at DESC LIMIT 1
        ),
        next_review_at = datetime('now', '+90 days')
      WHERE repository_id = NEW.repository_id AND user_id = NEW.user_id;
    END;

    CREATE TRIGGER IF NOT EXISTS trg_external_invitation_grant_update
    AFTER UPDATE OF permission ON repository_collaborators
    WHEN NEW.expires_at IS NULL AND EXISTS (
      SELECT 1 FROM repository_invitations i
      JOIN repositories r ON r.id = i.repository_id
      LEFT JOIN org_members om ON om.organization_id = r.organization_id AND om.user_id = NEW.user_id
      WHERE i.repository_id = NEW.repository_id AND i.accepted_by = NEW.user_id
        AND i.accepted_at IS NOT NULL AND om.user_id IS NULL
      ORDER BY i.accepted_at DESC LIMIT 1
    )
    BEGIN
      UPDATE repository_collaborators
      SET expires_at = (
          SELECT datetime(i.accepted_at, '+' || COALESCE(i.access_duration_days, 90) || ' days')
          FROM repository_invitations i
          WHERE i.repository_id = NEW.repository_id AND i.accepted_by = NEW.user_id
          ORDER BY i.accepted_at DESC LIMIT 1
        ),
        access_origin = 'invitation',
        invitation_id = (
          SELECT i.id FROM repository_invitations i
          WHERE i.repository_id = NEW.repository_id AND i.accepted_by = NEW.user_id
          ORDER BY i.accepted_at DESC LIMIT 1
        ),
        next_review_at = datetime('now', '+90 days')
      WHERE repository_id = NEW.repository_id AND user_id = NEW.user_id;
    END;
  `);
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
    if (size > MAX_BODY_BYTES) throw httpError(413, 'Renewal request is too large.', 'EXTERNAL_ACCESS_REQUEST_TOO_LARGE');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw httpError(400, 'Invalid JSON request body.', 'INVALID_JSON'); }
}

function routeMatch(pathname, pattern) {
  const keys = [];
  const regex = new RegExp('^' + pattern.replace(/:([A-Za-z0-9_]+)/g, (_, key) => {
    keys.push(key);
    return '([^/]+)';
  }) + '$');
  const match = pathname.match(regex);
  if (!match) return null;
  try { return Object.fromEntries(keys.map((key, index) => [key, decodeURIComponent(match[index + 1])])); }
  catch { throw httpError(400, 'Invalid request path.', 'INVALID_PATH'); }
}

export function expireExternalAccessGrants(db, config) {
  migrateExternalAccessExpiryGuard(db);
  migrateNotifications(db);
  const due = db.prepare(`
    SELECT c.repository_id AS repositoryId, c.user_id AS userId, c.permission,
      c.expires_at AS expiresAt, c.access_origin AS accessOrigin,
      c.invitation_id AS invitationId, r.organization_id AS organizationId,
      r.slug AS repoSlug, o.slug AS orgSlug
    FROM repository_collaborators c
    JOIN repositories r ON r.id = c.repository_id
    JOIN organizations o ON o.id = r.organization_id
    LEFT JOIN org_members om ON om.organization_id = r.organization_id AND om.user_id = c.user_id
    WHERE om.user_id IS NULL AND c.expires_at IS NOT NULL
      AND julianday(c.expires_at) <= julianday('now')
  `).all();
  let expired = 0;
  for (const row of due) {
    const historyId = uid('eah');
    db.exec('BEGIN IMMEDIATE');
    try {
      const current = db.prepare(`
        SELECT permission, expires_at AS expiresAt, access_origin AS accessOrigin,
          invitation_id AS invitationId
        FROM repository_collaborators
        WHERE repository_id = ? AND user_id = ? AND expires_at IS NOT NULL
          AND julianday(expires_at) <= julianday('now')
      `).get(row.repositoryId, row.userId);
      if (!current) {
        db.exec('ROLLBACK');
        continue;
      }
      db.prepare(`
        INSERT INTO external_access_grant_history
          (id, repository_id, user_id, permission, expires_at, access_origin,
           invitation_id, archived_reason)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'expired')
      `).run(historyId, row.repositoryId, row.userId, current.permission, current.expiresAt, current.accessOrigin, current.invitationId);
      db.prepare('DELETE FROM repository_collaborators WHERE repository_id = ? AND user_id = ?')
        .run(row.repositoryId, row.userId);
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      throw error;
    }
    audit(db, {
      organizationId: row.organizationId,
      userId: row.userId,
      action: 'external_repository_access.expired',
      targetType: 'repository',
      targetId: row.repositoryId,
      metadata: { permission: row.permission, expiresAt: row.expiresAt, historyId },
    });
    createNotification(db, config, {
      userId: row.userId,
      category: 'security',
      title: 'External repository access expired',
      body: `Your ${row.permission} access to ${row.orgSlug}/${row.repoSlug} has expired.`,
      link: '#/settings',
      dedupeKey: `external-access-expired:${row.repositoryId}:${row.userId}:${row.expiresAt}`,
      metadata: { repositoryId: row.repositoryId, permission: row.permission, expiresAt: row.expiresAt },
    });
    expired += 1;
  }
  return { scanned: due.length, expired };
}

function listHistory(db, repositoryId) {
  return db.prepare(`
    SELECT h.id, h.user_id AS userId, h.permission, h.expires_at AS expiresAt,
      h.access_origin AS accessOrigin, h.archived_reason AS archivedReason,
      h.archived_at AS archivedAt, h.restored_at AS restoredAt,
      u.email, u.display_name AS displayName,
      archiver.display_name AS archivedByName,
      restorer.display_name AS restoredByName
    FROM external_access_grant_history h
    JOIN users u ON u.id = h.user_id
    LEFT JOIN users archiver ON archiver.id = h.archived_by
    LEFT JOIN users restorer ON restorer.id = h.restored_by
    WHERE h.repository_id = ?
    ORDER BY h.archived_at DESC LIMIT 250
  `).all(repositoryId);
}

function restoreExpiredGrant(db, config, actor, access, historyId, input) {
  const organizationAdmin = orgAccess(db, actor.id, access.repository.orgSlug, 'admin');
  const history = db.prepare(`
    SELECT h.*, u.email, u.display_name AS displayName
    FROM external_access_grant_history h JOIN users u ON u.id = h.user_id
    WHERE h.id = ? AND h.repository_id = ? AND h.restored_at IS NULL
  `).get(historyId, access.repository.id);
  if (!history) throw httpError(404, 'Expired access history entry not found.', 'EXTERNAL_ACCESS_HISTORY_NOT_FOUND');
  if (actor.id === history.user_id && !organizationAdmin) {
    throw httpError(403, 'External collaborators cannot renew their own access.', 'EXTERNAL_ACCESS_SELF_EXTENSION_FORBIDDEN');
  }
  const permission = String(input.permission ?? history.permission).toLowerCase();
  if (!['read', 'triage', 'write', 'maintain', 'admin'].includes(permission)) {
    throw httpError(400, 'Select a valid repository permission.', 'REPOSITORY_PERMISSION_INVALID');
  }
  if (permission === 'admin' && !organizationAdmin) {
    throw httpError(403, 'Organization Admin or Owner must certify external Repository Admin access.', 'EXTERNAL_ADMIN_CERTIFICATION_REQUIRED');
  }
  const accessDays = Number(input.accessDays ?? 90);
  if (!RENEWAL_DAYS.has(accessDays)) throw httpError(400, 'Renewal must be 7, 30, 90, 180 or 365 days.', 'EXTERNAL_ACCESS_DURATION_INVALID');
  const expiresAt = new Date(Date.now() + accessDays * 86400000).toISOString();
  db.exec('BEGIN IMMEDIATE');
  try {
    const membership = db.prepare(`
      SELECT 1 FROM org_members WHERE organization_id = ? AND user_id = ?
    `).get(access.repository.organizationId, history.user_id);
    if (membership) throw httpError(409, 'This user is now an organization member and no longer needs external access.', 'EXTERNAL_ACCESS_NOW_INTERNAL');
    db.prepare(`
      INSERT INTO repository_collaborators
        (repository_id, user_id, permission, added_by, expires_at, access_origin,
         invitation_id, last_reviewed_at, next_review_at)
      VALUES (?, ?, ?, ?, ?, 'review_renewal', ?, CURRENT_TIMESTAMP, ?)
      ON CONFLICT(repository_id, user_id) DO UPDATE SET
        permission = excluded.permission, added_by = excluded.added_by,
        expires_at = excluded.expires_at, access_origin = excluded.access_origin,
        invitation_id = excluded.invitation_id,
        last_reviewed_at = CURRENT_TIMESTAMP, next_review_at = excluded.next_review_at,
        updated_at = CURRENT_TIMESTAMP
    `).run(
      access.repository.id,
      history.user_id,
      permission,
      actor.id,
      expiresAt,
      history.invitation_id,
      new Date(Date.now() + 90 * 86400000).toISOString(),
    );
    db.prepare(`
      UPDATE external_access_grant_history
      SET restored_at = CURRENT_TIMESTAMP, restored_by = ?
      WHERE id = ? AND restored_at IS NULL
    `).run(actor.id, history.id);
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  }
  audit(db, {
    organizationId: access.repository.organizationId,
    userId: actor.id,
    action: 'external_repository_access.renewed',
    targetType: 'repository',
    targetId: access.repository.id,
    metadata: { collaboratorId: history.user_id, historyId, permission, expiresAt },
  });
  createNotification(db, config, {
    userId: history.user_id,
    category: 'security',
    title: 'External repository access renewed',
    body: `Your ${permission} access to ${access.repository.orgSlug}/${access.repository.slug} is active until ${new Date(expiresAt).toLocaleDateString('en-IN')}.`,
    link: `#/repo/${access.repository.orgSlug}/${access.repository.slug}/code`,
    dedupeKey: `external-access-renewed:${history.id}:${expiresAt}`,
    metadata: { repositoryId: access.repository.id, permission, expiresAt },
  });
  return { historyId, userId: history.user_id, permission, expiresAt };
}

export function createExternalAccessHistoryApiHandler({ config, db }) {
  return async function externalAccessHistoryApi(req, res) {
    const url = new URL(req.url, config.baseUrl);
    if (!url.pathname.startsWith('/api/external-access-history/')) return false;
    const requestId = uid('req');
    res.setHeader('X-Request-Id', requestId);
    res.setHeader('Referrer-Policy', 'no-referrer');
    try {
      if (!originAllowed(req, config.baseUrl)) throw httpError(403, 'Request origin is not allowed.', 'CSRF_BLOCKED');
      const user = requireUser(db, req);
      migrateExternalAccessExpiryGuard(db);
      let params = routeMatch(url.pathname, '/api/external-access-history/:org/:repo');
      if (req.method === 'GET' && params) {
        const access = requireRepositoryAccess(db, user.id, { orgSlug: params.org, repoSlug: params.repo }, 'admin');
        return sendJson(res, 200, { repository: access.repository, history: listHistory(db, access.repository.id) });
      }
      params = routeMatch(url.pathname, '/api/external-access-history/:org/:repo/:historyId/renew');
      if (req.method === 'POST' && params) {
        const access = requireRepositoryAccess(db, user.id, { orgSlug: params.org, repoSlug: params.repo }, 'admin');
        const body = await readJson(req);
        return sendJson(res, 200, { grant: restoreExpiredGrant(db, config, user, access, params.historyId, body) });
      }
      throw httpError(404, 'External access history endpoint not found.', 'NOT_FOUND');
    } catch (error) {
      const status = Number(error.status) || 500;
      if (status >= 500) console.error(`[${requestId}] external access history API`, error);
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

export function createExternalAccessExpiryGuard({ config, db, next }) {
  return async function externalAccessExpiryGuard(req, res) {
    expireExternalAccessGrants(db, config);
    return next(req, res);
  };
}
