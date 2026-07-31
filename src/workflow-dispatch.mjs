import { spawnSync } from 'node:child_process';
import { currentUser } from './auth.mjs';
import { audit, uid } from './db.mjs';
import { repoDiskPath } from './git.mjs';
import { httpError } from './security.mjs';
import { validateWorkflowFile } from './workflow-schema.mjs';
import { appendJobLog } from './workflow-logs.mjs';
import { cancelRun, createWorkflowRun, listRunJobs } from './workflow-runs.mjs';

export const WORKFLOW_DIRECTORY = '.kukgit/workflows';

export const DISPATCH_LIMITS = {
  maxFilesPerRepository: 25,
  maxFileBytes: 128 * 1024,
  maxChangedPaths: 500,
};

function git(gitDir, args, { allowFailure = false, maxBuffer = 4 * 1024 * 1024 } = {}) {
  const result = spawnSync('git', ['--git-dir', gitDir, ...args], { encoding: 'utf8', maxBuffer, timeout: 30_000 });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) {
    throw httpError(500, `git ${args[0]} failed`, 'WORKFLOW_DISPATCH_GIT_FAILED');
  }
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/**
 * Records every branch and tag, so a push can be described by what actually
 * changed.
 *
 * Comparing a before and after snapshot rather than parsing the receive-pack
 * protocol: the snapshot is exact for every path that can update a ref — a Git
 * push, a browser commit, a branch created through the API — and none of them
 * have to agree on a format for it to work.
 */
export function refSnapshot(config, { orgSlug, repoSlug }) {
  const gitDir = repoDiskPath(config, orgSlug, repoSlug);
  const result = git(gitDir, ['for-each-ref', '--format=%(refname)%09%(objectname)', 'refs/heads/', 'refs/tags/'], { allowFailure: true });
  if (result.status !== 0) return new Map();
  return new Map(result.stdout.trim().split('\n').filter(Boolean).map((line) => {
    const [name, sha] = line.split('\t');
    return [name, sha];
  }));
}

/**
 * Describes what changed between two snapshots.
 *
 * A deleted ref produces no event. There is nothing to build at a commit that no
 * longer exists, and running a workflow from a deleted branch would execute code
 * the repository has just decided to remove.
 */
export function refChanges(before, after) {
  const changes = [];
  for (const [name, sha] of after) {
    if (before.get(name) === sha) continue;
    changes.push({
      ref: name,
      sha,
      previousSha: before.get(name) ?? null,
      created: !before.has(name),
      type: name.startsWith('refs/tags/') ? 'tag' : 'branch',
    });
  }
  return changes;
}

function changedPaths(config, { orgSlug, repoSlug }, change) {
  const gitDir = repoDiskPath(config, orgSlug, repoSlug);
  // A newly created ref has no previous state to diff against, so path filters
  // are evaluated with no path information rather than against a fabricated
  // comparison — see `workflowMatchesEvent`, which does not drop a build for
  // missing metadata.
  if (!change.previousSha) return [];
  const result = git(gitDir, ['diff', '--name-only', `${change.previousSha}..${change.sha}`], { allowFailure: true });
  if (result.status !== 0) return [];
  return result.stdout.trim().split('\n').filter(Boolean).slice(0, DISPATCH_LIMITS.maxChangedPaths);
}

/**
 * Reads the workflow files present at a commit.
 *
 * Read at the commit being built, not from the current default branch: a
 * workflow must describe what that commit asked for, otherwise a change to the
 * workflow file silently rewrites how already-pushed commits are built.
 */
