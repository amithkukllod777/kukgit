import fs from 'node:fs';
import path from 'node:path';
import { repoDiskPath } from './git.mjs';
import { against, organizationPlan } from './plans.mjs';

/**
 * What an organization is using, measured rather than remembered.
 *
 * Everything here is derived from the database and the disk at the moment it is
 * asked. Nothing increments a counter, because a counter is wrong the first
 * time a process dies between the write and the increment — and a billing
 * number that drifts is worse than one that costs a directory walk.
 *
 * The walk is the expensive part, so it is cached per repository against the
 * bare repository's mtime. A repository nobody has pushed to is measured once.
 */

const gitSizeCache = new Map();

export function billingPeriod(now = new Date()) {
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const start = new Date(Date.UTC(year, now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(year, now.getUTCMonth() + 1, 1));
  return { id: `${year}-${month}`, startsAt: start.toISOString(), endsAt: end.toISOString() };
}

function directoryBytes(root) {
  let total = 0;
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) { stack.push(full); continue; }
      // Symlinks are not followed and not counted: the bytes belong to whatever
      // they point at, and following them would let a link out of the tree bill
      // somebody for the operating system.
      if (!entry.isFile()) continue;
      try { total += fs.statSync(full).size; } catch { /* removed mid-walk */ }
    }
  }
  return total;
}

function repositoryGitBytes(config, orgSlug, repoSlug) {
  let root;
  try { root = repoDiskPath(config, orgSlug, repoSlug); } catch { return 0; }
  let stamp;
  try { stamp = fs.statSync(root).mtimeMs; } catch { return 0; }
  const cached = gitSizeCache.get(root);
  if (cached && cached.stamp === stamp) return cached.bytes;
  const bytes = directoryBytes(root);
  gitSizeCache.set(root, { stamp, bytes });
  return bytes;
}

/** Test seam: the cache is keyed by mtime, which has one-second granularity. */
export function forgetGitSizes() {
  gitSizeCache.clear();
}

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

/**
 * CI minutes for a period.
 *
 * Per job, rounded up to the minute, which is how every provider bills and what
 * a customer comparing invoices will expect. A job still running is counted for
 * the time it has already taken — a run that has been going for six hours is
 * six hours of machine whether or not it has finished, and showing zero until
 * it ends is how a runaway workflow stays invisible.
 */
function ciMinutes(db, organizationId, period, now) {
  if (!tableExists(db, 'workflow_jobs') || !tableExists(db, 'workflow_runs')) return { minutes: 0, jobs: 0, running: 0 };
  const rows = db.prepare(`
    SELECT j.started_at AS startedAt, j.completed_at AS completedAt
    FROM workflow_jobs j
    JOIN workflow_runs r ON r.id = j.run_id
    JOIN repositories rep ON rep.id = r.repository_id
    WHERE rep.organization_id = ? AND j.started_at IS NOT NULL AND j.started_at >= ? AND j.started_at < ?
  `).all(organizationId, period.startsAt.replace('T', ' ').slice(0, 19), period.endsAt.replace('T', ' ').slice(0, 19));

  let minutes = 0;
  let running = 0;
  for (const row of rows) {
    const started = new Date(`${String(row.startedAt).replace(' ', 'T')}Z`);
    if (!Number.isFinite(started.getTime())) continue;
    const finished = row.completedAt ? new Date(`${String(row.completedAt).replace(' ', 'T')}Z`) : now;
    if (!row.completedAt) running += 1;
    const elapsed = finished - started;
    if (elapsed <= 0) { minutes += 1; continue; }
    minutes += Math.ceil(elapsed / 60_000);
  }
  return { minutes, jobs: rows.length, running };
}

function storage(db, config, organizationId, orgSlug) {
  const repositories = db.prepare(`
    SELECT slug, archived_at AS archivedAt, deleted_at AS deletedAt
    FROM repositories WHERE organization_id = ?
  `).all(organizationId);

  let gitBytes = 0;
  for (const repository of repositories) gitBytes += repositoryGitBytes(config, orgSlug, repository.slug);

  // Deduplicated, because the customer should not pay twice for one object they
  // pushed to two repositories — and both numbers are reported, because the
  // difference is the part of the bill that dedup is saving them.
  const lfs = tableExists(db, 'repository_lfs_objects')
    ? db.prepare(`
        SELECT
          (SELECT COALESCE(SUM(size), 0) FROM lfs_objects WHERE oid IN (
            SELECT DISTINCT link.oid FROM repository_lfs_objects link
            JOIN repositories r ON r.id = link.repository_id WHERE r.organization_id = ?
          )) AS uniqueBytes,
          (SELECT COALESCE(SUM(o.size), 0) FROM repository_lfs_objects link
            JOIN repositories r ON r.id = link.repository_id
            JOIN lfs_objects o ON o.oid = link.oid WHERE r.organization_id = ?) AS linkedBytes
      `).get(organizationId, organizationId)
    : { uniqueBytes: 0, linkedBytes: 0 };

  const artifacts = tableExists(db, 'workflow_artifacts')
    ? db.prepare(`
        SELECT COALESCE(SUM(a.size_bytes), 0) AS bytes FROM workflow_artifacts a
        JOIN repositories r ON r.id = a.repository_id WHERE r.organization_id = ?
      `).get(organizationId).bytes
    : 0;

  const caches = tableExists(db, 'workflow_caches')
    ? db.prepare(`
        SELECT COALESCE(SUM(c.size_bytes), 0) AS bytes FROM workflow_caches c
        JOIN repositories r ON r.id = c.repository_id WHERE r.organization_id = ?
      `).get(organizationId).bytes
    : 0;

  return {
    repositories: {
      // Trashed repositories still occupy the disk, so they still count. A
      // delete that has not been purged is not a delete, and billing that
      // pretends otherwise is billing that funds somebody's free storage.
      active: repositories.filter((row) => !row.deletedAt && !row.archivedAt).length,
      archived: repositories.filter((row) => !row.deletedAt && row.archivedAt).length,
      trashed: repositories.filter((row) => row.deletedAt).length,
      total: repositories.length,
    },
    gitBytes,
    lfsBytes: Number(lfs.uniqueBytes) || 0,
    lfsLinkedBytes: Number(lfs.linkedBytes) || 0,
    artifactBytes: Number(artifacts) || 0,
    cacheBytes: Number(caches) || 0,
  };
}

