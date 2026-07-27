import { requireUser } from './auth.mjs';
import { audit, orgAccess, uid } from './db.mjs';
import { createNotification, migrateNotifications } from './notifications.mjs';
import {
  normalizeRepositoryPermission,
  permissionAtLeast,
  requireRepositoryAccess,
} from './repository-access.mjs';
import { httpError, originAllowed } from './security.mjs';

const MAX_BODY_BYTES = 64 * 1024;
const ACCESS_DAYS = new Set([7, 30, 90, 180, 365]);
const REVIEW_DUE_DAYS = new Set([7, 14, 30]);
const DECISIONS = new Set(['keep', 'renew', 'reduce', 'revoke']);
const REVIEW_INTERVAL_MS = 60 * 60 * 1000;

function tableColumns(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
}

function ensureColumn(db, table, column, definition) {
  if (!tableColumns(db, table).has(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export function migrateExternalAccessReviews(db) {
  ensureColumn(db, 'repository_collaborators', 'expires_at', 'TEXT');
  ensureColumn(db, 'repository_collaborators', 'access_origin', "TEXT NOT NULL DEFAULT 'direct'");
  ensureColumn(db, 'repository_collaborators', 'invitation_id', 'TEXT');
  ensureColumn(db, 'repository_collaborators', 'last_reviewed_at', 'TEXT');
  ensureColumn(db, 'repository_collaborators', 'next_review_at', 'TEXT');
  ensureColumn(db, 'repository_invitations', 'access_duration_days', 'INTEGER');
  db.exec(`
    CREATE TABLE IF NOT EXISTS external_access_review_campaigns (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      due_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','completed','cancelled')),
      created_by TEXT NOT NULL REFERENCES users(id),
      completed_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS external_access_review_items (
      id TEXT PRIMARY KEY,
      campaign_id TEXT NOT NULL REFERENCES external_access_review_campaigns(id) ON DELETE CASCADE,
      repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      permission_snapshot TEXT NOT NULL,
      expires_at_snapshot TEXT,
      decision TEXT NOT NULL DEFAULT 'pending' CHECK(decision IN ('pending','keep','renew','reduce','revoke')),
      decided_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      decided_at TEXT,
      decision_note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(campaign_id, repository_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_external_access_expiry
      ON repository_collaborators(expires_at, repository_id, user_id);
    CREATE INDEX IF NOT EXISTS idx_access_reviews_org
      ON external_access_review_campaigns(organization_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_access_review_items_campaign
      ON external_access_review_items(campaign_id, decision, repository_id);
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
    if (size > MAX_BODY_BYTES) throw httpError(413, 'Access review request is too large.', 'EXTERNAL_ACCESS_REQUEST_TOO_LARGE');
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

function requireOrganizationAdmin(db, userId, orgSlug) {
  const organization = orgAccess(db, userId, orgSlug, 'admin');
  if (!organization) throw httpError(403, 'Organization Admin or Owner permission is required.', 'ORGANIZATION_ADMIN_REQUIRED');
  return organization;
}

function normalizeAccessDays(value, { allowPermanent = false } = {}) {
  if ((value === null || value === '' || value === 'permanent') && allowPermanent) return null;
  const days = Number(value);
  if (!ACCESS_DAYS.has(days)) throw httpError(400, 'Access duration must be 7, 30, 90, 180 or 365 days.', 'EXTERNAL_ACCESS_DURATION_INVALID');
  return days;
}

function expiresAtFromDays(days) {
  return days === null ? null : new Date(Date.now() + days * 86400000).toISOString();
}

function externalGrant(db, repositoryId, userId) {
  const row = db.prepare(`
    SELECT c.repository_id AS repositoryId, c.user_id AS userId, c.permission,
      c.expires_at AS expiresAt, c.access_origin AS accessOrigin,
      c.last_reviewed_at AS lastReviewedAt, c.next_review_at AS nextReviewAt,
      c.created_at AS createdAt, c.updated_at AS updatedAt,
      u.email, u.display_name AS displayName,
      CASE WHEN c.expires_at IS NULL THEN 'permanent'
        WHEN julianday(c.expires_at) <= julianday('now') THEN 'expired'
        WHEN julianday(c.expires_at) <= julianday('now', '+7 days') THEN 'expiring'
        ELSE 'active' END AS status
    FROM repository_collaborators c
    JOIN users u ON u.id = c.user_id
    LEFT JOIN repositories r ON r.id = c.repository_id
    LEFT JOIN org_members om ON om.organization_id = r.organization_id AND om.user_id = c.user_id
    WHERE c.repository_id = ? AND c.user_id = ? AND om.user_id IS NULL
  `).get(repositoryId, userId);
  if (!row) throw httpError(404, 'External collaborator grant not found.', 'EXTERNAL_ACCESS_NOT_FOUND');
  return row;
}

function listRepositoryExternalAccess(db, repository) {
  return db.prepare(`
    SELECT c.user_id AS userId, c.permission, c.expires_at AS expiresAt,
      c.access_origin AS accessOrigin, c.last_reviewed_at AS lastReviewedAt,
      c.next_review_at AS nextReviewAt, c.created_at AS createdAt,
      c.updated_at AS updatedAt, u.email, u.display_name AS displayName,
      CASE WHEN c.expires_at IS NULL THEN 'permanent'
        WHEN julianday(c.expires_at) <= julianday('now') THEN 'expired'
        WHEN julianday(c.expires_at) <= julianday('now', '+7 days') THEN 'expiring'
        ELSE 'active' END AS status
    FROM repository_collaborators c
    JOIN users u ON u.id = c.user_id
    LEFT JOIN org_members om ON om.organization_id = ? AND om.user_id = c.user_id
    WHERE c.repository_id = ? AND om.user_id IS NULL
    ORDER BY CASE status WHEN 'expired' THEN 0 WHEN 'expiring' THEN 1 ELSE 2 END, u.display_name
  `).all(repository.organizationId, repository.id);
}

function updateExternalGrant(db, config, actor, access, targetUserId, input) {
  const organizationAdmin = orgAccess(db, actor.id, access.repository.orgSlug, 'admin');
  const current = externalGrant(db, access.repository.id, targetUserId);
  const permission = input.permission === undefined ? current.permission : normalizeRepositoryPermission(input.permission);
  const isExtending = input.accessDays !== undefined;
  if (actor.id === targetUserId && isExtending && !organizationAdmin) {
    throw httpError(403, 'External collaborators cannot extend their own access.', 'EXTERNAL_ACCESS_SELF_EXTENSION_FORBIDDEN');
  }
  if ((current.permission === 'admin' || permission === 'admin') && !organizationAdmin) {
    throw httpError(403, 'Organization Admin or Owner must certify external Repository Admin access.', 'EXTERNAL_ADMIN_CERTIFICATION_REQUIRED');
  }
  const days = input.accessDays === undefined
    ? undefined
    : normalizeAccessDays(input.accessDays, { allowPermanent: Boolean(organizationAdmin) });
  const expiresAt = days === undefined ? current.expiresAt : expiresAtFromDays(days);
  const nextReviewAt = new Date(Date.now() + 90 * 86400000).toISOString();
  db.prepare(`
    UPDATE repository_collaborators
    SET permission = ?, expires_at = ?, last_reviewed_at = CURRENT_TIMESTAMP,
      next_review_at = ?, added_by = ?, updated_at = CURRENT_TIMESTAMP
    WHERE repository_id = ? AND user_id = ?
  `).run(permission, expiresAt, nextReviewAt, actor.id, access.repository.id, targetUserId);
  const updated = externalGrant(db, access.repository.id, targetUserId);
  audit(db, {
    organizationId: access.repository.organizationId,
    userId: actor.id,
    action: 'external_repository_access.updated',
    targetType: 'repository',
    targetId: access.repository.id,
    metadata: {
      collaboratorId: targetUserId,
      previousPermission: current.permission,
      permission,
      previousExpiresAt: current.expiresAt,
      expiresAt,
    },
  });
  createNotification(db, config, {
    userId: targetUserId,
    category: 'security',
    title: `Repository access updated`,
    body: expiresAt
      ? `Your ${permission} access to ${access.repository.orgSlug}/${access.repository.slug} is active until ${new Date(expiresAt).toLocaleDateString('en-IN')}.`
      : `Your ${permission} access to ${access.repository.orgSlug}/${access.repository.slug} is now permanent.`,
    link: `#/repo/${access.repository.orgSlug}/${access.repository.slug}/code`,
    dedupeKey: `external-access-updated:${access.repository.id}:${targetUserId}:${updated.updatedAt}`,
    metadata: { repositoryId: access.repository.id, permission, expiresAt },
  });
  return updated;
}

function campaignSummary(db, organizationId) {
  return db.prepare(`
    SELECT c.id, c.name, c.due_at AS dueAt, c.status, c.created_at AS createdAt,
      c.completed_at AS completedAt, creator.display_name AS createdByName,
      COUNT(i.id) AS totalItems,
      SUM(CASE WHEN i.decision = 'pending' THEN 1 ELSE 0 END) AS pendingItems,
      SUM(CASE WHEN i.decision <> 'pending' THEN 1 ELSE 0 END) AS decidedItems,
      CASE WHEN c.status = 'open' AND julianday(c.due_at) < julianday('now') THEN 1 ELSE 0 END AS overdue
    FROM external_access_review_campaigns c
    JOIN users creator ON creator.id = c.created_by
    LEFT JOIN external_access_review_items i ON i.campaign_id = c.id
    WHERE c.organization_id = ?
    GROUP BY c.id
    ORDER BY c.created_at DESC
    LIMIT 50
  `).all(organizationId).map((row) => ({ ...row, overdue: Boolean(row.overdue) }));
}

function campaignDetails(db, organizationId, campaignId) {
  const campaign = db.prepare(`
    SELECT id, name, due_at AS dueAt, status, created_at AS createdAt,
      completed_at AS completedAt
    FROM external_access_review_campaigns
    WHERE id = ? AND organization_id = ?
  `).get(campaignId, organizationId);
  if (!campaign) throw httpError(404, 'Access review campaign not found.', 'ACCESS_REVIEW_NOT_FOUND');
  campaign.overdue = campaign.status === 'open' && new Date(campaign.dueAt).getTime() < Date.now();
  campaign.items = db.prepare(`
    SELECT i.id, i.repository_id AS repositoryId, i.user_id AS userId,
      i.permission_snapshot AS permissionSnapshot, i.expires_at_snapshot AS expiresAtSnapshot,
      i.decision, i.decided_at AS decidedAt, i.decision_note AS decisionNote,
      r.slug AS repoSlug, r.name AS repoName, u.email, u.display_name AS displayName,
      current.permission AS currentPermission, current.expires_at AS currentExpiresAt,
      decider.display_name AS decidedByName
    FROM external_access_review_items i
    JOIN repositories r ON r.id = i.repository_id
    JOIN users u ON u.id = i.user_id
    LEFT JOIN repository_collaborators current
      ON current.repository_id = i.repository_id AND current.user_id = i.user_id
    LEFT JOIN users decider ON decider.id = i.decided_by
    WHERE i.campaign_id = ?
    ORDER BY r.name, u.display_name
  `).all(campaign.id);
  return campaign;
}

function createCampaign(db, actor, organization, input) {
  const name = String(input.name ?? 'External access review').trim().replace(/\s+/g, ' ');
  if (name.length < 3 || name.length > 120) throw httpError(400, 'Review campaign name must contain 3 to 120 characters.', 'ACCESS_REVIEW_NAME_INVALID');
  const dueInDays = Number(input.dueInDays ?? 14);
  if (!REVIEW_DUE_DAYS.has(dueInDays)) throw httpError(400, 'Review due date must be 7, 14 or 30 days.', 'ACCESS_REVIEW_DUE_INVALID');
  const open = db.prepare(`SELECT id FROM external_access_review_campaigns WHERE organization_id = ? AND status = 'open' LIMIT 1`).get(organization.id);
  if (open) throw httpError(409, 'Complete or cancel the current access review before starting another.', 'ACCESS_REVIEW_ALREADY_OPEN');
  const rows = db.prepare(`
    SELECT c.repository_id AS repositoryId, c.user_id AS userId, c.permission,
      c.expires_at AS expiresAt
    FROM repository_collaborators c
    JOIN repositories r ON r.id = c.repository_id
    LEFT JOIN org_members om ON om.organization_id = r.organization_id AND om.user_id = c.user_id
    WHERE r.organization_id = ? AND r.deleted_at IS NULL AND om.user_id IS NULL
      AND (c.expires_at IS NULL OR julianday(c.expires_at) > julianday('now'))
    ORDER BY r.name
  `).all(organization.id);
  if (!rows.length) throw httpError(409, 'There is no active external access to review.', 'ACCESS_REVIEW_EMPTY');
  const campaignId = uid('ear');
  const dueAt = new Date(Date.now() + dueInDays * 86400000).toISOString();
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`
      INSERT INTO external_access_review_campaigns
        (id, organization_id, name, due_at, created_by)
      VALUES (?, ?, ?, ?, ?)
    `).run(campaignId, organization.id, name, dueAt, actor.id);
    const insert = db.prepare(`
      INSERT INTO external_access_review_items
        (id, campaign_id, repository_id, user_id, permission_snapshot, expires_at_snapshot)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const row of rows) insert.run(uid('eai'), campaignId, row.repositoryId, row.userId, row.permission, row.expiresAt);
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  }
  audit(db, {
    organizationId: organization.id,
    userId: actor.id,
    action: 'external_access_review.created',
    targetType: 'external_access_review',
    targetId: campaignId,
    metadata: { dueAt, itemCount: rows.length },
  });
  return campaignDetails(db, organization.id, campaignId);
}

function decideReviewItem(db, config, actor, organization, campaignId, itemId, input) {
  const decision = String(input.decision ?? '').toLowerCase();
  if (!DECISIONS.has(decision)) throw httpError(400, 'Select keep, renew, reduce or revoke.', 'ACCESS_REVIEW_DECISION_INVALID');
  const item = db.prepare(`
    SELECT i.*, r.slug AS repoSlug, r.organization_id AS organizationId,
      u.display_name AS displayName, u.email
    FROM external_access_review_items i
    JOIN repositories r ON r.id = i.repository_id
    JOIN users u ON u.id = i.user_id
    WHERE i.id = ? AND i.campaign_id = ? AND r.organization_id = ?
  `).get(itemId, campaignId, organization.id);
  if (!item) throw httpError(404, 'Access review item not found.', 'ACCESS_REVIEW_ITEM_NOT_FOUND');
  if (item.decision !== 'pending') throw httpError(409, 'This access review item was already decided.', 'ACCESS_REVIEW_ITEM_DECIDED');
  const grant = db.prepare(`SELECT permission, expires_at AS expiresAt FROM repository_collaborators WHERE repository_id = ? AND user_id = ?`).get(item.repository_id, item.user_id);
  let permission = grant?.permission ?? item.permission_snapshot;
  let expiresAt = grant?.expiresAt ?? item.expires_at_snapshot;
  const note = String(input.note ?? '').trim().slice(0, 500);

  db.exec('BEGIN IMMEDIATE');
  try {
    if (decision === 'revoke') {
      db.prepare('DELETE FROM repository_collaborators WHERE repository_id = ? AND user_id = ?').run(item.repository_id, item.user_id);
    } else {
      if (!grant) throw httpError(409, 'The external grant no longer exists.', 'EXTERNAL_ACCESS_NOT_FOUND');
      if (decision === 'renew') {
        expiresAt = expiresAtFromDays(normalizeAccessDays(input.accessDays ?? 90));
      }
      if (decision === 'reduce') {
        const reduced = normalizeRepositoryPermission(input.permission);
        if (permissionAtLeast(reduced, permission)) throw httpError(400, 'Reduced permission must be lower than the current permission.', 'ACCESS_REVIEW_REDUCTION_INVALID');
        permission = reduced;
        if (input.accessDays !== undefined) expiresAt = expiresAtFromDays(normalizeAccessDays(input.accessDays));
      }
      db.prepare(`
        UPDATE repository_collaborators
        SET permission = ?, expires_at = ?, last_reviewed_at = CURRENT_TIMESTAMP,
          next_review_at = ?, added_by = ?, updated_at = CURRENT_TIMESTAMP
        WHERE repository_id = ? AND user_id = ?
      `).run(permission, expiresAt, new Date(Date.now() + 90 * 86400000).toISOString(), actor.id, item.repository_id, item.user_id);
    }
    db.prepare(`
      UPDATE external_access_review_items
      SET decision = ?, decided_by = ?, decided_at = CURRENT_TIMESTAMP, decision_note = ?
      WHERE id = ? AND decision = 'pending'
    `).run(decision, actor.id, note, item.id);
    const pending = Number(db.prepare(`SELECT COUNT(*) AS count FROM external_access_review_items WHERE campaign_id = ? AND decision = 'pending'`).get(campaignId).count);
    if (!pending) db.prepare(`UPDATE external_access_review_campaigns SET status = 'completed', completed_at = CURRENT_TIMESTAMP WHERE id = ?`).run(campaignId);
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  }

  audit(db, {
    organizationId: organization.id,
    userId: actor.id,
    action: `external_access_review.${decision}`,
    targetType: 'repository',
    targetId: item.repository_id,
    metadata: { campaignId, itemId, collaboratorId: item.user_id, permission, expiresAt },
  });
  createNotification(db, config, {
    userId: item.user_id,
    category: 'security',
    title: decision === 'revoke' ? 'External repository access revoked' : 'External repository access reviewed',
    body: decision === 'revoke'
      ? `Your access to ${organization.slug}/${item.repoSlug} was revoked during an access review.`
      : `Your ${permission} access to ${organization.slug}/${item.repoSlug} was reviewed${expiresAt ? ` and is active until ${new Date(expiresAt).toLocaleDateString('en-IN')}` : ''}.`,
    link: decision === 'revoke' ? '#/settings' : `#/repo/${organization.slug}/${item.repoSlug}/code`,
    dedupeKey: `external-access-review:${campaignId}:${item.id}:${decision}`,
    metadata: { campaignId, repositoryId: item.repository_id, decision, permission, expiresAt },
  });
  return campaignDetails(db, organization.id, campaignId);
}

