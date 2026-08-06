import { httpError } from './security.mjs';
import { audit, findRepo, uid } from './db.mjs';
import { importMirror, listBranches, deleteBareRepository } from './git.mjs';
import { assertWithinPlan } from './plan-limits.mjs';
import { listForgeRepositories, planImport } from './forge-discovery.mjs';
import { importForgeIssues, listForgeIssues, migrateImportedIssues } from './forge-issues.mjs';
import { migrateIssueComments } from './issue-comments.mjs';
import { importLfsObjects } from './lfs-import.mjs';

/**
 * Importing more than one repository, without holding a request open.
 *
 * A single import blocks its request for as long as the clone takes, with a
 * three-minute ceiling — survivable for one small repository and useless for
 * forty, or for one large one. So a bulk import records what it intends to do,
 * answers immediately with a job to watch, and works through the list behind the
 * request.
 *
 * **The token stays in memory.** Everything about single-repository import rests
 * on the token never being written down (see repository-import.mjs), and a queue
 * is the obvious place that would stop being true — a background worker needs
 * the credential after the request that carried it has gone. Keeping it in a Map
 * for the life of the job preserves the property at a real cost: if the process
 * restarts mid-job, the private repositories still in the queue fail, and say
 * they failed because the token went with the process. That is a worse feature
 * and a better trade, and the failure is at least legible.
 */

const TOKENS = new Map();

export const IMPORT_JOB_LIMITS = Object.freeze({
  // One at a time. A clone saturates whatever it is given; running six in
  // parallel makes all six slow and the server unresponsive while they run.
  concurrency: 1,
  maxItems: 500,
});

