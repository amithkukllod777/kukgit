import crypto from 'node:crypto';
import { currentUser, requireUser } from './auth.mjs';
import { audit, uid } from './db.mjs';
import { clientAddress } from './rate-limit.mjs';
import { httpError, originAllowed } from './security.mjs';

export const ABUSE = {
  categories: [
    'malware',
    'phishing',
    'spam',
    'leaked_credentials',
    'harassment',
    'copyright',
    'other',
  ],
  actions: ['dismiss', 'warn', 'disable', 'escalate'],
  minimumDetailLength: 30,
  maximumDetailLength: 4000,
  minimumResolutionLength: 20,
};

function tableColumns(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => String(row.name)));
}

export function migrateAbuseReports(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS abuse_cases (
      id TEXT PRIMARY KEY,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      target_label TEXT NOT NULL,
      category TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      report_count INTEGER NOT NULL DEFAULT 0,
      first_reported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_reported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      action TEXT,
      resolution TEXT,
      resolved_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      resolved_at TEXT
    );
    CREATE TABLE IF NOT EXISTS abuse_reports (
      id TEXT PRIMARY KEY,
      case_id TEXT NOT NULL REFERENCES abuse_cases(id) ON DELETE CASCADE,
      category TEXT NOT NULL,
      detail TEXT NOT NULL,
      reporter_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      reporter_email TEXT,
      reporter_fingerprint TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_abuse_cases_open
      ON abuse_cases(status, last_reported_at DESC);
    CREATE INDEX IF NOT EXISTS idx_abuse_cases_target
      ON abuse_cases(target_type, target_id, status);
    CREATE INDEX IF NOT EXISTS idx_abuse_reports_case
      ON abuse_reports(case_id, created_at DESC);
  `);
  // Disabled, not deleted, and on the repository itself so every transport is
  // covered by the same check. HTTP, Git and LFS all resolve access through the
  // repository row; a flag anywhere else would have to be remembered in three
  // places and would be forgotten in one.
  if (!tableColumns(db, 'repositories').has('abuse_disabled_at')) {
    db.exec('ALTER TABLE repositories ADD COLUMN abuse_disabled_at TEXT');
  }
  if (!tableColumns(db, 'repositories').has('abuse_disabled_reason')) {
    db.exec('ALTER TABLE repositories ADD COLUMN abuse_disabled_reason TEXT');
  }
}

/**
 * A stable-but-not-identifying handle for whoever sent a report.
 *
 * Enough to see that fifty reports came from one place; not enough to be a
 * record of who looked at what. An abuse queue full of raw addresses is a log of
 * people who reported things, which is a list worth stealing.
 */
function reporterFingerprint(req, config) {
  const address = clientAddress(req, { trustProxy: config.rateLimitTrustProxy });
  return crypto.createHash('sha256').update(`kukgit-abuse:${address}`).digest('hex').slice(0, 16);
}

/**
 * Resolves what is being reported, and never says whether it exists.
 *
 * A form that answers "no such repository" is an existence oracle for every
 * private repository on the instance, usable by anybody, with no account. So an
 * unresolvable target is filed as `unknown` and looked at by a person — which is
 * also the right answer for a real report with a typo in the name, or one about
 * something that was deleted an hour ago.
 */
function findTarget(db, { orgSlug, repoSlug }) {
  const label = repoSlug ? `${orgSlug}/${repoSlug}` : String(orgSlug ?? '');
  if (repoSlug) {
    const repository = db.prepare(`
      SELECT r.id FROM repositories r
      JOIN organizations o ON o.id = r.organization_id
      WHERE o.slug = ? AND r.slug = ? AND r.deleted_at IS NULL
    `).get(orgSlug, repoSlug);
    if (repository) return { type: 'repository', id: repository.id, label };
    return { type: 'unknown', id: label, label };
  }
  const organization = db.prepare('SELECT id FROM organizations WHERE slug = ?').get(orgSlug);
  if (organization) return { type: 'organization', id: organization.id, label };
  return { type: 'unknown', id: label, label };
}

/**
 * Files a report.
 *
 * **No account required.** The person who finds phishing hosted here is usually
 * not a customer, and a form only customers can reach is a form that never sees
 * the reports that matter most.
 *
 * A report is evidence, not a verdict. Nothing is disabled by reporting it —
 * an automatic takedown on report is a weapon anybody can point at any
 * repository, and it would be used that way within a week.
 */
export function fileAbuseReport(db, config, req, { orgSlug, repoSlug = null, category, detail, reporterEmail = null }) {
  if (!ABUSE.categories.includes(category)) {
    throw httpError(422, `Category must be one of ${ABUSE.categories.join(', ')}.`, 'ABUSE_CATEGORY_INVALID');
  }
  const written = String(detail ?? '').trim();
  if (written.length < ABUSE.minimumDetailLength) {
    throw httpError(422, `Describe the problem in at least ${ABUSE.minimumDetailLength} characters.`, 'ABUSE_DETAIL_REQUIRED');
  }
  const email = String(reporterEmail ?? '').trim().toLowerCase().slice(0, 320) || null;
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw httpError(422, 'That contact address is not valid. Leave it blank to report anonymously.', 'ABUSE_EMAIL_INVALID');
  }

  const slug = /^[a-z0-9][a-z0-9._-]{0,99}$/i;
  if (!slug.test(String(orgSlug ?? '')) || (repoSlug && !slug.test(String(repoSlug)))) {
    throw httpError(422, 'Name the organization, and optionally the repository, being reported.', 'ABUSE_TARGET_INVALID');
  }
  const target = findTarget(db, { orgSlug, repoSlug });
  const reporter = currentUser(db, req);

  // One open case per target and category. Five hundred reports about the same
  // repository is one thing to look at, not five hundred — and the count is
  // itself a signal.
  let record = db.prepare(`
    SELECT * FROM abuse_cases
    WHERE target_type = ? AND target_id = ? AND category = ? AND status = 'open'
  `).get(target.type, target.id, category);

  if (!record) {
    const caseId = uid('abc');
    db.prepare(`
      INSERT INTO abuse_cases (id, target_type, target_id, target_label, category)
      VALUES (?, ?, ?, ?, ?)
    `).run(caseId, target.type, target.id, target.label, category);
    record = db.prepare('SELECT * FROM abuse_cases WHERE id = ?').get(caseId);
  }

  db.prepare(`
    INSERT INTO abuse_reports (id, case_id, category, detail, reporter_user_id, reporter_email, reporter_fingerprint)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(uid('abr'), record.id, category, written.slice(0, ABUSE.maximumDetailLength),
    reporter?.id ?? null, email, reporterFingerprint(req, config));
  db.prepare(`
    UPDATE abuse_cases SET report_count = report_count + 1, last_reported_at = datetime('now') WHERE id = ?
  `).run(record.id);

  // The acknowledgement says nothing about the target. Whether a repository
  // exists, is private, or has been reported before are all things this form
  // would otherwise answer for anybody who asks.
  return { received: true, caseId: record.id };
}

function shapeCase(db, row, { includeReporters = false } = {}) {
  if (!row) return null;
  const reports = db.prepare(`
    SELECT id, detail, created_at AS at, reporter_fingerprint AS reporter,
      reporter_email AS reporterEmail, reporter_user_id AS reporterUserId
    FROM abuse_reports WHERE case_id = ? ORDER BY created_at DESC LIMIT 50
  `).all(row.id);
  return {
    id: row.id,
    target: { type: row.target_type, id: row.target_id, label: row.target_label },
    category: row.category,
    status: row.status,
    action: row.action,
    reportCount: Number(row.report_count),
    firstReportedAt: row.first_reported_at,
    lastReportedAt: row.last_reported_at,
    resolution: row.resolution,
    resolvedAt: row.resolved_at,
    // Distinct sources, so "fifty reports" and "fifty reports from one place"
    // are not the same number on the screen.
    distinctReporters: new Set(reports.map((report) => report.reporter)).size,
    reports: reports.map((report) => (includeReporters
      ? { id: report.id, detail: report.detail, at: report.at, reporter: report.reporter, reporterEmail: report.reporterEmail }
      : { id: report.id, detail: report.detail, at: report.at, reporter: report.reporter })),
  };
}

export function listAbuseCases(db, { status = 'open', limit = 50 } = {}) {
  const rows = status === 'all'
    ? db.prepare('SELECT * FROM abuse_cases ORDER BY last_reported_at DESC LIMIT ?').all(limit)
    : db.prepare('SELECT * FROM abuse_cases WHERE status = ? ORDER BY last_reported_at DESC LIMIT ?').all(status, limit);
  return rows.map((row) => shapeCase(db, row, { includeReporters: true }));
}

export function getAbuseCase(db, id, options) {
  return shapeCase(db, db.prepare('SELECT * FROM abuse_cases WHERE id = ?').get(id), options);
}

/**
 * Decides a case.
 *
 * `disable` makes a repository unreachable **without destroying it**. The bytes
 * stay, the row stays, and the same call can be undone — because the alternative
 * to a reversible disable is either doing nothing or deleting somebody's work on
 * the strength of a report form.
 *
 * Every outcome needs a written reason, including `dismiss`. "We looked and it
 * was fine" is the sentence somebody needs when the same repository is reported
 * again next month.
 */
export function resolveAbuseCase(db, { caseId, action, resolution, userId }) {
  if (!ABUSE.actions.includes(action)) {
    throw httpError(422, `Action must be one of ${ABUSE.actions.join(', ')}.`, 'ABUSE_ACTION_INVALID');
  }
  const written = String(resolution ?? '').trim();
  if (written.length < ABUSE.minimumResolutionLength) {
    throw httpError(422, `A written outcome of at least ${ABUSE.minimumResolutionLength} characters is required.`, 'ABUSE_RESOLUTION_REQUIRED');
  }
  const record = db.prepare('SELECT * FROM abuse_cases WHERE id = ?').get(caseId);
  if (!record) throw httpError(404, 'No such abuse case.', 'ABUSE_CASE_NOT_FOUND');
  if (record.status !== 'open') throw httpError(409, 'That case is already resolved.', 'ABUSE_CASE_CLOSED');

  db.transaction(() => {
    if (action === 'disable') {
      if (record.target_type !== 'repository') {
        throw httpError(422, 'Only a repository can be disabled from here.', 'ABUSE_TARGET_NOT_DISABLEABLE');
      }
      db.prepare("UPDATE repositories SET abuse_disabled_at = datetime('now'), abuse_disabled_reason = ? WHERE id = ?")
        .run(written.slice(0, 500), record.target_id);
    }
    db.prepare(`
      UPDATE abuse_cases
      SET status = ?, action = ?, resolution = ?, resolved_by = ?, resolved_at = datetime('now')
      WHERE id = ?
    `).run(action === 'escalate' ? 'escalated' : action === 'dismiss' ? 'dismissed' : 'actioned',
      action, written, userId, caseId);
  })();

  audit(db, {
    userId,
    action: `abuse.${action}`,
    targetType: record.target_type,
    targetId: record.target_id,
    // The reports themselves are not copied into the audit metadata. A report is
    // somebody's prose about somebody else, and the audit log is read far more
    // widely than the abuse queue.
    metadata: { caseId, category: record.category, reportCount: Number(record.report_count) },
  });
  return getAbuseCase(db, caseId, { includeReporters: true });
}

/**
 * Puts a disabled repository back.
 *
 * Separate from resolving a case, because the two happen at different times: a
 * repository is disabled while somebody looks, and re-enabled when they are
 * satisfied — often after the owner has answered.
 */
export function reinstateRepository(db, { orgSlug, repoSlug, reason, userId }) {
  const written = String(reason ?? '').trim();
  if (written.length < ABUSE.minimumResolutionLength) {
    throw httpError(422, `A written reason of at least ${ABUSE.minimumResolutionLength} characters is required.`, 'ABUSE_RESOLUTION_REQUIRED');
  }
  const repository = db.prepare(`
    SELECT r.id, r.abuse_disabled_at AS disabledAt FROM repositories r
    JOIN organizations o ON o.id = r.organization_id
    WHERE o.slug = ? AND r.slug = ?
  `).get(orgSlug, repoSlug);
  if (!repository) throw httpError(404, 'No such repository.', 'ABUSE_TARGET_NOT_FOUND');
  if (!repository.disabledAt) throw httpError(409, 'That repository is not disabled.', 'ABUSE_NOT_DISABLED');

  db.prepare('UPDATE repositories SET abuse_disabled_at = NULL, abuse_disabled_reason = NULL WHERE id = ?')
    .run(repository.id);
  audit(db, {
    userId,
    action: 'abuse.reinstated',
    targetType: 'repository',
    targetId: repository.id,
    metadata: { reason: written, disabledSince: repository.disabledAt },
  });
  return { repository: `${orgSlug}/${repoSlug}`, reinstated: true };
}

export function disabledRepositories(db) {
  return db.prepare(`
    SELECT o.slug AS orgSlug, r.slug AS repoSlug, r.abuse_disabled_at AS disabledAt,
      r.abuse_disabled_reason AS reason
    FROM repositories r JOIN organizations o ON o.id = r.organization_id
    WHERE r.abuse_disabled_at IS NOT NULL ORDER BY r.abuse_disabled_at DESC
  `).all();
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
    if (size > 32 * 1024) throw httpError(413, 'Request body is too large.', 'ABUSE_REQUEST_TOO_LARGE');
    chunks.push(chunk);
  }
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw httpError(400, 'Invalid JSON request body.', 'INVALID_JSON'); }
}

