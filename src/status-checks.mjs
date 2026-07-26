import { currentUser } from './auth.mjs';
import { audit, uid } from './db.mjs';
import { resolveRef } from './git.mjs';
import { permissionAtLeast, requireRepositoryAccess } from './repository-access.mjs';
import { assertBranch, httpError, originAllowed } from './security.mjs';
import { verifyPersonalAccessToken } from './tokens.mjs';

const STATUS_STATES = Object.freeze(['pending', 'success', 'failure', 'error']);
const STATUS_CONTEXT_RE = /^[A-Za-z0-9][A-Za-z0-9._:/ -]{0,127}$/;
const SHA_RE = /^[0-9a-f]{40}$/i;
const MAX_BODY_BYTES = 96 * 1024;

export function migrateStatusChecks(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS required_status_check_policies (
      id TEXT PRIMARY KEY,
      repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
      branch TEXT NOT NULL,
      contexts_json TEXT NOT NULL DEFAULT '[]',
      created_by TEXT NOT NULL REFERENCES users(id),
      updated_by TEXT NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(repository_id, branch)
    );
    CREATE TABLE IF NOT EXISTS commit_status_checks (
      id TEXT PRIMARY KEY,
      repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
      commit_sha TEXT NOT NULL,
      context TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('pending','success','failure','error')),
      description TEXT NOT NULL DEFAULT '',
      target_url TEXT,
      publisher_id TEXT NOT NULL REFERENCES users(id),
      publisher_token_id TEXT REFERENCES personal_access_tokens(id),
      publisher_auth_type TEXT NOT NULL DEFAULT 'session',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(repository_id, commit_sha, context)
    );
    CREATE INDEX IF NOT EXISTS idx_required_status_policy_repository
      ON required_status_check_policies(repository_id, branch);
    CREATE INDEX IF NOT EXISTS idx_commit_status_repository_sha
      ON commit_status_checks(repository_id, commit_sha, context);
    CREATE INDEX IF NOT EXISTS idx_commit_status_context_updated
      ON commit_status_checks(repository_id, context, updated_at DESC);
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
    if (size > MAX_BODY_BYTES) throw httpError(413, 'Request body is too large.', 'STATUS_CHECK_REQUEST_TOO_LARGE');
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

function normalizeContext(value) {
  const context = String(value ?? '').trim().replace(/\s+/g, ' ');
  if (!STATUS_CONTEXT_RE.test(context)) {
    throw httpError(400, 'Check context must be 1–128 characters using letters, numbers, spaces, dots, slashes, colons, underscores or hyphens.', 'STATUS_CONTEXT_INVALID');
  }
  return context;
}

export function normalizeRequiredContexts(input) {
  const values = Array.isArray(input) ? input : String(input ?? '').split(/[\n,]/);
  const contexts = [...new Set(values.map((value) => String(value).trim()).filter(Boolean).map(normalizeContext))];
  if (contexts.length > 50) throw httpError(400, 'A branch may require at most 50 status-check contexts.', 'TOO_MANY_STATUS_CONTEXTS');
  return contexts.sort((a, b) => a.localeCompare(b));
}

function normalizeState(value) {
  const state = String(value ?? '').trim().toLowerCase();
  if (!STATUS_STATES.includes(state)) throw httpError(400, 'Status state must be pending, success, failure or error.', 'STATUS_STATE_INVALID');
  return state;
}

function normalizeDescription(value) {
  return String(value ?? '').trim().slice(0, 280);
}