export function migrateRepositoryImportJobs(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS repository_import_jobs (
      id TEXT PRIMARY KEY,
      -- The foreign key is not decoration. Deleting a tenant walks this graph,
      -- and a job row without it is a list of somebody's repository names left
      -- behind after they asked to be forgotten.
      organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      forge TEXT NOT NULL,
      owner TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      authenticated INTEGER NOT NULL DEFAULT 0,
      include_issues INTEGER NOT NULL DEFAULT 0,
      include_lfs INTEGER NOT NULL DEFAULT 0,
      note TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at TEXT
    );
    CREATE TABLE IF NOT EXISTS repository_import_items (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL REFERENCES repository_import_jobs(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      slug TEXT NOT NULL,
      source_url TEXT NOT NULL,
      visibility TEXT NOT NULL DEFAULT 'private',
      status TEXT NOT NULL DEFAULT 'pending',
      message TEXT,
      started_at TEXT,
      finished_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_repository_import_items_job
      ON repository_import_items(job_id, status);
  `);
  // This module now writes issues and their comments, so it makes sure both
  // exist rather than relying on the order server.mjs happens to call
  // migrations in. A dependency that works because of call order is a
  // dependency that breaks when somebody reorders the list.
  migrateImportedIssues(db);
  migrateIssueComments(db);
}

function jobRow(db, jobId) {
  const job = db.prepare(`
    SELECT id, organization_id AS organizationId, created_by AS createdBy, forge, owner,
           status, authenticated, include_issues AS includeIssues, include_lfs AS includeLfs, note,
           created_at AS createdAt, finished_at AS finishedAt
    FROM repository_import_jobs WHERE id = ?
  `).get(jobId);
  if (!job) throw httpError(404, 'Import job not found.', 'IMPORT_JOB_NOT_FOUND');
  return job;
}

export function importJobStatus(db, jobId, { organizationId = null } = {}) {
  const job = jobRow(db, jobId);
  // Checked here rather than only at the route, so a job id cannot be used to
  // read what another organization is importing.
  if (organizationId && job.organizationId !== organizationId) {
    throw httpError(404, 'Import job not found.', 'IMPORT_JOB_NOT_FOUND');
  }
  const items = db.prepare(`
    SELECT id, name, slug, source_url AS sourceUrl, visibility, status, message,
           started_at AS startedAt, finished_at AS finishedAt
    FROM repository_import_items WHERE job_id = ? ORDER BY rowid
  `).all(jobId);
  const counts = items.reduce((totals, item) => ({ ...totals, [item.status]: (totals[item.status] ?? 0) + 1 }), {});
  return {
    ...job,
    authenticated: Boolean(job.authenticated),
    items,
    total: items.length,
    counts: {
      pending: counts.pending ?? 0,
      importing: counts.importing ?? 0,
      imported: counts.imported ?? 0,
      failed: counts.failed ?? 0,
      skipped: counts.skipped ?? 0,
    },
  };
}

export function listImportJobs(db, organizationId) {
  return db.prepare(`
    SELECT j.id, j.forge, j.owner, j.status, j.created_at AS createdAt, j.finished_at AS finishedAt,
           COUNT(i.id) AS total,
           SUM(CASE WHEN i.status = 'imported' THEN 1 ELSE 0 END) AS imported,
           SUM(CASE WHEN i.status = 'failed' THEN 1 ELSE 0 END) AS failed
    FROM repository_import_jobs j
    LEFT JOIN repository_import_items i ON i.job_id = j.id
    WHERE j.organization_id = ?
    GROUP BY j.id ORDER BY j.created_at DESC LIMIT 50
  `).all(organizationId);
}

/**
 * Works out what would be imported, without importing any of it.
 *
 * Separate from starting the job on purpose: forty repositories arriving in an
 * organization is not something to discover afterwards, and the skip reasons are
 * worth reading before rather than after.
 */
export async function previewBulkImport({ forge, owner, token = null, includeForks = false, includeArchived = false }, { fetchImpl } = {}) {
  const listing = await listForgeRepositories({ forge, owner, token }, fetchImpl ? { fetchImpl } : {});
  const { selected, skipped } = planImport(listing.repositories, { includeForks, includeArchived });
  return { ...listing, selected, skipped };
}

/**
 * Records the plan and returns a job to watch. Does not wait for the work.
 */
export function createBulkImportJob(db, { organizationId, userId, forge, owner, authenticated, note, selected, skipped, token = null, includeIssues = false, includeLfs = false }) {
  if (!selected.length) throw httpError(400, 'Nothing here can be imported. Check the skipped list for why.', 'IMPORT_NOTHING_TO_DO');
  if (selected.length > IMPORT_JOB_LIMITS.maxItems) {
    throw httpError(400, `An import job may cover at most ${IMPORT_JOB_LIMITS.maxItems} repositories.`, 'IMPORT_TOO_MANY');
  }
  const jobId = uid('impjob');
  const insertJob = db.prepare(`
    INSERT INTO repository_import_jobs (id, organization_id, created_by, forge, owner, authenticated, include_issues, include_lfs, note)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertItem = db.prepare(`
    INSERT INTO repository_import_items (id, job_id, name, slug, source_url, visibility, status, message)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const write = db.transaction(() => {
    insertJob.run(jobId, organizationId, userId ?? null, forge, owner, authenticated ? 1 : 0, includeIssues ? 1 : 0, includeLfs ? 1 : 0, note ?? null);
    for (const repository of selected) {
      insertItem.run(uid('impitem'), jobId, repository.name, repository.slug, repository.cloneUrl, repository.private ? 'private' : 'public', 'pending', null);
    }
    // Recorded, not discarded. Somebody who expected forty and got thirty-one
    // needs the other nine accounted for, by name, after the fact as well as
    // before it.
    for (const repository of skipped) {
      insertItem.run(uid('impitem'), jobId, repository.name, repository.slug ?? '', repository.cloneUrl ?? '', 'private', 'skipped', repository.reason);
    }
  });
  write();
  if (token) TOKENS.set(jobId, token);
  return jobId;
}

/** Whether the credential for a job is still held. Public for the tests. */
export function importJobHasToken(jobId) {
  return TOKENS.has(jobId);
}

export function forgetImportJobToken(jobId) {
  TOKENS.delete(jobId);
}

function finishItem(db, itemId, status, message) {
  db.prepare("UPDATE repository_import_items SET status = ?, message = ?, finished_at = datetime('now') WHERE id = ?")
    .run(status, message ? String(message).slice(0, 700) : null, itemId);
}

/**
 * Works through one job's queue, one repository at a time.
 *
 * Every failure is confined to its own item: a repository that will not clone
 * must not stop the thirty after it, because the whole point of a bulk import is
 * not having to babysit it.
 */
export async function runBulkImportJob(db, config, jobId, { onProgress = null, importRepository = importMirror, readIssues = listForgeIssues, fetchLfs = importLfsObjects } = {}) {
  const job = jobRow(db, jobId);
  const token = TOKENS.get(jobId) ?? null;
  const orgSlug = db.prepare('SELECT slug FROM organizations WHERE id = ?').get(job.organizationId)?.slug;
  if (!orgSlug) throw httpError(404, 'Organization not found.', 'ORGANIZATION_NOT_FOUND');

  for (;;) {
    const item = db.prepare("SELECT * FROM repository_import_items WHERE job_id = ? AND status = 'pending' ORDER BY rowid LIMIT 1").get(jobId);
    if (!item) break;
    if (jobRow(db, jobId).status === 'cancelled') break;
    db.prepare("UPDATE repository_import_items SET status = 'importing', started_at = datetime('now') WHERE id = ?").run(item.id);
    onProgress?.({ jobId, item: item.slug });

    try {
      if (findRepo(db, orgSlug, item.slug)) throw httpError(409, 'A repository with this name already exists here.');
      // Re-checked per repository rather than once for the batch: a job that
      // takes an hour can cross the limit partway through, and the check that
      // matters is the one at the moment of creation.
      assertWithinPlan(db, config, { organizationId: job.organizationId, resource: 'repositories' });
      if (item.visibility === 'private' && !token) {
        throw httpError(400, 'The access token for this job is no longer held — the server restarted. Start the import again for the repositories that are left.', 'IMPORT_TOKEN_LOST');
      }

      // A seam, so the queue's behaviour — one failure not stopping the rest,
      // the limit re-checked partway through — can be tested without a network
      // and a forge. Production always passes the real one.
      await importRepository(config, orgSlug, item.slug, item.source_url, { credential: item.visibility === 'private' ? token : null });
      const branches = listBranches(config, orgSlug, item.slug);
      const defaultBranch = branches.some((branch) => branch.name === 'main') ? 'main'
        : branches.some((branch) => branch.name === 'master') ? 'master'
        : branches[0]?.name || 'main';
      const repoId = uid('repo');
      try {
        db.prepare(`
          INSERT INTO repositories (id, organization_id, slug, name, description, visibility, default_branch, created_by)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(repoId, job.organizationId, item.slug, item.name.slice(0, 120), `Imported from ${job.forge}/${job.owner}`, item.visibility, defaultBranch, job.createdBy);
      } catch (error) {
        // The bare repository is on disk and the row is not. Without this the
        // retry is refused by the "already exists on disk" guard forever.
        deleteBareRepository(config, orgSlug, item.slug);
        throw error;
      }
      audit(db, {
        organizationId: job.organizationId,
        userId: job.createdBy,
        action: 'repository.imported',
        targetType: 'repository',
        targetId: repoId,
        metadata: { slug: item.slug, sourceHost: job.forge, authenticated: Boolean(token), jobId },
      });
      // The tracker, if it was asked for. A repository whose code arrived and
      // whose issues did not is still an imported repository, so this cannot
      // turn a success into a failure — it says what happened on the item.
      const notes = [];
      // The files a mirror clone did not bring. A repository using Git LFS
      // contains pointers, not contents, so without this it looks complete and
      // hands whoever clones it a 130-byte text file where their weights were.
      if (job.includeLfs) {
        try {
          const lfs = await fetchLfs(db, config, {
            repository: { id: repoId, slug: item.slug, orgSlug },
            sourceUrl: item.source_url,
            token,
            attachedBy: job.createdBy,
          });
          if (lfs.found) {
            notes.push(`${lfs.imported} of ${lfs.found} Git LFS objects fetched`
              + (lfs.alreadyHeld ? `, ${lfs.alreadyHeld} already held` : '')
              + (lfs.failures.length ? `, ${lfs.failures.length} could not be fetched` : ''));
          }
        } catch (error) {
          notes.push(`code imported; Git LFS objects did not: ${String(error?.message ?? error).slice(0, 200)}`);
        }
      }
      let note = null;
      if (job.includeIssues) {
        try {
          const listing = await readIssues({ forge: job.forge, owner: job.owner, repo: item.name, token });
          const result = importForgeIssues(db, { repositoryId: repoId, actorId: job.createdBy, listing });
          note = `${result.imported} issues and ${result.comments} comments imported`
            + (result.pullRequestsSkipped ? `; ${result.pullRequestsSkipped} pull requests left behind` : '')
            + (result.note ? `. ${result.note}` : '');
        } catch (error) {
          note = `code imported; issues did not: ${String(error?.message ?? error).slice(0, 300)}`;
        }
      }
      if (note) notes.push(note);
      finishItem(db, item.id, 'imported', notes.length ? notes.join('. ') : null);
    } catch (error) {
      // One repository's failure is one repository's failure. Thirty more are
      // waiting, and nobody is watching this run.
      finishItem(db, item.id, 'failed', error?.message ?? String(error));
    }
  }

  const cancelled = jobRow(db, jobId).status === 'cancelled';
  db.prepare("UPDATE repository_import_jobs SET status = ?, finished_at = datetime('now') WHERE id = ?")
    .run(cancelled ? 'cancelled' : 'done', jobId);
  // The credential's whole life is this function. It goes even if the job failed.
  TOKENS.delete(jobId);
  return importJobStatus(db, jobId);
}

export function cancelBulkImportJob(db, jobId, { organizationId = null } = {}) {
  const job = jobRow(db, jobId);
  if (organizationId && job.organizationId !== organizationId) {
    throw httpError(404, 'Import job not found.', 'IMPORT_JOB_NOT_FOUND');
  }
  if (job.status !== 'running') return importJobStatus(db, jobId);
  db.prepare("UPDATE repository_import_jobs SET status = 'cancelled' WHERE id = ?").run(jobId);
  // Only what has not started. A clone already running is left to finish rather
  // than killed halfway, which would leave a partial repository on disk.
  db.prepare("UPDATE repository_import_items SET status = 'skipped', message = 'cancelled before it started', finished_at = datetime('now') WHERE job_id = ? AND status = 'pending'")
    .run(jobId);
  TOKENS.delete(jobId);
  return importJobStatus(db, jobId);
}
