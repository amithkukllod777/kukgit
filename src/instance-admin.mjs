import fs from 'node:fs';
import path from 'node:path';
import { requireUser } from './auth.mjs';
import { audit, uid } from './db.mjs';
import { normalizeEmail, httpError, originAllowed } from './security.mjs';

const MAX_BODY_BYTES = 64 * 1024;
const MAX_PAGE_SIZE = 50;
const SECRET_KEY_PATTERN = /(password|passwd|otp|token|secret|cipher|refresh|authorization|cookie|private[_-]?key|webhook[_-]?key|api[_-]?key|credential|session[_-]?hash|token[_-]?hash)/i;

export function instanceAdminEmails(config) {
  const configured = String(process.env.KUKGIT_INSTANCE_ADMIN_EMAILS || config.instanceAdminEmails || config.adminEmail || '')
    .split(',')
    .map((email) => email.trim())
    .filter(Boolean)
    .map(normalizeEmail);
  return [...new Set(configured)];
}

export function isInstanceAdmin(config, user) {
  if (!user?.email) return false;
  return instanceAdminEmails(config).includes(normalizeEmail(user.email));
}

export function requireInstanceAdmin(config, user) {
  if (!isInstanceAdmin(config, user)) {
    throw httpError(403, 'Instance administrator permission is required.', 'INSTANCE_ADMIN_REQUIRED');
  }
  return user;
}

export function migrateInstanceAdmin(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS instance_support_notes (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      author_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_instance_support_notes_org
      ON instance_support_notes(organization_id, created_at DESC);
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
    if (size > MAX_BODY_BYTES) throw httpError(413, 'Admin request body is too large.', 'INSTANCE_ADMIN_REQUEST_TOO_LARGE');
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

function safeJson(value, fallback = {}) {
  try { return JSON.parse(value || '{}'); }
  catch { return fallback; }
}

function redact(value, depth = 0) {
  if (depth > 6) return '[redacted-depth]';
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => redact(item, depth + 1));
  if (!value || typeof value !== 'object') return value;
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    output[key] = SECRET_KEY_PATTERN.test(key) ? '[redacted]' : redact(item, depth + 1);
  }
  return output;
}

function safeMetadata(text) {
  return redact(safeJson(text, {}));
}

function integer(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function escapeLike(value) {
  return String(value).replace(/[\\%_]/g, (character) => `\\${character}`);
}

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(name));
}

function countByStatus(db, table, allowedStatuses) {
  if (!tableExists(db, table)) return Object.fromEntries(allowedStatuses.map((status) => [status, 0]));
  const rows = db.prepare(`SELECT status, COUNT(*) AS count FROM ${table} GROUP BY status`).all();
  const result = Object.fromEntries(allowedStatuses.map((status) => [status, 0]));
  for (const row of rows) if (Object.hasOwn(result, row.status)) result[row.status] = Number(row.count);
  return result;
}

