import { requireUser } from './auth.mjs';
import { audit, uid } from './db.mjs';
import {
  createDiffReviewThread as createOriginalDiffReviewThread,
  getPullRequestFilePatch as getOriginalPullRequestFilePatch,
  listPullRequestDiffFiles,
  migratePullRequestDiffs,
  parseUnifiedPatch as parseOriginalUnifiedPatch,
} from './pull-request-diffs.mjs';
import { permissionAtLeast, requireRepositoryAccess } from './repository-access.mjs';
import { listReviewThreads, reviewThreadSummary } from './review-threads.mjs';
import { httpError, originAllowed, safeRepoRelativePath } from './security.mjs';

const MAX_BODY_BYTES = 96 * 1024;
const DIFF_SIDES = new Set(['left', 'right', 'file']);

export { listPullRequestDiffFiles, migratePullRequestDiffs };

function sanitizeHunk(hunk) {
  let oldSeen = 0;
  let newSeen = 0;
  const lines = [];
  for (const line of hunk.lines) {
    const consumesOld = line.oldLine !== null;
    const consumesNew = line.newLine !== null;
    if (consumesOld && oldSeen >= hunk.oldLines) continue;
    if (consumesNew && newSeen >= hunk.newLines) continue;
    lines.push(line);
    if (consumesOld) oldSeen += 1;
    if (consumesNew) newSeen += 1;
  }
  return { ...hunk, lines };
}

function sanitizePatch(patch) {
  return { ...patch, hunks: (patch.hunks || []).map(sanitizeHunk) };
}

export function parseUnifiedPatch(rawPatch) {
  return parseOriginalUnifiedPatch(rawPatch).map(sanitizeHunk);
}

export function getPullRequestFilePatch(config, repository, pull, pathValue, options = {}) {
  return sanitizePatch(getOriginalPullRequestFilePatch(config, repository, pull, pathValue, options));
}

function lineIndexForSide(hunk, side, lineNumber) {
  return hunk.lines.findIndex((line) => side === 'left' ? line.oldLine === lineNumber : line.newLine === lineNumber);
}

export function validateDiffAnchor(config, repository, pull, body) {
  const pathValue = safeRepoRelativePath(body.path);
  const side = String(body.side || 'right').toLowerCase();
  if (!DIFF_SIDES.has(side)) throw httpError(400, 'Review side must be left, right or file.', 'DIFF_ANCHOR_SIDE_INVALID');
  const patch = getPullRequestFilePatch(config, repository, pull, pathValue);
  if (patch.tooLarge) throw httpError(413, 'This file diff is too large for inline browser review.', 'DIFF_TOO_LARGE');
  if (side === 'file') {
    if (body.lineNumber !== undefined && body.lineNumber !== null && body.lineNumber !== '') {
      throw httpError(400, 'File-level comments cannot include a line number.', 'FILE_THREAD_LINE_INVALID');
    }
    return { path: patch.file.path, side, lineNumber: null, startLineNumber: null, startSide: null, patch };
  }
  if (patch.binary) throw httpError(400, 'Binary files support file-level comments only.', 'BINARY_LINE_THREAD_UNSUPPORTED');
  const lineNumber = Number(body.lineNumber);
  if (!Number.isInteger(lineNumber) || lineNumber < 1) throw httpError(400, 'Select an actual changed or context line.', 'DIFF_ANCHOR_LINE_INVALID');
  const startLineNumber = body.startLineNumber === undefined || body.startLineNumber === null || body.startLineNumber === ''
    ? lineNumber
    : Number(body.startLineNumber);
  const startSide = String(body.startSide || side).toLowerCase();
  if (startSide !== side) throw httpError(400, 'Multi-line comments must remain on one diff side.', 'DIFF_RANGE_SIDE_MISMATCH');
  if (!Number.isInteger(startLineNumber) || startLineNumber < 1 || startLineNumber > lineNumber) {
    throw httpError(400, 'Review range start must be a positive line not after the end line.', 'DIFF_RANGE_INVALID');
  }
  let matched = false;
  for (const hunk of patch.hunks) {
    const startIndex = lineIndexForSide(hunk, side, startLineNumber);
    const endIndex = lineIndexForSide(hunk, side, lineNumber);
    if (startIndex < 0 || endIndex < 0 || startIndex > endIndex) continue;
    const sideLines = hunk.lines.slice(startIndex, endIndex + 1)
      .map((line) => side === 'left' ? line.oldLine : line.newLine)
      .filter((value) => value !== null);
    if (new Set(sideLines).size !== lineNumber - startLineNumber + 1) continue;
    matched = true;
    break;
  }
  if (!matched) throw httpError(400, 'Review range must map to actual lines within one diff hunk.', 'DIFF_ANCHOR_NOT_IN_PATCH');
  return {
    path: patch.file.path,
    side,
    lineNumber,
    startLineNumber: startLineNumber === lineNumber ? null : startLineNumber,
    startSide: startLineNumber === lineNumber ? null : side,
    patch,
  };
}