export function sweepExternalAccessNotifications(db, config) {
  migrateNotifications(db);
  const rows = db.prepare(`
    SELECT c.repository_id AS repositoryId, c.user_id AS userId, c.permission,
      c.expires_at AS expiresAt, r.slug AS repoSlug, o.slug AS orgSlug
    FROM repository_collaborators c
    JOIN repositories r ON r.id = c.repository_id
    JOIN organizations o ON o.id = r.organization_id
    LEFT JOIN org_members om ON om.organization_id = r.organization_id AND om.user_id = c.user_id
    WHERE om.user_id IS NULL AND c.expires_at IS NOT NULL
      AND julianday(c.expires_at) <= julianday('now', '+7 days')
      AND julianday(c.expires_at) > julianday('now', '-1 day')
  `).all();
  let queued = 0;
  for (const row of rows) {
    const expired = new Date(row.expiresAt).getTime() <= Date.now();
    createNotification(db, config, {
      userId: row.userId,
      category: 'security',
      title: expired ? 'External repository access expired' : 'External repository access expires soon',
      body: expired
        ? `Your ${row.permission} access to ${row.orgSlug}/${row.repoSlug} has expired.`
        : `Your ${row.permission} access to ${row.orgSlug}/${row.repoSlug} expires on ${new Date(row.expiresAt).toLocaleDateString('en-IN')}.`,
      link: expired ? '#/settings' : `#/repo/${row.orgSlug}/${row.repoSlug}/code`,
      dedupeKey: `external-access-${expired ? 'expired' : 'expiring'}:${row.repositoryId}:${row.userId}:${row.expiresAt}`,
      metadata: { repositoryId: row.repositoryId, permission: row.permission, expiresAt: row.expiresAt },
    });
    queued += 1;
  }
  return { scanned: rows.length, queued };
}

