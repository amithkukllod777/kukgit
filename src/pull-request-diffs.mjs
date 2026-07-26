import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { requireUser } from './auth.mjs';
import { audit, uid } from './db.mjs';
import { repoDiskPath, resolveRef } from './git.mjs';
import { permissionAtLeast, requireRepositoryAccess } from './repository-access.mjs';
import { listReviewThreads, reviewThreadSummary } from './review-threads.mjs';
import { assertBranch, httpError, originAllowed, safeRepoRelativePath } from './security.mjs';

const MAX_BODY_BYTES = 96 * 1024;
const MAX_PATCH_BYTES = 2 * 1024 * 1024;
const MAX_PATCH_LINES = 20000;
const MAX_FILES = 5000;
const DIFF_SIDES = new Set(['left', 'right', 'file']);

function tableColumns(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
}

function ensureColumn(db, table, column, definition) {
  if (!tableColumns(db, table).has(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export function migratePullRequestDiffs(db) {
  ensureColumn(db, 'pull_request_review_threads', 'start_line_number', 'INTEGER');
  ensureColumn(db, 'pull_request_review_threads', 'start_side', 'TEXT');
  ensureColumn(db, 'pull_request_review_threads', 'anchor_key', 'TEXT');
  ensureColumn(db, 'pull_request_review_threads', 'base_sha', 'TEXT');
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_review_threads_anchor
      ON pull_request_review_threads(pull_request_id, head_sha, path, side, line_number);
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

function execGit(gitDir, args, { maxBuffer = 8 * 1024 * 1024, allowFailure = false } = {}) {
  const result = spawnSync('git', ['--git-dir', gitDir, ...args], {
    encoding: 'utf8',
    maxBuffer,
    timeout: 120000,
    env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
  });
  if (result.error) {
    if (result.error.code === 'ENOBUFS') throw httpError(413, 'Diff output exceeds the browser review limit.', 'DIFF_TOO_LARGE');
    throw result.error;
  }
  if (result.status !== 0 && !allowFailure) {
    throw httpError(400, String(result.stderr || result.stdout || 'Git diff failed.').trim().slice(0, 1000), 'GIT_DIFF_ERROR');
  }
  return { stdout: result.stdout || '', stderr: result.stderr || '', status: result.status };
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

function diffRefs(config, repository, pull) {
  const baseBranch = assertBranch(pull.base_branch);
  const headBranch = assertBranch(pull.head_branch);
  const gitDir = repoDiskPath(config, repository.orgSlug, repository.slug);
  const baseTipSha = resolveRef(config, repository.orgSlug, repository.slug, baseBranch);
  const headSha = resolveRef(config, repository.orgSlug, repository.slug, headBranch);
  const mergeBase = execGit(gitDir, ['merge-base', baseTipSha, headSha]).stdout.trim();
  if (!/^[0-9a-f]{40}$/i.test(mergeBase)) throw httpError(409, 'Pull-request branches do not share a valid merge base.', 'MERGE_BASE_NOT_FOUND');
  return { gitDir, baseBranch, headBranch, baseTipSha, headSha, mergeBase, range: `${mergeBase}..${headSha}` };
}

function parseNameStatus(output) {
  const tokens = output.split('\0');
  if (tokens.at(-1) === '') tokens.pop();
  const files = [];
  for (let index = 0; index < tokens.length;) {
    const statusToken = tokens[index++];
    if (!statusToken) continue;
    const change = statusToken[0];
    const score = Number(statusToken.slice(1)) || null;
    if (change === 'R' || change === 'C') {
      const previousPath = tokens[index++];
      const filePath = tokens[index++];
      if (!previousPath || !filePath) throw httpError(500, 'Git returned malformed rename metadata.', 'DIFF_METADATA_INVALID');
      files.push({ change, score, path: filePath, previousPath });
    } else {
      const filePath = tokens[index++];
      if (!filePath) throw httpError(500, 'Git returned malformed file metadata.', 'DIFF_METADATA_INVALID');
      files.push({ change, score: null, path: filePath, previousPath: null });
    }
  }
  return files;
}

function parseNumstat(output) {
  const tokens = output.split('\0');
  if (tokens.at(-1) === '') tokens.pop();
  const stats = new Map();
  for (let index = 0; index < tokens.length;) {
    const token = tokens[index++];
    if (!token) continue;
    const firstTab = token.indexOf('\t');
    const secondTab = token.indexOf('\t', firstTab + 1);
    if (firstTab < 0 || secondTab < 0) continue;
    const addedRaw = token.slice(0, firstTab);
    const deletedRaw = token.slice(firstTab + 1, secondTab);
    let filePath = token.slice(secondTab + 1);
    let previousPath = null;
    if (!filePath) {
      previousPath = tokens[index++] || null;
      filePath = tokens[index++] || '';
    }
    if (!filePath) continue;
    const binary = addedRaw === '-' || deletedRaw === '-';
    stats.set(filePath, {
      path: filePath,
      previousPath,
      binary,
      additions: binary ? 0 : Number(addedRaw) || 0,
      deletions: binary ? 0 : Number(deletedRaw) || 0,
    });
  }
  return stats;
}

export function listPullRequestDiffFiles(config, repository, pull) {
  const refs = diffRefs(config, repository, pull);
  const nameStatus = execGit(refs.gitDir, ['diff', '--name-status', '-z', '--find-renames', '--find-copies', refs.range], { maxBuffer: 16 * 1024 * 1024 }).stdout;
  const numstat = execGit(refs.gitDir, ['diff', '--numstat', '-z', '--find-renames', '--find-copies', refs.range], { maxBuffer: 16 * 1024 * 1024 }).stdout;
  const files = parseNameStatus(nameStatus).slice(0, MAX_FILES);
  const stats = parseNumstat(numstat);
  for (const file of files) {
    const stat = stats.get(file.path) || { additions: 0, deletions: 0, binary: false };
    Object.assign(file, stat);
    file.status = ({ A: 'added', D: 'deleted', M: 'modified', R: 'renamed', C: 'copied', T: 'type-changed', U: 'unmerged' })[file.change] || 'modified';
  }
  return {
    refs: {
      baseBranch: refs.baseBranch,
      headBranch: refs.headBranch,
      baseTipSha: refs.baseTipSha,
      headSha: refs.headSha,
      mergeBase: refs.mergeBase,
    },
    files,
    truncated: parseNameStatus(nameStatus).length > MAX_FILES,
    additions: files.reduce((sum, file) => sum + file.additions, 0),
    deletions: files.reduce((sum, file) => sum + file.deletions, 0),
  };
}

function parseHunkHeader(line) {
  const match = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/);
  if (!match) return null;
  return {
    oldStart: Number(match[1]),
    oldLines: match[2] === undefined ? 1 : Number(match[2]),
    newStart: Number(match[3]),
    newLines: match[4] === undefined ? 1 : Number(match[4]),
    context: match[5] || '',
  };
}

export function parseUnifiedPatch(rawPatch) {
  const lines = String(rawPatch || '').split('\n');
  const hunks = [];
  let hunk = null;
  let oldLine = 0;
  let newLine = 0;
  let patchLine = 0;
  for (const raw of lines) {
    patchLine += 1;
    const header = parseHunkHeader(raw);
    if (header) {
      hunk = { ...header, header: raw, patchLine, lines: [] };
      hunks.push(hunk);
      oldLine = header.oldStart;
      newLine = header.newStart;
      continue;
    }
    if (!hunk) continue;
    if (raw.startsWith('diff --git ') || raw.startsWith('index ') || raw.startsWith('--- ') || raw.startsWith('+++ ')) continue;
    if (raw.startsWith('@@ ')) continue;
    if (raw.startsWith('\\ No newline at end of file')) {
      hunk.lines.push({ type: 'meta', content: raw, oldLine: null, newLine: null, patchLine });
      continue;
    }
    const prefix = raw[0];
    const content = raw.slice(1);
    if (prefix === '+') {
      hunk.lines.push({ type: 'add', content, oldLine: null, newLine, patchLine });
      newLine += 1;
    } else if (prefix === '-') {
      hunk.lines.push({ type: 'delete', content, oldLine, newLine: null, patchLine });
      oldLine += 1;
    } else {
      hunk.lines.push({ type: 'context', content: prefix === ' ' ? content : raw, oldLine, newLine, patchLine });
      oldLine += 1;
      newLine += 1;
    }
  }
  return hunks;
}

function changedFile(summary, pathValue) {
  return summary.files.find((file) => file.path === pathValue || file.previousPath === pathValue) || null;
}

export function getPullRequestFilePatch(config, repository, pull, pathValue, { ignoreWhitespace = false } = {}) {
  const cleanPath = safeRepoRelativePath(pathValue);
  const summary = listPullRequestDiffFiles(config, repository, pull);
  const file = changedFile(summary, cleanPath);
  if (!file) throw httpError(404, 'Changed pull-request file not found.', 'DIFF_FILE_NOT_FOUND');
  if (file.binary) return { file, rawPatch: '', hunks: [], binary: true, tooLarge: false, refs: summary.refs };
  const refs = diffRefs(config, repository, pull);
  const paths = [...new Set([file.previousPath, file.path].filter(Boolean))];
  const args = ['diff', '--no-color', '--no-ext-diff', '--find-renames', '--find-copies', '--unified=3'];
  if (ignoreWhitespace) args.push('--ignore-all-space');
  args.push(refs.range, '--', ...paths);
  let rawPatch;
  try {
    rawPatch = execGit(refs.gitDir, args, { maxBuffer: MAX_PATCH_BYTES + 1024 }).stdout;
  } catch (error) {
    if (error.code === 'DIFF_TOO_LARGE') return { file, rawPatch: '', hunks: [], binary: false, tooLarge: true, refs: summary.refs };
    throw error;
  }
  if (Buffer.byteLength(rawPatch) > MAX_PATCH_BYTES || rawPatch.split('\n').length > MAX_PATCH_LINES) {
    return { file, rawPatch: '', hunks: [], binary: false, tooLarge: true, refs: summary.refs };
  }
  return { file, rawPatch, hunks: parseUnifiedPatch(rawPatch), binary: false, tooLarge: false, refs: summary.refs };
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
  let matched = null;
  for (const hunk of patch.hunks) {
    const startIndex = lineIndexForSide(hunk, side, startLineNumber);
    const endIndex = lineIndexForSide(hunk, side, lineNumber);
    if (startIndex < 0 || endIndex < 0 || startIndex > endIndex) continue;
    const sideLines = hunk.lines.slice(startIndex, endIndex + 1)
      .map((line) => side === 'left' ? line.oldLine : line.newLine)
      .filter((value) => value !== null);
    const expected = lineNumber - startLineNumber + 1;
    if (new Set(sideLines).size !== expected) continue;
    matched = { hunk, startIndex, endIndex };
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

function normalizeCommentBody(value) {
  const body = String(value ?? '').trim();
  if (!body) throw httpError(400, 'Review comment body is required.', 'REVIEW_COMMENT_BODY_REQUIRED');
  if (body.length > 20000) throw httpError(400, 'Review comment must be 20,000 characters or fewer.', 'REVIEW_COMMENT_TOO_LONG');
  return body;
}

function anchorKey(headSha, anchor) {
  return crypto.createHash('sha256').update([
    headSha,
    anchor.path,
    anchor.side,
    anchor.lineNumber ?? '',
    anchor.startSide ?? '',
    anchor.startLineNumber ?? '',
  ].join('\0')).digest('hex');
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

export function createDiffReviewThread(db, config, { repository, pull, user, body }) {
  if (pull.status !== 'open') throw httpError(409, 'Only open pull requests can receive review threads.', 'PULL_REQUEST_NOT_OPEN');
  const anchor = validateDiffAnchor(config, repository, pull, body);
  const commentBody = normalizeCommentBody(body.body);
  const headSha = anchor.patch.refs.headSha;
  const baseSha = anchor.patch.refs.mergeBase;
  const threadId = uid('rth');
  const commentId = uid('rvc');
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`
      INSERT INTO pull_request_review_threads
        (id, pull_request_id, path, line_number, side, head_sha, author_id,
         start_line_number, start_side, anchor_key, base_sha)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      threadId,
      pull.id,
      anchor.path,
      anchor.lineNumber,
      anchor.side,
      headSha,
      user.id,
      anchor.startLineNumber,
      anchor.startSide,
      anchorKey(headSha, anchor),
      baseSha,
    );
    db.prepare(`
      INSERT INTO pull_request_review_comments (id, thread_id, author_id, body)
      VALUES (?, ?, ?, ?)
    `).run(commentId, threadId, user.id, commentBody);
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  }
  return enrichedThreads(db, config, repository, pull).find((thread) => thread.id === threadId);
}

function diffPayload(db, config, repository, pull, url) {
  const summary = listPullRequestDiffFiles(config, repository, pull);
  const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
  const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit')) || 50, 100));
  const page = summary.files.slice(offset, offset + limit);
  const requestedPath = url.searchParams.get('path');
  const ignoreWhitespace = url.searchParams.get('whitespace') === 'ignore';
  const selected = requestedPath ? getPullRequestFilePatch(config, repository, pull, requestedPath, { ignoreWhitespace }) : null;
  const allThreads = enrichedThreads(db, config, repository, pull);
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
    files: page,
    offset,
    limit,
    nextOffset: offset + page.length < summary.files.length ? offset + page.length : null,
    selectedFile: selected,
    threads: requestedPath
      ? allThreads.filter((thread) => thread.path === selected?.file.path || thread.path === selected?.file.previousPath)
      : [],
  };
}

export function createPullRequestDiffsApiHandler({ config, db }) {
  return async function handlePullRequestDiffsApi(req, res) {
    const url = new URL(req.url, config.baseUrl);
    const pathname = url.pathname;
    const diffPrefix = '/api/pull-request-diffs/';
    const threadPrefix = '/api/review-threads/';
    if (!pathname.startsWith(diffPrefix) && !pathname.startsWith(threadPrefix)) return false;
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
        const thread = createDiffReviewThread(db, config, { repository, pull, user, body: await readJson(req) });
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