export function createDiffReviewThread(db, config, { repository, pull, user, body }) {
  validateDiffAnchor(config, repository, pull, body);
  return createOriginalDiffReviewThread(db, config, { repository, pull, user, body });
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
    if (size > MAX_BODY_BYTES) throw httpError(413, 'Request body is too large.', 'DIFF_REVIEW_REQUEST_TOO_LARGE');
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
    SELECT r.id, r.slug, r.name, r.visibility, r.default_branch AS defaultBranch,
      r.organization_id AS organizationId, o.slug AS orgSlug, o.name AS orgName
    FROM repositories r JOIN organizations o ON o.id = r.organization_id
    WHERE o.slug = ? AND r.slug = ? AND r.deleted_at IS NULL
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

function rangeMetadata(db, threadIds) {
  if (!threadIds.length) return new Map();
  const placeholders = threadIds.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT id, start_line_number AS startLineNumber, start_side AS startSide,
      anchor_key AS anchorKey, base_sha AS baseSha
    FROM pull_request_review_threads WHERE id IN (${placeholders})
  `).all(...threadIds);
  return new Map(rows.map((row) => [row.id, row]));
}

function enrichedThreads(db, config, repository, pull) {
  const threads = listReviewThreads(db, config, repository, pull);
  const metadata = rangeMetadata(db, threads.map((thread) => thread.id));
  return threads.map((thread) => ({ ...thread, ...(metadata.get(thread.id) || {}) }));
}

function diffPayload(db, config, repository, pull, url) {
  const summary = listPullRequestDiffFiles(config, repository, pull);
  const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
  const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit')) || 50, 100));
  const files = summary.files.slice(offset, offset + limit);
  const requestedPath = url.searchParams.get('path');
  const ignoreWhitespace = url.searchParams.get('whitespace') === 'ignore';
  const selectedFile = requestedPath ? getPullRequestFilePatch(config, repository, pull, requestedPath, { ignoreWhitespace }) : null;
  const threads = requestedPath
    ? enrichedThreads(db, config, repository, pull).filter((thread) => thread.path === selectedFile?.file.path || thread.path === selectedFile?.file.previousPath)
    : [];
  return {
    pullRequest: {
      id: pull.id,
      number: pull.number,
      title: pull.title,
      status: pull.status,
      baseBranch: pull.base_branch,
      headBranch: pull.head_branch,
    },
    refs: summary.refs,
    totals: {
      files: summary.files.length,
      additions: summary.additions,
      deletions: summary.deletions,
      truncated: summary.truncated,
    },
    files,
    offset,
    limit,
    nextOffset: offset + files.length < summary.files.length ? offset + files.length : null,
    selectedFile,
    threads,
  };
}

export function createPullRequestDiffsApiHandler({ config, db }) {
  return async function handlePullRequestDiffsApi(req, res) {
    const url = new URL(req.url, config.baseUrl);
    const pathname = url.pathname;
    if (!pathname.startsWith('/api/pull-request-diffs/') && !pathname.startsWith('/api/review-threads/')) return false;
    const requestId = uid('req');
    res.setHeader('X-Request-Id', requestId);
    res.setHeader('Referrer-Policy', 'no-referrer');
    try {
      if (!originAllowed(req, config.baseUrl)) throw httpError(403, 'Request origin is not allowed.', 'CSRF_BLOCKED');
      const user = requireUser(db, req);
      let params = routeMatch(pathname, '/api/pull-request-diffs/:org/:repo/pulls/:number');
      if (params && req.method === 'GET') {
        const access = requireRepositoryAccess(db, user.id, { orgSlug: params.org, repoSlug: params.repo }, 'read');
        const repository = repositoryForAccess(db, access);
        const pull = findPullRequest(db, repository.id, params.number);
        if (!pull) throw httpError(404, 'Pull request not found.', 'PULL_REQUEST_NOT_FOUND');
        return sendJson(res, 200, {
          effectivePermission: access.permission,
          canComment: permissionAtLeast(access.permission, 'write'),
          ...diffPayload(db, config, repository, pull, url),
        });
      }
      params = routeMatch(pathname, '/api/review-threads/:org/:repo/pulls/:number/threads');
      if (params && req.method === 'POST') {
        const access = requireRepositoryAccess(db, user.id, { orgSlug: params.org, repoSlug: params.repo }, 'write');
        const repository = repositoryForAccess(db, access);
        const pull = findPullRequest(db, repository.id, params.number);
        if (!pull) throw httpError(404, 'Pull request not found.', 'PULL_REQUEST_NOT_FOUND');
        const body = await readJson(req);
        const thread = createDiffReviewThread(db, config, { repository, pull, user, body });
        audit(db, {
          organizationId: repository.organizationId,
          userId: user.id,
          action: 'review_thread.created',
          targetType: 'pull_request',
          targetId: pull.id,
          metadata: {
            repository: repository.slug,
            number: pull.number,
            threadId: thread.id,
            path: thread.path,
            lineNumber: thread.lineNumber,
            side: thread.side,
            startLineNumber: thread.startLineNumber,
            startSide: thread.startSide,
            diffAnchored: true,
          },
        });
        return sendJson(res, 201, { thread, summary: reviewThreadSummary(db, config, repository, pull) });
      }
      return false;
    } catch (error) {
      const status = Number(error.status) || 500;
      if (status >= 500) console.error(`[${requestId}] pull request diffs API`, error);
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