function normalizeTargetUrl(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  if (raw.length > 2048) throw httpError(400, 'Status target URL is too long.', 'STATUS_TARGET_URL_INVALID');
  let url;
  try { url = new URL(raw); }
  catch { throw httpError(400, 'Enter a valid status target URL.', 'STATUS_TARGET_URL_INVALID'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
    throw httpError(400, 'Status target URL must use HTTP or HTTPS without embedded credentials.', 'STATUS_TARGET_URL_INVALID');
  }
  return url.toString();
}

function normalizeSha(value) {
  const sha = String(value ?? '').trim().toLowerCase();
  if (!SHA_RE.test(sha)) throw httpError(400, 'Commit SHA must be a full 40-character Git SHA.', 'STATUS_SHA_INVALID');
  return sha;
}

function verifyCommitExists(config, repository, sha) {
  let resolved;
  try { resolved = resolveRef(config, repository.orgSlug, repository.slug, sha); }
  catch { throw httpError(404, 'Commit was not found in this repository.', 'STATUS_COMMIT_NOT_FOUND'); }
  if (resolved.toLowerCase() !== sha.toLowerCase()) throw httpError(404, 'Commit was not found in this repository.', 'STATUS_COMMIT_NOT_FOUND');
  return resolved.toLowerCase();
}

function parseContexts(value) {
  try { return normalizeRequiredContexts(JSON.parse(value)); }
  catch { return []; }
}

function policyDto(row) {
  if (!row) return null;
  const contextsJson = row.contextsJson ?? row.contexts_json ?? '[]';
  return {
    id: row.id,
    repositoryId: row.repositoryId ?? row.repository_id,
    branch: row.branch,
    contexts: parseContexts(contextsJson),
    createdAt: row.createdAt ?? row.created_at,
    updatedAt: row.updatedAt ?? row.updated_at,
  };
}

function statusDto(row) {
  return {
    id: row.id,
    repositoryId: row.repositoryId ?? row.repository_id,
    commitSha: row.commitSha ?? row.commit_sha,
    context: row.context,
    state: row.state,
    description: row.description,
    targetUrl: row.targetUrl ?? row.target_url,
    publisherId: row.publisherId ?? row.publisher_id,
    publisherName: row.publisherName,
    publisherEmail: row.publisherEmail,
    publisherAuthType: row.publisherAuthType ?? row.publisher_auth_type,
    createdAt: row.createdAt ?? row.created_at,
    updatedAt: row.updatedAt ?? row.updated_at,
  };
}

export function getRequiredStatusPolicy(db, repositoryId, branch) {
  const value = assertBranch(branch);
  const row = db.prepare(`
    SELECT id, repository_id AS repositoryId, branch, contexts_json AS contextsJson,
      created_at AS createdAt, updated_at AS updatedAt
    FROM required_status_check_policies WHERE repository_id = ? AND branch = ?
  `).get(repositoryId, value);
  return policyDto(row);
}

export function listRequiredStatusPolicies(db, repositoryId) {
  return db.prepare(`
    SELECT id, repository_id AS repositoryId, branch, contexts_json AS contextsJson,
      created_at AS createdAt, updated_at AS updatedAt
    FROM required_status_check_policies WHERE repository_id = ? ORDER BY branch
  `).all(repositoryId).map(policyDto);
}

export function upsertRequiredStatusPolicy(db, { repositoryId, branch, userId, contexts }) {
  const value = assertBranch(branch);
  const required = normalizeRequiredContexts(contexts);
  const existing = db.prepare('SELECT id FROM required_status_check_policies WHERE repository_id = ? AND branch = ?')
    .get(repositoryId, value);
  const id = existing?.id ?? uid('scp');
  db.prepare(`
    INSERT INTO required_status_check_policies
      (id, repository_id, branch, contexts_json, created_by, updated_by)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(repository_id, branch) DO UPDATE SET
      contexts_json = excluded.contexts_json,
      updated_by = excluded.updated_by,
      updated_at = CURRENT_TIMESTAMP
  `).run(id, repositoryId, value, JSON.stringify(required), userId, userId);
  return getRequiredStatusPolicy(db, repositoryId, value);
}

export function listCommitStatuses(db, repositoryId, commitSha) {
  const sha = normalizeSha(commitSha);
  return db.prepare(`
    SELECT s.id, s.repository_id AS repositoryId, s.commit_sha AS commitSha,
      s.context, s.state, s.description, s.target_url AS targetUrl,
      s.publisher_id AS publisherId, s.publisher_auth_type AS publisherAuthType,
      s.created_at AS createdAt, s.updated_at AS updatedAt,
      u.display_name AS publisherName, u.email AS publisherEmail
    FROM commit_status_checks s JOIN users u ON u.id = s.publisher_id
    WHERE s.repository_id = ? AND s.commit_sha = ? ORDER BY s.context
  `).all(repositoryId, sha).map(statusDto);
}

export function publishCommitStatus(db, config, { repository, commitSha, context, state, description, targetUrl, publisher, tokenId = null, authType = 'session' }) {
  const sha = verifyCommitExists(config, repository, normalizeSha(commitSha));
  const normalizedContext = normalizeContext(context);
  const normalizedState = normalizeState(state);
  const normalizedDescription = normalizeDescription(description);
  const normalizedTargetUrl = normalizeTargetUrl(targetUrl);
  const existing = db.prepare('SELECT id FROM commit_status_checks WHERE repository_id = ? AND commit_sha = ? AND context = ?')
    .get(repository.id, sha, normalizedContext);
  const id = existing?.id ?? uid('sts');
  db.prepare(`
    INSERT INTO commit_status_checks
      (id, repository_id, commit_sha, context, state, description, target_url,
       publisher_id, publisher_token_id, publisher_auth_type)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(repository_id, commit_sha, context) DO UPDATE SET
      state = excluded.state,
      description = excluded.description,
      target_url = excluded.target_url,
      publisher_id = excluded.publisher_id,
      publisher_token_id = excluded.publisher_token_id,
      publisher_auth_type = excluded.publisher_auth_type,
      updated_at = CURRENT_TIMESTAMP
  `).run(
    id,
    repository.id,
    sha,
    normalizedContext,
    normalizedState,
    normalizedDescription,
    normalizedTargetUrl,
    publisher.id,
    tokenId,
    authType,
  );
  const row = db.prepare(`
    SELECT s.id, s.repository_id AS repositoryId, s.commit_sha AS commitSha,
      s.context, s.state, s.description, s.target_url AS targetUrl,
      s.publisher_id AS publisherId, s.publisher_auth_type AS publisherAuthType,
      s.created_at AS createdAt, s.updated_at AS updatedAt,
      u.display_name AS publisherName, u.email AS publisherEmail
    FROM commit_status_checks s JOIN users u ON u.id = s.publisher_id WHERE s.id = ?
  `).get(id);
  return statusDto(row);
}

export function statusCheckSummary(db, config, repository, pull) {
  const headSha = resolveRef(config, repository.orgSlug, repository.slug, pull.head_branch).toLowerCase();
  const policy = getRequiredStatusPolicy(db, repository.id, pull.base_branch);
  const statuses = listCommitStatuses(db, repository.id, headSha);
  const byContext = new Map(statuses.map((status) => [status.context, status]));
  const requiredContexts = policy?.contexts ?? [];
  const requiredChecks = requiredContexts.map((context) => byContext.get(context) ?? {
    id: null,
    repositoryId: repository.id,
    commitSha: headSha,
    context,
    state: 'missing',
    description: 'No status has been published for this commit.',
    targetUrl: null,
    publisherId: null,
    publisherName: null,
    publisherEmail: null,
    publisherAuthType: null,
    createdAt: null,
    updatedAt: null,
  });
  const missingCount = requiredChecks.filter((check) => check.state === 'missing').length;
  const pendingCount = requiredChecks.filter((check) => check.state === 'pending').length;
  const failureCount = requiredChecks.filter((check) => check.state === 'failure').length;
  const errorCount = requiredChecks.filter((check) => check.state === 'error').length;
  const successCount = requiredChecks.filter((check) => check.state === 'success').length;
  const reasons = [];
  if (missingCount) reasons.push(`${missingCount} required status check${missingCount === 1 ? ' is' : 's are'} missing.`);
  if (pendingCount) reasons.push(`${pendingCount} required status check${pendingCount === 1 ? ' is' : 's are'} pending.`);
  if (failureCount) reasons.push(`${failureCount} required status check${failureCount === 1 ? ' has' : 's have'} failed.`);
  if (errorCount) reasons.push(`${errorCount} required status check${errorCount === 1 ? ' has' : 's have'} errors.`);
  return {
    policy,
    headSha,
    statuses,
    requiredChecks,
    requiredCount: requiredContexts.length,
    successCount,
    missingCount,
    pendingCount,
    failureCount,
    errorCount,
    mergeAllowed: reasons.length === 0,
    mergeBlockReasons: reasons,
  };
}

function parseBasicToken(header = '') {
  if (!header.startsWith('Basic ')) return null;
  try {
    const raw = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const index = raw.indexOf(':');
    const username = index >= 0 ? raw.slice(0, index) : raw;
    const password = index >= 0 ? raw.slice(index + 1) : '';
    return password.startsWith('kgp_') ? password : username.startsWith('kgp_') ? username : null;
  } catch { return null; }
}

function presentedToken(req) {
  const authorization = String(req.headers.authorization ?? '');
  if (authorization.startsWith('Bearer ')) return authorization.slice(7).trim();
  return parseBasicToken(authorization);
}

function authenticateStatusPublisher(db, req, repository) {
  const tokenValue = presentedToken(req);
  if (tokenValue) {
    const token = verifyPersonalAccessToken(db, tokenValue, 'repo:write');
    if (!token) throw httpError(401, 'A valid repo:write personal access token is required.', 'STATUS_PUBLISHER_TOKEN_INVALID');
    const access = requireRepositoryAccess(db, token.userId, { repositoryId: repository.id }, 'write');
    return {
      publisher: { id: token.userId, email: token.email, displayName: token.displayName },
      tokenId: token.id,
      authType: 'personal-access-token',
      access,
    };
  }
  const user = currentUser(db, req);
  if (!user) throw httpError(401, 'Authentication is required.', 'AUTH_REQUIRED');
  const access = requireRepositoryAccess(db, user.id, { repositoryId: repository.id }, 'write');
  return { publisher: user, tokenId: null, authType: 'session', access };
}

function pullDto(db, config, repository, pull) {
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
    statusChecks: statusCheckSummary(db, config, repository, pull),
  };
}

