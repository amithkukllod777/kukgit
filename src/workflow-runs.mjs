import { audit, uid } from './db.mjs';
import { hashToken, httpError, randomToken } from './security.mjs';
import { resolveSecrets } from './secrets-vault.mjs';

// Notified whenever a run's state changes, so a commit status can follow it.
// A callback rather than a direct import: the scheduler should not depend on
// how a run is reported, and a reporting failure must not be able to break
// scheduling.
let runObserver = null;

export function observeRunChanges(callback) {
  runObserver = typeof callback === 'function' ? callback : null;
}

function notifyRunChanged(runId) {
  if (!runObserver) return;
  try { runObserver(runId); }
  catch (error) { console.error('KukGit run observer', error.message); }
}

export const RUN_STATES = new Set(['queued', 'running', 'success', 'failure', 'cancelled']);
export const JOB_STATES = new Set(['pending', 'queued', 'running', 'success', 'failure', 'cancelled', 'skipped']);

export const RUN_LIMITS = {
  jobTokenTtlSeconds: 3600,
  maxQueuedRunsPerRepository: 50,
};

// Permissions a job token may ever carry, and the ceiling for each event.
//
// A workflow asks for what it needs with `permissions:`; the token receives the
// intersection of that request and the ceiling below. A workflow can therefore
// only ever narrow what it gets, never widen it.
const PERMISSION_RANK = { none: 0, read: 1, write: 2 };
const ALL_SCOPES = ['contents', 'pull-requests', 'issues', 'statuses', 'packages', 'actions'];

function ceilingFor(event, { fork }) {
  // A pull request from a fork runs code written by someone who has no write
  // access to this repository. Giving that code a writable token — or any
  // secret — is the "pwn request" class of vulnerability, and it is the single
  // most exploited weakness in hosted CI. Read-only, always.
  if (fork) return Object.fromEntries(ALL_SCOPES.map((scope) => [scope, 'read']));
  if (event === 'pull_request') {
    return Object.fromEntries(ALL_SCOPES.map((scope) => [scope, scope === 'contents' ? 'read' : 'write']));
  }
  return Object.fromEntries(ALL_SCOPES.map((scope) => [scope, 'write']));
}

export function resolveJobPermissions(requested, { event, fork }) {
  const ceiling = ceilingFor(event, { fork });
  // With nothing requested a job gets the ceiling for reads only. Defaulting to
  // the full ceiling would make every workflow maximally privileged by omission.
  const base = requested ?? Object.fromEntries(ALL_SCOPES.map((scope) => [scope, 'read']));
  const resolved = {};
  for (const scope of ALL_SCOPES) {
    const asked = base[scope] ?? 'none';
    const allowed = ceiling[scope] ?? 'none';
    resolved[scope] = PERMISSION_RANK[asked] <= PERMISSION_RANK[allowed] ? asked : allowed;
  }
  return resolved;
}