function people(db, organizationId) {
  const seats = db.prepare('SELECT COUNT(*) AS count FROM org_members WHERE organization_id = ?').get(organizationId).count;
  const external = tableExists(db, 'repository_collaborators')
    ? db.prepare(`
        SELECT COUNT(DISTINCT c.user_id) AS count FROM repository_collaborators c
        JOIN repositories r ON r.id = c.repository_id
        WHERE r.organization_id = ?
          AND c.user_id NOT IN (SELECT user_id FROM org_members WHERE organization_id = ?)
      `).get(organizationId, organizationId).count
    : 0;
  return { seats: Number(seats) || 0, externalCollaborators: Number(external) || 0 };
}

/**
 * Everything an organization is using, and what its plan allows.
 *
 * Storage is one number against the plan because that is what a customer buys —
 * Git, LFS, artifacts and caches all land on the same disk, and a plan that
 * limits them separately is four conversations instead of one. The breakdown is
 * still reported, because "you are over" needs to say what filled it.
 */
export function organizationUsage(db, config, { organizationId, now = new Date() }) {
  const organization = db.prepare('SELECT id, slug, name, plan FROM organizations WHERE id = ?').get(organizationId);
  if (!organization) return null;

  const plan = organizationPlan(db, organizationId);
  const period = billingPeriod(now);
  const bytes = storage(db, config, organizationId, organization.slug);
  const headcount = people(db, organizationId);
  const ci = ciMinutes(db, organizationId, period, now);
  const storageBytes = bytes.gitBytes + bytes.lfsBytes + bytes.artifactBytes + bytes.cacheBytes;

  return {
    organization: { id: organization.id, slug: organization.slug, name: organization.name },
    plan: {
      id: plan.id,
      label: plan.label,
      // An organization whose stored plan is not one we know is on `free` and
      // says so, rather than silently looking correct.
      recognised: plan.recognised,
      stored: plan.stored,
    },
    period,
    measuredAt: now.toISOString(),
    storage: {
      ...bytes,
      totalBytes: storageBytes,
      // What deduplication is saving them, which is the only reason the two LFS
      // numbers are both here.
      lfsSavedBytes: Math.max(0, bytes.lfsLinkedBytes - bytes.lfsBytes),
    },
    ci,
    people: headcount,
    limits: {
      seats: against(headcount.seats, plan.seats),
      repositories: against(bytes.repositories.total, plan.repositories),
      storageBytes: against(storageBytes, plan.storageBytes),
      ciMinutesPerMonth: against(ci.minutes, plan.ciMinutesPerMonth),
      externalCollaborators: against(headcount.externalCollaborators, plan.externalCollaborators),
    },
  };
}

/** Whether anything on this plan is over its limit, and which. */
export function exceeded(usage) {
  return Object.entries(usage.limits).filter(([, value]) => value.over).map(([name]) => name);
}

export function instanceUsage(db, config, { now = new Date(), limit = 200 } = {}) {
  const rows = db.prepare('SELECT id FROM organizations ORDER BY created_at, rowid LIMIT ?').all(limit);
  const organizations = rows
    .map((row) => organizationUsage(db, config, { organizationId: row.id, now }))
    .filter(Boolean)
    .map((usage) => ({ ...usage, exceeded: exceeded(usage) }));

  return {
    period: billingPeriod(now),
    organizations,
    totals: {
      organizations: organizations.length,
      storageBytes: organizations.reduce((sum, entry) => sum + entry.storage.totalBytes, 0),
      seats: organizations.reduce((sum, entry) => sum + entry.people.seats, 0),
      ciMinutes: organizations.reduce((sum, entry) => sum + entry.ci.minutes, 0),
      overLimit: organizations.filter((entry) => entry.exceeded.length).length,
    },
  };
}
