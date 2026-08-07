import { audit, uid } from './db.mjs';
import { httpError, originAllowed } from './security.mjs';
import { requireUser } from './auth.mjs';

export const TENANT_LIFECYCLE = {
  // A deletion request waits before it executes. Deletion is the one operation
  // with no undo, and the most common reason to want one reversed is that it was
  // a mistake noticed within the hour.
  graceDays: 7,
  maxReasonLength: 2000,
};

/**
 * Tables whose link to a tenant is polymorphic, so no foreign key expresses it.
 *
 * `secrets` is scoped by `(scope, scope_id)` where the scope names which kind of
 * thing the id refers to. The graph cannot see that, and the first run of the
 * derivation reported it as unclassified — which is exactly what it is for. Left
 * unhandled, deleting an organization would leave its encrypted credentials in
 * the database forever.
 *
 * Each entry is a hand-written clause with `?` bound to the organization id.
 */
const POLYMORPHIC_TENANT_TABLES = new Map([
  ['secrets', `(
    (scope = 'organization' AND scope_id = ?)
    OR (scope = 'repository' AND scope_id IN (SELECT id FROM repositories WHERE organization_id = ?))
  )`],
]);

// Tables that are deliberately never deleted with a tenant, and why. Anything
// not listed here, not polymorphic above, and not reachable from
// `organizations` is a gap — and `tenantTableGraph` reports it as one rather
// than passing over it.
const NEVER_TENANT_SCOPED = new Map([
  ['users', 'a person is not owned by an organization and may belong to others'],
  ['sessions', 'belongs to a user'],
  // A live verification or password-reset link. Belongs to the person, not to
  // any organization they happen to be in — and it is a credential, so it must
  // never travel in a tenant export either.
  ['account_tokens', 'belongs to a user, and is a credential'],
  ['user_identities', 'a person\'s GitHub or Google account, which is theirs and not the tenant\'s'],
  ['oauth_states', 'a sign-in attempt in flight, with a ten-minute lifetime'],
  ['personal_access_tokens', 'belongs to a user'],
  ['user_ssh_keys', 'belongs to a user'],
  ['notification_preferences', 'belongs to a user'],
  ['notifications', 'belongs to a user'],
  ['notification_fanout', 'ephemeral delivery hints, pruned by age'],
  ['email_outbox', 'addressed to a person, not an organization'],
  ['email_delivery_attempts', 'belongs to an outbox row'],
  ['email_provider_events', 'belongs to an outbox row'],
  ['email_recipient_health', 'belongs to an email address'],
  ['email_suppressions', 'belongs to an email address'],
  ['job_leases', 'instance coordination state with a lifetime in seconds'],
  ['maintenance_windows', 'instance-wide downtime, not owned by any one tenant'],
  ['status_incidents', 'published to the public status page about the instance, not a tenant'],
  // Deliberately outlives the tenant. A moderation record that disappears when
  // the reported party leaves is a record that says nothing about repeat
  // offenders, and it is the one somebody asks for afterwards.
  ['abuse_cases', 'the record of what was reported and what was decided, kept as evidence'],
  ['abuse_reports', 'belongs to an abuse case'],
  ['abuse_appeals', 'the customer\'s reply to a moderation decision, kept with it'],
  ['blocked_content', 'a hash the instance refuses to serve, not owned by any tenant'],
  // Credentials for the instance's own accounts with Resend, Razorpay, Stripe
  // and the identity providers. Never a tenant's, and an export that carried
  // them would hand every customer the keys to the business.
  ['instance_settings', 'the instance\'s own integration credentials'],
  ['instance_integration_state', 'which of the instance\'s integrations are switched on'],
  // Unverified deliveries to the instance's own webhook URL. They name no
  // tenant — that is the point, since a refused delivery is one we could not
  // attribute — and the body is never kept.
  ['billing_webhook_rejections', 'refused webhook deliveries to the instance, attributed to no tenant'],
  ['status_incident_updates', 'belongs to a status incident'],
  ['kukgit_schema_migrations', 'schema history for the instance'],
  ['organizations', 'the tenant row itself, removed last'],
  ['lfs_objects', 'content-addressed and shared; removed by reference count'],
  ['workflow_blobs', 'content-addressed and shared; removed by reference count'],
  // Deliberately outlives the tenant, and deliberately has no foreign key to it.
  // The record of who asked for a deletion, when, why, and what the verification
  // found is the evidence the deletion happened — destroying it along with the
  // tenant would leave nothing to show for it.
  ['tenant_deletion_requests', 'the record of the deletion itself, kept as evidence'],
  ['tenant_exports', 'the record of what the customer was handed, kept as evidence'],
  ['tenant_imports', 'the record of where a tenant came from, kept as evidence'],
]);