export function startExternalAccessReviewWorker(db, config) {
  let stopped = false;
  const run = () => {
    if (stopped) return;
    try { sweepExternalAccessNotifications(db, config); }
    catch (error) { console.error('[external-access] reminder sweep failed', error); }
  };
  const timer = setInterval(run, REVIEW_INTERVAL_MS);
  timer.unref?.();
  setImmediate(run);
  return () => { stopped = true; clearInterval(timer); };
}

export function createExternalAccessReviewsApiHandler({ config, db }) {
  return async function externalAccessReviewsApi(req, res) {
    const url = new URL(req.url, config.baseUrl);
    const pathname = url.pathname;
    if (!pathname.startsWith('/api/external-access/')) return false;
    const requestId = uid('req');
    res.setHeader('X-Request-Id', requestId);
    res.setHeader('Referrer-Policy', 'no-referrer');
    try {
      if (!originAllowed(req, config.baseUrl)) throw httpError(403, 'Request origin is not allowed.', 'CSRF_BLOCKED');
      const user = requireUser(db, req);
      migrateExternalAccessReviews(db);

      let params = routeMatch(pathname, '/api/external-access/:org/:repo');
      if (req.method === 'GET' && params) {
        const access = requireRepositoryAccess(db, user.id, { orgSlug: params.org, repoSlug: params.repo }, 'read');
        return sendJson(res, 200, {
          repository: access.repository,
          canManage: permissionAtLeast(access.permission, 'admin'),
          organizationAdmin: Boolean(orgAccess(db, user.id, params.org, 'admin')),
          grants: listRepositoryExternalAccess(db, access.repository),
          accessDurations: [...ACCESS_DAYS],
        });
      }

      params = routeMatch(pathname, '/api/external-access/:org/:repo/collaborators/:userId');
      if (req.method === 'PATCH' && params) {
        const access = requireRepositoryAccess(db, user.id, { orgSlug: params.org, repoSlug: params.repo }, 'admin');
        const body = await readJson(req);
        return sendJson(res, 200, { grant: updateExternalGrant(db, config, user, access, params.userId, body) });
      }

      params = routeMatch(pathname, '/api/external-access/:org/reviews');
      if (req.method === 'GET' && params) {
        const organization = requireOrganizationAdmin(db, user.id, params.org);
        return sendJson(res, 200, { organization, campaigns: campaignSummary(db, organization.id) });
      }
      if (req.method === 'POST' && params) {
        const organization = requireOrganizationAdmin(db, user.id, params.org);
        const body = await readJson(req);
        return sendJson(res, 201, { campaign: createCampaign(db, user, organization, body) });
      }

      params = routeMatch(pathname, '/api/external-access/:org/reviews/:campaignId');
      if (req.method === 'GET' && params) {
        const organization = requireOrganizationAdmin(db, user.id, params.org);
        return sendJson(res, 200, { organization, campaign: campaignDetails(db, organization.id, params.campaignId) });
      }

      params = routeMatch(pathname, '/api/external-access/:org/reviews/:campaignId/items/:itemId');
      if (req.method === 'POST' && params) {
        const organization = requireOrganizationAdmin(db, user.id, params.org);
        const body = await readJson(req);
        return sendJson(res, 200, {
          campaign: decideReviewItem(db, config, user, organization, params.campaignId, params.itemId, body),
        });
      }

      throw httpError(404, 'External access endpoint not found.', 'NOT_FOUND');
    } catch (error) {
      const status = Number(error.status) || 500;
      if (status >= 500) console.error(`[${requestId}] external access API`, error);
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
