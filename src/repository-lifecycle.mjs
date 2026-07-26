import fs from 'node:fs';
import path from 'node:path';
import { currentUser, requireUser } from './auth.mjs';
import { audit, orgAccess, uid } from './db.mjs';
import { repoDiskPath } from './git.mjs';
import { requireRepositoryAccess } from './repository-access.mjs';
import { httpError, originAllowed } from './security.mjs';
import { enqueueWebhookEvent } from './webhooks.mjs';

const TRASH_ORG_ID = 'org_kukgit_system_trash';
const TRASH_ORG_SLUG = 'kukgit-trash';
const TRASH_RETENTION_DAYS = 30;
const MAX_BODY_BYTES = 64 * 1024;
const ROLE_RANK = Object.freeze({ viewer: 1, developer: 2, maintainer: 3, admin: 4, owner: 5 });

function tableColumns(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
}

function ensureColumn(db, table, column, definition) {
  if (!tableColumns(db, table).has(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export function migrateRepositoryLifecycle(db) {
  ensureColumn(db, 'repositories', 'archived_at', 'TEXT');
  ensureColumn(db, 'repositories', 'deleted_at', 'TEXT');
  ensureColumn(db, 'repositories', 'deleted_by', 'TEXT REFERENCES users(id) ON DELETE SET NULL');
  ensureColumn(db, 'repositories', 'deleted_from_org_id', 'TEXT REFERENCES organizations(id) ON DELETE SET NULL');
  ensureColumn(db, 'repositories', 'deleted_original_slug', 'TEXT');
  ensureColumn(db, 'repositories', 'purge_after', 'TEXT');
  db.prepare(`
    INSERT INTO organizations (id, slug, name, plan)
    VALUES (?, ?, 'KukGit System Trash', 'system')
    ON CONFLICT(slug) DO NOTHING
  `).run(TRASH_ORG_ID, TRASH_ORG_SLUG);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_repositories_lifecycle
      ON repositories(deleted_at, archived_at, updated_at DESC);
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
    if (size > MAX_BODY_BYTES) throw httpError(413, 'Request body is too large.', 'LIFECYCLE_REQUEST_TOO_LARGE');
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

function activeRepository(db, orgSlug, repoSlug) {
  return db.prepare(`
    SELECT r.id, r.slug, r.name, r.description, r.visibility,
      r.default_branch AS defaultBranch, r.organization_id AS organizationId,
      r.archived_at AS archivedAt, r.created_at AS createdAt, r.updated_at AS updatedAt,
      o.slug AS orgSlug, o.name AS orgName
    FROM repositories r JOIN organizations o ON o.id = r.organization_id
    WHERE o.slug = ? AND r.slug = ? AND r.deleted_at IS NULL
  `).get(orgSlug, repoSlug);
}

function deletedRepository(db, repositoryId) {
  return db.prepare(`
    SELECT r.id, r.slug AS trashSlug, r.name, r.description, r.visibility,
      r.default_branch AS defaultBranch, r.archived_at AS archivedAt,
      r.deleted_at AS deletedAt, r.deleted_by AS deletedBy,
      r.deleted_from_org_id AS deletedFromOrgId,
      r.deleted_original_slug AS originalSlug, r.purge_after AS purgeAfter,
      r.created_at AS createdAt, r.updated_at AS updatedAt,
      original.slug AS originalOrgSlug, original.name AS originalOrgName
    FROM repositories r
    LEFT JOIN organizations original ON original.id = r.deleted_from_org_id
    WHERE r.id = ? AND r.deleted_at IS NOT NULL
  `).get(repositoryId);
}

function lifecycleDto(repository, config) {
  return {
    ...repository,
    archived: Boolean(repository.archivedAt),
    cloneUrl: repository.orgSlug && repository.slug
      ? `${config.baseUrl}/git/${repository.orgSlug}/${repository.slug}.git`
      : null,
  };
}

function requireOrgRole(db, userId, orgSlug, minimumRole) {
  const access = orgAccess(db, userId, orgSlug, minimumRole);
  if (!access) throw httpError(403, `${minimumRole} organization permission is required.`, 'ORGANIZATION_ACCESS_DENIED');
  return access;
}

function assertConfirmation(value, expected) {
  if (String(value ?? '').trim() !== expected) {
    throw httpError(400, `Type '${expected}' to confirm this action.`, 'REPOSITORY_CONFIRMATION_MISMATCH');
  }
}

function safeRename(source, destination) {
  if (!fs.existsSync(source)) throw httpError(404, 'Repository storage was not found.', 'REPOSITORY_STORAGE_NOT_FOUND');
  if (fs.existsSync(destination)) throw httpError(409, 'Target repository storage already exists.', 'REPOSITORY_STORAGE_COLLISION');
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.renameSync(source, destination);
}

function moveRepositoryStorage(config, oldOrgSlug, newOrgSlug, repoSlug) {
  const source = repoDiskPath(config, oldOrgSlug, repoSlug);
  const destination = repoDiskPath(config, newOrgSlug, repoSlug);
  safeRename(source, destination);
  return { source, destination };
}

function rollbackStorageMove(move) {
  if (!move || !fs.existsSync(move.destination) || fs.existsSync(move.source)) return;
  fs.mkdirSync(path.dirname(move.source), { recursive: true });
  fs.renameSync(move.destination, move.source);
}

function availableTransferOrganizations(db, userId, repository) {
  return db.prepare(`
    SELECT o.id, o.slug, o.name, om.role
    FROM organizations o JOIN org_members om ON om.organization_id = o.id
    WHERE om.user_id = ? AND o.id <> ? AND o.slug <> ?
      AND om.role IN ('owner','admin')
    ORDER BY o.name
  `).all(userId, repository.organizationId, TRASH_ORG_SLUG);
}

function enqueueLifecycleEvent(db, repositoryId, action, data) {
  try {
    enqueueWebhookEvent(db, repositoryId, 'repository', { action, ...data, occurredAt: new Date().toISOString() });
  } catch (error) {
    console.error('KukGit repository lifecycle webhook', error);
  }
}

export function archiveRepository(db, repository, user) {
  if (repository.archivedAt) return activeRepository(db, repository.orgSlug, repository.slug);
  db.prepare(`
    UPDATE repositories SET archived_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND deleted_at IS NULL
  `).run(repository.id);
  audit(db, {
    organizationId: repository.organizationId,
    userId: user.id,
    action: 'repository.archived',
    targetType: 'repository',
    targetId: repository.id,
    metadata: { repository: repository.slug },
  });
  enqueueLifecycleEvent(db, repository.id, 'archived', { repository: repository.slug, organization: repository.orgSlug });
  return activeRepository(db, repository.orgSlug, repository.slug);
}

export function unarchiveRepository(db, repository, user) {
  if (!repository.archivedAt) return activeRepository(db, repository.orgSlug, repository.slug);
  db.prepare(`
    UPDATE repositories SET archived_at = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND deleted_at IS NULL
  `).run(repository.id);
  audit(db, {
    organizationId: repository.organizationId,
    userId: user.id,
    action: 'repository.unarchived',
    targetType: 'repository',
    targetId: repository.id,
    metadata: { repository: repository.slug },
  });
  enqueueLifecycleEvent(db, repository.id, 'unarchived', { repository: repository.slug, organization: repository.orgSlug });
  return activeRepository(db, repository.orgSlug, repository.slug);
}

export function transferRepository(db, config, repository, user, targetOrgSlug) {
  if (!repository.archivedAt) throw httpError(409, 'Archive the repository before transferring it.', 'REPOSITORY_TRANSFER_REQUIRES_ARCHIVE');
  const target = requireOrgRole(db, user.id, targetOrgSlug, 'admin');
  if (target.id === repository.organizationId) throw httpError(409, 'Repository already belongs to this organization.', 'REPOSITORY_TRANSFER_SAME_ORG');
  if (target.slug === TRASH_ORG_SLUG) throw httpError(403, 'The system trash organization cannot receive transfers.', 'REPOSITORY_TRANSFER_TARGET_INVALID');
  const collision = db.prepare('SELECT id FROM repositories WHERE organization_id = ? AND slug = ?').get(target.id, repository.slug);
  if (collision) throw httpError(409, 'The target organization already has a repository with this slug.', 'REPOSITORY_SLUG_COLLISION');

  const move = moveRepositoryStorage(config, repository.orgSlug, target.slug, repository.slug);
  try {
    db.exec('BEGIN IMMEDIATE');
    db.prepare('DELETE FROM repository_team_grants WHERE repository_id = ?').run(repository.id);
    db.prepare(`
      DELETE FROM repository_collaborators
      WHERE repository_id = ? AND user_id NOT IN (
        SELECT user_id FROM org_members WHERE organization_id = ?
      )
    `).run(repository.id, target.id);
    db.prepare(`
      UPDATE repositories SET organization_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `).run(target.id, repository.id);
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    rollbackStorageMove(move);
    throw error;
  }

  audit(db, {
    organizationId: repository.organizationId,
    userId: user.id,
    action: 'repository.transferred_out',
    targetType: 'repository',
    targetId: repository.id,
    metadata: { repository: repository.slug, targetOrganization: target.slug },
  });
  audit(db, {
    organizationId: target.id,
    userId: user.id,
    action: 'repository.transferred_in',
    targetType: 'repository',
    targetId: repository.id,
    metadata: { repository: repository.slug, sourceOrganization: repository.orgSlug },
  });
  enqueueLifecycleEvent(db, repository.id, 'transferred', {
    repository: repository.slug,
    fromOrganization: repository.orgSlug,
    toOrganization: target.slug,
  });
  return activeRepository(db, target.slug, repository.slug);
}

export function trashRepository(db, repository, user, confirmation) {
  if (!repository.archivedAt) throw httpError(409, 'Archive the repository before moving it to Trash.', 'REPOSITORY_DELETE_REQUIRES_ARCHIVE');
  assertConfirmation(confirmation, `${repository.orgSlug}/${repository.slug}`);
  const trashSlug = `${repository.slug}-${repository.id.slice(-10)}`;
  const trashOrg = db.prepare('SELECT id FROM organizations WHERE slug = ?').get(TRASH_ORG_SLUG);
  if (!trashOrg) throw httpError(500, 'System trash organization is unavailable.', 'TRASH_ORGANIZATION_MISSING');
  db.prepare(`
    UPDATE repositories SET organization_id = ?, slug = ?, deleted_at = CURRENT_TIMESTAMP,
      deleted_by = ?, deleted_from_org_id = ?, deleted_original_slug = ?,
      purge_after = datetime('now', '+${TRASH_RETENTION_DAYS} days'), updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND deleted_at IS NULL
  `).run(trashOrg.id, trashSlug, user.id, repository.organizationId, repository.slug, repository.id);
  audit(db, {
    organizationId: repository.organizationId,
    userId: user.id,
    action: 'repository.trashed',
    targetType: 'repository',
    targetId: repository.id,
    metadata: { repository: repository.slug, purgeAfterDays: TRASH_RETENTION_DAYS },
  });
  enqueueLifecycleEvent(db, repository.id, 'trashed', {
    repository: repository.slug,
    organization: repository.orgSlug,
    retentionDays: TRASH_RETENTION_DAYS,
  });
  return deletedRepository(db, repository.id);
}

function requireTrashPermission(db, userId, repository, minimumRole = 'admin') {
  if (!repository?.deletedFromOrgId || !repository.originalOrgSlug) throw httpError(404, 'Trashed repository not found.', 'TRASHED_REPOSITORY_NOT_FOUND');
  const membership = db.prepare(`
    SELECT role FROM org_members WHERE organization_id = ? AND user_id = ?
  `).get(repository.deletedFromOrgId, userId);
  if (!membership || ROLE_RANK[membership.role] < ROLE_RANK[minimumRole]) {
    throw httpError(403, `${minimumRole} permission in the original organization is required.`, 'TRASH_ACCESS_DENIED');
  }
  return membership;
}

export function restoreRepository(db, repository, user, confirmation) {
  requireTrashPermission(db, user.id, repository, 'admin');
  assertConfirmation(confirmation, `${repository.originalOrgSlug}/${repository.originalSlug}`);
  const collision = db.prepare(`
    SELECT id FROM repositories WHERE organization_id = ? AND slug = ? AND id <> ?
  `).get(repository.deletedFromOrgId, repository.originalSlug, repository.id);
  if (collision) throw httpError(409, 'A repository with the original slug already exists.', 'REPOSITORY_RESTORE_COLLISION');
  const result = db.prepare(`
    UPDATE repositories SET organization_id = ?, slug = ?, deleted_at = NULL, deleted_by = NULL,
      deleted_from_org_id = NULL, deleted_original_slug = NULL, purge_after = NULL,
      updated_at = CURRENT_TIMESTAMP WHERE id = ? AND deleted_at IS NOT NULL
  `).run(repository.deletedFromOrgId, repository.originalSlug, repository.id);
  if (!result.changes) throw httpError(409, 'Repository is no longer available for restore.', 'REPOSITORY_RESTORE_UNAVAILABLE');
  audit(db, {
    organizationId: repository.deletedFromOrgId,
    userId: user.id,
    action: 'repository.restored',
    targetType: 'repository',
    targetId: repository.id,
    metadata: { repository: repository.originalSlug },
  });
  const restored = activeRepository(db, repository.originalOrgSlug, repository.originalSlug);
  enqueueLifecycleEvent(db, repository.id, 'restored', {
    repository: repository.originalSlug,
    organization: repository.originalOrgSlug,
  });
  return restored;
}

export function purgeRepository(db, config, repository, user, confirmation) {
  requireTrashPermission(db, user.id, repository, 'owner');
  assertConfirmation(confirmation, `${repository.originalOrgSlug}/${repository.originalSlug}`);
  const source = repoDiskPath(config, repository.originalOrgSlug, repository.originalSlug);
  const quarantine = path.join(config.tempDir, `purge-${repository.id}-${Date.now()}.git`);
  let moved = false;
  if (fs.existsSync(source)) {
    fs.mkdirSync(config.tempDir, { recursive: true });
    safeRename(source, quarantine);
    moved = true;
  }
  try {
    db.exec('BEGIN IMMEDIATE');
    const result = db.prepare('DELETE FROM repositories WHERE id = ? AND deleted_at IS NOT NULL').run(repository.id);
    if (!result.changes) throw httpError(404, 'Trashed repository not found.', 'TRASHED_REPOSITORY_NOT_FOUND');
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    if (moved && fs.existsSync(quarantine)) {
      fs.mkdirSync(path.dirname(source), { recursive: true });
      fs.renameSync(quarantine, source);
    }
    throw error;
  }
  if (moved) fs.rmSync(quarantine, { recursive: true, force: true });
  audit(db, {
    organizationId: repository.deletedFromOrgId,
    userId: user.id,
    action: 'repository.purged',
    targetType: 'repository',
    targetId: repository.id,
    metadata: { repository: repository.originalSlug },
  });
  return { purged: true };
}

function listTrash(db, userId) {
  return db.prepare(`
    SELECT r.id, r.name, r.deleted_at AS deletedAt, r.purge_after AS purgeAfter,
      r.deleted_original_slug AS originalSlug,
      o.slug AS originalOrgSlug, o.name AS originalOrgName, om.role
    FROM repositories r
    JOIN organizations o ON o.id = r.deleted_from_org_id
    JOIN org_members om ON om.organization_id = o.id AND om.user_id = ?
    WHERE r.deleted_at IS NOT NULL AND om.role IN ('owner','admin')
    ORDER BY r.deleted_at DESC
  `).all(userId);
}

export function createRepositoryLifecycleApiHandler({ config, db }) {
  return async function handleRepositoryLifecycleApi(req, res) {
    const url = new URL(req.url, config.baseUrl);
    const pathname = url.pathname;
    if (!pathname.startsWith('/api/repository-lifecycle/')) return false;
    const requestId = uid('req');
    res.setHeader('X-Request-Id', requestId);
    res.setHeader('Referrer-Policy', 'no-referrer');

    try {
      if (!originAllowed(req, config.baseUrl)) throw httpError(403, 'Request origin is not allowed.', 'CSRF_BLOCKED');
      const user = requireUser(db, req);

      if (req.method === 'GET' && pathname === '/api/repository-lifecycle/trash') {
        return sendJson(res, 200, { repositories: listTrash(db, user.id), retentionDays: TRASH_RETENTION_DAYS });
      }

      let params = routeMatch(pathname, '/api/repository-lifecycle/trash/:repositoryId/restore');
      if (req.method === 'POST' && params) {
        const repository = deletedRepository(db, params.repositoryId);
        if (!repository) throw httpError(404, 'Trashed repository not found.', 'TRASHED_REPOSITORY_NOT_FOUND');
        const body = await readJson(req);
        return sendJson(res, 200, { repository: lifecycleDto(restoreRepository(db, repository, user, body.confirmation), config) });
      }

      params = routeMatch(pathname, '/api/repository-lifecycle/trash/:repositoryId');
      if (req.method === 'DELETE' && params) {
        const repository = deletedRepository(db, params.repositoryId);
        if (!repository) throw httpError(404, 'Trashed repository not found.', 'TRASHED_REPOSITORY_NOT_FOUND');
        const body = await readJson(req);
        return sendJson(res, 200, purgeRepository(db, config, repository, user, body.confirmation));
      }

      params = routeMatch(pathname, '/api/repository-lifecycle/:org/:repo');
      if (req.method === 'GET' && params) {
        const access = requireRepositoryAccess(db, user.id, { orgSlug: params.org, repoSlug: params.repo }, 'admin');
        const repository = activeRepository(db, params.org, params.repo);
        if (!repository) throw httpError(404, 'Repository not found.', 'REPO_NOT_FOUND');
        return sendJson(res, 200, {
          repository: lifecycleDto(repository, config),
          availableTransferOrganizations: availableTransferOrganizations(db, user.id, repository),
          confirmation: `${repository.orgSlug}/${repository.slug}`,
          retentionDays: TRASH_RETENTION_DAYS,
          effectivePermission: access.permission,
        });
      }

      params = routeMatch(pathname, '/api/repository-lifecycle/:org/:repo/archive');
      if (params && ['POST', 'DELETE'].includes(req.method)) {
        requireRepositoryAccess(db, user.id, { orgSlug: params.org, repoSlug: params.repo }, 'admin');
        const repository = activeRepository(db, params.org, params.repo);
        if (!repository) throw httpError(404, 'Repository not found.', 'REPO_NOT_FOUND');
        const result = req.method === 'POST' ? archiveRepository(db, repository, user) : unarchiveRepository(db, repository, user);
        return sendJson(res, 200, { repository: lifecycleDto(result, config) });
      }

      params = routeMatch(pathname, '/api/repository-lifecycle/:org/:repo/transfer');
      if (req.method === 'POST' && params) {
        requireRepositoryAccess(db, user.id, { orgSlug: params.org, repoSlug: params.repo }, 'admin');
        const repository = activeRepository(db, params.org, params.repo);
        if (!repository) throw httpError(404, 'Repository not found.', 'REPO_NOT_FOUND');
        const body = await readJson(req);
        const transferred = transferRepository(db, config, repository, user, String(body.targetOrgSlug ?? ''));
        return sendJson(res, 200, { repository: lifecycleDto(transferred, config) });
      }

      params = routeMatch(pathname, '/api/repository-lifecycle/:org/:repo/trash');
      if (req.method === 'POST' && params) {
        requireRepositoryAccess(db, user.id, { orgSlug: params.org, repoSlug: params.repo }, 'admin');
        const repository = activeRepository(db, params.org, params.repo);
        if (!repository) throw httpError(404, 'Repository not found.', 'REPO_NOT_FOUND');
        const body = await readJson(req);
        return sendJson(res, 200, { repository: trashRepository(db, repository, user, body.confirmation) });
      }

      throw httpError(404, 'Repository lifecycle endpoint not found.', 'NOT_FOUND');
    } catch (error) {
      const status = Number(error.status) || 500;
      if (status >= 500) console.error(`[${requestId}] repository lifecycle API`, error);
      if (!res.headersSent) {
        sendJson(res, status, {
          error: {
            code: error.code || 'INTERNAL_ERROR',
            message: status >= 500 ? 'An unexpected server error occurred.' : error.message,
            requestId,
          },
        });
      } else res.end();
    }
    return true;
  };
}

function repositoryReference(pathname) {
  const patterns = [
    /^\/api\/(?:repos|repository-access|governance|review-threads|status-checks|webhooks)\/([^/]+)\/([^/]+)/,
    /^\/git\/([^/]+)\/([^/]+)\.git(?:\/|$)/,
  ];
  for (const pattern of patterns) {
    const match = pathname.match(pattern);
    if (!match) continue;
    try { return { orgSlug: decodeURIComponent(match[1]), repoSlug: decodeURIComponent(match[2]) }; }
    catch { return null; }
  }
  return null;
}

function isRepositoryWrite(req, url) {
  if (url.pathname.startsWith('/git/')) {
    return url.pathname.includes('git-receive-pack') || url.searchParams.get('service') === 'git-receive-pack';
  }
  return !['GET', 'HEAD', 'OPTIONS'].includes(String(req.method || 'GET').toUpperCase());
}

export function createRepositoryLifecycleGuard({ config, db, next }) {
  return async function repositoryLifecycleGuard(req, res) {
    const url = new URL(req.url, config.baseUrl);
    if (url.pathname.startsWith('/api/repository-lifecycle/')) return next(req, res);
    const reference = repositoryReference(url.pathname);
    if (!reference) return next(req, res);
    const repository = activeRepository(db, reference.orgSlug, reference.repoSlug);
    if (!repository) return next(req, res);
    if (repository.archivedAt && isRepositoryWrite(req, url)) {
      return sendJson(res, 409, {
        error: {
          code: 'REPOSITORY_ARCHIVED',
          message: 'This repository is archived and read-only. Unarchive it before making changes.',
        },
      });
    }
    return next(req, res);
  };
}
