import { requireUser } from './auth.mjs';
import { audit, uid } from './db.mjs';
import { hashToken, httpError, originAllowed, randomToken } from './security.mjs';
import { claimNextJob, listRunJobs, secretsForJob } from './workflow-runs.mjs';

export const RUNNER_TOKEN_PREFIX = 'kgr_';

export const RUNNER_LIMITS = {
  maxPerOrganization: 50,
  maxLabels: 10,
  maxNameLength: 100,
  offlineAfterSeconds: 120,
};

const RUNNER_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/;
const RUNNER_LABEL = /^[a-z0-9][a-z0-9._-]*$/;
const ORG_ROLE_RANK = { viewer: 1, developer: 2, maintainer: 3, admin: 4, owner: 5 };
const MAX_BODY_BYTES = 32 * 1024;

export function migrateRunners(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS runners (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      labels_json TEXT NOT NULL DEFAULT '[]',
      token_hash TEXT NOT NULL UNIQUE,
      allow_fork_jobs INTEGER NOT NULL DEFAULT 0,
      created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_seen_at TEXT,
      last_seen_version TEXT,
      UNIQUE(organization_id, name)
    );
    CREATE INDEX IF NOT EXISTS idx_runners_organization ON runners(organization_id, name);
  `);
}

function normalizeName(value) {
  const name = String(value ?? '').trim();
  if (!name) throw httpError(400, 'A runner name is required.', 'RUNNER_NAME_REQUIRED');
  if (name.length > RUNNER_LIMITS.maxNameLength) throw httpError(400, 'Runner name is too long.', 'RUNNER_NAME_INVALID');
  if (!RUNNER_NAME.test(name)) throw httpError(400, 'A runner name may contain letters, numbers, spaces, dots, underscores and hyphens.', 'RUNNER_NAME_INVALID');
  return name;
}

function normalizeLabels(value) {
  const labels = Array.isArray(value) ? value : String(value ?? '').split(',');
  const normalized = [...new Set(labels.map((label) => String(label).trim().toLowerCase()).filter(Boolean))];
  if (!normalized.length) throw httpError(400, 'A runner must declare at least one label.', 'RUNNER_LABELS_REQUIRED');
  if (normalized.length > RUNNER_LIMITS.maxLabels) throw httpError(400, `A runner may declare at most ${RUNNER_LIMITS.maxLabels} labels.`, 'RUNNER_LABELS_INVALID');
  for (const label of normalized) {
    if (!RUNNER_LABEL.test(label) || label.length > 64) {
      throw httpError(400, `'${label}' is not a valid runner label.`, 'RUNNER_LABELS_INVALID');
    }
  }
  return normalized.sort();
}

/**
 * Registers a runner and returns its token exactly once.
 *
 * The token is stored only as a SHA-256 hash, like every other KukGit
 * credential. An operator who loses it registers a new runner rather than
 * recovering the old one.
 */
export function registerRunner(db, { organizationId, name, labels, allowForkJobs = false, createdBy = null }) {
  const runnerName = normalizeName(name);
  const runnerLabels = normalizeLabels(labels);

  const count = db.prepare('SELECT COUNT(*) AS count FROM runners WHERE organization_id = ?').get(organizationId).count;
  if (count >= RUNNER_LIMITS.maxPerOrganization) {
    throw httpError(409, `An organization may register at most ${RUNNER_LIMITS.maxPerOrganization} runners.`, 'RUNNER_LIMIT_REACHED');
  }
  const existing = db.prepare('SELECT id FROM runners WHERE organization_id = ? AND name = ?').get(organizationId, runnerName);
  if (existing) throw httpError(409, 'A runner with that name is already registered.', 'RUNNER_NAME_TAKEN');

  const token = `${RUNNER_TOKEN_PREFIX}${randomToken(32)}`;
  const id = uid('rnr');
  db.prepare(`
    INSERT INTO runners (id, organization_id, name, labels_json, token_hash, allow_fork_jobs, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, organizationId, runnerName, JSON.stringify(runnerLabels), hashToken(token), allowForkJobs ? 1 : 0, createdBy);

  return { id, name: runnerName, labels: runnerLabels, allowForkJobs: Boolean(allowForkJobs), token };
}

function runnerDto(row) {
  const lastSeen = row.lastSeenAt ? Date.parse(`${String(row.lastSeenAt).replace(' ', 'T')}Z`) : null;
  return {
    id: row.id,
    name: row.name,
    labels: JSON.parse(row.labelsJson),
    allowForkJobs: Boolean(row.allowForkJobs),
    createdAt: row.createdAt,
    lastSeenAt: row.lastSeenAt,
    lastSeenVersion: row.lastSeenVersion,
    online: Boolean(lastSeen && Date.now() - lastSeen < RUNNER_LIMITS.offlineAfterSeconds * 1000),
  };
}