export function createAbuseReportsApiHandler({ config, db, isInstanceAdmin }) {
  return async function abuseReportsApi(req, res) {
    const url = new URL(req.url, config.baseUrl);
    const reportRoute = url.pathname === '/api/abuse/reports';
    const caseList = url.pathname === '/api/instance-admin/abuse/cases';
    const caseAction = /^\/api\/instance-admin\/abuse\/cases\/([^/]+)\/resolve$/.exec(url.pathname);
    const disabledList = url.pathname === '/api/instance-admin/abuse/disabled';
    const reinstate = /^\/api\/instance-admin\/abuse\/disabled\/([^/]+)\/([^/]+)\/reinstate$/.exec(url.pathname);
    if (!reportRoute && !caseList && !caseAction && !disabledList && !reinstate) return false;

    const requestId = uid('req');
    res.setHeader('X-Request-Id', requestId);
    res.setHeader('Referrer-Policy', 'no-referrer');
    const method = String(req.method || 'GET').toUpperCase();

    try {
      if (reportRoute) {
        if (method !== 'POST') throw httpError(405, 'Method not allowed.', 'METHOD_NOT_ALLOWED');
        const body = await readJson(req);
        const result = fileAbuseReport(db, config, req, {
          orgSlug: String(body.org ?? ''),
          repoSlug: body.repo ? String(body.repo) : null,
          category: String(body.category ?? ''),
          detail: body.detail,
          reporterEmail: body.email ?? null,
        });
        return sendJson(res, 202, { ...result, requestId });
      }

      const user = requireUser(db, req);
      if (!isInstanceAdmin(config, user)) throw httpError(403, 'KukGit instance administrator access is required.', 'INSTANCE_ADMIN_REQUIRED');

      if (caseList && method === 'GET') {
        return sendJson(res, 200, { cases: listAbuseCases(db, { status: url.searchParams.get('status') ?? 'open' }) });
      }
      if (disabledList && method === 'GET') {
        return sendJson(res, 200, { repositories: disabledRepositories(db) });
      }
      if (method !== 'POST') throw httpError(405, 'Method not allowed.', 'METHOD_NOT_ALLOWED');
      if (!originAllowed(req, config.baseUrl)) throw httpError(403, 'Request origin is not allowed.', 'CSRF_BLOCKED');

      if (caseAction) {
        const body = await readJson(req);
        const record = resolveAbuseCase(db, {
          caseId: decodeURIComponent(caseAction[1]),
          action: String(body.action ?? ''),
          resolution: body.resolution,
          userId: user.id,
        });
        return sendJson(res, 200, { case: record, requestId });
      }
      if (reinstate) {
        const body = await readJson(req);
        const result = reinstateRepository(db, {
          orgSlug: decodeURIComponent(reinstate[1]),
          repoSlug: decodeURIComponent(reinstate[2]),
          reason: body.reason,
          userId: user.id,
        });
        return sendJson(res, 200, { ...result, requestId });
      }
      throw httpError(404, 'Unknown abuse route.', 'ABUSE_ROUTE_NOT_FOUND');
    } catch (error) {
      const status = Number(error.status) || 500;
      return sendJson(res, status, {
        error: {
          code: error.code || 'ABUSE_FAILED',
          message: status >= 500 ? 'Abuse reporting is temporarily unavailable.' : error.message,
          requestId,
        },
      });
    }
  };
}
