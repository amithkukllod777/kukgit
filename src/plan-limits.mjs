import { httpError } from './security.mjs';
import { organizationPlan } from './plans.mjs';
import { billingPeriod, organizationUsage } from './usage.mjs';

/**
 * Enforcement for plan limits.
 *
 * Two rules shape everything here.
 *
 * **Only growth is refused.** Clone, fetch, pull, read, browse and download all
 * continue when an organization is over its limit. What stops is adding: a new
 * repository, a new member, a new LFS object. A customer locked out of code
 * they have already pushed has lost work over an invoice, and no limit is worth
 * that. It also means a downgrade is survivable: what exists stays.
 *
 * **The check is cheap or it is not on the hot path.** Seats, repositories and
 * collaborators are one `COUNT(*)`. Storage needs a directory walk, so it is
 * cached for a short window and enforced only where the size is known before
 * the bytes arrive — the Git LFS batch endpoint. Git pack size is not enforced
 * here; see `docs/BILLING_AND_QUOTAS.md`.
 */

const STORAGE_CACHE_MS = 60_000;
const storageCache = new Map();

/** Test seam. The cache is time-based, so a test cannot wait it out. */
export function forgetPlanUsage() {
  storageCache.clear();
}

function count(db, sql, ...parameters) {
  return Number(db.prepare(sql).get(...parameters)?.count ?? 0);
}

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function storageBytes(db, config, organizationId, now) {
  const cached = storageCache.get(organizationId);
  if (cached && now.getTime() - cached.at < STORAGE_CACHE_MS) return cached.bytes;
  const usage = organizationUsage(db, config, { organizationId, now });
  const bytes = usage ? usage.storage.totalBytes : 0;
  storageCache.set(organizationId, { at: now.getTime(), bytes });
  return bytes;
}

function ciMinutes(db, config, organizationId, now) {
  const usage = organizationUsage(db, config, { organizationId, now });
  return usage ? usage.ci.minutes : 0;
}

const RESOURCES = {
  repositories: {
    label: 'repositories',
    // Trash counts, exactly as it does in the usage report. A limit that
    // disagreed with the number on the screen would be unarguable with.
    current: (db) => (organizationId) => count(db, 'SELECT COUNT(*) AS count FROM repositories WHERE organization_id = ?', organizationId),
    message: (limit) => `This organization's plan allows ${limit} repositories.`,
  },
  seats: {
    label: 'seats',
    current: (db) => (organizationId) => count(db, 'SELECT COUNT(*) AS count FROM org_members WHERE organization_id = ?', organizationId),
    message: (limit) => `This organization's plan allows ${limit} members.`,
  },
  externalCollaborators: {
    label: 'external collaborators',
    current: (db) => (organizationId) => (tableExists(db, 'repository_collaborators')
      ? count(db, `
          SELECT COUNT(DISTINCT c.user_id) AS count FROM repository_collaborators c
          JOIN repositories r ON r.id = c.repository_id
          WHERE r.organization_id = ?
            AND c.user_id NOT IN (SELECT user_id FROM org_members WHERE organization_id = ?)
        `, organizationId, organizationId)
      : 0),
    message: (limit) => `This organization's plan allows ${limit} external collaborators.`,
  },
  storageBytes: {
    label: 'storage',
    message: (limit) => `This organization's plan allows ${Math.round(limit / 1024 ** 3)} GiB of storage.`,
  },
  ciMinutesPerMonth: {
    label: 'CI minutes',
    message: (limit) => `This organization's plan allows ${limit} CI minutes per month.`,
  },
};

/**
 * What a resource stands at, and what the plan allows.
 *
 * Returns `limit: null` for an unlimited plan, which callers must treat as
 * allowed rather than as zero.
 */
export function planStanding(db, config, { organizationId, resource, now = new Date() }) {
  // `config` is needed only where the answer comes off the disk. Seats,
  // repositories and collaborators are counted in the database, and their
  // callers should not have to thread configuration through to ask.
  const definition = RESOURCES[resource];
  if (!definition) throw new Error(`Unknown plan resource: ${resource}`);
  const plan = organizationPlan(db, organizationId);
  const limit = plan[resource] ?? null;

  const used = resource === 'storageBytes' ? storageBytes(db, config, organizationId, now)
    : resource === 'ciMinutesPerMonth' ? ciMinutes(db, config, organizationId, now)
      : definition.current(db)(organizationId);

  return { plan: plan.id, resource, used, limit, period: billingPeriod(now).id };
}

/**
 * Refuse an addition that would take an organization past its plan.
 *
 * `402` because that is what this is: the request is well formed, the caller is
 * authorized, and the answer is that the plan does not cover it. A `403` would
 * say they are not allowed to do this at all, which is wrong and sends people
 * to look for a permissions problem that does not exist.
 */
export function assertWithinPlan(db, config, { organizationId, resource, adding = 1, now = new Date() }) {
  const standing = planStanding(db, config, { organizationId, resource, now });
  if (standing.limit === null) return standing;
  if (standing.used + adding <= standing.limit) return standing;

  throw httpError(402, `${RESOURCES[resource].message(standing.limit)} It is using ${standing.used}.`, 'PLAN_LIMIT_EXCEEDED');
}

/**
 * Invalidate a cached storage figure.
 *
 * Called after something is known to have grown, so the next check sees it
 * rather than waiting out the window. Without this an organization could push
 * past its storage limit once per minute.
 */
export function planUsageChanged(organizationId) {
  storageCache.delete(organizationId);
}