export function migrateWorkflowRuns(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workflow_runs (
      id TEXT PRIMARY KEY,
      repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
      workflow_path TEXT NOT NULL,
      workflow_name TEXT,
      event TEXT NOT NULL,
      ref TEXT NOT NULL,
      commit_sha TEXT NOT NULL,
      actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      fork INTEGER NOT NULL DEFAULT 0,
      concurrency_group TEXT,
      status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','success','failure','cancelled')),
      conclusion_reason TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      started_at TEXT,
      completed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS workflow_jobs (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
      job_key TEXT NOT NULL,
      name TEXT NOT NULL,
      runs_on TEXT NOT NULL,
      needs_json TEXT NOT NULL DEFAULT '[]',
      steps_json TEXT NOT NULL DEFAULT '[]',
      env_json TEXT NOT NULL DEFAULT '{}',
      permissions_json TEXT NOT NULL DEFAULT '{}',
      timeout_minutes INTEGER NOT NULL DEFAULT 60,
      position INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','queued','running','success','failure','cancelled','skipped')),
      conclusion_reason TEXT,
      runner_id TEXT,
      token_hash TEXT,
      token_expires_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      started_at TEXT,
      completed_at TEXT,
      UNIQUE(run_id, job_key)
    );
    CREATE INDEX IF NOT EXISTS idx_workflow_runs_repository
      ON workflow_runs(repository_id, status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_workflow_runs_concurrency
      ON workflow_runs(repository_id, concurrency_group, status);
    CREATE INDEX IF NOT EXISTS idx_workflow_jobs_queue
      ON workflow_jobs(status, runs_on, created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_jobs_token
      ON workflow_jobs(token_hash) WHERE token_hash IS NOT NULL;
  `);
}

// Glob matching for branch, tag and path filters. Deliberately not a regular
// expression: a filter written by a repository is untrusted input, and compiling
// it into a regex invites catastrophic backtracking on the scheduler's thread.
export function matchesPattern(pattern, value) {
  const text = String(value ?? '');
  let patternIndex = 0;
  let textIndex = 0;
  let starPattern = -1;
  let starText = 0;

  while (textIndex < text.length) {
    const patternChar = pattern[patternIndex];
    if (patternChar === '?' || (patternChar !== undefined && patternChar === text[textIndex])) {
      patternIndex += 1;
      textIndex += 1;
    } else if (patternChar === '*') {
      starPattern = patternIndex;
      starText = textIndex;
      patternIndex += 1;
    } else if (starPattern >= 0) {
      patternIndex = starPattern + 1;
      starText += 1;
      textIndex = starText;
    } else {
      return false;
    }
  }
  while (pattern[patternIndex] === '*') patternIndex += 1;
  return patternIndex === pattern.length;
}

function matchesAny(patterns, value) {
  return patterns.some((pattern) => matchesPattern(pattern, value));
}

function refName(ref) {
  return String(ref ?? '').replace(/^refs\/(heads|tags)\//, '');
}

/**
 * Decides whether an event triggers a workflow.
 *
 * Ignore filters win over include filters: an explicit exclusion is the stronger
 * statement, and a rule that could be overridden by an inclusion would not be an
 * exclusion at all.
 */
export function workflowMatchesEvent(workflow, event) {
  const filters = workflow.on?.[event.name];
  if (!filters) return { matched: false, reason: 'event not declared' };

  const name = refName(event.ref);

  if (event.name === 'push' || event.name === 'pull_request') {
    if (filters['branches-ignore']?.length && matchesAny(filters['branches-ignore'], name)) {
      return { matched: false, reason: 'branch excluded by branches-ignore' };
    }
    if (filters.branches?.length && !matchesAny(filters.branches, name)) {
      return { matched: false, reason: 'branch does not match branches' };
    }
  }
  if (event.name === 'tag') {
    if (filters['tags-ignore']?.length && matchesAny(filters['tags-ignore'], name)) {
      return { matched: false, reason: 'tag excluded by tags-ignore' };
    }
    if (filters.tags?.length && !matchesAny(filters.tags, name)) {
      return { matched: false, reason: 'tag does not match tags' };
    }
  }
  if (event.name === 'pull_request' && filters.types?.length) {
    if (!filters.types.includes(event.action)) return { matched: false, reason: 'activity type not requested' };
  }

  const paths = Array.isArray(event.paths) ? event.paths : [];
  if (filters['paths-ignore']?.length && paths.length) {
    if (paths.every((changed) => matchesAny(filters['paths-ignore'], changed))) {
      return { matched: false, reason: 'every changed path is excluded by paths-ignore' };
    }
  }
  if (filters.paths?.length) {
    // With no path information the filter cannot be evaluated, and skipping a
    // run because of missing metadata would silently drop builds.
    if (paths.length && !paths.some((changed) => matchesAny(filters.paths, changed))) {
      return { matched: false, reason: 'no changed path matches paths' };
    }
  }
  return { matched: true, reason: null };
}

function interpolateConcurrencyGroup(group, event) {
  return String(group).replace(/\$\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (whole, reference) => {
    if (reference === 'github.ref') return String(event.ref ?? '');
    if (reference === 'github.ref_name') return refName(event.ref);
    if (reference === 'github.sha') return String(event.sha ?? '');
    if (reference === 'github.event_name') return String(event.name ?? '');
    if (reference === 'github.workflow') return String(event.workflow ?? '');
    // An unresolved reference becomes a literal rather than an empty string, so
    // two different groups cannot silently collapse into one and cancel each
    // other's runs.
    return whole;
  });
}

/**
 * Creates a run and its jobs from a validated workflow and an event.
 *
 * Jobs with no dependencies are queued immediately; the rest wait in `pending`
 * until their dependencies succeed.
 */
export function createWorkflowRun(db, {
  repository, workflow, workflowPath, event, actorId = null, fork = false,
}) {
  const match = workflowMatchesEvent(workflow, event);
  if (!match.matched) return { created: false, reason: match.reason };

  const queued = db.prepare("SELECT COUNT(*) AS count FROM workflow_runs WHERE repository_id = ? AND status IN ('queued','running')")
    .get(repository.id).count;
  if (queued >= RUN_LIMITS.maxQueuedRunsPerRepository) {
    throw httpError(429, 'This repository already has the maximum number of runs in flight.', 'WORKFLOW_RUN_LIMIT_REACHED');
  }

  const group = workflow.concurrency?.group
    ? interpolateConcurrencyGroup(workflow.concurrency.group, { ...event, workflow: workflow.name ?? workflowPath })
    : null;

  const runId = uid('run');
  const cancelled = [];

  const insert = db.transaction(() => {
    if (group && workflow.concurrency?.cancelInProgress) {
      const superseded = db.prepare(`
        SELECT id FROM workflow_runs
        WHERE repository_id = ? AND concurrency_group = ? AND status IN ('queued','running')
      `).all(repository.id, group);
      for (const run of superseded) {
        cancelRun(db, run.id, 'superseded by a newer run in the same concurrency group');
        cancelled.push(run.id);
      }
    }

    db.prepare(`
      INSERT INTO workflow_runs
        (id, repository_id, workflow_path, workflow_name, event, ref, commit_sha, actor_id, fork, concurrency_group)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(runId, repository.id, workflowPath, workflow.name ?? null, event.name, event.ref, event.sha, actorId, fork ? 1 : 0, group);

    const statement = db.prepare(`
      INSERT INTO workflow_jobs
        (id, run_id, job_key, name, runs_on, needs_json, steps_json, env_json,
         permissions_json, timeout_minutes, position, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    workflow.jobOrder.forEach((jobKey, position) => {
      const job = workflow.jobs.find((candidate) => candidate.id === jobKey);
      const permissions = resolveJobPermissions(job.permissions ?? workflow.permissions, { event: event.name, fork });
      statement.run(
        uid('job'), runId, job.id, job.name, job.runsOn,
        JSON.stringify(job.needs), JSON.stringify(job.steps),
        // Workflow-level env is merged in here so a runner receives one map and
        // does not have to know the precedence rule.
        JSON.stringify({ ...workflow.env, ...job.env }),
        JSON.stringify(permissions), job.timeoutMinutes, position,
        job.needs.length ? 'pending' : 'queued',
      );
    });
  });
  insert();

  for (const superseded of cancelled) notifyRunChanged(superseded);
  notifyRunChanged(runId);
  return { created: true, runId, concurrencyGroup: group, cancelledRuns: cancelled };
}

export function getRun(db, runId) {
  const run = db.prepare(`
    SELECT id, repository_id AS repositoryId, workflow_path AS workflowPath, workflow_name AS workflowName,
      event, ref, commit_sha AS commitSha, actor_id AS actorId, fork, concurrency_group AS concurrencyGroup,
      status, conclusion_reason AS conclusionReason, created_at AS createdAt, started_at AS startedAt,
      completed_at AS completedAt
    FROM workflow_runs WHERE id = ?
  `).get(runId);
  if (!run) throw httpError(404, 'Workflow run not found.', 'WORKFLOW_RUN_NOT_FOUND');
  return { ...run, fork: Boolean(run.fork) };
}

export function listRunJobs(db, runId) {
  return db.prepare(`
    SELECT id, job_key AS jobKey, name, runs_on AS runsOn, needs_json AS needsJson,
      steps_json AS stepsJson, env_json AS envJson,
      permissions_json AS permissionsJson, timeout_minutes AS timeoutMinutes, position, status,
      conclusion_reason AS conclusionReason, runner_id AS runnerId, token_expires_at AS tokenExpiresAt,
      started_at AS startedAt, completed_at AS completedAt
    FROM workflow_jobs WHERE run_id = ? ORDER BY position
  `).all(runId).map((job) => ({
    ...job,
    needs: JSON.parse(job.needsJson),
    steps: JSON.parse(job.stepsJson || '[]'),
    env: JSON.parse(job.envJson || '{}'),
    permissions: JSON.parse(job.permissionsJson),
    needsJson: undefined,
    stepsJson: undefined,
    envJson: undefined,
    permissionsJson: undefined,
  }));
}

const TERMINAL_JOB_STATES = new Set(['success', 'failure', 'cancelled', 'skipped']);

// Recomputes what should happen next after a job reaches a terminal state.
//
// A job whose dependency did not succeed is `skipped`, not `failure`: it never
// ran, and reporting it as failed would put a defect where there was only an
// unmet precondition.
function advanceRun(db, runId) {
  const jobs = listRunJobs(db, runId);
  const byKey = new Map(jobs.map((job) => [job.jobKey, job]));
  const setStatus = db.prepare('UPDATE workflow_jobs SET status = ?, conclusion_reason = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?');
  const queue = db.prepare("UPDATE workflow_jobs SET status = 'queued' WHERE id = ?");

  let changed = true;
  while (changed) {
    changed = false;
    for (const job of jobs) {
      if (job.status !== 'pending') continue;
      const dependencies = job.needs.map((key) => byKey.get(key)).filter(Boolean);
      if (dependencies.some((dependency) => !TERMINAL_JOB_STATES.has(dependency.status))) continue;
      const blocked = dependencies.find((dependency) => dependency.status !== 'success');
      if (blocked) {
        setStatus.run('skipped', `dependency '${blocked.jobKey}' did not succeed`, job.id);
        job.status = 'skipped';
      } else {
        queue.run(job.id);
        job.status = 'queued';
      }
      changed = true;
    }
  }

  const current = listRunJobs(db, runId);
  if (current.some((job) => !TERMINAL_JOB_STATES.has(job.status))) {
    db.prepare("UPDATE workflow_runs SET status = 'running', started_at = COALESCE(started_at, CURRENT_TIMESTAMP) WHERE id = ? AND status = 'queued'")
      .run(runId);
    return;
  }
  const failed = current.some((job) => job.status === 'failure');
  const cancelled = current.some((job) => job.status === 'cancelled');
  const status = failed ? 'failure' : cancelled ? 'cancelled' : 'success';
  db.prepare(`
    UPDATE workflow_runs SET status = ?, completed_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status IN ('queued','running')
  `).run(status, runId);
}

/**
 * Hands the next runnable job to a runner, together with a short-lived token.
 *
 * The token is returned once and stored only as a hash, so a leaked database
 * cannot be used to impersonate a job.
 */
export function claimNextJob(db, { runnerId, labels, organizationId, allowForkJobs = false }) {
  if (!runnerId) throw httpError(400, 'A runner identifier is required.', 'RUNNER_ID_REQUIRED');
  const available = Array.isArray(labels) ? labels : [labels];
  if (!available.length) throw httpError(400, 'A runner must declare at least one label.', 'RUNNER_LABELS_REQUIRED');
  // Tenancy is a required argument rather than an option. A claim that could be
  // made without naming an organization is a claim that can cross one.
  if (!organizationId) throw httpError(400, 'A claim must name the organization it is for.', 'RUNNER_ORGANIZATION_REQUIRED');

  const placeholders = available.map(() => '?').join(', ');
  const claim = db.transaction(() => {
    const job = db.prepare(`
      SELECT j.id, j.run_id AS runId FROM workflow_jobs j
      JOIN workflow_runs r ON r.id = j.run_id
      JOIN repositories repo ON repo.id = r.repository_id
      WHERE j.status = 'queued' AND j.runs_on IN (${placeholders})
        AND repo.organization_id = ?
        AND (r.fork = 0 OR ? = 1)
      ORDER BY j.created_at, j.position LIMIT 1
    `).get(...available, organizationId, allowForkJobs ? 1 : 0);
    if (!job) return null;

    const token = randomToken(32);
    const expiresAt = new Date(Date.now() + RUN_LIMITS.jobTokenTtlSeconds * 1000).toISOString();
    const updated = db.prepare(`
      UPDATE workflow_jobs
      SET status = 'running', runner_id = ?, token_hash = ?, token_expires_at = ?, started_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'queued'
    `).run(runnerId, hashToken(token), expiresAt, job.id);
    // Another runner won the row between the select and the update.
    if (!updated.changes) return null;
    return { jobId: job.id, runId: job.runId, token, expiresAt };
  });

  const claimed = claim();
  if (!claimed) return null;

  db.prepare("UPDATE workflow_runs SET status = 'running', started_at = COALESCE(started_at, CURRENT_TIMESTAMP) WHERE id = ? AND status = 'queued'")
    .run(claimed.runId);
  notifyRunChanged(claimed.runId);
  return claimed;
}

/**
 * Resolves a job token to the job it belongs to.
 *
 * Expiry is enforced here rather than by a sweep, so a token that outlived its
 * window is refused even if nothing has cleaned it up yet.
 */
export function authorizeJobToken(db, token) {
  const job = db.prepare(`
    SELECT j.id, j.run_id AS runId, j.job_key AS jobKey, j.status, j.permissions_json AS permissionsJson,
      j.token_expires_at AS tokenExpiresAt, r.repository_id AS repositoryId, r.fork, r.commit_sha AS commitSha,
      r.event, r.ref
    FROM workflow_jobs j JOIN workflow_runs r ON r.id = j.run_id
    WHERE j.token_hash = ?
  `).get(hashToken(String(token ?? '')));
  if (!job) throw httpError(401, 'Job credentials are not valid.', 'JOB_TOKEN_INVALID');
  if (job.status !== 'running') throw httpError(401, 'This job is no longer running.', 'JOB_TOKEN_INACTIVE');
  if (Date.parse(job.tokenExpiresAt) <= Date.now()) throw httpError(401, 'Job credentials have expired.', 'JOB_TOKEN_EXPIRED');
  return {
    jobId: job.id,
    runId: job.runId,
    jobKey: job.jobKey,
    repositoryId: job.repositoryId,
    fork: Boolean(job.fork),
    event: job.event,
    ref: job.ref,
    commitSha: job.commitSha,
    permissions: JSON.parse(job.permissionsJson),
  };
}

export function jobPermissionAtLeast(permissions, scope, required) {
  return PERMISSION_RANK[permissions?.[scope] ?? 'none'] >= PERMISSION_RANK[required];
}

/**
 * Resolves the secrets a job may use.
 *
 * A fork pull request receives none. Its code was written by someone with no
 * write access to this repository, so handing it the repository's credentials
 * would make every secret readable by anyone who can open a pull request.
 */
export function secretsForJob(db, config, jobContext, { organizationId, names = null }) {
  if (jobContext.fork) return [];
  return resolveSecrets(db, config, { organizationId, repositoryId: jobContext.repositoryId, names });
}

export function completeJob(db, jobId, { status, reason = null }) {
  if (!['success', 'failure', 'cancelled'].includes(status)) {
    throw httpError(400, 'A job may only complete as success, failure or cancelled.', 'JOB_STATUS_INVALID');
  }
  const job = db.prepare('SELECT id, run_id AS runId, status FROM workflow_jobs WHERE id = ?').get(jobId);
  if (!job) throw httpError(404, 'Workflow job not found.', 'WORKFLOW_JOB_NOT_FOUND');
  if (TERMINAL_JOB_STATES.has(job.status)) {
    throw httpError(409, 'This job has already finished.', 'WORKFLOW_JOB_ALREADY_COMPLETE');
  }
  db.prepare(`
    UPDATE workflow_jobs
    SET status = ?, conclusion_reason = ?, completed_at = CURRENT_TIMESTAMP,
        token_hash = NULL, token_expires_at = NULL
    WHERE id = ?
  `).run(status, reason, jobId);
  advanceRun(db, job.runId);
  notifyRunChanged(job.runId);
  return getRun(db, job.runId);
}

/**
 * Cancels a run and everything in it that has not already finished.
 *
 * The token of every running job is destroyed in the same statement, so a runner
 * that has not noticed the cancellation cannot keep acting on the repository.
 */
export function cancelRun(db, runId, reason = 'cancelled') {
  const run = db.prepare("SELECT id, status FROM workflow_runs WHERE id = ?").get(runId);
  if (!run) throw httpError(404, 'Workflow run not found.', 'WORKFLOW_RUN_NOT_FOUND');
  if (!['queued', 'running'].includes(run.status)) {
    throw httpError(409, 'This run has already finished.', 'WORKFLOW_RUN_ALREADY_COMPLETE');
  }
  db.prepare(`
    UPDATE workflow_jobs
    SET status = 'cancelled', conclusion_reason = ?, completed_at = CURRENT_TIMESTAMP,
        token_hash = NULL, token_expires_at = NULL
    WHERE run_id = ? AND status IN ('pending','queued','running')
  `).run(reason, runId);
  db.prepare("UPDATE workflow_runs SET status = 'cancelled', conclusion_reason = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?")
    .run(reason, runId);
  notifyRunChanged(runId);
  return getRun(db, runId);
}

export function recordRunAudit(db, { run, actorId, action }) {
  audit(db, {
    userId: actorId,
    action,
    targetType: 'repository',
    targetId: run.repositoryId,
    metadata: { runId: run.id, workflow: run.workflowPath, event: run.event, ref: run.ref },
  });
}
