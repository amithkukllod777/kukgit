import { httpError } from './security.mjs';

/**
 * What a plan is allowed to use.
 *
 * Limits live here rather than in configuration because a limit that differs
 * between two instances of the same plan is a limit nobody can quote to a
 * customer. `KUKGIT_LFS_REPOSITORY_QUOTA_BYTES` stays as it is — it is a
 * per-repository ceiling an operator sets for their own instance, and it is a
 * different question from what an organization has bought.
 *
 * `null` means no limit. It is not the same as `0`, and both appear here.
 */
const GIB = 1024 ** 3;

export const PLANS = Object.freeze({
  free: {
    id: 'free',
    label: 'Free',
    seats: 5,
    repositories: 20,
    storageBytes: 5 * GIB,
    ciMinutesPerMonth: 500,
    externalCollaborators: 5,
  },
  team: {
    id: 'team',
    label: 'Team',
    seats: 50,
    repositories: 500,
    storageBytes: 100 * GIB,
    ciMinutesPerMonth: 10_000,
    externalCollaborators: 50,
  },
  business: {
    id: 'business',
    label: 'Business',
    seats: 500,
    repositories: null,
    storageBytes: 1024 * GIB,
    ciMinutesPerMonth: 50_000,
    externalCollaborators: null,
  },
  /**
   * Kuklabs' own organization and anything an operator has agreed by contract.
   * Deliberately not purchasable: it exists so an enterprise agreement is a row
   * somebody set rather than a limit quietly edited in code.
   */
  founder: {
    id: 'founder',
    label: 'Founder',
    seats: null,
    repositories: null,
    storageBytes: null,
    ciMinutesPerMonth: null,
    externalCollaborators: null,
  },
});

export const PURCHASABLE_PLANS = Object.freeze(['free', 'team', 'business']);

/**
 * The plan a row names, or `free`.
 *
 * An unknown plan resolves to `free` rather than throwing. A plan string that
 * no longer exists — renamed, removed, typed wrong in a migration — must not
 * take an organization's Git hosting down; it should give them the smallest
 * plan and be visible in the usage report.
 */
export function planFor(value) {
  const id = String(value ?? '').trim().toLowerCase();
  return PLANS[id] ?? PLANS.free;
}

export function organizationPlan(db, organizationId) {
  const row = db.prepare('SELECT plan FROM organizations WHERE id = ?').get(organizationId);
  if (!row) throw httpError(404, 'Organization not found.', 'ORG_NOT_FOUND');
  return { ...planFor(row.plan), recognised: Boolean(PLANS[String(row.plan ?? '').toLowerCase()]), stored: row.plan };
}

/**
 * How much of a limit is used, as a number a screen and a decision can both use.
 *
 * `null` limit gives `null` ratio and `over: false` — an unlimited plan cannot
 * be over, and a percentage of nothing is not zero, it is meaningless.
 */
export function against(used, limit) {
  const amount = Number(used) || 0;
  if (limit === null || limit === undefined) return { used: amount, limit: null, ratio: null, over: false, remaining: null };
  const cap = Number(limit);
  return {
    used: amount,
    limit: cap,
    ratio: cap === 0 ? 1 : amount / cap,
    over: amount > cap,
    remaining: Math.max(0, cap - amount),
  };
}
