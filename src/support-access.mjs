import { requireUser } from './auth.mjs';
import { audit, orgAccess, uid } from './db.mjs';
import { httpError, originAllowed } from './security.mjs';

const MAX_BODY_BYTES = 16 * 1024;

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw httpError(413, 'Request body is too large.', 'SUPPORT_REQUEST_TOO_LARGE');
    chunks.push(chunk);
  }
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw httpError(400, 'Invalid JSON request body.', 'INVALID_JSON'); }
}

export const SUPPORT_ACCESS = {
  // Three days. Long enough to work an escalation across a weekend, short
  // enough that nobody has to remember to take it away — and short enough that
  // a grant somebody forgot about is not still open next month.
  maximumHours: 72,
  defaultHours: 24,
  minimumReasonLength: 20,
};

export function migrateSupportAccess(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS support_access_grants (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      repository_id TEXT REFERENCES repositories(id) ON DELETE CASCADE,
      operator_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      operator_email TEXT NOT NULL,
      reason TEXT NOT NULL,
      granted_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expires_at TEXT NOT NULL,
      revoked_at TEXT,
      revoked_by TEXT REFERENCES users(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_support_grants_operator
      ON support_access_grants(operator_user_id, expires_at);
    CREATE INDEX IF NOT EXISTS idx_support_grants_organization
      ON support_access_grants(organization_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS support_access_events (
      id TEXT PRIMARY KEY,
      grant_id TEXT NOT NULL REFERENCES support_access_grants(id) ON DELETE CASCADE,
      repository_id TEXT,
      action TEXT NOT NULL,
      minute TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(grant_id, repository_id, action, minute)
    );
    CREATE INDEX IF NOT EXISTS idx_support_events_grant
      ON support_access_events(grant_id, created_at DESC);
  `);
}

// Which users may hold a support grant at all. Registered by the server, which
// is the only place that knows the configured operator list. Unregistered means
// **no** support access — a check that cannot be performed is a check that
// fails closed, and every test that never registers one is unaffected.
const OPERATORS = new WeakMap();

export function registerSupportOperators(db, isOperator) {
  if (typeof isOperator !== 'function') throw new Error('Support operator check must be a function.');
  OPERATORS.set(db, isOperator);
  return isOperator;
}

/**
 * The grant that lets a named operator read one repository, if there is one.
 *
 * Checked live rather than trusted from the grant row: an operator removed from
 * the instance's list stops having access to everything immediately, including
 * grants a customer gave them yesterday.
 */
export function supportGrantFor(db, { userId, organizationId, repositoryId }) {
  // Asked before the table is touched, not after. An embedding that never
  // registered an operator check has no support access at all, so there is
  // nothing to look up — and a database that never ran this migration is never
  // queried for a table it does not have.
  const isOperator = OPERATORS.get(db);
  if (!isOperator) return null;

  const grant = db.prepare(`
    SELECT id, organization_id AS organizationId, repository_id AS repositoryId,
      operator_email AS operatorEmail, reason, expires_at AS expiresAt
    FROM support_access_grants
    WHERE operator_user_id = ? AND organization_id = ?
      AND revoked_at IS NULL AND expires_at > datetime('now')
      AND (repository_id IS NULL OR repository_id = ?)
    ORDER BY repository_id IS NULL, expires_at DESC
    LIMIT 1
  `).get(userId, organizationId, repositoryId ?? null);
  if (!grant) return null;
  if (!isOperator({ id: userId, email: grant.operatorEmail })) return null;
  return grant;
}

/**
 * Writes down that the grant was used.
 *
 * Bucketed to the minute per repository and action, because a single `git
 * clone` is many requests and a log the customer cannot read is not
 * transparency. What matters is *that* support read this repository at this
 * time, not how many HTTP requests it took.
 */
export function recordSupportAccess(db, { grantId, repositoryId = null, action = 'read' }) {
  const minute = new Date().toISOString().slice(0, 16);
  db.prepare(`
    INSERT OR IGNORE INTO support_access_events (id, grant_id, repository_id, action, minute)
    VALUES (?, ?, ?, ?, ?)
  `).run(uid('sae'), grantId, repositoryId, action, minute);
}

function normalizeEmail(value) {
  return String(value ?? '').trim().toLowerCase();
}

/**
 * Grants a named operator temporary read access.
 *
 * **The customer grants it.** An operator cannot give this to themselves, and
 * that single rule is the whole difference between this and impersonation: the
 * access exists because somebody who owns the data said so, in writing, for a
 * stated reason, for a bounded time.
 */
export function grantSupportAccess(db, config, {
  orgSlug, userId, operatorEmail, reason, hours = SUPPORT_ACCESS.defaultHours, repoSlug = null, isOperator,
}) {
  const organization = orgAccess(db, userId, orgSlug, 'owner');
  if (!organization) throw httpError(403, 'Organization owner access is required.', 'ORG_OWNER_REQUIRED');

  const written = String(reason ?? '').trim();
  if (written.length < SUPPORT_ACCESS.minimumReasonLength) {
    throw httpError(422, `A reason of at least ${SUPPORT_ACCESS.minimumReasonLength} characters is required.`, 'SUPPORT_REASON_REQUIRED');
  }
  const duration = Number(hours);
  if (!Number.isFinite(duration) || duration <= 0 || duration > SUPPORT_ACCESS.maximumHours) {
    throw httpError(422, `Support access lasts between 1 and ${SUPPORT_ACCESS.maximumHours} hours.`, 'SUPPORT_DURATION_INVALID');
  }

  const email = normalizeEmail(operatorEmail);
  const operator = db.prepare('SELECT id, email, display_name AS displayName FROM users WHERE email = ?').get(email);
  if (!operator) throw httpError(404, 'That person has no account on this instance.', 'SUPPORT_OPERATOR_UNKNOWN');
  // Only somebody the instance already trusts to operate it. Otherwise this
  // would be a way to hand repository access to anybody at all, dressed up as
  // a support ticket.
  if (!isOperator(config, operator)) {
    throw httpError(422, 'That person is not a KukGit support operator.', 'SUPPORT_OPERATOR_NOT_ALLOWED');
  }
  if (operator.id === userId) throw httpError(422, 'Support access cannot be granted to yourself.', 'SUPPORT_SELF_GRANT');

  let repositoryId = null;
  if (repoSlug) {
    const repository = db.prepare('SELECT id FROM repositories WHERE organization_id = ? AND slug = ? AND deleted_at IS NULL')
      .get(organization.id, repoSlug);
    if (!repository) throw httpError(404, 'Repository not found.', 'REPO_NOT_FOUND');
    repositoryId = repository.id;
  }

  const id = uid('sag');
  db.prepare(`
    INSERT INTO support_access_grants
      (id, organization_id, repository_id, operator_user_id, operator_email, reason, granted_by, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now', ?))
  `).run(id, organization.id, repositoryId, operator.id, email, written, userId, `+${Math.round(duration * 60)} minutes`);

  audit(db, {
    organizationId: organization.id,
    userId,
    action: 'support_access.granted',
    targetType: 'organization',
    targetId: organization.id,
    metadata: { grantId: id, operatorEmail: email, repositoryId, hours: duration, reason: written },
  });
  return listSupportGrants(db, { orgSlug }).find((grant) => grant.id === id);
}

export function revokeSupportAccess(db, { orgSlug, grantId, userId }) {
  const grant = db.prepare(`
    SELECT g.*, o.slug AS orgSlug FROM support_access_grants g
    JOIN organizations o ON o.id = g.organization_id
    WHERE g.id = ? AND o.slug = ?
  `).get(grantId, orgSlug);
  if (!grant) throw httpError(404, 'No such support grant.', 'SUPPORT_GRANT_NOT_FOUND');

  // The operator may end their own access. Nobody should have to wait for a
  // customer to revoke something support has finished with.
  const isHolder = grant.operator_user_id === userId;
  if (!isHolder && !orgAccess(db, userId, orgSlug, 'admin')) {
    throw httpError(403, 'Organization admin access is required.', 'ORG_ADMIN_REQUIRED');
  }
  if (grant.revoked_at) return { id: grant.id, alreadyRevoked: true };

  db.prepare("UPDATE support_access_grants SET revoked_at = datetime('now'), revoked_by = ? WHERE id = ?")
    .run(userId, grantId);
  audit(db, {
    organizationId: grant.organization_id,
    userId,
    action: 'support_access.revoked',
    targetType: 'organization',
    targetId: grant.organization_id,
    metadata: { grantId, byOperator: isHolder },
  });
  return { id: grantId, revoked: true, byOperator: isHolder };
}

export function listSupportGrants(db, { orgSlug, operatorUserId = null, limit = 100 }) {
  const rows = operatorUserId
    ? db.prepare(`
        SELECT g.*, o.slug AS orgSlug FROM support_access_grants g
        JOIN organizations o ON o.id = g.organization_id
        WHERE g.operator_user_id = ? ORDER BY g.created_at DESC, g.rowid DESC LIMIT ?
      `).all(operatorUserId, limit)
    : db.prepare(`
        SELECT g.*, o.slug AS orgSlug FROM support_access_grants g
        JOIN organizations o ON o.id = g.organization_id
        WHERE o.slug = ? ORDER BY g.created_at DESC, g.rowid DESC LIMIT ?
      `).all(orgSlug, limit);

  return rows.map((row) => {
    const events = db.prepare(`
      SELECT e.action, e.repository_id AS repositoryId, e.created_at AS at, r.slug AS repoSlug
      FROM support_access_events e
      LEFT JOIN repositories r ON r.id = e.repository_id
      WHERE e.grant_id = ? ORDER BY e.created_at DESC LIMIT 200
    `).all(row.id);
    const repository = row.repository_id
      ? db.prepare('SELECT slug FROM repositories WHERE id = ?').get(row.repository_id)?.slug ?? null
      : null;
    return {
      id: row.id,
      orgSlug: row.orgSlug,
      repository,
      scope: repository ? 'repository' : 'organization',
      operatorEmail: row.operator_email,
      reason: row.reason,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      revokedAt: row.revoked_at,
      active: !row.revoked_at && row.expires_at > new Date().toISOString().replace('T', ' ').slice(0, 19),
      // What support actually looked at, in the customer's own view. A grant
      // with no events is a grant nobody used, and that is worth being able to
      // see too.
      uses: events.length,
      events,
    };
  });
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

export function createSupportAccessApiHandler({ config, db, isInstanceAdmin }) {
  return async function supportAccessApi(req, res) {
    const url = new URL(req.url, config.baseUrl);
    const organizationRoute = /^\/api\/orgs\/([^/]+)\/support-access(?:\/([^/]+)\/revoke)?$/.exec(url.pathname);
    const operatorRoute = url.pathname === '/api/instance-admin/support-access';
    if (!organizationRoute && !operatorRoute) return false;

    const requestId = uid('req');
    res.setHeader('X-Request-Id', requestId);
    res.setHeader('Referrer-Policy', 'no-referrer');
    const method = String(req.method || 'GET').toUpperCase();

    try {
      const user = requireUser(db, req);

      if (operatorRoute) {
        if (method !== 'GET') throw httpError(405, 'Method not allowed.', 'METHOD_NOT_ALLOWED');
        if (!isInstanceAdmin(config, user)) throw httpError(403, 'KukGit instance administrator access is required.', 'INSTANCE_ADMIN_REQUIRED');
        return sendJson(res, 200, { grants: listSupportGrants(db, { orgSlug: null, operatorUserId: user.id }) });
      }

      const orgSlug = decodeURIComponent(organizationRoute[1]);
      const grantId = organizationRoute[2] ? decodeURIComponent(organizationRoute[2]) : null;

      if (method === 'GET') {
        // Every member may see it. Support having read the repository is
        // something the people whose work it is are entitled to know, and
        // restricting the record to the person who granted it would make it
        // evidence only for whoever already knew.
        if (!orgAccess(db, user.id, orgSlug, 'viewer')) throw httpError(404, 'Organization not found.', 'ORG_NOT_FOUND');
        return sendJson(res, 200, { grants: listSupportGrants(db, { orgSlug }), maximumHours: SUPPORT_ACCESS.maximumHours });
      }

      if (method !== 'POST') throw httpError(405, 'Method not allowed.', 'METHOD_NOT_ALLOWED');
      if (!originAllowed(req, config.baseUrl)) throw httpError(403, 'Request origin is not allowed.', 'CSRF_BLOCKED');

      if (grantId) {
        return sendJson(res, 200, { ...revokeSupportAccess(db, { orgSlug, grantId, userId: user.id }), requestId });
      }

      const body = await readJson(req);
      const grant = grantSupportAccess(db, config, {
        orgSlug,
        userId: user.id,
        operatorEmail: body.operatorEmail,
        reason: body.reason,
        hours: body.hours ?? SUPPORT_ACCESS.defaultHours,
        repoSlug: body.repoSlug ?? null,
        isOperator: isInstanceAdmin,
      });
      return sendJson(res, 201, { grant, requestId });
    } catch (error) {
      const status = Number(error.status) || 500;
      return sendJson(res, status, {
        error: {
          code: error.code || 'SUPPORT_ACCESS_FAILED',
          message: status >= 500 ? 'Support access is temporarily unavailable.' : error.message,
          requestId,
        },
      });
    }
  };
}
