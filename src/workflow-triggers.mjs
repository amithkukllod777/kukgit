import { spawnSync } from 'node:child_process';
import { audit, uid } from './db.mjs';
import { httpError, originAllowed } from './security.mjs';
import { requireUser } from './auth.mjs';
import { requireRepositoryAccess } from './repository-access.mjs';
import { validateWorkflowFile } from './workflow-schema.mjs';
import { createWorkflowRun } from './workflow-runs.mjs';
import { dispatchWorkflows, readWorkflowFiles } from './workflow-dispatch.mjs';
import { repoDiskPath } from './git.mjs';
import { leaseGate, migrateJobLeases } from './job-leases.mjs';

// Same shape as the dispatcher's own helper: `--git-dir` and an argument
// vector, so a ref name out of a request never reaches a shell.
function git(gitDir, args, { allowFailure = false } = {}) {
  const result = spawnSync('git', ['--git-dir', gitDir, ...args], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 30_000 });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) {
    throw httpError(500, `git ${args[0]} failed`, 'WORKFLOW_TRIGGER_GIT_FAILED');
  }
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

export const TRIGGER_LIMITS = {
  scheduleIntervalMs: 60_000,
  maxSchedulesPerSweep: 50,
  maxInputBytes: 4096,
  maxInputs: 20,
};

