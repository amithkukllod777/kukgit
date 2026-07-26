import { currentUser, requireUser } from './auth.mjs';
import { audit, uid } from './db.mjs';
import { compareBranches, readBlob, resolveRef } from './git.mjs';
import { permissionAtLeast, requireRepositoryAccess } from './repository-access.mjs';
import { assertBranch, httpError, originAllowed, safeRepoRelativePath } from './security.mjs';

const MAX_BODY_BYTES = 96 * 1024;
const THREAD_SIDES = new Set(['left', 'right', 'file']);

export function migrateReviewThreads(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS review_thread_policies (
      id TEXT PRIMARY KEY,
      repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
      branch TEXT NOT NULL,
      require_resolved_threads INTEGER NOT NULL DEFAULT 0 CHECK(require_resolved_threads IN (0,1)),
      created_by TEXT NOT NULL REFERENCES users(id),
      updated_by TEXT NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(repository_id, branch)
    );
    CREATE TABLE IF NOT EXISTS pull_request_review_threads (
      id TEXT PRIMARY KEY,
      pull_request_id TEXT NOT NULL REFERENCES pull_requests(id) ON DELETE CASCADE,
      path TEXT NOT NULL,
      line_number INTEGER,
      side TEXT NOT NULL DEFAULT 'right' CHECK(side IN ('left','right','file')),
      head_sha TEXT NOT NULL,
      author_id TEXT NOT NULL REFERENCES users(id),
      resolved_by TEXT REFERENCES users(id),
      resolved_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS pull_request_review_comments (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES pull_request_review_threads(id) ON DELETE CASCADE,
      author_id TEXT NOT NULL REFERENCES users(id),
      body TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_review_thread_policy_repository
      ON review_thread_policies(repository_id, branch);
    CREATE INDEX IF NOT EXISTS idx_review_threads_pull
      ON pull_request_review_threads(pull_request_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_review_comments_thread
      ON pull_request_review_comments(thread_id, created_at);
  `);
}

function boolValue(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  return value === true || value === 1 || value === '1' || value === 'true';
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
    if (size > MAX_BODY_BYTES) throw httpError(413, 'Request body is too large.', 'REVIEW_THREAD_REQUEST_TOO_LARGE');
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

function findRepository(db, orgSlug, repoSlug) {
  return db.prepare(`
    SELECT r.id, r.slug, r.name, r.default_branch AS defaultBranch,
      r.organization_id AS organizationId, o.slug AS orgSlug, o.name AS orgName
    FROM repositories r JOIN organizations o ON o.id = r.organization_id
    WHERE o.slug = ? AND r.slug = ?
  `).get(orgSlug, repoSlug);
}

function findPullRequest(db, repositoryId, number) {
  return db.prepare(`
    SELECT p.*, u.display_name AS authorName, u.email AS authorEmail
    FROM pull_requests p JOIN users u ON u.id = p.author_id
    WHERE p.repository_id = ? AND p.number = ?
  `).get(repositoryId, Number(number));
}

function repositoryForAccess(db, access) {
  const repository = findRepository(db, access.repository.orgSlug, access.repository.slug);
  if (!repository) throw httpError(404, 'Repository not found.', 'REPO_NOT_FOUND');
  return repository;
}

export function getReviewThreadPolicy(db, repositoryId, branch) {
  const protectedBranch = assertBranch(branch);
  const row = db.prepare(`
    SELECT id, repository_id AS repositoryId, branch,
      require_resolved_threads AS requireResolvedThreads,
      created_at AS createdAt, updated_at AS updatedAt
    FROM review_thread_policies
    WHERE repository_id = ? AND branch = ?
  `).get(repositoryId, protectedBranch);
  return row ? { ...row, requireResolvedThreads: Boolean(row.requireResolvedThreads) } : null;
}

export function listReviewThreadPolicies(db, repositoryId) {
  return db.prepare(`
    SELECT id, repository_id AS repositoryId, branch,
      require_resolved_threads AS requireResolvedThreads,
      created_at AS createdAt, updated_at AS updatedAt
    FROM review_thread_policies WHERE repository_id = ? ORDER BY branch
  `).all(repositoryId).map((row) => ({ ...row, requireResolvedThreads: Boolean(row.requireResolvedThreads) }));
}

export function upsertReviewThreadPolicy(db, { repositoryId, branch, userId, requireResolvedThreads }) {
  const value = assertBranch(branch);
  const existing = db.prepare('SELECT id FROM review_thread_policies WHERE repository_id = ? AND branch = ?')
    .get(repositoryId, value);
  const id = existing?.id ?? uid('rtp');
  db.prepare(`
    INSERT INTO review_thread_policies
      (id, repository_id, branch, require_resolved_threads, created_by, updated_by)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(repository_id, branch) DO UPDATE SET
      require_resolved_threads = excluded.require_resolved_threads,
      updated_by = excluded.updated_by,
      updated_at = CURRENT_TIMESTAMP
  `).run(id, repositoryId, value, boolValue(requireResolvedThreads) ? 1 : 0, userId, userId);
  return getReviewThreadPolicy(db, repositoryId, value);
}

function normalizeCommentBody(value) {
  const body = String(value ?? '').trim();
  if (!body) throw httpError(400, 'Review comment body is required.', 'REVIEW_COMMENT_BODY_REQUIRED');
  if (body.length > 20000) throw httpError(400, 'Review comment must be 20,000 characters or fewer.', 'REVIEW_COMMENT_TOO_LONG');
  return body;
}

function normalizeSide(value) {
  const side = String(value ?? 'right').toLowerCase();
  if (!THREAD_SIDES.has(side)) throw httpError(400, 'Review thread side must be left, right or file.', 'REVIEW_THREAD_SIDE_INVALID');
  return side;
}

function changedFileForPath(comparison, pathValue) {
  return comparison.files.find((file) => file.path === pathValue || file.previousPath === pathValue) ?? null;
}

function validateAnchor(config, repository, pull, body) {
  const pathValue = safeRepoRelativePath(body.path);
  const side = normalizeSide(body.side);
  const lineNumber = body.lineNumber === null || body.lineNumber === undefined || body.lineNumber === ''
    ? null
    : Number(body.lineNumber);
  if (lineNumber !== null && (!Number.isInteger(lineNumber) || lineNumber < 1 || lineNumber > 1000000)) {
    throw httpError(400, 'Review line must be a positive whole number.', 'REVIEW_THREAD_LINE_INVALID');
  }
  if (side === 'file' && lineNumber !== null) {
    throw httpError(400, 'File-level review threads cannot include a line number.', 'FILE_THREAD_LINE_INVALID');
  }
  const comparison = compareBranches(config, repository.orgSlug, repository.slug, pull.base_branch, pull.head_branch);
  const changed = changedFileForPath(comparison, pathValue);
  if (!changed) throw httpError(400, 'Review threads must be anchored to a changed pull-request file.', 'REVIEW_PATH_NOT_CHANGED');

  if (lineNumber !== null) {
    const ref = side === 'left' ? pull.base_branch : pull.head_branch;
    const anchorPath = side === 'left' ? (changed.previousPath || pathValue) : changed.path;
    let file;
    try { file = readBlob(config, repository.orgSlug, repository.slug, ref, anchorPath); }
    catch { throw httpError(400, 'The selected review side does not contain this file.', 'REVIEW_ANCHOR_NOT_FOUND'); }
    if (file.isBinary) throw httpError(400, 'Binary files support file-level threads only.', 'BINARY_LINE_THREAD_UNSUPPORTED');
    const lines = file.content.split('\n').length;
    if (lineNumber > lines) throw httpError(400, `Line ${lineNumber} exceeds the ${lines}-line file.`, 'REVIEW_THREAD_LINE_OUT_OF_RANGE');
  }
  return { path: pathValue, side, lineNumber, comparison };
}

function currentHeadSha(config, repository, pull) {
  return resolveRef(config, repository.orgSlug, repository.slug, pull.head_branch);
}

function commentsForThreads(db, threadIds) {
  if (!threadIds.length) return new Map();
  const placeholders = threadIds.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT c.id, c.thread_id AS threadId, c.body,
      c.created_at AS createdAt, c.updated_at AS updatedAt,
      u.id AS authorId, u.display_name AS authorName, u.email AS authorEmail
    FROM pull_request_review_comments c JOIN users u ON u.id = c.author_id
    WHERE c.thread_id IN (${placeholders})
    ORDER BY c.created_at, c.rowid
  `).all(...threadIds);
  const map = new Map(threadIds.map((id) => [id, []]));
  for (const row of rows) map.get(row.threadId)?.push(row);
  return map;
}

export function listReviewThreads(db, config, repository, pull) {
  const headSha = currentHeadSha(config, repository, pull);
  const rows = db.prepare(`
    SELECT t.id, t.path, t.line_number AS lineNumber, t.side, t.head_sha AS headSha,
      t.created_at AS createdAt, t.updated_at AS updatedAt,
      t.resolved_at AS resolvedAt,
      author.id AS authorId, author.display_name AS authorName, author.email AS authorEmail,
      resolver.id AS resolvedById, resolver.display_name AS resolvedByName
    FROM pull_request_review_threads t
    JOIN users author ON author.id = t.author_id
    LEFT JOIN users resolver ON resolver.id = t.resolved_by
    WHERE t.pull_request_id = ?
    ORDER BY t.created_at, t.rowid
  `).all(pull.id);
  const comments = commentsForThreads(db, rows.map((row) => row.id));
  return rows.map((thread) => ({
    ...thread,
    outdated: thread.headSha !== headSha,
    resolved: Boolean(thread.resolvedAt),
    comments: comments.get(thread.id) ?? [],
  }));
}

export function reviewThreadSummary(db, config, repository, pull) {
  const policy = getReviewThreadPolicy(db, repository.id, pull.base_branch);
  const threads = listReviewThreads(db, config, repository, pull);
  const activeUnresolved = threads.filter((thread) => !thread.resolved && !thread.outdated);
  return {
    policy,
    threads,
    totalThreads: threads.length,
    activeUnresolvedCount: activeUnresolved.length,
    resolvedCount: threads.filter((thread) => thread.resolved).length,
    outdatedCount: threads.filter((thread) => thread.outdated).length,
    mergeAllowed: !(policy?.requireResolvedThreads && activeUnresolved.length > 0),
    mergeBlockReason: policy?.requireResolvedThreads && activeUnresolved.length > 0
      ? `${activeUnresolved.length} active review thread${activeUnresolved.length === 1 ? '' : 's'} must be resolved.`
      : null,
  };
}

export function createReviewThread(db, config, { repository, pull, user, body }) {
  if (pull.status !== 'open') throw httpError(409, 'Only open pull requests can receive review threads.', 'PULL_REQUEST_NOT_OPEN');
  const anchor = validateAnchor(config, repository, pull, body);
  const headSha = currentHeadSha(config, repository, pull);
  const threadId = uid('rth');
  const commentId = uid('rvc');
  const commentBody = normalizeCommentBody(body.body);
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`
      INSERT INTO pull_request_review_threads
        (id, pull_request_id, path, line_number, side, head_sha, author_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(threadId, pull.id, anchor.path, anchor.lineNumber, anchor.side, headSha, user.id);
    db.prepare(`
      INSERT INTO pull_request_review_comments (id, thread_id, author_id, body)
      VALUES (?, ?, ?, ?)
    `).run(commentId, threadId, user.id, commentBody);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return listReviewThreads(db, config, repository, pull).find((thread) => thread.id === threadId);
}

export function replyToReviewThread(db, config, { repository, pull, threadId, user, body }) {
  const thread = db.prepare('SELECT id FROM pull_request_review_threads WHERE id = ? AND pull_request_id = ?')
    .get(threadId, pull.id);
  if (!thread) throw httpError(404, 'Review thread not found.', 'REVIEW_THREAD_NOT_FOUND');
  const id = uid('rvc');
  db.prepare('INSERT INTO pull_request_review_comments (id, thread_id, author_id, body) VALUES (?, ?, ?, ?)')
    .run(id, thread.id, user.id, normalizeCommentBody(body));
  db.prepare('UPDATE pull_request_review_threads SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(thread.id);
  return listReviewThreads(db, config, repository, pull).find((item) => item.id === thread.id);
}

export function setReviewThreadResolved(db, config, { repository, pull, threadId, user, resolved }) {
  const thread = db.prepare('SELECT id FROM pull_request_review_threads WHERE id = ? AND pull_request_id = ?')
    .get(threadId, pull.id);
  if (!thread) throw httpError(404, 'Review thread not found.', 'REVIEW_THREAD_NOT_FOUND');
  if (resolved) {
    db.prepare(`
      UPDATE pull_request_review_threads
      SET resolved_by = ?, resolved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(user.id, thread.id);
  } else {
    db.prepare(`
      UPDATE pull_request_review_threads
      SET resolved_by = NULL, resolved_at = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(thread.id);
  }
  return listReviewThreads(db, config, repository, pull).find((item) => item.id === thread.id);
}

function pullPayload(db, config, repository, pull) {
  const comparison = compareBranches(config, repository.orgSlug, repository.slug, pull.base_branch, pull.head_branch);
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    baseBranch: pull.base_branch,
    headBranch: pull.head_branch,
    status: pull.status,
    authorId: pull.author_id,
    authorName: pull.authorName,
    comparison,
    reviewThreads: reviewThreadSummary(db, config, repository, pull),
  };
}

export function createReviewThreadsApiHandler({ config, db }) {
  return async function handleReviewThreadsApi(req, res) {
    const url = new URL(req.url, config.baseUrl);
    const pathname = url.pathname;
    if (!pathname.startsWith('/api/review-threads/')) return false;
    const requestId = uid('req');
    res.setHeader('X-Request-Id', requestId);
    res.setHeader('Referrer-Policy', 'no-referrer');

    try {
      if (!originAllowed(req, config.baseUrl)) throw httpError(403, 'Request origin is not allowed.', 'CSRF_BLOCKED');
      const user = requireUser(db, req);

      let params = routeMatch(pathname, '/api/review-threads/:org/:repo');
      if (req.method === 'GET' && params) {
        const access = requireRepositoryAccess(db, user.id, { orgSlug: params.org, repoSlug: params.repo }, 'read');
        const repository = repositoryForAccess(db, access);
        return sendJson(res, 200, {
          repository,
          effectivePermission: access.permission,
          canManage: permissionAtLeast(access.permission, 'admin'),
          policies: listReviewThreadPolicies(db, repository.id),
        });
      }

      params = routeMatch(pathname, '/api/review-threads/:org/:repo/policies/:branch');
      if (req.method === 'PUT' && params) {
        const access = requireRepositoryAccess(db, user.id, { orgSlug: params.org, repoSlug: params.repo }, 'admin');
        const repository = repositoryForAccess(db, access);
        const body = await readJson(req);
        const policy = upsertReviewThreadPolicy(db, {
          repositoryId: repository.id,
          branch: params.branch,
          userId: user.id,
          requireResolvedThreads: body.requireResolvedThreads,
        });
        audit(db, {
          organizationId: repository.organizationId,
          userId: user.id,
          action: 'review_thread_policy.updated',
          targetType: 'repository',
          targetId: repository.id,
          metadata: { repository: repository.slug, branch: policy.branch, requireResolvedThreads: policy.requireResolvedThreads },
        });
        return sendJson(res, 200, { policy });
      }
      if (req.method === 'DELETE' && params) {
        const access = requireRepositoryAccess(db, user.id, { orgSlug: params.org, repoSlug: params.repo }, 'admin');
        const repository = repositoryForAccess(db, access);
        const result = db.prepare('DELETE FROM review_thread_policies WHERE repository_id = ? AND branch = ?')
          .run(repository.id, assertBranch(params.branch));
        if (!result.changes) throw httpError(404, 'Review-thread policy not found.', 'REVIEW_THREAD_POLICY_NOT_FOUND');
        audit(db, {
          organizationId: repository.organizationId,
          userId: user.id,
          action: 'review_thread_policy.deleted',
          targetType: 'repository',
          targetId: repository.id,
          metadata: { repository: repository.slug, branch: params.branch },
        });
        return sendJson(res, 200, { deleted: true });
      }

      params = routeMatch(pathname, '/api/review-threads/:org/:repo/pulls/:number');
      if (req.method === 'GET' && params) {
        const access = requireRepositoryAccess(db, user.id, { orgSlug: params.org, repoSlug: params.repo }, 'read');
        const repository = repositoryForAccess(db, access);
        const pull = findPullRequest(db, repository.id, params.number);
        if (!pull) throw httpError(404, 'Pull request not found.', 'PULL_REQUEST_NOT_FOUND');
        return sendJson(res, 200, {
          effectivePermission: access.permission,
          canComment: permissionAtLeast(access.permission, 'write'),
          canResolve: permissionAtLeast(access.permission, 'write'),
          pullRequest: pullPayload(db, config, repository, pull),
        });
      }

      params = routeMatch(pathname, '/api/review-threads/:org/:repo/pulls/:number/threads');
      if (req.method === 'POST' && params) {
        const access = requireRepositoryAccess(db, user.id, { orgSlug: params.org, repoSlug: params.repo }, 'write');
        const repository = repositoryForAccess(db, access);
        const pull = findPullRequest(db, repository.id, params.number);
        if (!pull) throw httpError(404, 'Pull request not found.', 'PULL_REQUEST_NOT_FOUND');
        const thread = createReviewThread(db, config, { repository, pull, user, body: await readJson(req) });
        audit(db, {
          organizationId: repository.organizationId,
          userId: user.id,
          action: 'review_thread.created',
          targetType: 'pull_request',
          targetId: pull.id,
          metadata: { repository: repository.slug, number: pull.number, threadId: thread.id, path: thread.path, lineNumber: thread.lineNumber, side: thread.side },
        });
        return sendJson(res, 201, { thread, summary: reviewThreadSummary(db, config, repository, pull) });
      }

      params = routeMatch(pathname, '/api/review-threads/:org/:repo/pulls/:number/threads/:threadId/replies');
      if (req.method === 'POST' && params) {
        const access = requireRepositoryAccess(db, user.id, { orgSlug: params.org, repoSlug: params.repo }, 'write');
        const repository = repositoryForAccess(db, access);
        const pull = findPullRequest(db, repository.id, params.number);
        if (!pull) throw httpError(404, 'Pull request not found.', 'PULL_REQUEST_NOT_FOUND');
        const body = await readJson(req);
        const thread = replyToReviewThread(db, config, { repository, pull, threadId: params.threadId, user, body: body.body });
        audit(db, {
          organizationId: repository.organizationId,
          userId: user.id,
          action: 'review_thread.replied',
          targetType: 'pull_request',
          targetId: pull.id,
          metadata: { repository: repository.slug, number: pull.number, threadId: thread.id },
        });
        return sendJson(res, 200, { thread });
      }

      params = routeMatch(pathname, '/api/review-threads/:org/:repo/pulls/:number/threads/:threadId/:action');
      if (req.method === 'POST' && params && ['resolve', 'reopen'].includes(params.action)) {
        const access = requireRepositoryAccess(db, user.id, { orgSlug: params.org, repoSlug: params.repo }, 'write');
        const repository = repositoryForAccess(db, access);
        const pull = findPullRequest(db, repository.id, params.number);
        if (!pull) throw httpError(404, 'Pull request not found.', 'PULL_REQUEST_NOT_FOUND');
        const resolved = params.action === 'resolve';
        const thread = setReviewThreadResolved(db, config, { repository, pull, threadId: params.threadId, user, resolved });
        audit(db, {
          organizationId: repository.organizationId,
          userId: user.id,
          action: resolved ? 'review_thread.resolved' : 'review_thread.reopened',
          targetType: 'pull_request',
          targetId: pull.id,
          metadata: { repository: repository.slug, number: pull.number, threadId: thread.id },
        });
        return sendJson(res, 200, { thread, summary: reviewThreadSummary(db, config, repository, pull) });
      }

      throw httpError(404, 'Review threads API endpoint not found.', 'NOT_FOUND');
    } catch (error) {
      const status = Number(error.status) || 500;
      if (status >= 500) console.error(`[${requestId}] review threads API`, error);
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

export function createReviewThreadMergeGuard({ config, db, app }) {
  return async function reviewThreadMergeGuard(req, res) {
    const url = new URL(req.url, config.baseUrl);
    const params = routeMatch(url.pathname, '/api/repos/:org/:repo/pulls/:number/merge');
    if (req.method !== 'POST' || !params) return app(req, res);
    try {
      const user = currentUser(db, req);
      if (!user) return app(req, res);
      const access = requireRepositoryAccess(db, user.id, { orgSlug: params.org, repoSlug: params.repo }, 'maintain');
      const repository = repositoryForAccess(db, access);
      const pull = findPullRequest(db, repository.id, params.number);
      if (!pull) throw httpError(404, 'Pull request not found.', 'PULL_REQUEST_NOT_FOUND');
      const summary = reviewThreadSummary(db, config, repository, pull);
      if (!summary.mergeAllowed) {
        throw httpError(409, summary.mergeBlockReason, 'PULL_REQUEST_THREADS_UNRESOLVED');
      }
      return app(req, res);
    } catch (error) {
      return sendJson(res, Number(error.status) || 500, {
        error: {
          code: error.code || 'INTERNAL_ERROR',
          message: Number(error.status) >= 500 ? 'An unexpected server error occurred.' : error.message,
        },
      });
    }
  };
}
