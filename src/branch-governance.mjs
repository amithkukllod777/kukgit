import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { currentUser, requireUser } from './auth.mjs';
import { audit, uid } from './db.mjs';
import { repoDiskPath, resolveRef } from './git.mjs';
import { permissionAtLeast, requireRepositoryAccess } from './repository-access.mjs';
import { assertBranch, httpError, originAllowed } from './security.mjs';

const REVIEW_STATES = Object.freeze(['approved', 'changes_requested', 'commented']);
const MAX_BODY_BYTES = 64 * 1024;

export function migrateBranchGovernance(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS branch_protection_rules (
      id TEXT PRIMARY KEY,
      repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
      branch TEXT NOT NULL,
      require_pull_request INTEGER NOT NULL DEFAULT 1 CHECK(require_pull_request IN (0,1)),
      required_approvals INTEGER NOT NULL DEFAULT 1 CHECK(required_approvals BETWEEN 0 AND 10),
      dismiss_stale_approvals INTEGER NOT NULL DEFAULT 1 CHECK(dismiss_stale_approvals IN (0,1)),
      block_direct_pushes INTEGER NOT NULL DEFAULT 1 CHECK(block_direct_pushes IN (0,1)),
      created_by TEXT NOT NULL REFERENCES users(id),
      updated_by TEXT NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(repository_id, branch)
    );
    CREATE TABLE IF NOT EXISTS pull_request_reviews (
      id TEXT PRIMARY KEY,
      pull_request_id TEXT NOT NULL REFERENCES pull_requests(id) ON DELETE CASCADE,
      reviewer_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      state TEXT NOT NULL CHECK(state IN ('approved','changes_requested','commented')),
      body TEXT NOT NULL DEFAULT '',
      head_sha TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(pull_request_id, reviewer_id)
    );
    CREATE INDEX IF NOT EXISTS idx_branch_rules_repository
      ON branch_protection_rules(repository_id, branch);
    CREATE INDEX IF NOT EXISTS idx_pr_reviews_pull
      ON pull_request_reviews(pull_request_id, updated_at DESC);
  `);
}

function boolValue(value, fallback) {
  if (value === undefined || value === null) return fallback;
  return value === true || value === 1 || value === '1' || value === 'true';
}

function ruleDto(row) {
  if (!row) return null;
  return {
    id: row.id,
    repositoryId: row.repositoryId ?? row.repository_id,
    branch: row.branch,
    requirePullRequest: Boolean(row.requirePullRequest ?? row.require_pull_request),
    requiredApprovals: Number(row.requiredApprovals ?? row.required_approvals),
    dismissStaleApprovals: Boolean(row.dismissStaleApprovals ?? row.dismiss_stale_approvals),
    blockDirectPushes: Boolean(row.blockDirectPushes ?? row.block_direct_pushes),
    createdAt: row.createdAt ?? row.created_at,
    updatedAt: row.updatedAt ?? row.updated_at,
  };
}

function findRepository(db, orgSlug, repoSlug) {
  return db.prepare(`
    SELECT r.id, r.slug, r.name, r.default_branch AS defaultBranch,
      r.organization_id AS organizationId, o.slug AS orgSlug, o.name AS orgName
    FROM repositories r JOIN organizations o ON o.id = r.organization_id
    WHERE o.slug = ? AND r.slug = ?
  `).get(orgSlug, repoSlug);
}

export function getBranchProtectionRule(db, repositoryId, branch) {
  const value = assertBranch(branch);
  const row = db.prepare(`
    SELECT id, repository_id AS repositoryId, branch,
      require_pull_request AS requirePullRequest,
      required_approvals AS requiredApprovals,
      dismiss_stale_approvals AS dismissStaleApprovals,
      block_direct_pushes AS blockDirectPushes,
      created_at AS createdAt, updated_at AS updatedAt
    FROM branch_protection_rules
    WHERE repository_id = ? AND branch = ?
  `).get(repositoryId, value);
  return ruleDto(row);
}

export function listBranchProtectionRules(db, repositoryId) {
  return db.prepare(`
    SELECT id, repository_id AS repositoryId, branch,
      require_pull_request AS requirePullRequest,
      required_approvals AS requiredApprovals,
      dismiss_stale_approvals AS dismissStaleApprovals,
      block_direct_pushes AS blockDirectPushes,
      created_at AS createdAt, updated_at AS updatedAt
    FROM branch_protection_rules
    WHERE repository_id = ? ORDER BY branch
  `).all(repositoryId).map(ruleDto);
}

export function upsertBranchProtectionRule(db, { repositoryId, branch, userId, requirePullRequest, requiredApprovals, dismissStaleApprovals, blockDirectPushes }) {
  const protectedBranch = assertBranch(branch);
  const approvals = Number(requiredApprovals ?? 1);
  if (!Number.isInteger(approvals) || approvals < 0 || approvals > 10) {
    throw httpError(400, 'Required approvals must be a whole number from 0 to 10.', 'REQUIRED_APPROVALS_INVALID');
  }
  const existing = db.prepare('SELECT id FROM branch_protection_rules WHERE repository_id = ? AND branch = ?')
    .get(repositoryId, protectedBranch);
  const id = existing?.id ?? uid('bpr');
  db.prepare(`
    INSERT INTO branch_protection_rules
      (id, repository_id, branch, require_pull_request, required_approvals,
       dismiss_stale_approvals, block_direct_pushes, created_by, updated_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(repository_id, branch) DO UPDATE SET
      require_pull_request = excluded.require_pull_request,
      required_approvals = excluded.required_approvals,
      dismiss_stale_approvals = excluded.dismiss_stale_approvals,
      block_direct_pushes = excluded.block_direct_pushes,
      updated_by = excluded.updated_by,
      updated_at = CURRENT_TIMESTAMP
  `).run(
    id,
    repositoryId,
    protectedBranch,
    boolValue(requirePullRequest, true) ? 1 : 0,
    approvals,
    boolValue(dismissStaleApprovals, true) ? 1 : 0,
    boolValue(blockDirectPushes, true) ? 1 : 0,
    userId,
    userId,
  );
  return getBranchProtectionRule(db, repositoryId, protectedBranch);
}

export function assertDirectBranchWriteAllowed(db, repositoryId, branch) {
  const rule = getBranchProtectionRule(db, repositoryId, branch);
  if (!rule) return { allowed: true, rule: null };
  if (rule.blockDirectPushes || rule.requirePullRequest) {
    throw httpError(
      409,
      `Branch '${branch}' is protected. Create a pull request and satisfy its review policy.`,
      'PROTECTED_BRANCH_DIRECT_WRITE',
    );
  }
  return { allowed: true, rule };
}

function findPullRequest(db, repositoryId, number) {
  return db.prepare(`
    SELECT p.*, u.display_name AS authorName, u.email AS authorEmail
    FROM pull_requests p JOIN users u ON u.id = p.author_id
    WHERE p.repository_id = ? AND p.number = ?
  `).get(repositoryId, Number(number));
}

function currentHeadSha(config, repository, pull) {
  return resolveRef(config, repository.orgSlug, repository.slug, pull.head_branch);
}

function listReviews(db, pullRequestId, currentSha, dismissStaleApprovals) {
  return db.prepare(`
    SELECT r.id, r.state, r.body, r.head_sha AS headSha,
      r.created_at AS createdAt, r.updated_at AS updatedAt,
      u.id AS reviewerId, u.display_name AS reviewerName, u.email AS reviewerEmail
    FROM pull_request_reviews r JOIN users u ON u.id = r.reviewer_id
    WHERE r.pull_request_id = ? ORDER BY r.updated_at DESC
  `).all(pullRequestId).map((review) => ({
    ...review,
    stale: Boolean(dismissStaleApprovals && review.headSha !== currentSha),
  }));
}

export function getPullRequestGovernance(db, config, repository, pull) {
  const rule = getBranchProtectionRule(db, repository.id, pull.base_branch);
  const headSha = currentHeadSha(config, repository, pull);
  const reviews = listReviews(db, pull.id, headSha, rule?.dismissStaleApprovals ?? false);
  const activeReviews = reviews.filter((review) => !review.stale);
  const approvals = activeReviews.filter((review) => review.state === 'approved');
  const changeRequests = activeReviews.filter((review) => review.state === 'changes_requested');
  const requiredApprovals = rule?.requiredApprovals ?? 0;
  const reasons = [];
  if (changeRequests.length) reasons.push(`${changeRequests.length} active change request${changeRequests.length === 1 ? '' : 's'} must be resolved.`);
  if (approvals.length < requiredApprovals) reasons.push(`${requiredApprovals - approvals.length} more approval${requiredApprovals - approvals.length === 1 ? '' : 's'} required.`);
  if (pull.status !== 'open') reasons.push('Only open pull requests can be merged.');
  return {
    rule,
    headSha,
    reviews,
    approvalCount: approvals.length,
    changeRequestCount: changeRequests.length,
    requiredApprovals,
    mergeAllowed: reasons.length === 0,
    mergeBlockReasons: reasons,
  };
}

export function submitPullRequestReview(db, config, { repository, pull, reviewer, state, body = '' }) {
  const reviewState = String(state ?? '').trim();
  if (!REVIEW_STATES.includes(reviewState)) throw httpError(400, 'Select approve, request changes or comment.', 'REVIEW_STATE_INVALID');
  if (pull.status !== 'open') throw httpError(409, 'Only open pull requests can be reviewed.', 'PULL_REQUEST_NOT_OPEN');
  if (pull.author_id === reviewer.id && reviewState !== 'commented') {
    throw httpError(409, 'Pull request authors cannot approve or request changes on their own pull request.', 'SELF_REVIEW_NOT_ALLOWED');
  }
  const headSha = currentHeadSha(config, repository, pull);
  const reviewBody = String(body ?? '').trim().slice(0, 20000);
  const existing = db.prepare('SELECT id FROM pull_request_reviews WHERE pull_request_id = ? AND reviewer_id = ?')
    .get(pull.id, reviewer.id);
  const id = existing?.id ?? uid('prr');
  db.prepare(`
    INSERT INTO pull_request_reviews (id, pull_request_id, reviewer_id, state, body, head_sha)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(pull_request_id, reviewer_id) DO UPDATE SET
      state = excluded.state,
      body = excluded.body,
      head_sha = excluded.head_sha,
      updated_at = CURRENT_TIMESTAMP
  `).run(id, pull.id, reviewer.id, reviewState, reviewBody, headSha);
  return db.prepare(`
    SELECT r.id, r.state, r.body, r.head_sha AS headSha,
      r.created_at AS createdAt, r.updated_at AS updatedAt,
      u.id AS reviewerId, u.display_name AS reviewerName, u.email AS reviewerEmail
    FROM pull_request_reviews r JOIN users u ON u.id = r.reviewer_id
    WHERE r.id = ?
  `).get(id);
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

async function readBody(req, maxBytes = MAX_BODY_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw httpError(413, 'Request body is too large.', 'GOVERNANCE_REQUEST_TOO_LARGE');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function parseJson(raw) {
  if (!raw.length) return {};
  try { return JSON.parse(raw.toString('utf8')); }
  catch { throw httpError(400, 'Invalid JSON request body.', 'INVALID_JSON'); }
}

function replayRequest(req, raw) {
  const replay = new PassThrough();
  replay.method = req.method;
  replay.url = req.url;
  replay.headers = { ...req.headers, 'content-length': String(raw.length) };
  replay.rawHeaders = req.rawHeaders;
  replay.httpVersion = req.httpVersion;
  replay.httpVersionMajor = req.httpVersionMajor;
  replay.httpVersionMinor = req.httpVersionMinor;
  replay.socket = req.socket;
  replay.connection = req.connection;
  queueMicrotask(() => replay.end(raw));
  return replay;
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

function repositoryForAccess(db, access) {
  const row = findRepository(db, access.repository.orgSlug, access.repository.slug);
  if (!row) throw httpError(404, 'Repository not found.', 'REPO_NOT_FOUND');
  return row;
}

function pullDto(pull, governance) {
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
    createdAt: pull.created_at,
    updatedAt: pull.updated_at,
    governance,
  };
}

export function createBranchGovernanceApiHandler({ config, db }) {
  return async function handleBranchGovernanceApi(req, res) {
    const url = new URL(req.url, config.baseUrl);
    const pathname = url.pathname;
    if (!pathname.startsWith('/api/governance/')) return false;
    const requestId = uid('req');
    res.setHeader('X-Request-Id', requestId);
    res.setHeader('Referrer-Policy', 'no-referrer');

    try {
      if (!originAllowed(req, config.baseUrl)) throw httpError(403, 'Request origin is not allowed.', 'CSRF_BLOCKED');
      const user = requireUser(db, req);

      let params = routeMatch(pathname, '/api/governance/:org/:repo');
      if (req.method === 'GET' && params) {
        const access = requireRepositoryAccess(db, user.id, { orgSlug: params.org, repoSlug: params.repo }, 'read');
        const repository = repositoryForAccess(db, access);
        const pulls = db.prepare(`
          SELECT p.*, u.display_name AS authorName, u.email AS authorEmail
          FROM pull_requests p JOIN users u ON u.id = p.author_id
          WHERE p.repository_id = ? AND p.status = 'open'
          ORDER BY p.created_at DESC LIMIT 50
        `).all(repository.id).map((pull) => pullDto(pull, getPullRequestGovernance(db, config, repository, pull)));
        return sendJson(res, 200, {
          repository,
          effectivePermission: access.permission,
          canManage: permissionAtLeast(access.permission, 'admin'),
          canReview: permissionAtLeast(access.permission, 'write'),
          availableReviewStates: REVIEW_STATES,
          rules: listBranchProtectionRules(db, repository.id),
          pullRequests: pulls,
        });
      }

      params = routeMatch(pathname, '/api/governance/:org/:repo/rules/:branch');
      if (req.method === 'PUT' && params) {
        const access = requireRepositoryAccess(db, user.id, { orgSlug: params.org, repoSlug: params.repo }, 'admin');
        const repository = repositoryForAccess(db, access);
        const body = parseJson(await readBody(req));
        const rule = upsertBranchProtectionRule(db, {
          repositoryId: repository.id,
          branch: params.branch,
          userId: user.id,
          requirePullRequest: body.requirePullRequest,
          requiredApprovals: body.requiredApprovals,
          dismissStaleApprovals: body.dismissStaleApprovals,
          blockDirectPushes: body.blockDirectPushes,
        });
        installBranchProtectionHook(config, repository.orgSlug, repository.slug);
        audit(db, {
          organizationId: repository.organizationId,
          userId: user.id,
          action: 'branch_protection.updated',
          targetType: 'repository',
          targetId: repository.id,
          metadata: { repository: repository.slug, branch: rule.branch, requiredApprovals: rule.requiredApprovals },
        });
        return sendJson(res, 200, { rule });
      }
      if (req.method === 'DELETE' && params) {
        const access = requireRepositoryAccess(db, user.id, { orgSlug: params.org, repoSlug: params.repo }, 'admin');
        const repository = repositoryForAccess(db, access);
        const result = db.prepare('DELETE FROM branch_protection_rules WHERE repository_id = ? AND branch = ?')
          .run(repository.id, assertBranch(params.branch));
        if (!result.changes) throw httpError(404, 'Branch protection rule not found.', 'BRANCH_RULE_NOT_FOUND');
        audit(db, {
          organizationId: repository.organizationId,
          userId: user.id,
          action: 'branch_protection.deleted',
          targetType: 'repository',
          targetId: repository.id,
          metadata: { repository: repository.slug, branch: params.branch },
        });
        return sendJson(res, 200, { deleted: true });
      }

      params = routeMatch(pathname, '/api/governance/:org/:repo/pulls/:number');
      if (req.method === 'GET' && params) {
        const access = requireRepositoryAccess(db, user.id, { orgSlug: params.org, repoSlug: params.repo }, 'read');
        const repository = repositoryForAccess(db, access);
        const pull = findPullRequest(db, repository.id, params.number);
        if (!pull) throw httpError(404, 'Pull request not found.', 'PULL_REQUEST_NOT_FOUND');
        return sendJson(res, 200, { pullRequest: pullDto(pull, getPullRequestGovernance(db, config, repository, pull)) });
      }

      params = routeMatch(pathname, '/api/governance/:org/:repo/pulls/:number/reviews');
      if (req.method === 'POST' && params) {
        const access = requireRepositoryAccess(db, user.id, { orgSlug: params.org, repoSlug: params.repo }, 'write');
        const repository = repositoryForAccess(db, access);
        const pull = findPullRequest(db, repository.id, params.number);
        if (!pull) throw httpError(404, 'Pull request not found.', 'PULL_REQUEST_NOT_FOUND');
        const body = parseJson(await readBody(req));
        const review = submitPullRequestReview(db, config, {
          repository,
          pull,
          reviewer: user,
          state: body.state,
          body: body.body,
        });
        audit(db, {
          organizationId: repository.organizationId,
          userId: user.id,
          action: `pull_request_review.${review.state}`,
          targetType: 'pull_request',
          targetId: pull.id,
          metadata: { repository: repository.slug, number: pull.number, headSha: review.headSha },
        });
        return sendJson(res, 200, {
          review,
          governance: getPullRequestGovernance(db, config, repository, pull),
        });
      }

      throw httpError(404, 'Governance API endpoint not found.', 'NOT_FOUND');
    } catch (error) {
      const status = Number(error.status) || 500;
      if (status >= 500) console.error(`[${requestId}] branch governance API`, error);
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

export function createBranchGovernanceGuard({ config, db, app }) {
  return async function branchGovernanceGuard(req, res) {
    const url = new URL(req.url, config.baseUrl);
    let params = routeMatch(url.pathname, '/api/repos/:org/:repo/files');
    try {
      if (req.method === 'POST' && params) {
        const user = currentUser(db, req);
        if (!user) return app(req, res);
        const access = requireRepositoryAccess(db, user.id, { orgSlug: params.org, repoSlug: params.repo }, 'write');
        const repository = repositoryForAccess(db, access);
        const raw = await readBody(req, 2 * 1024 * 1024);
        const body = parseJson(raw);
        const branch = assertBranch(body.branch || repository.defaultBranch);
        assertDirectBranchWriteAllowed(db, repository.id, branch);
        return app(replayRequest(req, raw), res);
      }

      params = routeMatch(url.pathname, '/api/repos/:org/:repo/pulls/:number/merge');
      if (req.method === 'POST' && params) {
        const user = currentUser(db, req);
        if (!user) return app(req, res);
        const access = requireRepositoryAccess(db, user.id, { orgSlug: params.org, repoSlug: params.repo }, 'maintain');
        const repository = repositoryForAccess(db, access);
        const pull = findPullRequest(db, repository.id, params.number);
        if (!pull) throw httpError(404, 'Pull request not found.', 'PULL_REQUEST_NOT_FOUND');
        const governance = getPullRequestGovernance(db, config, repository, pull);
        if (!governance.mergeAllowed) {
          throw httpError(409, governance.mergeBlockReasons.join(' '), 'PULL_REQUEST_POLICY_BLOCKED');
        }
        return app(req, res);
      }

      return app(req, res);
    } catch (error) {
      const status = Number(error.status) || 500;
      return sendJson(res, status, {
        error: {
          code: error.code || 'INTERNAL_ERROR',
          message: status >= 500 ? 'An unexpected server error occurred.' : error.message,
        },
      });
    }
  };
}

function hookProgram() {
  return `#!/usr/bin/env node
const { DatabaseSync } = require('node:sqlite');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => input += chunk);
process.stdin.on('end', () => {
  if (process.env.KUKGIT_BYPASS_BRANCH_PROTECTION === '1') process.exit(0);
  const databasePath = process.env.KUKGIT_DATABASE_PATH;
  const repositoryId = process.env.KUKGIT_REPOSITORY_ID;
  if (!databasePath || !repositoryId) process.exit(0);
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const statement = db.prepare('SELECT branch, require_pull_request, block_direct_pushes FROM branch_protection_rules WHERE repository_id = ? AND branch = ?');
    for (const line of input.trim().split(/\\r?\\n/).filter(Boolean)) {
      const parts = line.trim().split(/\\s+/);
      const ref = parts[2] || '';
      if (!ref.startsWith('refs/heads/')) continue;
      const branch = ref.slice('refs/heads/'.length);
      const rule = statement.get(repositoryId, branch);
      if (rule && (rule.require_pull_request || rule.block_direct_pushes)) {
        console.error('KukGit: protected branch ' + branch + ' only accepts changes through an approved pull request.');
        process.exit(1);
      }
    }
  } finally {
    db.close();
  }
  process.exit(0);
});
`;
}

export function installBranchProtectionHook(config, orgSlug, repoSlug) {
  const gitDir = repoDiskPath(config, orgSlug, repoSlug);
  const hooksDir = path.join(gitDir, 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });
  const target = path.join(hooksDir, 'pre-receive');
  fs.writeFileSync(target, hookProgram(), { encoding: 'utf8', mode: 0o755 });
  fs.chmodSync(target, 0o755);
  return target;
}

export function installExistingBranchProtectionHooks(config, db) {
  const repositories = db.prepare(`
    SELECT DISTINCT o.slug AS orgSlug, r.slug AS repoSlug
    FROM branch_protection_rules b
    JOIN repositories r ON r.id = b.repository_id
    JOIN organizations o ON o.id = r.organization_id
  `).all();
  for (const repository of repositories) {
    try { installBranchProtectionHook(config, repository.orgSlug, repository.repoSlug); }
    catch (error) { console.warn(`Unable to install branch protection hook for ${repository.orgSlug}/${repository.repoSlug}: ${error.message}`); }
  }
}