export function readWorkflowFiles(config, { orgSlug, repoSlug }, commitSha) {
  const gitDir = repoDiskPath(config, orgSlug, repoSlug);
  const listing = git(gitDir, ['ls-tree', '-l', '--full-name', `${commitSha}:${WORKFLOW_DIRECTORY}`], { allowFailure: true });
  if (listing.status !== 0) return [];

  const files = [];
  for (const line of listing.stdout.trim().split('\n').filter(Boolean)) {
    const match = line.match(/^(\d+)\s+blob\s+([0-9a-f]+)\s+(-|\d+)\t(.+)$/);
    if (!match) continue;
    const [, , , sizeRaw, name] = match;
    if (!/\.ya?ml$/i.test(name)) continue;
    if (files.length >= DISPATCH_LIMITS.maxFilesPerRepository) break;
    const size = sizeRaw === '-' ? 0 : Number(sizeRaw);
    const path = `${WORKFLOW_DIRECTORY}/${name}`;
    if (size > DISPATCH_LIMITS.maxFileBytes) {
      files.push({ path, oversized: true, source: null });
      continue;
    }
    const content = git(gitDir, ['show', `${commitSha}:${path}`], { allowFailure: true });
    if (content.status !== 0) continue;
    files.push({ path, oversized: false, source: content.stdout });
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

// A workflow file that cannot be parsed becomes a failed run carrying the
// error, rather than being skipped.
//
// Skipping is the worse behaviour by far: the author sees no run at all and has
// no way to tell a typo from a filter that legitimately did not match. A failed
// run with the line number is a bug report addressed to the person who caused it.
function recordInvalidWorkflow(db, config, { repository, file, event, actorId, message }) {
  const runId = uid('run');
  const jobId = uid('job');
  db.prepare(`
    INSERT INTO workflow_runs
      (id, repository_id, workflow_path, workflow_name, event, ref, commit_sha, actor_id, fork, status, conclusion_reason, completed_at)
    VALUES (?, ?, ?, NULL, ?, ?, ?, ?, 0, 'failure', 'the workflow file could not be read', CURRENT_TIMESTAMP)
  `).run(runId, repository.id, file.path, event.name, event.ref, event.sha, actorId);
  db.prepare(`
    INSERT INTO workflow_jobs
      (id, run_id, job_key, name, runs_on, position, status, conclusion_reason, completed_at)
    VALUES (?, ?, 'validate', 'Validate workflow', 'kukgit', 0, 'failure', 'invalid workflow file', CURRENT_TIMESTAMP)
  `).run(jobId, runId);
  try {
    appendJobLog(db, config, { jobId, chunks: [{ stream: 'system', content: `${message}\n` }] });
  } catch {
    // The run already records the failure; a log that could not be written must
    // not turn a reported problem into an unreported one.
  }
  return runId;
}

/**
 * Creates runs for every workflow at a commit that the event matches.
 *
 * One broken file never stops the others: each is validated on its own, so a
 * typo in a deployment workflow does not silently disable the test workflow
 * beside it.
 */
export function dispatchWorkflows(db, config, { repository, event, actorId = null, fork = false }) {
  const files = readWorkflowFiles(config, repository, event.sha);
  const started = [];
  const failed = [];
  const skipped = [];

  for (const file of files) {
    if (file.oversized) {
      failed.push({ path: file.path, runId: recordInvalidWorkflow(db, config, {
        repository, file, event, actorId,
        message: `${file.path} is larger than the ${Math.round(DISPATCH_LIMITS.maxFileBytes / 1024)} KiB workflow file limit.`,
      }) });
      continue;
    }

    let workflow;
    try {
      workflow = validateWorkflowFile(file.source, { config, path: file.path });
    } catch (error) {
      failed.push({ path: file.path, runId: recordInvalidWorkflow(db, config, {
        repository, file, event, actorId, message: error.message,
      }) });
      continue;
    }

    try {
      const created = createWorkflowRun(db, {
        repository, workflow, workflowPath: file.path, event, actorId, fork,
      });
      if (created.created) started.push({ path: file.path, runId: created.runId, cancelled: created.cancelledRuns });
      else skipped.push({ path: file.path, reason: created.reason });
    } catch (error) {
      // A limit reached, not a broken file: reporting it as invalid would blame
      // the wrong thing.
      skipped.push({ path: file.path, reason: error.message });
    }
  }

  if (started.length || failed.length) {
    audit(db, {
      userId: actorId,
      action: 'workflow.dispatched',
      targetType: 'repository',
      targetId: repository.id,
      metadata: {
        event: event.name,
        ref: event.ref,
        started: started.map((entry) => entry.path),
        failed: failed.map((entry) => entry.path),
      },
    });
  }
  return { started, failed, skipped };
}

/**
 * Dispatches for everything a push changed.
 *
 * A branch update is a `push`; a tag update is a `tag`. Both are described from
 * the ref that actually moved, so a workflow filtered to one branch is not
 * started by activity on another.
 */
export function dispatchForRefChanges(db, config, { repository, changes, actorId = null }) {
  const results = [];
  for (const change of changes) {
    const event = {
      name: change.type === 'tag' ? 'tag' : 'push',
      ref: change.ref,
      sha: change.sha,
      paths: changedPaths(config, repository, change),
    };
    results.push({ ref: change.ref, ...dispatchWorkflows(db, config, { repository, event, actorId }) });
  }
  return results;
}

/**
 * Cancels the runs of a branch that has been deleted.
 *
 * Work queued for a commit nobody can reach is work nobody wants, and leaving it
 * queued would hold a slot against the repository's in-flight limit.
 */
export function cancelRunsForDeletedRefs(db, { repository, before, after }) {
  const cancelled = [];
  for (const [name] of before) {
    if (after.has(name)) continue;
    const runs = db.prepare(`
      SELECT id FROM workflow_runs
      WHERE repository_id = ? AND ref = ? AND status IN ('queued','running')
    `).all(repository.id, name);
    for (const run of runs) {
      cancelRun(db, run.id, `the ref ${name} was deleted`);
      cancelled.push(run.id);
    }
  }
  return cancelled;
}

function findRepository(db, orgSlug, repoSlug) {
  return db.prepare(`
    SELECT r.id, r.slug AS repoSlug, o.slug AS orgSlug, r.organization_id AS organizationId
    FROM repositories r JOIN organizations o ON o.id = r.organization_id
    WHERE o.slug = ? AND r.slug = ? AND r.deleted_at IS NULL
  `).get(orgSlug, repoSlug);
}

const PUSH_ROUTES = [
  { regex: /^\/api\/repos\/([^/]+)\/([^/]+)\/(?:branches|files)(?:\/.*)?$/, methods: ['POST', 'PUT', 'PATCH'] },
  { regex: /^\/git\/([^/]+)\/([^/]+)\.git\/git-receive-pack$/, methods: ['POST'] },
];

function pushTarget(pathname, method) {
  for (const route of PUSH_ROUTES) {
    if (!route.methods.includes(method)) continue;
    const match = pathname.match(route.regex);
    if (!match) continue;
    try { return { orgSlug: decodeURIComponent(match[1]), repoSlug: decodeURIComponent(match[2]) }; }
    catch { return null; }
  }
  return null;
}

/**
 * Starts workflows after a request that changed a ref.
 *
 * Dispatch happens after the response, never before: a build must not be started
 * for a push that was then rejected by branch protection, and the request must
 * not be made slower by reading workflow files.
 */
export function createWorkflowDispatchCapture({ config, db, next }) {
  return async function workflowDispatchCapture(req, res) {
    const url = new URL(req.url, config.baseUrl);
    const target = pushTarget(url.pathname, String(req.method || 'GET').toUpperCase());
    if (!target) return next(req, res);

    const repository = findRepository(db, target.orgSlug, target.repoSlug);
    if (!repository) return next(req, res);

    const actorId = currentActorId(db, req);
    const before = refSnapshot(config, repository);

    // Dispatch on the response finishing, not on the handler returning. Git
    // smart HTTP streams through a spawned backend and its handler resolves as
    // soon as the pipe is wired, long before Git has written any ref — awaiting
    // it would compare the repository against itself and see no push at all.
    // A finished response is the one moment every path agrees the work is done.
    res.once('finish', () => {
      // Only a successful request can have changed anything.
      if (res.statusCode >= 400) return;
      try {
        const after = refSnapshot(config, repository);
        const changes = refChanges(before, after);
        cancelRunsForDeletedRefs(db, { repository, before, after });
        if (changes.length) dispatchForRefChanges(db, config, { repository, changes, actorId });
      } catch (error) {
        // A dispatch failure must never turn a successful push into an error the
        // client sees; the push happened and has already been acknowledged.
        console.error('KukGit workflow dispatch', error);
      }
    });

    return next(req, res);
  };
}

function currentActorId(db, req) {
  // A Git push over HTTP carries a personal access token rather than a session,
  // so an absent user is normal and not an error.
  try { return currentUser(db, req)?.id ?? null; }
  catch { return null; }
}

export function runSummary(db, runId) {
  const jobs = listRunJobs(db, runId);
  return {
    runId,
    jobs: jobs.map((job) => ({ key: job.jobKey, status: job.status })),
  };
}