export function createStatusChecksApiHandler({ config, db }) {
  return async function handleStatusChecksApi(req, res) {
    const url = new URL(req.url, config.baseUrl);
    const pathname = url.pathname;
    if (!pathname.startsWith('/api/status-checks/')) return false;
    const requestId = uid('req');
    res.setHeader('X-Request-Id', requestId);
    res.setHeader('Referrer-Policy', 'no-referrer');

    try {
      if (!originAllowed(req, config.baseUrl)) throw httpError(403, 'Request origin is not allowed.', 'CSRF_BLOCKED');

      let params = routeMatch(pathname, '/api/status-checks/:org/:repo/commits/:sha/statuses');
      if (req.method === 'POST' && params) {
        const repository = findRepository(db, params.org, params.repo);
        if (!repository) throw httpError(404, 'Repository not found.', 'REPO_NOT_FOUND');
        const authenticated = authenticateStatusPublisher(db, req, repository);
        const body = await readJson(req);
        const status = publishCommitStatus(db, config, {
          repository,
          commitSha: params.sha,
          context: body.context,
          state: body.state,
          description: body.description,
          targetUrl: body.targetUrl,
          publisher: authenticated.publisher,
          tokenId: authenticated.tokenId,
          authType: authenticated.authType,
        });
        audit(db, {
          organizationId: repository.organizationId,
          userId: authenticated.publisher.id,
          action: 'commit_status.published',
          targetType: 'repository',
          targetId: repository.id,
          metadata: {
            repository: repository.slug,
            commitSha: status.commitSha,
            context: status.context,
            state: status.state,
            authType: authenticated.authType,
          },
        });
        return sendJson(res, 200, { status });
      }

      const user = currentUser(db, req);
      if (!user) throw httpError(401, 'Authentication is required.', 'AUTH_REQUIRED');

      params = routeMatch(pathname, '/api/status-checks/:org/:repo');
      if (req.method === 'GET' && params) {
        const access = requireRepositoryAccess(db, user.id, { orgSlug: params.org, repoSlug: params.repo }, 'read');
        const repository = repositoryForAccess(db, access);
        const pulls = db.prepare(`
          SELECT p.*, u.display_name AS authorName, u.email AS authorEmail
          FROM pull_requests p JOIN users u ON u.id = p.author_id
          WHERE p.repository_id = ? AND p.status = 'open'
          ORDER BY p.created_at DESC LIMIT 50
        `).all(repository.id).map((pull) => pullDto(db, config, repository, pull));
        const knownContexts = db.prepare(`
          SELECT context, MAX(updated_at) AS updatedAt
          FROM commit_status_checks WHERE repository_id = ?
          GROUP BY context ORDER BY updatedAt DESC, context LIMIT 100
        `).all(repository.id).map((row) => row.context);
        return sendJson(res, 200, {
          repository,
          effectivePermission: access.permission,
          canManage: permissionAtLeast(access.permission, 'admin'),
          canPublish: permissionAtLeast(access.permission, 'write'),
          availableStates: STATUS_STATES,
          policies: listRequiredStatusPolicies(db, repository.id),
          knownContexts,
          pullRequests: pulls,
        });
      }

      params = routeMatch(pathname, '/api/status-checks/:org/:repo/policies/:branch');
      if (req.method === 'PUT' && params) {
        const access = requireRepositoryAccess(db, user.id, { orgSlug: params.org, repoSlug: params.repo }, 'admin');
        const repository = repositoryForAccess(db, access);
        const body = await readJson(req);
        const policy = upsertRequiredStatusPolicy(db, {
          repositoryId: repository.id,
          branch: params.branch,
          userId: user.id,
          contexts: body.contexts,
        });
        audit(db, {
          organizationId: repository.organizationId,
          userId: user.id,
          action: 'required_status_policy.updated',
          targetType: 'repository',
          targetId: repository.id,
          metadata: { repository: repository.slug, branch: policy.branch, contexts: policy.contexts },
        });
        return sendJson(res, 200, { policy });
      }
      if (req.method === 'DELETE' && params) {
        const access = requireRepositoryAccess(db, user.id, { orgSlug: params.org, repoSlug: params.repo }, 'admin');
        const repository = repositoryForAccess(db, access);
        const result = db.prepare('DELETE FROM required_status_check_policies WHERE repository_id = ? AND branch = ?')
          .run(repository.id, assertBranch(params.branch));
        if (!result.changes) throw httpError(404, 'Required status-check policy not found.', 'STATUS_POLICY_NOT_FOUND');
        audit(db, {
          organizationId: repository.organizationId,
          userId: user.id,
          action: 'required_status_policy.deleted',
          targetType: 'repository',
          targetId: repository.id,
          metadata: { repository: repository.slug, branch: params.branch },
        });
        return sendJson(res, 200, { deleted: true });
      }

      params = routeMatch(pathname, '/api/status-checks/:org/:repo/commits/:sha/statuses');
      if (req.method === 'GET' && params) {
        const access = requireRepositoryAccess(db, user.id, { orgSlug: params.org, repoSlug: params.repo }, 'read');
        const repository = repositoryForAccess(db, access);
        const sha = verifyCommitExists(config, repository, normalizeSha(params.sha));
        return sendJson(res, 200, { commitSha: sha, statuses: listCommitStatuses(db, repository.id, sha) });
      }

      params = routeMatch(pathname, '/api/status-checks/:org/:repo/pulls/:number');
      if (req.method === 'GET' && params) {
        const access = requireRepositoryAccess(db, user.id, { orgSlug: params.org, repoSlug: params.repo }, 'read');
        const repository = repositoryForAccess(db, access);
        const pull = findPullRequest(db, repository.id, params.number);
        if (!pull) throw httpError(404, 'Pull request not found.', 'PULL_REQUEST_NOT_FOUND');
        return sendJson(res, 200, { pullRequest: pullDto(db, config, repository, pull) });
      }

      throw httpError(404, 'Status checks API endpoint not found.', 'NOT_FOUND');
    } catch (error) {
      const status = Number(error.status) || 500;
      if (status >= 500) console.error(`[${requestId}] status checks API`, error);
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

export function createStatusCheckMergeGuard({ config, db, app }) {
  return async function statusCheckMergeGuard(req, res) {
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
      const summary = statusCheckSummary(db, config, repository, pull);
      if (!summary.mergeAllowed) {
        throw httpError(409, summary.mergeBlockReasons.join(' '), 'PULL_REQUEST_STATUS_CHECKS_BLOCKED');
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
