import { leaseGate } from './job-leases.mjs';
import { billingPeriod, organizationUsage } from './usage.mjs';

/**
 * What an organization used, kept after the period it used it in.
 *
 * The current figure is not enough to invoice from. Storage is a level, not a
 * total: measuring it once, at the end of the month, bills whatever happens to
 * be on disk on the last day — and anybody who works that out deletes on the
 * 30th and pays nothing. So storage is **sampled through the period** and the
 * period is closed on the peak, with the average and the last reading kept
 * beside it so a disputed invoice can be looked at rather than argued about.
 *
 * CI minutes are a total, not a level. They accumulate within the period and
 * the closing figure is simply the period's own sum.
 *
 * A closed period never changes. Closing again does nothing. An invoice that
 * can be recomputed into a different number is not evidence of anything.
 */

const SAMPLE_INTERVAL_MS = 6 * 3600_000;
const CLOSE_INTERVAL_MS = 3600_000;

export function migrateUsageHistory(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS usage_samples (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      period TEXT NOT NULL,
      taken_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      plan TEXT NOT NULL,
      storage_bytes INTEGER NOT NULL,
      git_bytes INTEGER NOT NULL,
      lfs_bytes INTEGER NOT NULL,
      artifact_bytes INTEGER NOT NULL,
      cache_bytes INTEGER NOT NULL,
      repositories INTEGER NOT NULL,
      seats INTEGER NOT NULL,
      external_collaborators INTEGER NOT NULL,
      ci_minutes INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_usage_samples_period
      ON usage_samples(organization_id, period, taken_at);

    CREATE TABLE IF NOT EXISTS usage_periods (
      organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      period TEXT NOT NULL,
      closed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      plan TEXT NOT NULL,
      storage_peak_bytes INTEGER NOT NULL,
      storage_average_bytes INTEGER NOT NULL,
      storage_last_bytes INTEGER NOT NULL,
      repositories_peak INTEGER NOT NULL,
      seats_peak INTEGER NOT NULL,
      external_collaborators_peak INTEGER NOT NULL,
      ci_minutes INTEGER NOT NULL,
      samples INTEGER NOT NULL,
      PRIMARY KEY (organization_id, period)
    );
  `);
}

function organizations(db, limit) {
  return db.prepare('SELECT id FROM organizations ORDER BY created_at, rowid LIMIT ?').all(limit).map((row) => row.id);
}

/**
 * One reading of every organization, filed under the period it falls in.
 *
 * Cheap enough to run every few hours and useless if it runs once — a peak
 * computed from a single sample is that sample.
 */
export function sampleUsage(db, config, { now = new Date(), limit = 500 } = {}) {
  const period = billingPeriod(now);
  const insert = db.prepare(`
    INSERT INTO usage_samples (
      organization_id, period, taken_at, plan, storage_bytes, git_bytes, lfs_bytes,
      artifact_bytes, cache_bytes, repositories, seats, external_collaborators, ci_minutes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let taken = 0;
  for (const organizationId of organizations(db, limit)) {
    const usage = organizationUsage(db, config, { organizationId, now });
    if (!usage) continue;
    insert.run(
      organizationId,
      period.id,
      now.toISOString(),
      usage.plan.id,
      usage.storage.totalBytes,
      usage.storage.gitBytes,
      usage.storage.lfsBytes,
      usage.storage.artifactBytes,
      usage.storage.cacheBytes,
      usage.storage.repositories.total,
      usage.people.seats,
      usage.people.externalCollaborators,
      usage.ci.minutes,
    );
    taken += 1;
  }
  return { period: period.id, taken };
}

function previousPeriod(now) {
  return billingPeriod(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))).id;
}

/**
 * Close a period, once.
 *
 * Refuses to close the period that is still running: a figure recorded while
 * the month is open is not that month's figure, and having recorded it would
 * make the real one look like a correction.
 */
