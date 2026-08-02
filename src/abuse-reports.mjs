import crypto from 'node:crypto';
import { currentUser, requireUser } from './auth.mjs';
import { audit, orgAccess, uid } from './db.mjs';
import { createNotification } from './notifications.mjs';
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
    CREATE TABLE IF NOT EXISTS abuse_appeals (
      id TEXT PRIMARY KEY,
      case_id TEXT REFERENCES abuse_cases(id) ON DELETE SET NULL,
      organization_slug TEXT NOT NULL,
      repository_slug TEXT NOT NULL,
      body TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      submitted_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      answer TEXT,
      answered_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      answered_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_abuse_appeals_open
      ON abuse_appeals(status, created_at DESC);
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

/**
 * Tells the people who own the repository.
 *
 * Everyone who could have done something about it: owners and admins. A
 * repository that stops working with no message is indistinguishable from an
 * outage, and the first thing its owner does is open a support ticket asking why
 * the platform is broken.
 *
 * A notification failure never stops the decision. An operator who disabled
 * hosted malware has done the important part; not being able to send an email is
 * a worse day, not a reason to leave it running.
 */
function notifyRepositoryOwners(db, config, { organizationId, title, body, link, dedupeKey }) {
  const recipients = db.prepare(`
    SELECT user_id AS userId FROM org_members
    WHERE organization_id = ? AND role IN ('owner', 'admin')
  `).all(organizationId);
  let sent = 0;
  for (const recipient of recipients) {
    try {
      createNotification(db, config, {
        userId: recipient.userId,
        // `security`, which defaults to email on. This is not a digest item.
        category: 'security',
        title,
        body,
        link,
        dedupeKey: dedupeKey ? `${dedupeKey}:${recipient.userId}` : null,
      });
      sent += 1;
    } catch { /* one unreachable recipient does not stop the others */ }
  }
  return sent;
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
export function resolveAbuseCase(db, config, { caseId, action, resolution, userId }) {
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

  let notified = null;
  if (action === 'disable' || action === 'warn') {
    const repository = db.prepare(`
      SELECT r.slug AS repoSlug, r.organization_id AS organizationId, o.slug AS orgSlug
      FROM repositories r JOIN organizations o ON o.id = r.organization_id WHERE r.id = ?
    `).get(record.target_id);
    if (repository) {
      notified = notifyRepositoryOwners(db, config, {
        organizationId: repository.organizationId,
        title: action === 'disable'
          ? `${repository.orgSlug}/${repository.repoSlug} has been disabled`
          : `A warning about ${repository.orgSlug}/${repository.repoSlug}`,
        // The operator's written reason, verbatim. A message that says only
        // "policy violation" leaves somebody unable to fix anything, and they
        // are the only person who can.
        body: action === 'disable'
          ? `A KukGit operator has disabled this repository following an abuse report.\n\nReason: ${written}\n\nNothing has been deleted. If you believe this is wrong, appeal at /api/abuse/appeals with the organization and repository and an explanation.`
          : `A KukGit operator has reviewed an abuse report about this repository.\n\n${written}`,
        link: `#/repos/${repository.orgSlug}/${repository.repoSlug}`,
        dedupeKey: `abuse:${action}:${caseId}`,
      });
    }
  }

  audit(db, {
    userId,
    action: `abuse.${action}`,
    targetType: record.target_type,
    targetId: record.target_id,
    // The reports themselves are not copied into the audit metadata. A report is
    // somebody's prose about somebody else, and the audit log is read far more
    // widely than the abuse queue.
    // How many owners were actually reached. Delivery failures are swallowed so
    // a notification problem cannot leave hosted malware running — but silently
    // telling nobody is its own failure, and this is where it shows up.
    metadata: { caseId, category: record.category, reportCount: Number(record.report_count), notified },
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
export function reinstateRepository(db, config, { orgSlug, repoSlug, reason, userId }) {
  const written = String(reason ?? '').trim();
  if (written.length < ABUSE.minimumResolutionLength) {
    throw httpError(422, `A written reason of at least ${ABUSE.minimumResolutionLength} characters is required.`, 'ABUSE_RESOLUTION_REQUIRED');
  }
  const repository = db.prepare(`
    SELECT r.id, r.organization_id AS organizationId, r.abuse_disabled_at AS disabledAt FROM repositories r
    JOIN organizations o ON o.id = r.organization_id
    WHERE o.slug = ? AND r.slug = ?
  `).get(orgSlug, repoSlug);
  if (!repository) throw httpError(404, 'No such repository.', 'ABUSE_TARGET_NOT_FOUND');
  if (!repository.disabledAt) throw httpError(409, 'That repository is not disabled.', 'ABUSE_NOT_DISABLED');

  db.prepare('UPDATE repositories SET abuse_disabled_at = NULL, abuse_disabled_reason = NULL WHERE id = ?')
    .run(repository.id);
  // Any appeal about this repository is answered by the reinstatement itself.
  // Leaving it open would mean somebody waiting for a reply to a question that
  // has already been decided in their favour.
  db.prepare(`
    UPDATE abuse_appeals SET status = 'answered', answer = ?, answered_by = ?, answered_at = datetime('now')
    WHERE organization_slug = ? AND repository_slug = ? AND status = 'open'
  `).run(written, userId, orgSlug, repoSlug);
  notifyRepositoryOwners(db, config, {
    organizationId: repository.organizationId,
    title: `${orgSlug}/${repoSlug} is available again`,
    body: `A KukGit operator has re-enabled this repository.\n\n${written}`,
    link: `#/repos/${orgSlug}/${repoSlug}`,
    // The timestamp goes through the same charset the key allows; a raw SQLite
    // datetime has a space in it.
    dedupeKey: `abuse:reinstate:${repository.id}:${String(repository.disabledAt).replace(/[^A-Za-z0-9:_./-]/g, '-')}`,
  });
  audit(db, {
    userId,
    action: 'abuse.reinstated',
    targetType: 'repository',
    targetId: repository.id,
    metadata: { reason: written, disabledSince: repository.disabledAt },
  });
  return { repository: `${orgSlug}/${repoSlug}`, reinstated: true };
}

/**
 * The owner's reply.
 *
 * Deliberately **not** under `/api/repos/:org/:repo/…`. Those routes resolve
 * repository access, which is exactly what a disable takes away — so the one
 * route somebody needs when their repository is disabled would have been the one
 * refusing them. Authorization is on the organization instead, which a disable
 * does not touch.
 */
export function appealDisable(db, { orgSlug, repoSlug, body, userId }) {
  if (!orgAccess(db, userId, orgSlug, 'admin')) {
    throw httpError(403, 'Organization admin access is required.', 'ORG_ADMIN_REQUIRED');
  }
  const written = String(body ?? '').trim();
  if (written.length < ABUSE.minimumDetailLength) {
    throw httpError(422, `Explain in at least ${ABUSE.minimumDetailLength} characters.`, 'ABUSE_APPEAL_TOO_SHORT');
  }
  const repository = db.prepare(`
    SELECT r.id, r.abuse_disabled_at AS disabledAt FROM repositories r
    JOIN organizations o ON o.id = r.organization_id
    WHERE o.slug = ? AND r.slug = ?
  `).get(orgSlug, repoSlug);
  if (!repository) throw httpError(404, 'No such repository.', 'ABUSE_TARGET_NOT_FOUND');
  if (!repository.disabledAt) throw httpError(409, 'That repository is not disabled.', 'ABUSE_NOT_DISABLED');

  const existing = db.prepare(`
    SELECT id FROM abuse_appeals WHERE organization_slug = ? AND repository_slug = ? AND status = 'open'
  `).get(orgSlug, repoSlug);
  // One open appeal at a time. Filing ten does not make anybody read it faster,
  // and it turns the appeal route into the same flooding problem the report
  // route already has.
  if (existing) throw httpError(409, 'An appeal for this repository is already open.', 'ABUSE_APPEAL_OPEN');

  const record = db.prepare(`
    SELECT id FROM abuse_cases WHERE target_type = 'repository' AND target_id = ? AND action = 'disable'
    ORDER BY resolved_at DESC LIMIT 1
  `).get(repository.id);

  const id = uid('aba');
  db.prepare(`
    INSERT INTO abuse_appeals (id, case_id, organization_slug, repository_slug, body, submitted_by)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, record?.id ?? null, orgSlug, repoSlug, written.slice(0, ABUSE.maximumDetailLength), userId);
  audit(db, {
    userId,
    action: 'abuse.appealed',
    targetType: 'repository',
    targetId: repository.id,
    metadata: { appealId: id, caseId: record?.id ?? null },
  });
  return { id, status: 'open', repository: `${orgSlug}/${repoSlug}` };
}

/**
 * Answers an appeal without reinstating.
 *
 * The other outcome, and the one that needs saying out loud: the decision
 * stands, and here is why. An appeal that is only ever answered by a
 * reinstatement is an appeal process that has no way to say no, so it says
 * nothing at all and the person waits forever.
 */
export function answerAppeal(db, config, { appealId, answer, userId }) {
  const written = String(answer ?? '').trim();
  if (written.length < ABUSE.minimumResolutionLength) {
    throw httpError(422, `A written answer of at least ${ABUSE.minimumResolutionLength} characters is required.`, 'ABUSE_RESOLUTION_REQUIRED');
  }
  const appeal = db.prepare('SELECT * FROM abuse_appeals WHERE id = ?').get(appealId);
  if (!appeal) throw httpError(404, 'No such appeal.', 'ABUSE_APPEAL_NOT_FOUND');
  if (appeal.status !== 'open') throw httpError(409, 'That appeal is already answered.', 'ABUSE_APPEAL_ANSWERED');

  db.prepare(`
    UPDATE abuse_appeals SET status = 'answered', answer = ?, answered_by = ?, answered_at = datetime('now')
    WHERE id = ?
  `).run(written, userId, appealId);

  const repository = db.prepare(`
    SELECT r.id, r.organization_id AS organizationId FROM repositories r
    JOIN organizations o ON o.id = r.organization_id
    WHERE o.slug = ? AND r.slug = ?
  `).get(appeal.organization_slug, appeal.repository_slug);
  if (repository) {
    notifyRepositoryOwners(db, config, {
      organizationId: repository.organizationId,
      title: `Your appeal about ${appeal.organization_slug}/${appeal.repository_slug} has been answered`,
      body: written,
      link: `#/repos/${appeal.organization_slug}/${appeal.repository_slug}`,
      dedupeKey: `abuse:appeal-answer:${appealId}`,
    });
  }
  audit(db, {
    userId,
    action: 'abuse.appeal_answered',
    targetType: 'repository',
    targetId: repository?.id ?? null,
    metadata: { appealId },
  });
  return { id: appealId, status: 'answered' };
}

export function listAbuseAppeals(db, { status = 'open', limit = 50 } = {}) {
  const rows = status === 'all'
    ? db.prepare('SELECT * FROM abuse_appeals ORDER BY created_at DESC LIMIT ?').all(limit)
    : db.prepare('SELECT * FROM abuse_appeals WHERE status = ? ORDER BY created_at DESC LIMIT ?').all(status, limit);
  return rows.map((row) => ({
    id: row.id,
    caseId: row.case_id,
    repository: `${row.organization_slug}/${row.repository_slug}`,
    body: row.body,
    status: row.status,
    createdAt: row.created_at,
    answer: row.answer,
    answeredAt: row.answered_at,
  }));
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
    const appealRoute = url.pathname === '/api/abuse/appeals';
    const appealList = url.pathname === '/api/instance-admin/abuse/appeals';
    const appealAnswer = /^\/api\/instance-admin\/abuse\/appeals\/([^/]+)\/answer$/.exec(url.pathname);
    const disabledList = url.pathname === '/api/instance-admin/abuse/disabled';
    const reinstate = /^\/api\/instance-admin\/abuse\/disabled\/([^/]+)\/([^/]+)\/reinstate$/.exec(url.pathname);
    if (!reportRoute && !caseList && !caseAction && !disabledList && !reinstate
      && !appealRoute && !appealList && !appealAnswer) return false;

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

      // An appeal is filed by the customer, not by an operator, so it is
      // authorized before the instance-admin gate below.
      if (appealRoute) {
        if (method !== 'POST') throw httpError(405, 'Method not allowed.', 'METHOD_NOT_ALLOWED');
        if (!originAllowed(req, config.baseUrl)) throw httpError(403, 'Request origin is not allowed.', 'CSRF_BLOCKED');
        const body = await readJson(req);
        const appeal = appealDisable(db, {
          orgSlug: String(body.org ?? ''), repoSlug: String(body.repo ?? ''), body: body.body, userId: user.id,
        });
        return sendJson(res, 201, { appeal, requestId });
      }

      if (!isInstanceAdmin(config, user)) throw httpError(403, 'KukGit instance administrator access is required.', 'INSTANCE_ADMIN_REQUIRED');

      if (caseList && method === 'GET') {
        return sendJson(res, 200, { cases: listAbuseCases(db, { status: url.searchParams.get('status') ?? 'open' }) });
      }
      if (disabledList && method === 'GET') {
        return sendJson(res, 200, { repositories: disabledRepositories(db) });
      }
      if (appealList && method === 'GET') {
        return sendJson(res, 200, { appeals: listAbuseAppeals(db, { status: url.searchParams.get('status') ?? 'open' }) });
      }
      if (method !== 'POST') throw httpError(405, 'Method not allowed.', 'METHOD_NOT_ALLOWED');
      if (!originAllowed(req, config.baseUrl)) throw httpError(403, 'Request origin is not allowed.', 'CSRF_BLOCKED');

      if (caseAction) {
        const body = await readJson(req);
        const record = resolveAbuseCase(db, config, {
          caseId: decodeURIComponent(caseAction[1]),
          action: String(body.action ?? ''),
          resolution: body.resolution,
          userId: user.id,
        });
        return sendJson(res, 200, { case: record, requestId });
      }
      if (reinstate) {
        const body = await readJson(req);
        const result = reinstateRepository(db, config, {
          orgSlug: decodeURIComponent(reinstate[1]),
          repoSlug: decodeURIComponent(reinstate[2]),
          reason: body.reason,
          userId: user.id,
        });
        return sendJson(res, 200, { ...result, requestId });
      }
      if (appealAnswer) {
        const body = await readJson(req);
        const answered = answerAppeal(db, config, {
          appealId: decodeURIComponent(appealAnswer[1]), answer: body.answer, userId: user.id,
        });
        return sendJson(res, 200, { appeal: answered, requestId });
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