function tableNames(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all().map((row) => row.name);
}

function foreignKeys(db, table) {
  const nullable = new Map(db.prepare(`PRAGMA table_info(${table})`).all()
    .map((row) => [row.name, row.notnull === 0]));
  return db.prepare(`PRAGMA foreign_key_list(${table})`).all()
    .map((row) => ({ table: row.table, from: row.from, to: row.to, nullable: nullable.get(row.from) !== false }));
}

/**
 * Works out how every table reaches an organization, from the schema itself.
 *
 * Deriving this rather than writing it down is the point. A hand-maintained list
 * of "tables to delete" is correct on the day it is written and wrong by the
 * next migration, and the failure is silent: a tenant is deleted, the report
 * says complete, and rows nobody enumerated are still there. Every table added
 * from now on is included automatically or reported as unreachable.
 *
 * The result is a delete order: children before parents, so foreign keys hold at
 * every step rather than being switched off.
 */
export function tenantTableGraph(db) {
  const tables = tableNames(db);
  const paths = new Map([['organizations', { table: 'organizations', column: 'id', via: null, depth: 0 }]]);
  const unreachable = [];

  // Breadth-first from `organizations`, following foreign keys inward.
  let changed = true;
  while (changed) {
    changed = false;
    for (const table of tables) {
      if (paths.has(table)) continue;
      // Every foreign key that reaches a known parent, then the best one —
      // not simply the first.
      //
      // `repositories` has both `organization_id NOT NULL` and a nullable
      // `deleted_from_org_id` left by the trash workflow. Taking the first match
      // picked the nullable one, and every table reachable *through*
      // repositories was then scoped by a column that is null for every live
      // repository. The census printed almost nothing, which is what made it
      // visible; a deletion would have reported success having removed one row.
      const candidates = foreignKeys(db, table)
        .map((key) => ({ key, parent: paths.get(key.table) }))
        .filter((candidate) => candidate.parent)
        .sort((a, b) => {
          // A nullable link is optional and cannot be the ownership path.
          if (a.key.nullable !== b.key.nullable) return a.key.nullable ? 1 : -1;
          return a.parent.depth - b.parent.depth;
        });
      if (candidates.length) {
        const { key, parent } = candidates[0];
        paths.set(table, { table, column: key.from, via: { table: key.table, column: key.to }, depth: parent.depth + 1 });
        changed = true;
      }
    }
  }

  const polymorphic = [];
  for (const table of tables) {
    if (paths.has(table)) continue;
    if (POLYMORPHIC_TENANT_TABLES.has(table)) { polymorphic.push(table); continue; }
    unreachable.push({ table, reason: NEVER_TENANT_SCOPED.get(table) ?? null });
  }

  // Deepest first: a child is removed before the row it points at.
  const ordered = [...paths.values()]
    .filter((entry) => entry.table !== 'organizations')
    .sort((a, b) => b.depth - a.depth || a.table.localeCompare(b.table));

  return {
    // Polymorphic tables go first: their rows point at repositories, which the
    // ordinary order removes.
    deleteOrder: [...polymorphic.map((table) => ({ table, polymorphic: true, depth: 99 })), ...ordered],
    polymorphic,
    unreachable,
    // A table nobody has classified is the gap this whole design exists to
    // prevent. Surfaced rather than assumed harmless.
    unclassified: unreachable.filter((entry) => entry.reason === null).map((entry) => entry.table),
  };
}

function selectorFor(entry, graph) {
  if (entry.polymorphic) {
    const sql = POLYMORPHIC_TENANT_TABLES.get(entry.table);
    return { sql, params: (sql.match(/\?/g) ?? []).length };
  }
  // A row belongs to the tenant if it can be followed up the chain to it. Built
  // as nested `IN` rather than joins so each table's clause is independent of
  // the ones around it and can be read on its own.
  if (!entry.via) return { sql: `${entry.column} = ?`, params: 1 };
  return {
    sql: `${entry.column} IN (SELECT ${entry.via.column} FROM ${entry.via.table} WHERE ${subSelector(entry.via.table, graph)})`,
    params: 1,
  };
}

