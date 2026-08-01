import os from 'node:os';
import { uid } from './db.mjs';

export const LEASE_DEFAULTS = {
  ttlSeconds: 90,
  // Rows claimed by a worker that died. Long enough that a slow but living
  // attempt is never stolen — a webhook delivery waiting on a remote timeout is
  // still working — and short enough that a crash is not a permanent stall.
  strandedMinutes: 15,
};

// One id per process. It identifies which instance holds a lease, so an
// operator reading `job_leases` sees a machine and a process rather than an
// opaque string.
const INSTANCE_ID = `${os.hostname()}:${process.pid}:${uid('inst')}`;

export function instanceId() {
  return INSTANCE_ID;
}

/**
 * Creates the lease table.
 *
 * A lease is coordination state with a lifetime measured in seconds, so it is
 * never migrated in place: an older shape is dropped and recreated. The most
 * that can cost is one tick where nobody holds a lease, which is exactly what
 * happens whenever an instance restarts anyway.
 */
export function migrateJobLeases(db) {
  const existing = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'job_leases'").get();
  if (existing) {
    const columns = db.prepare('PRAGMA table_info(job_leases)').all().map((column) => column.name);
    if (!columns.includes('job') || !columns.includes('heartbeat_at')) db.exec('DROP TABLE job_leases');
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS job_leases (
      job TEXT PRIMARY KEY,
      owner TEXT NOT NULL,
      acquired_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      heartbeat_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      lease_expires_at TEXT NOT NULL
    );
  `);
}

/**
 * Takes a named lease, or reports that somebody else holds it.
 *
 * One statement decides it. Two instances that read "expired" at the same
 * moment both attempt the write, and the `WHERE` clause means exactly one row
 * changes — a read-then-write would let both conclude they had won and run
 * every worker twice.
 *
 * The same call renews: the holder always matches its own `owner`, so a tick is
 * the heartbeat and there is no second code path that could forget to send one.
 * `acquired_at` is preserved across a renewal, so an operator can see how long
 * an instance has held a job rather than only when it last checked in.
 */
export function acquireLease(db, job, { owner = INSTANCE_ID, ttlSeconds = LEASE_DEFAULTS.ttlSeconds, now = new Date() } = {}) {
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1000).toISOString();
  const taken = db.prepare(`
    INSERT INTO job_leases (job, owner, acquired_at, heartbeat_at, lease_expires_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(job) DO UPDATE SET
      owner = excluded.owner,
      acquired_at = CASE WHEN job_leases.owner = excluded.owner THEN job_leases.acquired_at ELSE excluded.acquired_at END,
      heartbeat_at = excluded.heartbeat_at,
      lease_expires_at = excluded.lease_expires_at
    WHERE job_leases.lease_expires_at <= ? OR job_leases.owner = ?
  `).run(job, owner, nowIso, nowIso, expiresAt, nowIso, owner);
  return taken.changes > 0;
}

/**
 * Whether this owner still holds the lease.
 *
 * The fencing check. A worker that lost its lease mid-batch calls this before
 * the next externally visible effect, so a handover costs at most the one
 * attempt already in flight instead of a whole batch sent twice.
 *
 * It narrows the window rather than closing it: an email handed to SMTP cannot
 * be recalled by a later check. Closing it entirely would need the effect and
 * the lease check in one transaction, which is not possible when the effect
 * leaves the database.
 */
export function holdsLease(db, job, { owner = INSTANCE_ID, now = new Date() } = {}) {
  const row = db.prepare('SELECT owner, lease_expires_at AS expiresAt FROM job_leases WHERE job = ?').get(job);
  return Boolean(row) && row.owner === owner && row.expiresAt > now.toISOString();
}

export function releaseLease(db, job, owner = INSTANCE_ID) {
  return db.prepare('DELETE FROM job_leases WHERE job = ? AND owner = ?').run(job, owner).changes > 0;
}

export function leaseHolder(db, job) {
  return db.prepare(`
    SELECT job, owner, acquired_at AS acquiredAt, heartbeat_at AS heartbeatAt, lease_expires_at AS expiresAt
    FROM job_leases WHERE job = ?
  `).get(job) ?? null;
}

/**
 * Every held lease.
 *
 * Answers "nothing is held" rather than throwing when the table is absent. This
 * is read by the health endpoint, and a diagnostic surface that fails because a
 * coordination table has not been created yet reports an outage that is not
 * happening — precisely when somebody is looking at it to find out.
 */
export function listLeases(db) {
  const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'job_leases'").get();
  if (!table) return [];
  return db.prepare(`
    SELECT job, owner, acquired_at AS acquiredAt, heartbeat_at AS heartbeatAt, lease_expires_at AS expiresAt
    FROM job_leases ORDER BY job
  `).all();
}

/**
 * A predicate a worker calls at the top of every tick.
 *
 * Acquiring and renewing are the same call, so the tick *is* the heartbeat —
 * there is no separate heartbeat path that could stop while the work carries
 * on. A worker whose gate returns false does nothing and tries again next tick;
 * it does not stop, because the instance holding the lease may be about to die.
 */
export function leaseGate(db, job, { owner = INSTANCE_ID, ttlSeconds = LEASE_DEFAULTS.ttlSeconds } = {}) {
  const gate = () => {
    try { return acquireLease(db, job, { owner, ttlSeconds }); }
    catch (error) {
      // A lease that cannot be read is not permission to run. Failing open here
      // would turn a database blip into every instance working at once, which
      // is the one thing the lease exists to prevent.
      console.error(`KukGit lease ${job}`, error.message);
      return false;
    }
  };
  gate.job = job;
  gate.owner = owner;
  gate.release = () => { try { releaseLease(db, job, owner); } catch { /* shutting down */ } };
  gate.holds = () => holdsLease(db, job, { owner });
  return gate;
}

/**
 * Returns rows a worker claimed and never finished.
 *
 * By **age**, never wholesale. Resetting every `processing` row — at startup, or
 * on any other event — would resurrect work another instance is at that moment
 * performing, and the visible result is a webhook delivered twice or an email
 * sent twice. A row is only reclaimed once it has been claimed for longer than
 * any live attempt could still be running.
 */
export function requeueStranded(db, {
  table,
  claimedColumn = 'updated_at',
  pendingStatus = 'pending',
  strandedMinutes = LEASE_DEFAULTS.strandedMinutes,
  extraSet = '',
}) {
  if (!/^[a-z_]+$/.test(table) || !/^[a-z_]+$/.test(claimedColumn)) {
    throw new Error('requeueStranded takes fixed identifiers, not caller input.');
  }
  const result = db.prepare(`
    UPDATE ${table}
    SET status = ?${extraSet ? `, ${extraSet}` : ''}
    WHERE status = 'processing' AND ${claimedColumn} < datetime('now', ?)
  `).run(pendingStatus, `-${Math.max(1, Math.round(strandedMinutes))} minutes`);
  return result.changes;
}