export function migrateWorkflowTriggers(db) {
  migrateJobLeases(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS workflow_schedules (
      id TEXT PRIMARY KEY,
      repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
      workflow_path TEXT NOT NULL,
      cron TEXT NOT NULL,
      ref TEXT NOT NULL,
      next_due_at TEXT NOT NULL,
      last_fired_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(repository_id, workflow_path, cron)
    );
    CREATE INDEX IF NOT EXISTS idx_workflow_schedules_due ON workflow_schedules(next_due_at);
  `);

  // `event_action` records which activity type started a run. Without it an
  // `opened` run and a `closed` run for the same head commit are the same row,
  // so a `closed` dispatch could not tell whether it had already happened.
  const columns = db.prepare('PRAGMA table_info(workflow_runs)').all().map((column) => column.name);
  if (!columns.includes('event_action')) {
    db.exec('ALTER TABLE workflow_runs ADD COLUMN event_action TEXT');
  }
}

function cronField(field, min, max) {
  const allowed = new Set();
  for (const part of String(field).split(',')) {
    const [range, step] = part.split('/');
    const increment = step === undefined ? 1 : Number(step);
    let from = min;
    let to = max;
    if (range !== '*') {
      const bounds = range.split('-');
      from = Number(bounds[0]);
      to = bounds.length === 2 ? Number(bounds[1]) : from;
      // A step with a single starting value runs from there to the end of the
      // field: `5/10` in minutes means 5, 15, 25… not just 5.
      if (bounds.length === 1 && step !== undefined) to = max;
    }
    for (let value = from; value <= to; value += increment) allowed.add(value);
  }
  return allowed;
}

/**
 * The next UTC minute a cron expression matches, strictly after `after`.
 *
 * UTC, always. A schedule interpreted in a local zone changes when that zone
 * changes, so a nightly build would run twice on one day each year and not at
 * all on another — and the workflow file would give no hint why.
 *
 * Minute-by-minute rather than by arithmetic. The search is bounded to four
 * years, which is what it takes for `29 2 *` (February 29th) to come round, and
 * a few hundred thousand set lookups once per fire is not worth the arithmetic
 * this would otherwise need to get right.
 */
export function nextCronOccurrence(expression, after) {
  const [minute, hour, dayOfMonth, month, dayOfWeek] = String(expression).trim().split(/\s+/);
  const minutes = cronField(minute, 0, 59);
  const hours = cronField(hour, 0, 23);
  const daysOfMonth = cronField(dayOfMonth, 1, 31);
  const months = cronField(month, 1, 12);
  const daysOfWeek = cronField(dayOfWeek, 0, 6);

  // A restricted day-of-month and a restricted day-of-week are a union, not an
  // intersection — this is cron's rule, and reading it as an intersection makes
  // `0 0 1 * 1` mean "never" instead of "the 1st, and every Monday".
  const dayIsRestricted = dayOfMonth !== '*' && dayOfWeek !== '*';

  const candidate = new Date(after.getTime());
  candidate.setUTCSeconds(0, 0);
  candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);

  for (let step = 0; step < 4 * 366 * 24 * 60; step += 1) {
    const matchesDay = dayIsRestricted
      ? daysOfMonth.has(candidate.getUTCDate()) || daysOfWeek.has(candidate.getUTCDay())
      : daysOfMonth.has(candidate.getUTCDate()) && daysOfWeek.has(candidate.getUTCDay());
    if (
      minutes.has(candidate.getUTCMinutes())
      && hours.has(candidate.getUTCHours())
      && months.has(candidate.getUTCMonth() + 1)
      && matchesDay
    ) return candidate;
    candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);
  }
  return null;
}

function defaultBranchOf(db, repositoryId) {
  return db.prepare('SELECT default_branch AS defaultBranch FROM repositories WHERE id = ?')
    .get(repositoryId)?.defaultBranch ?? null;
}

function headSha(config, repository, branch) {
  const result = git(repoDiskPath(config, repository.orgSlug, repository.repoSlug), ['rev-parse', `refs/heads/${branch}`], { allowFailure: true });
  return result.status === 0 ? result.stdout.trim() : null;
}

/**
 * Records the schedules declared on a repository's default branch.
 *
 * **Only the default branch.** A schedule read from any ref would let anyone who
 * can push a branch — or open a pull request, once forks exist — install
 * recurring work on the instance that outlives their branch. The default branch
 * is the one a repository's maintainers control.
 *
 * A workflow that drops its `schedule:` block has its rows removed here, so
 * deleting a schedule is a normal edit to the file rather than an operator task.
 */
export function syncSchedules(db, config, { repository, sha = null, now = new Date() }) {
  const branch = defaultBranchOf(db, repository.id);
  const ref = `refs/heads/${branch}`;
  const commit = sha ?? (branch ? headSha(config, repository, branch) : null);
  if (!commit) {
    db.prepare('DELETE FROM workflow_schedules WHERE repository_id = ?').run(repository.id);
    return { schedules: [], removed: true };
  }

  const wanted = new Map();
  for (const file of readWorkflowFiles(config, repository, commit)) {
    if (file.oversized) continue;
    let workflow;
    // A file that no longer validates keeps no schedule. Its failure is already
    // reported as a failed run by the push that broke it; firing an old schedule
    // from a file nobody can read any more would be work with no definition.
    try { workflow = validateWorkflowFile(file.source, { config, path: file.path }); } catch { continue; }
    for (const cron of workflow.on?.schedule?.cron ?? []) {
      wanted.set(`${file.path}::${cron}`, { path: file.path, cron });
    }
  }

  const existing = db.prepare('SELECT id, workflow_path AS workflowPath, cron FROM workflow_schedules WHERE repository_id = ?')
    .all(repository.id);
  for (const row of existing) {
    if (!wanted.has(`${row.workflowPath}::${row.cron}`)) {
      db.prepare('DELETE FROM workflow_schedules WHERE id = ?').run(row.id);
    }
  }

  const schedules = [];
  for (const { path, cron } of wanted.values()) {
    const next = nextCronOccurrence(cron, now);
    if (!next) continue;
    db.prepare(`
      INSERT INTO workflow_schedules (id, repository_id, workflow_path, cron, ref, next_due_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(repository_id, workflow_path, cron) DO UPDATE SET ref = excluded.ref
    `).run(uid('sch'), repository.id, path, cron, ref, next.toISOString());
    schedules.push({ workflowPath: path, cron, ref, nextDueAt: next.toISOString() });
  }
  return { schedules, removed: false };
}

function repositoryFor(db, repositoryId) {
  return db.prepare(`
    SELECT r.id, r.slug AS repoSlug, o.slug AS orgSlug, r.organization_id AS organizationId, r.default_branch AS defaultBranch
    FROM repositories r JOIN organizations o ON o.id = r.organization_id
    WHERE r.id = ? AND r.deleted_at IS NULL
  `).get(repositoryId) ?? null;
}

/**
 * Starts the schedules that are due and moves each on to its next occurrence.
 *
 * **Missed ticks are not backfilled.** An instance that was down overnight owes
 * one run per schedule, not one per minute it was asleep: coming back up and
 * starting a night's worth of builds at once would take the instance down again
 * for the same reason it was down in the first place.
 *
 * The commit is resolved at fire time from the default branch, so a scheduled
 * run always builds what is on the branch now rather than whatever was there
 * when the schedule was recorded.
 */
export function dispatchDueSchedules(db, config, { now = new Date(), limit = TRIGGER_LIMITS.maxSchedulesPerSweep } = {}) {
  const due = db.prepare(`
    SELECT id, repository_id AS repositoryId, workflow_path AS workflowPath, cron, ref, last_fired_at AS lastFiredAt
    FROM workflow_schedules WHERE next_due_at <= ? ORDER BY next_due_at LIMIT ?
  `).all(now.toISOString(), limit);

  const fired = [];
  for (const schedule of due) {
    const next = nextCronOccurrence(schedule.cron, now);
    db.prepare('UPDATE workflow_schedules SET last_fired_at = ?, next_due_at = ? WHERE id = ?')
      .run(now.toISOString(), (next ?? now).toISOString(), schedule.id);

    const repository = repositoryFor(db, schedule.repositoryId);
    if (!repository) continue;
    const branch = repository.defaultBranch;
    const sha = headSha(config, repository, branch);
    if (!sha) continue;

    const event = { name: 'schedule', ref: `refs/heads/${branch}`, sha, paths: [] };
    // No actor. A scheduled run is not something a person asked for at that
    // moment, and attributing it to whoever last touched the file would put
    // their name on work they did not start.
    const result = dispatchWorkflows(db, config, { repository, event, actorId: null, only: schedule.workflowPath });
    const started = result.started;
    fired.push({
      scheduleId: schedule.id,
      workflowPath: schedule.workflowPath,
      cron: schedule.cron,
      runId: started[0]?.runId ?? null,
      nextDueAt: (next ?? now).toISOString(),
    });
  }
  return fired;
}

/**
 * Runs the schedule sweep on whichever instance holds the lease.
 *
 * The lease is what makes this safe to run everywhere. Every instance starts the
 * worker; only the one that wins the lease each tick does the work, so a
 * deployment with three instances fires each schedule once rather than three
 * times, and losing an instance does not stop schedules — the next tick is won
 * by somebody else.
 */
export function startScheduleWorker(db, config, {
  intervalMs = TRIGGER_LIMITS.scheduleIntervalMs,
  gate = leaseGate(db, 'workflow-schedule'),
} = {}) {
  const tick = () => {
    try {
      if (!gate()) return;
      dispatchDueSchedules(db, config, {});
    } catch (error) {
      console.error('KukGit schedule worker', error.message);
    }
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return () => { clearInterval(timer); gate.release?.(); };
}

function normalizeInputs(raw, declared) {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw httpError(400, 'Inputs must be a mapping of names to values.', 'WORKFLOW_INPUTS_INVALID');
  }
  const entries = Object.entries(raw);
  if (entries.length > TRIGGER_LIMITS.maxInputs) {
    throw httpError(400, `A manual run accepts at most ${TRIGGER_LIMITS.maxInputs} inputs.`, 'WORKFLOW_INPUTS_INVALID');
  }
  const inputs = {};
  for (const [name, value] of entries) {
    // Only what the workflow declared. An undeclared input reaching a job would
    // be an environment variable the file's author never wrote and never
    // reviewed, chosen by whoever pressed the button.
    if (declared && !Object.hasOwn(declared, name)) {
      throw httpError(400, `'${name}' is not an input of this workflow.`, 'WORKFLOW_INPUT_UNKNOWN');
    }
    if (value !== null && typeof value === 'object') {
      throw httpError(400, `Input '${name}' must be a string, number or boolean.`, 'WORKFLOW_INPUTS_INVALID');
    }
    const text = value === null ? '' : String(value);
    if (Buffer.byteLength(text) > TRIGGER_LIMITS.maxInputBytes) {
      throw httpError(400, `Input '${name}' is too long.`, 'WORKFLOW_INPUTS_INVALID');
    }
    inputs[name] = text;
  }
  for (const [name, spec] of Object.entries(declared ?? {})) {
    if (spec?.required === true && !(name in inputs)) {
      throw httpError(400, `Input '${name}' is required.`, 'WORKFLOW_INPUT_REQUIRED');
    }
    if (!(name in inputs) && spec?.default !== undefined && spec?.default !== null) {
      inputs[name] = String(spec.default);
    }
  }
  return inputs;
}

/**
 * Starts one workflow on demand.
 *
 * Unlike every other trigger this one names its workflow and its ref, because a
 * person is choosing both. Both are therefore checked against what actually
 * exists: the ref is resolved through Git rather than trusted as text, and the
 * workflow must be present *at that commit* and declare `manual` — a workflow
 * that never asked to be started by hand is not started by hand.
 */
export function dispatchManualRun(db, config, { repository, workflowPath, ref, inputs = {}, actorId = null }) {
  const requested = String(ref ?? '').trim() || `refs/heads/${defaultBranchOf(db, repository.id)}`;
  const fullRef = requested.startsWith('refs/') ? requested : `refs/heads/${requested}`;
  const resolved = git(repoDiskPath(config, repository.orgSlug, repository.repoSlug), ['rev-parse', fullRef], { allowFailure: true });
  if (resolved.status !== 0) throw httpError(404, `'${fullRef}' does not exist in this repository.`, 'WORKFLOW_REF_NOT_FOUND');
  const sha = resolved.stdout.trim();

  const wanted = String(workflowPath ?? '').trim();
  if (!wanted) throw httpError(400, 'A workflow path is required.', 'WORKFLOW_PATH_REQUIRED');
  const file = readWorkflowFiles(config, repository, sha).find((candidate) => candidate.path === wanted);
  if (!file || file.oversized) throw httpError(404, `'${wanted}' is not a workflow at ${sha.slice(0, 12)}.`, 'WORKFLOW_NOT_FOUND');

  const workflow = validateWorkflowFile(file.source, { config, path: file.path });
  if (!workflow.on?.manual) {
    throw httpError(400, `'${file.path}' does not declare the manual trigger, so it cannot be started by hand.`, 'WORKFLOW_MANUAL_NOT_DECLARED');
  }

  const resolvedInputs = normalizeInputs(inputs, workflow.on.manual.inputs ?? null);
  const created = createWorkflowRun(db, {
    repository,
    workflow,
    workflowPath: file.path,
    event: { name: 'manual', ref: fullRef, sha, paths: [], inputs: resolvedInputs },
    actorId,
  });
  if (!created.created) throw httpError(409, `The workflow was not started: ${created.reason}.`, 'WORKFLOW_NOT_STARTED');

  db.prepare("UPDATE workflow_runs SET event_action = 'manual' WHERE id = ?").run(created.runId);
  audit(db, {
    userId: actorId,
    organizationId: repository.organizationId,
    action: 'workflow.manual_dispatch',
    targetType: 'repository',
    targetId: repository.id,
    // Input *names* only. A value is chosen by the person pressing the button
    // and can be anything they typed, including something they should not have.
    metadata: { workflowPath: file.path, ref: fullRef, sha, inputs: Object.keys(resolvedInputs) },
  });
  return { runId: created.runId, workflowPath: file.path, ref: fullRef, sha, inputs: Object.keys(resolvedInputs) };
}

/**
 * Starts the `closed` runs a repository owes.
 *
 * Asked as a question about state — "which closed pull requests have no
 * `closed` run?" — rather than reacting to a close event. A close can happen
 * through a merge, an API call, a branch deletion or a lifecycle sweep, and a
 * dispatcher that had to enumerate those routes would miss whichever one was
 * added next.
 *
 * `event_action` is what makes this answerable: without it a `closed` run and
 * the `opened` run at the same commit are indistinguishable, and every sweep
 * would start another.
 */
export function dispatchClosedPullRequests(db, config, { repository, actorId = null }) {
  const closed = db.prepare(`
    SELECT p.id, p.number, p.base_branch AS baseBranch, p.head_branch AS headBranch, p.status
    FROM pull_requests p
    WHERE p.repository_id = ? AND p.status IN ('closed','merged')
      AND NOT EXISTS (
        SELECT 1 FROM workflow_runs r
        WHERE r.repository_id = p.repository_id AND r.event = 'pull_request'
          AND r.event_action = 'closed' AND r.ref = 'refs/heads/' || p.head_branch
      )
  `).all(repository.id);

  const results = [];
  for (const pull of closed) {
    // The head branch is usually deleted with the merge, so the commit comes
    // from the run that already built it. A `closed` run must describe the same
    // commit the pull request proposed, not the base it landed on.
    const built = db.prepare(`
      SELECT commit_sha AS sha FROM workflow_runs
      WHERE repository_id = ? AND event = 'pull_request' AND ref = ?
      ORDER BY created_at DESC, rowid DESC LIMIT 1
    `).get(repository.id, `refs/heads/${pull.headBranch}`);
    const sha = built?.sha ?? headSha(config, repository, pull.headBranch);
    if (!sha) continue;

    const event = {
      name: 'pull_request',
      action: 'closed',
      ref: `refs/heads/${pull.headBranch}`,
      sha,
      paths: [],
    };
    const dispatched = dispatchWorkflows(db, config, { repository, event, actorId, fork: false });
    for (const started of dispatched.started) {
      db.prepare("UPDATE workflow_runs SET event_action = 'closed' WHERE id = ?").run(started.runId);
    }
    results.push({ pullNumber: pull.number, status: pull.status, ...dispatched });
  }
  return results;
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
    if (size > 64 * 1024) throw httpError(413, 'Request body is too large.', 'REQUEST_TOO_LARGE');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw httpError(400, 'Invalid JSON request body.', 'INVALID_JSON'); }
}

/**
 * The manual dispatch route and the schedule listing beside it.
 *
 * Starting a workflow by hand is a **write**: it runs the repository's own code
 * with the repository's own secrets, on a runner the organization owns. Reading
 * which schedules exist is a read.
 */
export function createWorkflowTriggersApiHandler({ config, db }) {
  return async function workflowTriggersApi(req, res) {
    const url = new URL(req.url, config.baseUrl);
    const match = /^\/api\/repos\/([^/]+)\/([^/]+)\/(workflow-dispatch|workflow-schedules)$/.exec(url.pathname);
    if (!match) return false;

    const requestId = uid('req');
    res.setHeader('X-Request-Id', requestId);
    res.setHeader('Referrer-Policy', 'no-referrer');
    const method = String(req.method || 'GET').toUpperCase();
    const [, orgSlug, repoSlug, surface] = match;

    try {
      const user = requireUser(db, req);

      if (surface === 'workflow-schedules' && method === 'GET') {
        const access = requireRepositoryAccess(db, user.id, { orgSlug, repoSlug }, 'read');
        return sendJson(res, 200, {
          schedules: db.prepare(`
            SELECT workflow_path AS workflowPath, cron, ref, next_due_at AS nextDueAt, last_fired_at AS lastFiredAt
            FROM workflow_schedules WHERE repository_id = ? ORDER BY workflow_path, cron
          `).all(access.repository.id),
        });
      }

      if (surface === 'workflow-dispatch' && method === 'POST') {
        const access = requireRepositoryAccess(db, user.id, { orgSlug, repoSlug }, 'write');
        if (!originAllowed(req, config.baseUrl)) throw httpError(403, 'Request origin is not allowed.', 'CSRF_BLOCKED');
        const body = await readJson(req);
        const repository = {
          id: access.repository.id,
          orgSlug,
          repoSlug,
          organizationId: access.repository.organizationId ?? access.organization?.id ?? null,
        };
        const started = dispatchManualRun(db, config, {
          repository,
          workflowPath: body.workflow,
          ref: body.ref,
          inputs: body.inputs,
          actorId: user.id,
        });
        return sendJson(res, 201, { ...started, requestId });
      }

      throw httpError(405, 'Method not allowed for this route.', 'METHOD_NOT_ALLOWED');
    } catch (error) {
      const status = Number(error.status) || 500;
      return sendJson(res, status, {
        error: {
          code: error.code || 'WORKFLOW_TRIGGER_FAILED',
          message: status >= 500 ? 'Workflow triggers are temporarily unavailable.' : error.message,
          requestId,
        },
      });
    }
  };
}