export function listRunners(db, organizationId) {
  return db.prepare(`
    SELECT id, name, labels_json AS labelsJson, allow_fork_jobs AS allowForkJobs,
      created_at AS createdAt, last_seen_at AS lastSeenAt, last_seen_version AS lastSeenVersion
    FROM runners WHERE organization_id = ? ORDER BY name
  `).all(organizationId).map(runnerDto);
}

export function removeRunner(db, { organizationId, runnerId }) {
  const result = db.prepare('DELETE FROM runners WHERE organization_id = ? AND id = ?').run(organizationId, runnerId);
  if (!result.changes) throw httpError(404, 'Runner not found.', 'RUNNER_NOT_FOUND');
  return { id: runnerId };
}

/**
 * Resolves a runner token to the runner it belongs to.
 *
 * The organization comes from the stored row, never from the request. A runner
 * cannot name a tenancy it was not registered for.
 */
export function authorizeRunner(db, token) {
  const value = String(token ?? '');
  if (!value.startsWith(RUNNER_TOKEN_PREFIX)) throw httpError(401, 'Runner credentials are not valid.', 'RUNNER_TOKEN_INVALID');
  const runner = db.prepare(`
    SELECT id, organization_id AS organizationId, name, labels_json AS labelsJson,
      allow_fork_jobs AS allowForkJobs
    FROM runners WHERE token_hash = ?
  `).get(hashToken(value));
  if (!runner) throw httpError(401, 'Runner credentials are not valid.', 'RUNNER_TOKEN_INVALID');
  return {
    id: runner.id,
    organizationId: runner.organizationId,
    name: runner.name,
    labels: JSON.parse(runner.labelsJson),
    allowForkJobs: Boolean(runner.allowForkJobs),
  };
}

/**
 * Claims the next job for a registered runner and returns everything needed to
 * execute it.
 *
 * The labels a runner may claim for are the ones it registered with. A runner
 * asking for a label it does not hold gets nothing rather than an error, so a
 * misconfigured agent idles instead of silently picking up other work.
 */
export function claimForRunner(db, config, { runner, labels = null }) {
  const requested = labels
    ? normalizeLabels(labels).filter((label) => runner.labels.includes(label))
    : runner.labels;
  if (!requested.length) return null;

  db.prepare('UPDATE runners SET last_seen_at = CURRENT_TIMESTAMP WHERE id = ?').run(runner.id);

  const claimed = claimNextJob(db, {
    runnerId: runner.id,
    labels: requested,
    organizationId: runner.organizationId,
    allowForkJobs: runner.allowForkJobs,
  });
  if (!claimed) return null;

  const run = db.prepare(`
    SELECT r.id, r.repository_id AS repositoryId, r.workflow_path AS workflowPath, r.workflow_name AS workflowName,
      r.event, r.ref, r.commit_sha AS commitSha, r.fork,
      repo.slug AS repoSlug, org.slug AS orgSlug
    FROM workflow_runs r
    JOIN repositories repo ON repo.id = r.repository_id
    JOIN organizations org ON org.id = repo.organization_id
    WHERE r.id = ?
  `).get(claimed.runId);
  const job = listRunJobs(db, claimed.runId).find((candidate) => candidate.id === claimed.jobId);

  const fork = Boolean(run.fork);
  const secrets = fork
    ? []
    : secretsForJob(db, config, { fork, repositoryId: run.repositoryId }, { organizationId: runner.organizationId });

  return {
    job: {
      id: job.id,
      key: job.jobKey,
      name: job.name,
      steps: job.steps,
      env: job.env,
      permissions: job.permissions,
      timeoutMinutes: job.timeoutMinutes,
    },
    run: {
      id: run.id,
      workflow: run.workflowName || run.workflowPath,
      event: run.event,
      ref: run.ref,
      commitSha: run.commitSha,
      fork,
      repository: `${run.orgSlug}/${run.repoSlug}`,
      cloneUrl: `${config.baseUrl}/git/${run.orgSlug}/${run.repoSlug}.git`,
    },
    // Delivered once, at claim, and never through a route that can be replayed.
    secrets: Object.fromEntries(secrets.map((secret) => [secret.name, secret.value])),
    token: claimed.token,
    tokenExpiresAt: claimed.expiresAt,
  };
}

function sendJson(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(body);
  return true;
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw httpError(413, 'Request body is too large.', 'RUNNER_REQUEST_TOO_LARGE');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw httpError(400, 'Invalid JSON request body.', 'INVALID_JSON'); }
}

function routeMatch(pathname, pattern) {
  const parts = pattern.split('/');
  const actual = pathname.split('/');
  if (parts.length !== actual.length) return null;
  const params = {};
  for (let index = 0; index < parts.length; index += 1) {
    if (parts[index].startsWith(':')) {
      if (!actual[index]) return null;
      params[parts[index].slice(1)] = decodeURIComponent(actual[index]);
    } else if (parts[index] !== actual[index]) return null;
  }
  return params;
}