function backupSummary(config) {
  try {
    const files = fs.readdirSync(config.backupsDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.kgbak'))
      .map((entry) => {
        const target = path.join(config.backupsDir, entry.name);
        const stat = fs.statSync(target);
        return { name: entry.name, sizeBytes: stat.size, modifiedAt: stat.mtime.toISOString() };
      })
      .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
    return {
      count: files.length,
      totalBytes: files.reduce((sum, file) => sum + file.sizeBytes, 0),
      latest: files[0] || null,
    };
  } catch {
    return { count: 0, totalBytes: 0, latest: null };
  }
}

function overview(db, config) {
  const users = db.prepare(`
    SELECT COUNT(*) AS total,
      SUM(CASE WHEN kuklabs_user_id IS NOT NULL THEN 1 ELSE 0 END) AS centralLinked
    FROM users
  `).get();
  const organizations = db.prepare(`SELECT COUNT(*) AS total FROM organizations WHERE slug <> '__kukgit_trash__'`).get();
  const repositories = db.prepare(`
    SELECT COUNT(*) AS total,
      SUM(CASE WHEN deleted_at IS NULL AND archived_at IS NULL THEN 1 ELSE 0 END) AS active,
      SUM(CASE WHEN deleted_at IS NULL AND archived_at IS NOT NULL THEN 1 ELSE 0 END) AS archived,
      SUM(CASE WHEN deleted_at IS NOT NULL THEN 1 ELSE 0 END) AS trashed
    FROM repositories
  `).get();
  const externalAccess = tableExists(db, 'repository_collaborators')
    ? db.prepare(`
        SELECT COUNT(*) AS total,
          SUM(CASE WHEN c.expires_at IS NULL THEN 1 ELSE 0 END) AS permanent,
          SUM(CASE WHEN c.expires_at IS NOT NULL AND julianday(c.expires_at) > julianday('now') THEN 1 ELSE 0 END) AS active,
          SUM(CASE WHEN c.expires_at IS NOT NULL AND julianday(c.expires_at) <= julianday('now', '+7 days') AND julianday(c.expires_at) > julianday('now') THEN 1 ELSE 0 END) AS expiring
        FROM repository_collaborators c
        JOIN repositories r ON r.id = c.repository_id
        LEFT JOIN org_members om ON om.organization_id = r.organization_id AND om.user_id = c.user_id
        WHERE om.user_id IS NULL
      `).get()
    : { total: 0, permanent: 0, active: 0, expiring: 0 };
  const lfs = tableExists(db, 'lfs_objects')
    ? db.prepare(`SELECT COUNT(*) AS objects, COALESCE(SUM(size), 0) AS bytes FROM lfs_objects`).get()
    : { objects: 0, bytes: 0 };
  const auditActivity = db.prepare(`
    SELECT COUNT(*) AS last24Hours FROM audit_logs WHERE julianday(created_at) >= julianday('now', '-1 day')
  `).get();
  return {
    users: { total: Number(users.total), centralLinked: Number(users.centralLinked || 0) },
    organizations: { total: Number(organizations.total) },
    repositories: Object.fromEntries(Object.entries(repositories).map(([key, value]) => [key, Number(value || 0)])),
    externalAccess: Object.fromEntries(Object.entries(externalAccess).map(([key, value]) => [key, Number(value || 0)])),
    email: countByStatus(db, 'email_outbox', ['pending', 'processing', 'sent', 'failed', 'cancelled']),
    webhooks: countByStatus(db, 'webhook_deliveries', ['pending', 'processing', 'success', 'failure']),
    lfs: { objects: Number(lfs.objects || 0), bytes: Number(lfs.bytes || 0) },
    backups: backupSummary(config),
    audit: { last24Hours: Number(auditActivity.last24Hours || 0) },
    generatedAt: new Date().toISOString(),
  };
}

function searchInstance(db, input) {
  const query = String(input.q || '').trim().replace(/\s+/g, ' ');
  if (query.length < 2 || query.length > 100) throw httpError(400, 'Search query must contain 2 to 100 characters.', 'INSTANCE_SEARCH_INVALID');
  const type = ['all', 'users', 'organizations', 'repositories'].includes(input.type) ? input.type : 'all';
  const page = integer(input.page, 1, 1, 10000);
  const pageSize = integer(input.pageSize, 25, 1, MAX_PAGE_SIZE);
  const offset = (page - 1) * pageSize;
  const like = `%${escapeLike(query)}%`;
  const result = { query, type, page, pageSize, users: [], organizations: [], repositories: [] };
  if (type === 'all' || type === 'users') {
    result.users = db.prepare(`
      SELECT u.id, u.email, u.display_name AS displayName, u.avatar_url AS avatarUrl,
        u.kuklabs_user_id IS NOT NULL AS centralLinked, u.auth_source AS authSource,
        u.created_at AS createdAt,
        COUNT(DISTINCT om.organization_id) AS organizationCount,
        COUNT(DISTINCT rc.repository_id) AS directRepositoryCount
      FROM users u
      LEFT JOIN org_members om ON om.user_id = u.id
      LEFT JOIN repository_collaborators rc ON rc.user_id = u.id
      WHERE u.email LIKE ? ESCAPE '\\' OR u.display_name LIKE ? ESCAPE '\\' OR u.id = ?
      GROUP BY u.id ORDER BY u.created_at DESC LIMIT ? OFFSET ?
    `).all(like, like, query, pageSize, offset).map((row) => ({ ...row, centralLinked: Boolean(row.centralLinked) }));
  }
  if (type === 'all' || type === 'organizations') {
    result.organizations = db.prepare(`
      SELECT o.id, o.slug, o.name, o.plan, o.created_at AS createdAt,
        COUNT(DISTINCT om.user_id) AS memberCount,
        COUNT(DISTINCT r.id) AS repositoryCount
      FROM organizations o
      LEFT JOIN org_members om ON om.organization_id = o.id
      LEFT JOIN repositories r ON r.organization_id = o.id AND r.deleted_at IS NULL
      WHERE o.slug <> '__kukgit_trash__' AND (o.slug LIKE ? ESCAPE '\\' OR o.name LIKE ? ESCAPE '\\' OR o.id = ?)
      GROUP BY o.id ORDER BY o.created_at DESC LIMIT ? OFFSET ?
    `).all(like, like, query, pageSize, offset);
  }
  if (type === 'all' || type === 'repositories') {
    result.repositories = db.prepare(`
      SELECT r.id, r.slug, r.name, r.visibility, r.archived_at AS archivedAt,
        r.deleted_at AS deletedAt, r.updated_at AS updatedAt,
        o.id AS organizationId, o.slug AS orgSlug, o.name AS orgName
      FROM repositories r JOIN organizations o ON o.id = r.organization_id
      WHERE o.slug <> '__kukgit_trash__' AND (
        r.slug LIKE ? ESCAPE '\\' OR r.name LIKE ? ESCAPE '\\' OR r.id = ? OR
        o.slug LIKE ? ESCAPE '\\' OR o.name LIKE ? ESCAPE '\\'
      )
      ORDER BY r.updated_at DESC LIMIT ? OFFSET ?
    `).all(like, like, query, like, like, pageSize, offset);
  }
  return result;
}

function organizationDetail(db, slug) {
  const organization = db.prepare(`
    SELECT id, slug, name, plan, description, website_url AS websiteUrl,
      company_size AS companySize, onboarding_completed_at AS onboardingCompletedAt,
      created_at AS createdAt
    FROM organizations WHERE slug = ? AND slug <> '__kukgit_trash__'
  `).get(slug);
  if (!organization) throw httpError(404, 'Organization not found.', 'ORGANIZATION_NOT_FOUND');
  const members = db.prepare(`
    SELECT u.id, u.email, u.display_name AS displayName, om.role,
      om.created_at AS joinedAt, u.kuklabs_user_id IS NOT NULL AS centralLinked
    FROM org_members om JOIN users u ON u.id = om.user_id
    WHERE om.organization_id = ? ORDER BY CASE om.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, u.display_name
  `).all(organization.id).map((row) => ({ ...row, centralLinked: Boolean(row.centralLinked) }));
  const repositories = db.prepare(`
    SELECT r.id, r.slug, r.name, r.visibility, r.archived_at AS archivedAt,
      r.deleted_at AS deletedAt, r.updated_at AS updatedAt,
      COUNT(DISTINCT i.id) AS issueCount, COUNT(DISTINCT p.id) AS pullRequestCount,
      COUNT(DISTINCT rc.user_id) AS directCollaboratorCount,
      COUNT(DISTINCT rlo.oid) AS lfsObjectCount,
      COALESCE(SUM(DISTINCT lo.size), 0) AS lfsBytes
    FROM repositories r
    LEFT JOIN issues i ON i.repository_id = r.id
    LEFT JOIN pull_requests p ON p.repository_id = r.id
    LEFT JOIN repository_collaborators rc ON rc.repository_id = r.id
    LEFT JOIN repository_lfs_objects rlo ON rlo.repository_id = r.id
    LEFT JOIN lfs_objects lo ON lo.oid = rlo.oid
    WHERE r.organization_id = ?
    GROUP BY r.id ORDER BY r.updated_at DESC
  `).all(organization.id);
  const externalAccess = db.prepare(`
    SELECT rc.repository_id AS repositoryId, r.slug AS repoSlug, rc.user_id AS userId,
      u.email, u.display_name AS displayName, rc.permission, rc.expires_at AS expiresAt,
      rc.last_reviewed_at AS lastReviewedAt
    FROM repository_collaborators rc
    JOIN repositories r ON r.id = rc.repository_id
    JOIN users u ON u.id = rc.user_id
    LEFT JOIN org_members om ON om.organization_id = r.organization_id AND om.user_id = rc.user_id
    WHERE r.organization_id = ? AND om.user_id IS NULL
    ORDER BY COALESCE(rc.expires_at, '9999-12-31'), r.name, u.display_name
  `).all(organization.id);
  const webhookFailures = tableExists(db, 'webhook_deliveries') ? db.prepare(`
    SELECT d.id, d.event, d.status, d.attempt_count AS attemptCount,
      d.response_status AS responseStatus, d.last_error AS lastError,
      d.updated_at AS updatedAt, r.slug AS repoSlug
    FROM webhook_deliveries d
    JOIN repository_webhooks w ON w.id = d.webhook_id
    JOIN repositories r ON r.id = w.repository_id
    WHERE r.organization_id = ? AND d.status = 'failure'
    ORDER BY d.updated_at DESC LIMIT 50
  `).all(organization.id) : [];
  const emailFailures = tableExists(db, 'email_outbox') ? db.prepare(`
    SELECT e.id, e.to_email AS toEmail, e.category, e.subject, e.status,
      e.attempt_count AS attemptCount, e.last_error AS lastError, e.updated_at AS updatedAt
    FROM email_outbox e
    WHERE e.status = 'failed' AND e.user_id IN (
      SELECT user_id FROM org_members WHERE organization_id = ?
    )
    ORDER BY e.updated_at DESC LIMIT 50
  `).all(organization.id) : [];
  const activity = db.prepare(`
    SELECT a.id, a.action, a.target_type AS targetType, a.target_id AS targetId,
      a.metadata_json AS metadataJson, a.created_at AS createdAt,
      u.display_name AS userName, u.email AS userEmail
    FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id
    WHERE a.organization_id = ? ORDER BY a.created_at DESC LIMIT 100
  `).all(organization.id).map((row) => ({ ...row, metadata: safeMetadata(row.metadataJson), metadataJson: undefined }));
  const notes = db.prepare(`
    SELECT n.id, n.body, n.created_at AS createdAt,
      u.id AS authorId, u.display_name AS authorName, u.email AS authorEmail
    FROM instance_support_notes n JOIN users u ON u.id = n.author_id
    WHERE n.organization_id = ? ORDER BY n.created_at DESC LIMIT 100
  `).all(organization.id);
  return { organization, members, repositories, externalAccess, webhookFailures, emailFailures, activity, notes };
}

function userDetail(db, userId) {
  const user = db.prepare(`
    SELECT id, email, display_name AS displayName, avatar_url AS avatarUrl,
      kuklabs_user_id AS kuklabsUserId, auth_source AS authSource,
      email_verified AS emailVerified, phone, created_at AS createdAt
    FROM users WHERE id = ?
  `).get(userId);
  if (!user) throw httpError(404, 'User not found.', 'USER_NOT_FOUND');
  user.emailVerified = Boolean(user.emailVerified);
  const memberships = db.prepare(`
    SELECT o.id, o.slug, o.name, o.plan, om.role, om.created_at AS joinedAt
    FROM org_members om JOIN organizations o ON o.id = om.organization_id
    WHERE om.user_id = ? AND o.slug <> '__kukgit_trash__' ORDER BY o.name
  `).all(userId);
  const directAccess = db.prepare(`
    SELECT r.id AS repositoryId, r.slug AS repoSlug, r.name AS repoName,
      o.slug AS orgSlug, o.name AS orgName, rc.permission,
      rc.expires_at AS expiresAt, rc.created_at AS grantedAt
    FROM repository_collaborators rc
    JOIN repositories r ON r.id = rc.repository_id
    JOIN organizations o ON o.id = r.organization_id
    WHERE rc.user_id = ? ORDER BY rc.created_at DESC
  `).all(userId);
  const security = {
    activeSessions: Number(db.prepare(`SELECT COUNT(*) AS count FROM sessions WHERE user_id = ? AND julianday(expires_at) > julianday('now')`).get(userId).count),
    activePersonalAccessTokens: Number(db.prepare(`SELECT COUNT(*) AS count FROM personal_access_tokens WHERE user_id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR julianday(expires_at) > julianday('now'))`).get(userId).count),
    activeSshKeys: tableExists(db, 'user_ssh_keys')
      ? Number(db.prepare(`SELECT COUNT(*) AS count FROM user_ssh_keys WHERE user_id = ? AND revoked_at IS NULL`).get(userId).count)
      : 0,
  };
  const notifications = tableExists(db, 'notifications')
    ? db.prepare(`SELECT COUNT(*) AS total, SUM(CASE WHEN read_at IS NULL THEN 1 ELSE 0 END) AS unread FROM notifications WHERE user_id = ?`).get(userId)
    : { total: 0, unread: 0 };
  return {
    user,
    memberships,
    directAccess,
    security,
    notifications: { total: Number(notifications.total || 0), unread: Number(notifications.unread || 0) },
  };
}

function auditLookup(db, input) {
  const query = String(input.q || '').trim();
  const orgSlug = String(input.org || '').trim();
  const action = String(input.action || '').trim();
  const page = integer(input.page, 1, 1, 10000);
  const pageSize = integer(input.pageSize, 50, 1, 100);
  const offset = (page - 1) * pageSize;
  const conditions = [];
  const args = [];
  if (orgSlug) {
    conditions.push('o.slug = ?');
    args.push(orgSlug);
  }
  if (action) {
    conditions.push("a.action LIKE ? ESCAPE '\\'");
    args.push(`%${escapeLike(action)}%`);
  }
  if (query) {
    if (query.length > 120) throw httpError(400, 'Audit query is too long.', 'AUDIT_QUERY_INVALID');
    const like = `%${escapeLike(query)}%`;
    conditions.push("(a.id = ? OR a.target_id = ? OR a.action LIKE ? ESCAPE '\\' OR a.metadata_json LIKE ? ESCAPE '\\')");
    args.push(query, query, like, like);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = db.prepare(`
    SELECT a.id, a.action, a.target_type AS targetType, a.target_id AS targetId,
      a.metadata_json AS metadataJson, a.created_at AS createdAt,
      o.slug AS orgSlug, o.name AS orgName,
      u.id AS userId, u.display_name AS userName, u.email AS userEmail
    FROM audit_logs a
    LEFT JOIN organizations o ON o.id = a.organization_id
    LEFT JOIN users u ON u.id = a.user_id
    ${where}
    ORDER BY a.created_at DESC LIMIT ? OFFSET ?
  `).all(...args, pageSize, offset);
  return {
    page,
    pageSize,
    events: rows.map((row) => ({ ...row, metadata: safeMetadata(row.metadataJson), metadataJson: undefined })),
  };
}

function addSupportNote(db, actor, organization, body) {
  const note = String(body.note || '').trim().replace(/\r\n/g, '\n');
  if (note.length < 3 || note.length > 4000) throw httpError(400, 'Support note must contain 3 to 4000 characters.', 'SUPPORT_NOTE_INVALID');
  if (String(body.confirm || '') !== organization.slug) {
    throw httpError(400, `Type ${organization.slug} to confirm this support note.`, 'SUPPORT_CONFIRMATION_REQUIRED');
  }
  const id = uid('spn');
  db.prepare(`INSERT INTO instance_support_notes (id, organization_id, author_id, body) VALUES (?, ?, ?, ?)`)
    .run(id, organization.id, actor.id, note);
  audit(db, {
    organizationId: organization.id,
    userId: actor.id,
    action: 'instance_support.note_added',
    targetType: 'organization',
    targetId: organization.id,
    metadata: { supportNoteId: id, length: note.length },
  });
  return db.prepare(`
    SELECT n.id, n.body, n.created_at AS createdAt,
      u.id AS authorId, u.display_name AS authorName, u.email AS authorEmail
    FROM instance_support_notes n JOIN users u ON u.id = n.author_id WHERE n.id = ?
  `).get(id);
}

function retryEmail(db, actor, outboxId, body) {
  if (String(body.confirm || '') !== outboxId) throw httpError(400, 'Type the email delivery ID to confirm retry.', 'SUPPORT_CONFIRMATION_REQUIRED');
  const email = db.prepare(`SELECT id, status, to_email AS toEmail, category FROM email_outbox WHERE id = ?`).get(outboxId);
  if (!email) throw httpError(404, 'Email delivery not found.', 'EMAIL_DELIVERY_NOT_FOUND');
  if (!['failed', 'cancelled'].includes(email.status)) throw httpError(409, 'Only failed or cancelled email can be retried.', 'EMAIL_RETRY_STATE_INVALID');
  db.prepare(`
    UPDATE email_outbox SET status = 'pending', attempt_count = 0,
      next_attempt_at = CURRENT_TIMESTAMP, last_attempt_at = NULL,
      sent_at = NULL, last_error = NULL, provider_response = NULL,
      updated_at = CURRENT_TIMESTAMP WHERE id = ?
  `).run(outboxId);
  audit(db, { userId: actor.id, action: 'instance_support.email_retried', targetType: 'email_delivery', targetId: outboxId, metadata: { category: email.category } });
  return { ...email, status: 'pending' };
}

function retryWebhook(db, actor, deliveryId, body) {
  if (String(body.confirm || '') !== deliveryId) throw httpError(400, 'Type the webhook delivery ID to confirm retry.', 'SUPPORT_CONFIRMATION_REQUIRED');
  const delivery = db.prepare(`
    SELECT d.id, d.status, d.event, r.id AS repositoryId, r.organization_id AS organizationId
    FROM webhook_deliveries d
    JOIN repository_webhooks w ON w.id = d.webhook_id
    JOIN repositories r ON r.id = w.repository_id
    WHERE d.id = ?
  `).get(deliveryId);
  if (!delivery) throw httpError(404, 'Webhook delivery not found.', 'WEBHOOK_DELIVERY_NOT_FOUND');
  if (delivery.status !== 'failure') throw httpError(409, 'Only failed webhook deliveries can be retried.', 'WEBHOOK_RETRY_STATE_INVALID');
  db.prepare(`
    UPDATE webhook_deliveries SET status = 'pending', attempt_count = 0,
      next_attempt_at = CURRENT_TIMESTAMP, response_status = NULL,
      response_headers_json = NULL, response_body = NULL, last_error = NULL,
      delivered_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?
  `).run(deliveryId);
  audit(db, {
    organizationId: delivery.organizationId,
    userId: actor.id,
    action: 'instance_support.webhook_retried',
    targetType: 'webhook_delivery',
    targetId: deliveryId,
    metadata: { repositoryId: delivery.repositoryId, event: delivery.event },
  });
  return { id: deliveryId, status: 'pending', event: delivery.event };
}

/**
 * Operator paths that belong to another module.
 *
 * This handler runs before them in the chain and ends with a 404 for anything
 * it does not recognise, so without this list it answered for all of them —
 * abuse cases, maintenance windows, status incidents, support access and
 * blocked content were 404 on the real server while their own tests passed,
 * because those tests call each module's handler directly.
 *
 * `/api/instance-admin/status` is this module's own — it is what the panel asks
 * to find out whether the session is an operator. Only `status/incidents`
 * belongs to the status page.
 */
const DELEGATED_PREFIXES = [
  '/api/instance-admin/abuse/',
  '/api/instance-admin/maintenance/',
  '/api/instance-admin/status/incidents',
  '/api/instance-admin/support-access',
  '/api/instance-admin/blocked-content',
  '/api/instance-admin/usage',
  '/api/instance-admin/billing',
  '/api/instance-admin/integrations',
];

export function delegatedToAnotherHandler(pathname) {
  return DELEGATED_PREFIXES.some((prefix) => pathname === prefix.replace(/\/$/, '') || pathname.startsWith(prefix));
}

export function createInstanceAdminApiHandler({ config, db }) {
  return async function instanceAdminApi(req, res) {
    const url = new URL(req.url, config.baseUrl);
    if (!url.pathname.startsWith('/api/instance-admin')) return false;
    if (delegatedToAnotherHandler(url.pathname)) return false;
    const requestId = uid('req');
    res.setHeader('X-Request-Id', requestId);
    res.setHeader('Referrer-Policy', 'no-referrer');
    try {
      if (!originAllowed(req, config.baseUrl)) throw httpError(403, 'Request origin is not allowed.', 'CSRF_BLOCKED');
      const user = requireInstanceAdmin(config, requireUser(db, req));
      migrateInstanceAdmin(db);

      if (req.method === 'GET' && url.pathname === '/api/instance-admin/status') {
        return sendJson(res, 200, { instanceAdmin: true, email: user.email });
      }
      if (req.method === 'GET' && url.pathname === '/api/instance-admin/overview') {
        return sendJson(res, 200, { overview: overview(db, config) });
      }
      if (req.method === 'GET' && url.pathname === '/api/instance-admin/search') {
        return sendJson(res, 200, { results: searchInstance(db, Object.fromEntries(url.searchParams)) });
      }
      if (req.method === 'GET' && url.pathname === '/api/instance-admin/audit') {
        return sendJson(res, 200, { audit: auditLookup(db, Object.fromEntries(url.searchParams)) });
      }

      let params = routeMatch(url.pathname, '/api/instance-admin/organizations/:slug');
      if (params && req.method === 'GET') return sendJson(res, 200, organizationDetail(db, params.slug));

      params = routeMatch(url.pathname, '/api/instance-admin/organizations/:slug/notes');
      if (params && req.method === 'POST') {
        const organization = db.prepare(`SELECT id, slug, name FROM organizations WHERE slug = ? AND slug <> '__kukgit_trash__'`).get(params.slug);
        if (!organization) throw httpError(404, 'Organization not found.', 'ORGANIZATION_NOT_FOUND');
        return sendJson(res, 201, { note: addSupportNote(db, user, organization, await readJson(req)) });
      }

      params = routeMatch(url.pathname, '/api/instance-admin/users/:userId');
      if (params && req.method === 'GET') return sendJson(res, 200, userDetail(db, params.userId));

      params = routeMatch(url.pathname, '/api/instance-admin/email/:outboxId/retry');
      if (params && req.method === 'POST') return sendJson(res, 200, { delivery: retryEmail(db, user, params.outboxId, await readJson(req)) });

      params = routeMatch(url.pathname, '/api/instance-admin/webhooks/:deliveryId/retry');
      if (params && req.method === 'POST') return sendJson(res, 200, { delivery: retryWebhook(db, user, params.deliveryId, await readJson(req)) });

      throw httpError(404, 'Instance admin endpoint not found.', 'NOT_FOUND');
    } catch (error) {
      const status = Number(error.status) || 500;
      if (status >= 500) console.error(`[${requestId}] instance admin API`, error);
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