export function closePeriod(db, config, { period, now = new Date(), limit = 500 } = {}) {
  const target = period ?? previousPeriod(now);
  if (target >= billingPeriod(now).id) {
    return { period: target, closed: 0, skipped: 'period has not ended' };
  }

  const existing = db.prepare('SELECT organization_id AS id FROM usage_periods WHERE period = ?').all(target);
  const already = new Set(existing.map((row) => row.id));

  const read = db.prepare(`
    SELECT plan, storage_bytes AS storage, repositories, seats,
      external_collaborators AS external, ci_minutes AS ciMinutes
    FROM usage_samples WHERE organization_id = ? AND period = ? ORDER BY taken_at, id
  `);
  const insert = db.prepare(`
    INSERT INTO usage_periods (
      organization_id, period, plan, storage_peak_bytes, storage_average_bytes, storage_last_bytes,
      repositories_peak, seats_peak, external_collaborators_peak, ci_minutes, samples
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let closed = 0;
  const withoutSamples = [];
  for (const organizationId of organizations(db, limit)) {
    // Already closed. Not an error and not an update — a closed period is
    // final, and re-running the worker must not move a number somebody has
    // been invoiced for.
    if (already.has(organizationId)) continue;

    const samples = read.all(organizationId, target);
    if (!samples.length) {
      // Nothing was sampled — the instance was down, or the organization was
      // created after the last sample. Recorded with `samples: 0` so it reads
      // as "we do not know" rather than "they used nothing".
      withoutSamples.push(organizationId);
      const plan = db.prepare('SELECT plan FROM organizations WHERE id = ?').get(organizationId)?.plan ?? 'free';
      insert.run(organizationId, target, plan, 0, 0, 0, 0, 0, 0, 0, 0);
      closed += 1;
      continue;
    }

    const storage = samples.map((row) => Number(row.storage) || 0);
    insert.run(
      organizationId,
      target,
      samples[samples.length - 1].plan,
      Math.max(...storage),
      Math.round(storage.reduce((sum, value) => sum + value, 0) / storage.length),
      storage[storage.length - 1],
      Math.max(...samples.map((row) => Number(row.repositories) || 0)),
      Math.max(...samples.map((row) => Number(row.seats) || 0)),
      Math.max(...samples.map((row) => Number(row.external) || 0)),
      // The period's own total, so the last reading is the sum — not a peak,
      // because minutes accumulate rather than rise and fall.
      Math.max(...samples.map((row) => Number(row.ciMinutes) || 0)),
      samples.length,
    );
    closed += 1;
  }

  return { period: target, closed, withoutSamples: withoutSamples.length };
}

function shape(row) {
  return {
    period: row.period,
    plan: row.plan,
    closedAt: row.closed_at,
    storage: {
      peakBytes: Number(row.storage_peak_bytes),
      averageBytes: Number(row.storage_average_bytes),
      lastBytes: Number(row.storage_last_bytes),
    },
    repositoriesPeak: Number(row.repositories_peak),
    seatsPeak: Number(row.seats_peak),
    externalCollaboratorsPeak: Number(row.external_collaborators_peak),
    ciMinutes: Number(row.ci_minutes),
    samples: Number(row.samples),
    // A period closed with nothing sampled is not a bill. Saying so here means
    // nothing downstream has to know the convention.
    billable: Number(row.samples) > 0,
  };
}

export function organizationPeriods(db, organizationId, { limit = 24 } = {}) {
  return db.prepare(`
    SELECT * FROM usage_periods WHERE organization_id = ?
    ORDER BY period DESC LIMIT ?
  `).all(organizationId, limit).map(shape);
}

export function instancePeriod(db, period, { limit = 500 } = {}) {
  const rows = db.prepare(`
    SELECT p.*, o.slug AS slug, o.name AS name FROM usage_periods p
    JOIN organizations o ON o.id = p.organization_id
    WHERE p.period = ? ORDER BY p.storage_peak_bytes DESC LIMIT ?
  `).all(period, limit);
  return {
    period,
    organizations: rows.map((row) => ({ slug: row.slug, name: row.name, ...shape(row) })),
    totals: {
      organizations: rows.length,
      storagePeakBytes: rows.reduce((sum, row) => sum + Number(row.storage_peak_bytes), 0),
      seatsPeak: rows.reduce((sum, row) => sum + Number(row.seats_peak), 0),
      ciMinutes: rows.reduce((sum, row) => sum + Number(row.ci_minutes), 0),
      unsampled: rows.filter((row) => Number(row.samples) === 0).length,
    },
  };
}

export function startUsageSampleWorker(db, config, {
  intervalMs = SAMPLE_INTERVAL_MS,
  gate = leaseGate(db, 'usage-sample'),
} = {}) {
  const tick = () => {
    try {
      // One instance samples. Two would double the rows and halve the meaning
      // of an average.
      if (!gate()) return;
      sampleUsage(db, config, {});
    } catch (error) { console.error('KukGit usage sample worker', error.message); }
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return () => { clearInterval(timer); gate.release?.(); };
}

export function startUsagePeriodWorker(db, config, {
  intervalMs = CLOSE_INTERVAL_MS,
  gate = leaseGate(db, 'usage-period-close'),
} = {}) {
  const tick = () => {
    try {
      if (!gate()) return;
      closePeriod(db, config, {});
    } catch (error) { console.error('KukGit usage period worker', error.message); }
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return () => { clearInterval(timer); gate.release?.(); };
}