// Registering a runner decides what machine executes an organization's code, so
// it is Admin work. Membership is read directly rather than through the shared
// helper, whose repository-access path returns before the role rank is compared.
function requireOrganizationRunnerAdmin(db, userId, orgSlug) {
  const organization = db.prepare('SELECT id, slug, name FROM organizations WHERE slug = ?').get(orgSlug);
  if (!organization) throw httpError(404, 'Organization not found.', 'ORGANIZATION_NOT_FOUND');
  const membership = db.prepare('SELECT role FROM org_members WHERE organization_id = ? AND user_id = ?')
    .get(organization.id, userId);
  if (!membership || (ORG_ROLE_RANK[membership.role] ?? 0) < ORG_ROLE_RANK.admin) {
    throw httpError(403, 'Organization Admin permission is required to manage runners.', 'ORGANIZATION_ACCESS_DENIED');
  }
  return organization;
}

function bearerToken(req) {
  const header = String(req.headers.authorization || '');
  if (!header.startsWith('Bearer ')) throw httpError(401, 'Runner credentials are required.', 'RUNNER_TOKEN_REQUIRED');
  return header.slice(7).trim();
}

export function createRunnersApiHandler({ config, db }) {
  return async function runnersApi(req, res) {
    const url = new URL(req.url, config.baseUrl);
    if (!url.pathname.startsWith('/api/runners')) return false;

    const requestId = uid('req');
    res.setHeader('X-Request-Id', requestId);
    res.setHeader('Referrer-Policy', 'no-referrer');
    const method = String(req.method || 'GET').toUpperCase();

    try {
      // The agent's own route. Authenticated by the runner token, which carries
      // its organization, so there is no tenancy in the request to get wrong.
      if (url.pathname === '/api/runners/claim' && method === 'POST') {
        const runner = authorizeRunner(db, bearerToken(req));
        const body = await readJson(req);
        const claimed = claimForRunner(db, config, { runner, labels: body.labels ?? null });
        if (body.version) {
          db.prepare('UPDATE runners SET last_seen_version = ? WHERE id = ?')
            .run(String(body.version).slice(0, 40), runner.id);
        }
        // Nothing to do is a 204, not an error: an idle runner polls constantly
        // and a 4xx would make every quiet minute look like a fault.
        if (!claimed) { res.writeHead(204, { 'Cache-Control': 'no-store' }); res.end(); return true; }
        return sendJson(res, 200, claimed);
      }

      let params = routeMatch(url.pathname, '/api/runners/orgs/:org');
      if (params && method === 'GET') {
        const user = requireUser(db, req);
        const organization = requireOrganizationRunnerAdmin(db, user.id, params.org);
        return sendJson(res, 200, { organization: organization.slug, runners: listRunners(db, organization.id) });
      }
      if (params && method === 'POST') {
        if (!originAllowed(req, config.baseUrl)) throw httpError(403, 'Request origin is not allowed.', 'CSRF_BLOCKED');
        const user = requireUser(db, req);
        const organization = requireOrganizationRunnerAdmin(db, user.id, params.org);
        const body = await readJson(req);
        const runner = registerRunner(db, {
          organizationId: organization.id,
          name: body.name,
          labels: body.labels,
          allowForkJobs: body.allowForkJobs === true,
          createdBy: user.id,
        });
        audit(db, {
          userId: user.id,
          organizationId: organization.id,
          action: 'runner.registered',
          targetType: 'organization',
          targetId: organization.id,
          // The token is not audited, only the fact and the shape of the runner.
          metadata: { runnerId: runner.id, name: runner.name, labels: runner.labels, allowForkJobs: runner.allowForkJobs },
        });
        return sendJson(res, 201, { ...runner, requestId });
      }

      params = routeMatch(url.pathname, '/api/runners/orgs/:org/:runnerId');
      if (params && method === 'DELETE') {
        if (!originAllowed(req, config.baseUrl)) throw httpError(403, 'Request origin is not allowed.', 'CSRF_BLOCKED');
        const user = requireUser(db, req);
        const organization = requireOrganizationRunnerAdmin(db, user.id, params.org);
        removeRunner(db, { organizationId: organization.id, runnerId: params.runnerId });
        audit(db, {
          userId: user.id,
          organizationId: organization.id,
          action: 'runner.removed',
          targetType: 'organization',
          targetId: organization.id,
          metadata: { runnerId: params.runnerId },
        });
        res.writeHead(204, { 'Cache-Control': 'no-store' });
        res.end();
        return true;
      }

      throw httpError(404, 'Unknown runner route.', 'RUNNER_ROUTE_NOT_FOUND');
    } catch (error) {
      const status = Number(error.status) || 500;
      return sendJson(res, status, {
        error: {
          code: error.code || 'RUNNER_REQUEST_FAILED',
          message: status >= 500 ? 'Runner registration is temporarily unavailable.' : error.message,
          requestId,
        },
      });
    }
  };
}