function subSelector(table, graph) {
  if (table === 'organizations') return 'id = ?';
  const entry = graph?.deleteOrder.find((candidate) => candidate.table === table);
  if (!entry) return '1 = 0';
  if (!entry.via) return `${entry.column} = ?`;
  return `${entry.column} IN (SELECT ${entry.via.column} FROM ${entry.via.table} WHERE ${subSelector(entry.via.table, graph)})`;
}

/**
 * The one place a "rows this tenant owns" clause is built.
 *
 * The census, the deletion and the export all read it. That is what makes an
 * export and a deletion cover the same rows by construction rather than by two
 * lists agreeing today: if a table is exported it is deleted, and if it is
 * deleted it was exported.
 */
export function tenantSelectors(db) {
  const graph = tenantTableGraph(db);
  return {
    graph,
    selectors: graph.deleteOrder.map((entry) => ({ ...entry, ...selectorFor(entry, graph) })),
  };
}

/**
 * Counts every row this tenant owns, table by table.
 *
 * Run before a deletion and again after. Before, it is what somebody is agreeing
 * to destroy; after, every number must be zero, and a number that is not is the
 * report saying so rather than the deletion claiming success.
 */
export function tenantRowCensus(db, organizationId) {
  const { graph, selectors } = tenantSelectors(db);
  const counts = {};
  let total = 0;
  for (const selector of selectors) {
    try {
      const count = Number(db.prepare(`SELECT COUNT(*) AS count FROM ${selector.table} WHERE ${selector.sql}`)
        .get(...Array(selector.params).fill(organizationId)).count);
      if (count) { counts[selector.table] = count; total += count; }
    } catch (error) {
      // A table whose linkage cannot be queried is reported, never skipped.
      counts[selector.table] = { error: error.message };
    }
  }
  const organization = db.prepare('SELECT COUNT(*) AS count FROM organizations WHERE id = ?').get(organizationId).count;
  return { organizationId, total, organizationRows: Number(organization), counts, unclassified: graph.unclassified };
}

