import { publishCommitStatus } from './status-checks.mjs';
import { getRun, listRunJobs } from './workflow-runs.mjs';

export const CHECK_PREFIX = 'kukgit/';

/**
 * Derives the status context a run publishes under.
 *
 * **The workflow does not choose this.** If a file could name its own context, a
 * repository could add a workflow that declares the context a branch rule
 * requires and reports success without running anything — the protection would
 * be defeated by the thing it protects against.
 *
 * The name comes from the workflow's file path, which is part of the commit and
 * therefore already subject to review and branch protection.
 */
export function checkContextForWorkflow(workflowPath) {
  const name = String(workflowPath ?? '')
    .replace(/^\.kukgit\/workflows\//, '')
    .replace(/\.ya?ml$/i, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);
  return `${CHECK_PREFIX}${name || 'workflow'}`;
}

function describeRun(run, jobs) {
  const total = jobs.length;
  if (run.status === 'queued') return `${total} job${total === 1 ? '' : 's'} queued.`;
  if (run.status === 'running') {
    const done = jobs.filter((job) => ['success', 'failure', 'cancelled', 'skipped'].includes(job.status)).length;
    return `${done} of ${total} job${total === 1 ? '' : 's'} complete.`;
  }
  const failed = jobs.filter((job) => job.status === 'failure');
  if (failed.length) return `${failed.map((job) => job.jobKey).slice(0, 3).join(', ')} failed.`;
  if (run.status === 'cancelled') return run.conclusionReason || 'The run was cancelled.';
  const skipped = jobs.filter((job) => job.status === 'skipped').length;
  return skipped ? `${total - skipped} of ${total} jobs succeeded, ${skipped} skipped.` : `All ${total} job${total === 1 ? '' : 's'} succeeded.`;
}

// A cancelled run is `error`, not `failure`.
//
// `failure` says the code is wrong. A cancellation says nobody found out — an
// operator stopped it, a newer commit superseded it, or a runner disappeared.
// Reporting that as a code failure would send someone looking for a bug that
// does not exist, and would make a legitimate re-run look like a fix.
function stateForRun(run) {
  if (run.status === 'success') return 'success';
  if (run.status === 'failure') return 'failure';
  if (run.status === 'cancelled') return 'error';
  return 'pending';
}

/**
 * Publishes the commit status for a run.
 *
 * Published by the server on the run's behalf, never by the job's own token: a
 * job must not be able to write the verdict on itself. A failure to publish is
 * swallowed — a status that could not be recorded must not also destroy the run
 * that produced it, and the run's own record remains authoritative.
 */
export function publishRunCheck(db, config, runId) {
  let run;
  try { run = getRun(db, runId); }
  catch { return null; }

  const repository = db.prepare(`
    SELECT r.id, r.slug, o.slug AS orgSlug
    FROM repositories r JOIN organizations o ON o.id = r.organization_id
    WHERE r.id = ?
  `).get(run.repositoryId);
  if (!repository) return null;

  // Attributed to whoever caused the run, and marked `workflow` so the *how* is
  // never mistaken for a person publishing it by hand. A run with no resolvable
  // actor publishes nothing rather than borrowing someone else's name.
  if (!run.actorId) return null;
  const publisher = db.prepare('SELECT id FROM users WHERE id = ?').get(run.actorId);
  if (!publisher) return null;

  const jobs = listRunJobs(db, runId);
  try {
    return publishCommitStatus(db, config, {
      repository,
      commitSha: run.commitSha,
      context: checkContextForWorkflow(run.workflowPath),
      state: stateForRun(run),
      description: describeRun(run, jobs).slice(0, 140),
      targetUrl: `${config.baseUrl}/${repository.orgSlug}/${repository.slug}/runs/${run.id}`,
      publisher,
      authType: 'workflow',
    });
  } catch (error) {
    console.error('KukGit workflow check', error.message);
    return null;
  }
}

/**
 * Reports every run for a commit as a status, so a branch rule can require one.
 *
 * Nothing here decides whether a merge is allowed. The required-status policy and
 * the merge guard already do that, for every publisher; this only supplies a
 * status they can read. Adding a workflow can never relax a branch rule — at
 * most it adds another check that has to pass.
 */
export function publishChecksForCommit(db, config, { repositoryId, commitSha }) {
  const runs = db.prepare(`
    SELECT id FROM workflow_runs WHERE repository_id = ? AND commit_sha = ?
  `).all(repositoryId, commitSha);
  return runs.map((run) => publishRunCheck(db, config, run.id)).filter(Boolean);
}
