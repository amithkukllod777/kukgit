import { requireUser } from './auth.mjs';
import { audit, uid } from './db.mjs';
import { httpError, originAllowed } from './security.mjs';

export const DANGEROUS_FILES = {
  minimumReasonLength: 20,
  sources: ['operator', 'abuse_case', 'feed'],
};

const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

export function migrateDangerousFiles(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS blocked_content (
      digest TEXT PRIMARY KEY,
      reason TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'operator',
      case_id TEXT,
      created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      removed_at TEXT,
      removed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      removed_reason TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_blocked_content_active
      ON blocked_content(removed_at, created_at DESC);
  `);
}

/**
 * Whether this exact content is blocked, by its SHA-256.
 *
 * This is the enforcement primitive and it is deliberately tiny: one indexed
 * lookup on the primary key, cheap enough to sit on every LFS and artifact
 * request without anybody weighing whether to call it.
 *
 * Blocking is **by content hash**, not by repository. LFS objects and workflow
 * blobs are content-addressed and shared between tenants — the same trojan
 * uploaded to fifty repositories is one row here, and a block covers every copy
 * including ones uploaded later. Repository-level action is the abuse disable,
 * which is a different tool for a different problem.
 */
// Cached only once true: a table that exists does not go away, while a database
// that has not run this migration is asked again rather than remembered as
// missing. Without it, adding the check to LFS and artifacts would break every
// embedding that builds its own subset of the schema.
const INSTALLED = new WeakSet();

function policyInstalled(db) {
  if (INSTALLED.has(db)) return true;
  const present = db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'blocked_content'").get();
  if (present) INSTALLED.add(db);
  return Boolean(present);
}

export function contentBlocked(db, digest) {
  const value = String(digest ?? '').toLowerCase();
  if (!DIGEST_PATTERN.test(value) || !policyInstalled(db)) return null;
  const row = db.prepare(`
    SELECT digest, reason, created_at AS createdAt FROM blocked_content
    WHERE digest = ? AND removed_at IS NULL
  `).get(value);
  return row ?? null;
}

/**
 * Refuses the request if the content is blocked.
 *
 * The refusal names the digest and nothing else. It deliberately does not say
 * what the file is, which report got it blocked, or who decided — a download
 * error message is shown to whoever is fetching, and for malware that is as
 * likely to be the attacker checking whether their payload still serves.
 */
export function assertContentAllowed(db, digest, { context = 'content' } = {}) {
  const blocked = contentBlocked(db, digest);
  if (!blocked) return;
  throw httpError(451, `This ${context} (sha256:${blocked.digest.slice(0, 12)}…) has been blocked by the KukGit operator.`, 'CONTENT_BLOCKED');
}

/**
 * Blocks content everywhere, by hash.
 *
 * The bytes are **not deleted**. The same digest can be attached to fifty
 * tenants' repositories, and most of them are victims who cloned something,
 * not offenders — deleting by hash destroys evidence and other people's
 * repositories in one motion. A block makes the bytes unservable, which is the
 * part that stops the harm, and it is reversible when it turns out to be wrong.
 */
export function blockContent(db, { digest, reason, source = 'operator', caseId = null, userId }) {
  const value = String(digest ?? '').toLowerCase();
  if (!DIGEST_PATTERN.test(value)) {
    throw httpError(422, 'A block names content by its 64-character SHA-256 digest.', 'BLOCK_DIGEST_INVALID');
  }
  const written = String(reason ?? '').trim();
  if (written.length < DANGEROUS_FILES.minimumReasonLength) {
    throw httpError(422, `A written reason of at least ${DANGEROUS_FILES.minimumReasonLength} characters is required.`, 'BLOCK_REASON_REQUIRED');
  }
  if (!DANGEROUS_FILES.sources.includes(source)) {
    throw httpError(422, `Source must be one of ${DANGEROUS_FILES.sources.join(', ')}.`, 'BLOCK_SOURCE_INVALID');
  }

  const existing = db.prepare('SELECT digest, removed_at AS removedAt FROM blocked_content WHERE digest = ?').get(value);
  if (existing && !existing.removedAt) throw httpError(409, 'That content is already blocked.', 'CONTENT_ALREADY_BLOCKED');
  if (existing) {
    // Re-blocking something that was unblocked: the history of the first block
    // is part of the record, so the row is revived rather than replaced.
    db.prepare(`
      UPDATE blocked_content SET reason = ?, source = ?, case_id = ?, created_by = ?,
        created_at = datetime('now'), removed_at = NULL, removed_by = NULL, removed_reason = NULL
      WHERE digest = ?
    `).run(written, source, caseId, userId, value);
  } else {
    db.prepare(`
      INSERT INTO blocked_content (digest, reason, source, case_id, created_by)
      VALUES (?, ?, ?, ?, ?)
    `).run(value, written, source, caseId, userId);
  }

  audit(db, {
    userId,
    action: 'dangerous_files.blocked',
    targetType: 'content',
    targetId: value,
    metadata: { source, caseId, reason: written },
  });
  return { digest: value, blocked: true, affected: affectedByDigest(db, value) };
}

export function unblockContent(db, { digest, reason, userId }) {
  const value = String(digest ?? '').toLowerCase();
  const written = String(reason ?? '').trim();
  if (written.length < DANGEROUS_FILES.minimumReasonLength) {
    throw httpError(422, `A written reason of at least ${DANGEROUS_FILES.minimumReasonLength} characters is required.`, 'BLOCK_REASON_REQUIRED');
  }
  const existing = db.prepare('SELECT digest FROM blocked_content WHERE digest = ? AND removed_at IS NULL').get(value);
  if (!existing) throw httpError(404, 'That content is not blocked.', 'CONTENT_NOT_BLOCKED');

  db.prepare("UPDATE blocked_content SET removed_at = datetime('now'), removed_by = ?, removed_reason = ? WHERE digest = ?")
    .run(userId, written, value);
  audit(db, {
    userId,
    action: 'dangerous_files.unblocked',
    targetType: 'content',
    targetId: value,
    metadata: { reason: written },
  });
  return { digest: value, blocked: false };
}

/**
 * What a block touches, before it is placed.
 *
 * "This hash" is an opaque decision; "this hash, which is attached to nine
 * repositories across four organizations" is one an operator can weigh. It also
 * answers the question afterwards: who to tell.
 */
export function affectedByDigest(db, digest) {
  const value = String(digest ?? '').toLowerCase();
  const lfs = db.prepare(`
    SELECT o.slug AS orgSlug, r.slug AS repoSlug FROM repository_lfs_objects link
    JOIN repositories r ON r.id = link.repository_id
    JOIN organizations o ON o.id = r.organization_id
    WHERE link.oid = ? ORDER BY o.slug, r.slug
  `).all(value);
  const artifacts = db.prepare(`
    SELECT o.slug AS orgSlug, r.slug AS repoSlug, a.name FROM workflow_artifacts a
    JOIN repositories r ON r.id = a.repository_id
    JOIN organizations o ON o.id = r.organization_id
    WHERE a.digest = ? ORDER BY o.slug, r.slug
  `).all(value);
  return {
    lfsRepositories: lfs.map((row) => `${row.orgSlug}/${row.repoSlug}`),
    artifacts: artifacts.map((row) => ({ repository: `${row.orgSlug}/${row.repoSlug}`, name: row.name })),
  };
}

export function listBlockedContent(db, { includeRemoved = false, limit = 100 } = {}) {
  const rows = includeRemoved
    ? db.prepare('SELECT * FROM blocked_content ORDER BY created_at DESC LIMIT ?').all(limit)
    : db.prepare('SELECT * FROM blocked_content WHERE removed_at IS NULL ORDER BY created_at DESC LIMIT ?').all(limit);
  return rows.map((row) => ({
    digest: row.digest,
    reason: row.reason,
    source: row.source,
    caseId: row.case_id,
    createdAt: row.created_at,
    removedAt: row.removed_at,
    removedReason: row.removed_reason,
    affected: affectedByDigest(db, row.digest),
  }));
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
    if (size > 32 * 1024) throw httpError(413, 'Request body is too large.', 'BLOCK_REQUEST_TOO_LARGE');
    chunks.push(chunk);
  }
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw httpError(400, 'Invalid JSON request body.', 'INVALID_JSON'); }
}

export function createDangerousFilesApiHandler({ config, db, isInstanceAdmin }) {
  return async function dangerousFilesApi(req, res) {
    const url = new URL(req.url, config.baseUrl);
    const listRoute = url.pathname === '/api/instance-admin/blocked-content';
    const unblockRoute = /^\/api\/instance-admin\/blocked-content\/([0-9a-f]{64})\/unblock$/.exec(url.pathname);
    if (!listRoute && !unblockRoute) return false;

    const requestId = uid('req');
    res.setHeader('X-Request-Id', requestId);
    res.setHeader('Referrer-Policy', 'no-referrer');
    const method = String(req.method || 'GET').toUpperCase();

    try {
      const user = requireUser(db, req);
      if (!isInstanceAdmin(config, user)) throw httpError(403, 'KukGit instance administrator access is required.', 'INSTANCE_ADMIN_REQUIRED');

      if (listRoute && method === 'GET') {
        return sendJson(res, 200, {
          blocked: listBlockedContent(db, { includeRemoved: url.searchParams.get('all') === 'true' }),
        });
      }
      if (method !== 'POST') throw httpError(405, 'Method not allowed.', 'METHOD_NOT_ALLOWED');
      if (!originAllowed(req, config.baseUrl)) throw httpError(403, 'Request origin is not allowed.', 'CSRF_BLOCKED');

      const body = await readJson(req);
      if (unblockRoute) {
        const result = unblockContent(db, { digest: unblockRoute[1], reason: body.reason, userId: user.id });
        return sendJson(res, 200, { ...result, requestId });
      }
      const result = blockContent(db, {
        digest: body.digest, reason: body.reason, source: body.source ?? 'operator', caseId: body.caseId ?? null, userId: user.id,
      });
      return sendJson(res, 201, { ...result, requestId });
    } catch (error) {
      const status = Number(error.status) || 500;
      return sendJson(res, status, {
        error: {
          code: error.code || 'BLOCKED_CONTENT_FAILED',
          message: status >= 500 ? 'Blocked-content administration is temporarily unavailable.' : error.message,
          requestId,
        },
      });
    }
  };
}