export function migrateTenantLifecycle(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tenant_deletion_requests (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      organization_slug TEXT NOT NULL,
      reason TEXT NOT NULL,
      requested_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      requested_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      execute_after TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'scheduled' CHECK(status IN ('scheduled','cancelled','executed','failed')),
      cancelled_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      cancelled_at TEXT,
      executed_at TEXT,
      census_before TEXT,
      census_after TEXT,
      verification TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_tenant_deletion_status
      ON tenant_deletion_requests(status, execute_after);
  `);
}

function findOrganization(db, slug) {
  return db.prepare('SELECT id, slug, name FROM organizations WHERE slug = ?').get(slug) ?? null;
}

/**
 * Schedules a deletion rather than performing one.
 *
 * The delay is the whole feature. Deletion is the one operation with no undo,
 * and the most common reason to want one reversed is that it was a mistake
 * noticed within the hour. A request that executed immediately would be correct
 * and useless.
 */
export function requestTenantDeletion(db, { slug, reason, userId, graceDays = TENANT_LIFECYCLE.graceDays }) {
  const organization = findOrganization(db, slug);
  if (!organization) throw httpError(404, 'Organization not found.', 'ORGANIZATION_NOT_FOUND');
  const trimmed = String(reason ?? '').trim();
  if (trimmed.length < 20) {
    throw httpError(400, 'A deletion request needs a reason of at least 20 characters.', 'DELETION_REASON_REQUIRED');
  }
  const existing = db.prepare("SELECT id FROM tenant_deletion_requests WHERE organization_id = ? AND status = 'scheduled'")
    .get(organization.id);
  if (existing) throw httpError(409, 'A deletion is already scheduled for this organization.', 'DELETION_ALREADY_SCHEDULED');

  const id = uid('del');
  const census = tenantRowCensus(db, organization.id);
  db.prepare(`
    INSERT INTO tenant_deletion_requests
      (id, organization_id, organization_slug, reason, requested_by, execute_after, census_before)
    VALUES (?, ?, ?, ?, ?, datetime('now', ?), ?)
  `).run(id, organization.id, organization.slug, trimmed.slice(0, TENANT_LIFECYCLE.maxReasonLength), userId,
    `+${Math.max(0, Math.round(graceDays))} days`, JSON.stringify(census));

  return { id, organizationId: organization.id, slug: organization.slug, census, graceDays };
}

export function cancelTenantDeletion(db, { requestId, userId }) {
  const changed = db.prepare(`
    UPDATE tenant_deletion_requests SET status = 'cancelled', cancelled_by = ?, cancelled_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status = 'scheduled'
  `).run(userId, requestId).changes;
  if (!changed) throw httpError(404, 'No scheduled deletion with that id.', 'DELETION_NOT_SCHEDULED');
  return { requestId, status: 'cancelled' };
}

export function listTenantDeletions(db, { status = null } = {}) {
  const rows = status
    ? db.prepare('SELECT * FROM tenant_deletion_requests WHERE status = ? ORDER BY requested_at DESC').all(status)
    : db.prepare('SELECT * FROM tenant_deletion_requests ORDER BY requested_at DESC LIMIT 100').all();
  return rows.map((row) => ({
    id: row.id,
    organizationId: row.organization_id,
    slug: row.organization_slug,
    reason: row.reason,
    status: row.status,
    requestedAt: row.requested_at,
    executeAfter: row.execute_after,
    executedAt: row.executed_at,
    cancelledAt: row.cancelled_at,
    censusBefore: row.census_before ? JSON.parse(row.census_before) : null,
    censusAfter: row.census_after ? JSON.parse(row.census_after) : null,
    verification: row.verification ? JSON.parse(row.verification) : null,
  }));
}

/**
 * Deletes the tenant, then proves it.
 *
 * The proof is the point. "We deleted it" is a claim anybody can make; a census
 * taken afterwards against a schema-derived table list is a check that fails
 * loudly when something was missed.
 *
 * Repository bytes and LFS objects are **not** touched here. They are removed by
 * the repository lifecycle, which already knows how to do it safely — deleting
 * content-addressed objects that another tenant shares is a way to destroy
 * somebody else's data while destroying your own.
 */
/**
 * Finds the export that makes this deletion survivable.
 *
 * Required to be taken **after the request was made**, not merely to exist. An
 * export from six months ago is a copy of a tenant that no longer exists, and
 * handing it over would be a worse outcome than admitting there is none.
 *
 * A database that predates the export feature has no table at all, which is
 * treated as "no export" rather than as permission to skip the check.
 */
function verifiedExportSince(db, organizationId, since) {
  const table = db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'tenant_exports'").get();
  if (!table) return null;
  return db.prepare(`
    SELECT id, archive_path AS archivePath, archive_sha256 AS archiveSha256, archive_bytes AS archiveBytes, created_at AS createdAt
    FROM tenant_exports
    WHERE organization_id = ? AND complete = 1 AND verified_at IS NOT NULL AND created_at >= ?
    ORDER BY created_at DESC, rowid DESC LIMIT 1
  `).get(organizationId, since) ?? null;
}

export function executeTenantDeletion(db, { requestId, now = new Date(), force = false, withoutExport = false }) {
  const request = db.prepare("SELECT * FROM tenant_deletion_requests WHERE id = ? AND status = 'scheduled'").get(requestId);
  if (!request) throw httpError(404, 'No scheduled deletion with that id.', 'DELETION_NOT_SCHEDULED');
  if (!force && request.execute_after > now.toISOString()) {
    throw httpError(409, `This deletion is not due until ${request.execute_after}.`, 'DELETION_NOT_DUE');
  }

  // Two overrides, deliberately separate. Skipping the wait is an operator in a
  // hurry; skipping the export is the customer losing their data. One flag for
  // both would let the second happen while somebody meant the first.
  const exported = verifiedExportSince(db, request.organization_id, request.requested_at);
  if (!exported && !withoutExport) {
    throw httpError(409, `No verified export of '${request.organization_slug}' has been taken since this deletion was requested. Run: npm run export -- --org ${request.organization_slug}`, 'TENANT_EXPORT_REQUIRED');
  }

  const organizationId = request.organization_id;
  const { graph, selectors } = tenantSelectors(db);
  const deleted = {};

  const run = db.transaction(() => {
    for (const selector of selectors) {
      const changes = db.prepare(`DELETE FROM ${selector.table} WHERE ${selector.sql}`)
        .run(...Array(selector.params).fill(organizationId)).changes;
      if (changes) deleted[selector.table] = changes;
    }
    // The tenant row last, so every child is gone before the thing they point at.
    const organization = db.prepare('DELETE FROM organizations WHERE id = ?').run(organizationId).changes;
    if (organization) deleted.organizations = organization;
  });
  run();

  const after = tenantRowCensus(db, organizationId);
  const verification = {
    verifiedAt: new Date().toISOString(),
    remainingRows: after.total + after.organizationRows,
    remaining: after.counts,
    // A table nobody classified is not evidence of a clean deletion; it is
    // evidence that nobody looked.
    unclassifiedTables: graph.unclassified,
    complete: after.total === 0 && after.organizationRows === 0 && graph.unclassified.length === 0,
    // What the customer keeps, or a record that they were given nothing. A
    // waived export is the single most consequential decision anybody makes
    // here, so it is written down beside the proof of deletion rather than
    // living only in whoever typed the flag.
    export: exported,
    exportWaived: !exported,
  };

  db.prepare(`
    UPDATE tenant_deletion_requests
    SET status = ?, executed_at = CURRENT_TIMESTAMP, census_after = ?, verification = ?
    WHERE id = ?
  `).run(verification.complete ? 'executed' : 'failed', JSON.stringify(after), JSON.stringify(verification), requestId);

  return { requestId, deleted, verification };
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
    if (size > 32 * 1024) throw httpError(413, 'Request body is too large.', 'REQUEST_TOO_LARGE');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw httpError(400, 'Invalid JSON request body.', 'INVALID_JSON'); }
}

/**
 * Instance-administrator only, all of it.
 *
 * Deleting a tenant destroys other people's work. An organization owner can
 * *ask*; only the operator running the instance can carry it out, and the record
 * of who asked and who executed is the reason the distinction is worth keeping.
 */
export function createTenantLifecycleApiHandler({ config, db, isInstanceAdmin }) {
  return async function tenantLifecycleApi(req, res) {
    const url = new URL(req.url, config.baseUrl);
    if (!url.pathname.startsWith('/api/instance-admin/tenants')) return false;

    const requestId = uid('req');
    res.setHeader('X-Request-Id', requestId);
    res.setHeader('Referrer-Policy', 'no-referrer');
    const method = String(req.method || 'GET').toUpperCase();

    try {
      const user = requireUser(db, req);
      if (!isInstanceAdmin(config, user)) {
        throw httpError(403, 'KukGit instance administrator access is required.', 'INSTANCE_ADMIN_REQUIRED');
      }

      const censusMatch = /^\/api\/instance-admin\/tenants\/([^/]+)\/census$/.exec(url.pathname);
      if (censusMatch && method === 'GET') {
        const organization = findOrganization(db, decodeURIComponent(censusMatch[1]));
        if (!organization) throw httpError(404, 'Organization not found.', 'ORGANIZATION_NOT_FOUND');
        return sendJson(res, 200, { census: tenantRowCensus(db, organization.id) });
      }

      if (url.pathname === '/api/instance-admin/tenants/deletions' && method === 'GET') {
        return sendJson(res, 200, { deletions: listTenantDeletions(db, { status: url.searchParams.get('status') }) });
      }

      if (url.pathname === '/api/instance-admin/tenants/deletions' && method === 'POST') {
        if (!originAllowed(req, config.baseUrl)) throw httpError(403, 'Request origin is not allowed.', 'CSRF_BLOCKED');
        const body = await readJson(req);
        const scheduled = requestTenantDeletion(db, { slug: body.slug, reason: body.reason, userId: user.id });
        audit(db, {
          userId: user.id,
          organizationId: scheduled.organizationId,
          action: 'tenant.deletion_scheduled',
          targetType: 'organization',
          targetId: scheduled.organizationId,
          metadata: { slug: scheduled.slug, rows: scheduled.census.total, graceDays: scheduled.graceDays },
        });
        return sendJson(res, 201, { ...scheduled, requestId });
      }

      const cancelMatch = /^\/api\/instance-admin\/tenants\/deletions\/([^/]+)\/cancel$/.exec(url.pathname);
      if (cancelMatch && method === 'POST') {
        if (!originAllowed(req, config.baseUrl)) throw httpError(403, 'Request origin is not allowed.', 'CSRF_BLOCKED');
        const cancelled = cancelTenantDeletion(db, { requestId: decodeURIComponent(cancelMatch[1]), userId: user.id });
        audit(db, {
          userId: user.id,
          action: 'tenant.deletion_cancelled',
          targetType: 'organization',
          targetId: cancelled.requestId,
          metadata: { requestId: cancelled.requestId },
        });
        return sendJson(res, 200, { ...cancelled, requestId });
      }

      throw httpError(404, 'Unknown tenant lifecycle route.', 'TENANT_ROUTE_NOT_FOUND');
    } catch (error) {
      const status = Number(error.status) || 500;
      return sendJson(res, status, {
        error: {
          code: error.code || 'TENANT_LIFECYCLE_FAILED',
          message: status >= 500 ? 'Tenant lifecycle is temporarily unavailable.' : error.message,
          requestId,
        },
      });
    }
  };
}
