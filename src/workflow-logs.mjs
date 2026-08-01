import { requireUser } from './auth.mjs';
import { uid } from './db.mjs';
import { requireRepositoryAccess } from './repository-access.mjs';
import { maskSecrets, resolveSecrets } from './secrets-vault.mjs';
import { httpError, originAllowed } from './security.mjs';
import { authorizeJobToken, cancelRun, completeJob, getRun, listRunJobs } from './workflow-runs.mjs';
import { leaseGate } from './job-leases.mjs';

export const LOG_LIMITS = {
  maxBytesPerJob: 8 * 1024 * 1024,
  maxChunkBytes: 256 * 1024,
  maxChunksPerRequest: 200,
  maxLineBytes: 32 * 1024,
  defaultReadChunks: 500,
  heartbeatTimeoutSeconds: 300,
};

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const TRUNCATION_NOTICE = '\n[log truncated: this job reached the maximum log size for a single job]\n';

export function migrateWorkflowLogs(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workflow_job_logs (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL REFERENCES workflow_jobs(id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL,
      stream TEXT NOT NULL CHECK(stream IN ('stdout','stderr','system')),
      step_index INTEGER,
      content TEXT NOT NULL,
      byte_length INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(job_id, sequence)
    );
    CREATE INDEX IF NOT EXISTS idx_workflow_job_logs_tail
      ON workflow_job_logs(job_id, sequence);
  `);
  const columns = new Set(db.prepare('PRAGMA table_info(workflow_jobs)').all().map((row) => row.name));
  if (!columns.has('last_heartbeat_at')) db.exec('ALTER TABLE workflow_jobs ADD COLUMN last_heartbeat_at TEXT');
  if (!columns.has('log_bytes')) db.exec('ALTER TABLE workflow_jobs ADD COLUMN log_bytes INTEGER NOT NULL DEFAULT 0');
  if (!columns.has('log_truncated')) db.exec('ALTER TABLE workflow_jobs ADD COLUMN log_truncated INTEGER NOT NULL DEFAULT 0');
}

/**
 * Removes control characters from build output.
 *
 * Log output is untrusted: it is whatever a build printed, and a build can print
 * anything a repository's code chooses to. Terminal escape sequences can move the
 * cursor, clear the screen or rewrite what a reader already saw, which turns a
 * log viewer into a place where a failure can be made to look like a pass.
 * Carriage returns are dropped for the same reason — a progress bar that
 * overwrites its line would let later output erase earlier output.
 *
 * Colour is lost. That is the deliberate trade: a log has to be trustworthy
 * before it is pretty.
 */
export function sanitizeLogContent(text) {
  const input = String(text ?? '').replace(/\r\n?/g, '\n');
  let output = '';
  for (const character of input) {
    const code = character.codePointAt(0);
    if (character === '\n' || character === '\t') { output += character; continue; }
    // C0 controls, DEL, and the C1 range, which includes the escape introducers.
    if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) continue;
    output += character;
  }
  // A single unbroken "line" of many megabytes is a denial of service against
  // every viewer that ever renders it.
  return output.split('\n').map((line) => (
    Buffer.byteLength(line) > LOG_LIMITS.maxLineBytes
      ? `${Buffer.from(line).subarray(0, LOG_LIMITS.maxLineBytes).toString('utf8')}…[line truncated]`
      : line
  )).join('\n');
}

function jobRow(db, jobId) {
  const job = db.prepare(`
    SELECT id, run_id AS runId, status, log_bytes AS logBytes, log_truncated AS logTruncated
    FROM workflow_jobs WHERE id = ?
  `).get(jobId);
  if (!job) throw httpError(404, 'Workflow job not found.', 'WORKFLOW_JOB_NOT_FOUND');
  return job;
}

/**
 * Appends output to a job's log.
 *
 * Secrets are masked here, at ingestion, and never at read time. Masking on read
 * would mean the raw value is on disk, in every backup and in every replica; a
 * single query that forgets to mask would expose it. Masking once, before the
 * bytes are stored, means the value was never written down.
 */
export function appendJobLog(db, config, { jobId, chunks, organizationId = null, repositoryId = null }) {
  const job = jobRow(db, jobId);
  if (!Array.isArray(chunks) || !chunks.length) throw httpError(400, 'At least one log chunk is required.', 'LOG_CHUNKS_REQUIRED');
  if (chunks.length > LOG_LIMITS.maxChunksPerRequest) {
    throw httpError(413, `At most ${LOG_LIMITS.maxChunksPerRequest} chunks may be sent at once.`, 'LOG_CHUNKS_TOO_MANY');
  }

  let secretValues = [];
  if (organizationId) {
    try {
      secretValues = resolveSecrets(db, config, { organizationId, repositoryId }).map((secret) => secret.value);
    } catch {
      // A vault that cannot be read must not stop a build's output being
      // recorded; it only means there is nothing to mask.
      secretValues = [];
    }
  }

  const next = db.prepare('SELECT COALESCE(MAX(sequence), 0) AS last FROM workflow_job_logs WHERE job_id = ?').get(jobId).last;
  const insert = db.prepare(`
    INSERT INTO workflow_job_logs (id, job_id, sequence, stream, step_index, content, byte_length)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  let sequence = next;
  let written = 0;
  let truncated = Boolean(job.logTruncated);
  let total = Number(job.logBytes || 0);

  // Every chunk is validated and normalized before anything is written, so a
  // malformed request is rejected on its own terms rather than depending on how
  // much of the log has already been stored.
  const prepared = chunks.map((chunk) => {
    const raw = String(chunk?.content ?? '');
    if (Buffer.byteLength(raw) > LOG_LIMITS.maxChunkBytes) {
      throw httpError(413, 'A single log chunk is too large.', 'LOG_CHUNK_TOO_LARGE');
    }
    return {
      stream: ['stdout', 'stderr', 'system'].includes(chunk?.stream) ? chunk.stream : 'stdout',
      stepIndex: Number.isInteger(chunk?.stepIndex) ? chunk.stepIndex : null,
      content: maskSecrets(sanitizeLogContent(raw), secretValues),
    };
  });

  const append = db.transaction(() => {
    for (const { stream, stepIndex, content } of prepared) {
      if (truncated) break;
      if (!content) continue;

      const bytes = Buffer.byteLength(content);
      if (total + bytes > LOG_LIMITS.maxBytesPerJob) {
        sequence += 1;
        insert.run(uid('log'), jobId, sequence, 'system', null, TRUNCATION_NOTICE, Buffer.byteLength(TRUNCATION_NOTICE));
        truncated = true;
        break;
      }
      sequence += 1;
      insert.run(uid('log'), jobId, sequence, stream, stepIndex, content, bytes);
      total += bytes;
      written += 1;
    }
    db.prepare('UPDATE workflow_jobs SET log_bytes = ?, log_truncated = ?, last_heartbeat_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(total, truncated ? 1 : 0, jobId);
  });
  append();

  return { accepted: written, sequence, truncated, totalBytes: total };
}

/**
 * Reads a page of a job's log.
 *
 * `after` is the last sequence the caller already has, so a viewer tails by
 * repeating the call with the cursor it was given. Cursor paging rather than a
 * pushed stream: a log has to be readable after the run finished and from an
 * instance other than the one that recorded it, and a cursor works in both cases
 * where a socket does not.
 */
export function readJobLog(db, { jobId, after = 0, limit = LOG_LIMITS.defaultReadChunks }) {
  const job = jobRow(db, jobId);
  const bounded = Math.max(1, Math.min(Number(limit) || LOG_LIMITS.defaultReadChunks, LOG_LIMITS.defaultReadChunks));
  const chunks = db.prepare(`
    SELECT sequence, stream, step_index AS stepIndex, content, created_at AS createdAt
    FROM workflow_job_logs WHERE job_id = ? AND sequence > ?
    ORDER BY sequence LIMIT ?
  `).all(jobId, Number(after) || 0, bounded);

  const cursor = chunks.length ? chunks.at(-1).sequence : Number(after) || 0;
  const more = Boolean(db.prepare('SELECT 1 AS found FROM workflow_job_logs WHERE job_id = ? AND sequence > ? LIMIT 1')
    .get(jobId, cursor));
  return {
    jobId,
    status: job.status,
    chunks,
    cursor,
    more,
    truncated: Boolean(job.logTruncated),
    // A finished job with no more chunks will never produce another one, which is
    // how a viewer knows to stop polling rather than guessing from a timeout.
    complete: !more && ['success', 'failure', 'cancelled', 'skipped'].includes(job.status),
  };
}

/**
 * Records that a runner is still working, and tells it whether to stop.
 *
 * Cancellation is delivered as the answer to a heartbeat rather than pushed. A
 * runner that has lost its connection cannot be pushed to; one that is still
 * talking asks on every beat, so the worst case is one heartbeat interval of
 * wasted work rather than a job that never learns it was cancelled.
 */
export function jobHeartbeat(db, jobId) {
  const job = db.prepare(`
    SELECT j.id, j.status, j.run_id AS runId, r.status AS runStatus
    FROM workflow_jobs j JOIN workflow_runs r ON r.id = j.run_id WHERE j.id = ?
  `).get(jobId);
  if (!job) throw httpError(404, 'Workflow job not found.', 'WORKFLOW_JOB_NOT_FOUND');
  db.prepare('UPDATE workflow_jobs SET last_heartbeat_at = CURRENT_TIMESTAMP WHERE id = ?').run(jobId);
  const cancelled = job.status === 'cancelled' || job.runStatus === 'cancelled';
  return { jobId, status: job.status, cancelled, heartbeatIntervalSeconds: Math.floor(LOG_LIMITS.heartbeatTimeoutSeconds / 5) };
}

/**
 * Fails jobs whose runner stopped reporting.
 *
 * Without this a crashed runner leaves a job `running` forever, holding its
 * dependants in `pending` and a run in flight against the repository's limit.
 */
export function reapStalledJobs(db, { timeoutSeconds = LOG_LIMITS.heartbeatTimeoutSeconds } = {}) {
  const stalled = db.prepare(`
    SELECT id FROM workflow_jobs
    WHERE status = 'running'
      AND COALESCE(last_heartbeat_at, started_at) IS NOT NULL
      AND (julianday('now') - julianday(COALESCE(last_heartbeat_at, started_at))) * 86400 > ?
  `).all(timeoutSeconds);
  for (const job of stalled) {
    completeJob(db, job.id, { status: 'failure', reason: `runner stopped reporting for more than ${timeoutSeconds} seconds` });
  }
  return { reaped: stalled.length };
}

/**
 * Periodically fails jobs whose runner went away.
 *
 * The interval is long relative to the heartbeat timeout: reaping is a
 * correctness backstop, not a latency-sensitive path, and checking every second
 * would only add load to the same instance the runners are reporting to.
 */
export function startStalledJobWorker(db, {
  intervalMs = 60_000,
  timeoutSeconds = LOG_LIMITS.heartbeatTimeoutSeconds,
  gate = leaseGate(db, 'stalled-jobs'),
} = {}) {
  const tick = () => {
    try {
      // Reaping twice is harmless, but the reap writes a job outcome and a log
      // line, so two instances would write the same explanation twice into the
      // log a person is reading.
      if (!gate()) return;
      reapStalledJobs(db, { timeoutSeconds });
    } catch (error) {
      console.error('KukGit stalled job worker', error);
    }
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return () => { clearInterval(timer); gate.release?.(); };
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
    if (size > MAX_BODY_BYTES) throw httpError(413, 'Request body is too large.', 'LOG_REQUEST_TOO_LARGE');
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

function bearerToken(req) {
  const header = String(req.headers.authorization || '');
  if (!header.startsWith('Bearer ')) throw httpError(401, 'A job credential is required.', 'JOB_TOKEN_REQUIRED');
  return header.slice(7).trim();
}

function repositoryOrganizationId(db, repositoryId) {
  return db.prepare('SELECT organization_id AS organizationId FROM repositories WHERE id = ?')
    .get(repositoryId)?.organizationId ?? null;
}

export function createWorkflowLogsApiHandler({ config, db }) {
  // A run is addressed through its repository, and the run must actually belong
  // to that repository — otherwise a caller with access to one repository could
  // read another's logs by naming its own path with a foreign run id.
  function authorizeRunAccess(req, params, permission) {
    const user = requireUser(db, req);
    const access = requireRepositoryAccess(db, user.id, { orgSlug: params.org, repoSlug: params.repo }, permission);
    const run = getRun(db, params.runId);
    if (run.repositoryId !== access.repository.id) {
      throw httpError(404, 'Workflow run not found.', 'WORKFLOW_RUN_NOT_FOUND');
    }
    return { user, access, run };
  }

  return async function workflowLogsApi(req, res) {
    const url = new URL(req.url, config.baseUrl);
    if (!url.pathname.startsWith('/api/workflow-runs/') && !url.pathname.startsWith('/api/workflow-jobs/')) return false;

    const requestId = uid('req');
    res.setHeader('X-Request-Id', requestId);
    res.setHeader('Referrer-Policy', 'no-referrer');
    const method = String(req.method || 'GET').toUpperCase();

    try {
      // Runner-authenticated routes. A job token is the only credential accepted
      // here, and it identifies exactly one job — a runner cannot name another.
      let params = routeMatch(url.pathname, '/api/workflow-jobs/self/logs');
      if (params && method === 'POST') {
        const context = authorizeJobToken(db, bearerToken(req));
        const body = await readJson(req);
        const result = appendJobLog(db, config, {
          jobId: context.jobId,
          chunks: body.chunks,
          organizationId: repositoryOrganizationId(db, context.repositoryId),
          repositoryId: context.repositoryId,
        });
        return sendJson(res, 202, { ...result, requestId });
      }

      params = routeMatch(url.pathname, '/api/workflow-jobs/self/heartbeat');
      if (params && method === 'POST') {
        const context = authorizeJobToken(db, bearerToken(req));
        return sendJson(res, 200, jobHeartbeat(db, context.jobId));
      }

      params = routeMatch(url.pathname, '/api/workflow-jobs/self/complete');
      if (params && method === 'POST') {
        const context = authorizeJobToken(db, bearerToken(req));
        const body = await readJson(req);
        const run = completeJob(db, context.jobId, { status: body.status, reason: body.reason ?? null });
        return sendJson(res, 200, { jobId: context.jobId, runStatus: run.status });
      }

      // Reader routes. Reading a build log means reading whatever the build
      // printed about the repository, so it needs repository read permission.
      params = routeMatch(url.pathname, '/api/workflow-runs/:org/:repo/:runId');
      if (params && method === 'GET') {
        const { run } = authorizeRunAccess(req, params, 'read');
        return sendJson(res, 200, { run, jobs: listRunJobs(db, run.id) });
      }

      params = routeMatch(url.pathname, '/api/workflow-runs/:org/:repo/:runId/cancel');
      if (params && method === 'POST') {
        // Cancelling stops work on the repository, which is a write.
        const { run, user } = authorizeRunAccess(req, params, 'write');
        if (!originAllowed(req, config.baseUrl)) throw httpError(403, 'Request origin is not allowed.', 'CSRF_BLOCKED');
        const cancelled = cancelRun(db, run.id, `cancelled by ${user.email}`);
        return sendJson(res, 200, { run: cancelled });
      }

      params = routeMatch(url.pathname, '/api/workflow-runs/:org/:repo/:runId/jobs/:jobId/logs');
      if (params && method === 'GET') {
        const { run } = authorizeRunAccess(req, params, 'read');
        const job = listRunJobs(db, run.id).find((candidate) => candidate.id === params.jobId);
        if (!job) throw httpError(404, 'Workflow job not found.', 'WORKFLOW_JOB_NOT_FOUND');
        return sendJson(res, 200, readJobLog(db, {
          jobId: job.id,
          after: Number(url.searchParams.get('after') || 0),
          limit: Number(url.searchParams.get('limit') || LOG_LIMITS.defaultReadChunks),
        }));
      }

      throw httpError(404, 'Unknown workflow route.', 'WORKFLOW_ROUTE_NOT_FOUND');
    } catch (error) {
      const status = Number(error.status) || 500;
      return sendJson(res, status, {
        error: {
          code: error.code || 'WORKFLOW_REQUEST_FAILED',
          message: status >= 500 ? 'Workflow data is temporarily unavailable.' : error.message,
          requestId,
        },
      });
    }
  };
}
