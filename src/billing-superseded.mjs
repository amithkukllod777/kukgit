import { audit, uid } from './db.mjs';

/**
 * The provider subscription KukGit stopped pointing at.
 *
 * `billing_subscriptions` holds one row per organization, keyed on the
 * organization. When a second activation arrives with a different provider
 * reference, the `ON CONFLICT DO UPDATE` replaces the reference — and the first
 * subscription is still live at the provider, still charging the customer's
 * card every month, with nothing in KukGit pointing at it any more.
 *
 * That is not hypothetical. It happens the moment somebody on Team buys
 * Business: checkout has no idea they already have a subscription, the provider
 * creates a second one, its `activated` event overwrites the reference, and
 * `Cancel` on the billing screen can only ever cancel the newer of the two.
 * The customer pays for both until they notice.
 *
 * Two things address it, and both are needed.
 *
 * **`billing-checkout.mjs` refuses to start a second purchase** while a live
 * one exists. That is the fix; it stops it happening through KukGit at all.
 *
 * **This is the net underneath.** A subscription created in the provider's own
 * dashboard, a race between two events, a restore from a backup taken mid
 * change — none of those go through checkout, and the first anybody would know
 * is a customer asking why they were billed twice. So a replaced reference is
 * written down here instead of vanishing, and it is loud: it stays
 * `open` until an operator says what happened to it.
 *
 * It deliberately does not cancel anything by itself. Cancelling a subscription
 * KukGit has lost track of, without a human looking, is how you end somebody's
 * paid plan because two events arrived out of order.
 */

export function migrateBillingSuperseded(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS billing_superseded_subscriptions (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      provider_reference TEXT NOT NULL,
      plan TEXT NOT NULL,
      -- What replaced it, so the two can be told apart at the provider.
      replaced_by_reference TEXT,
      replaced_by_plan TEXT,
      status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','resolved')),
      resolution TEXT,
      resolved_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      resolved_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      -- One row per reference. A provider that retries the replacing event must
      -- not file the same orphan twice and make one problem look like five.
      UNIQUE(organization_id, provider, provider_reference)
    );
    CREATE INDEX IF NOT EXISTS idx_billing_superseded_open
      ON billing_superseded_subscriptions(status, created_at DESC);
  `);
}

/**
 * Called from `applyChange` before the row is overwritten.
 *
 * Only when the reference actually changes. Every ordinary event — a renewal, a
 * payment failure, a cancellation — arrives with the same reference, and
 * filing those would bury the one that matters.
 */
export function recordSupersededSubscription(db, {
  organizationId, provider, previousReference, previousPlan,
  replacedByReference, replacedByPlan,
}) {
  const previous = String(previousReference ?? '').trim();
  const next = String(replacedByReference ?? '').trim();
  if (!previous || !next || previous === next) return null;

  const id = uid('sup');
  const inserted = db.prepare(`
    INSERT INTO billing_superseded_subscriptions
      (id, organization_id, provider, provider_reference, plan, replaced_by_reference, replaced_by_plan)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(organization_id, provider, provider_reference) DO NOTHING
  `).run(id, organizationId, String(provider ?? '').toLowerCase(), previous, String(previousPlan ?? 'unknown'), next, String(replacedByPlan ?? 'unknown'));
  if (!inserted.changes) return null;

  // The reference is in the audit row on purpose. It is not a secret — it is
  // the identifier an operator types into the provider's dashboard to find the
  // subscription that is still charging somebody.
  audit(db, {
    organizationId,
    action: 'billing.subscription.superseded',
    targetType: 'organization',
    targetId: organizationId,
    metadata: { provider, superseded: previous, replacedBy: next, plan: previousPlan ?? null },
  });
  return id;
}

export function openSupersededSubscriptions(db, { limit = 100 } = {}) {
  return db.prepare(`
    SELECT s.id, s.organization_id AS organizationId, o.slug AS organizationSlug,
           s.provider, s.provider_reference AS reference, s.plan,
           s.replaced_by_reference AS replacedByReference, s.replaced_by_plan AS replacedByPlan,
           s.created_at AS createdAt
    FROM billing_superseded_subscriptions s
    LEFT JOIN organizations o ON o.id = s.organization_id
    WHERE s.status = 'open'
    ORDER BY s.created_at DESC, s.rowid DESC
    LIMIT ?
  `).all(Math.max(1, Math.min(Number(limit) || 100, 500)));
}

/**
 * An operator saying what happened to it.
 *
 * The resolution is free text because the answers differ: cancelled at the
 * provider, refunded, was already cancelled, belongs to a different customer.
 * What matters is that somebody looked, and that the row stops being open only
 * because they said so.
 */
export function resolveSupersededSubscription(db, id, { resolution, userId = null }) {
  const note = String(resolution ?? '').trim();
  if (!note) return false;
  const result = db.prepare(`
    UPDATE billing_superseded_subscriptions
    SET status = 'resolved', resolution = ?, resolved_by = ?, resolved_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status = 'open'
  `).run(note.slice(0, 500), userId, String(id));
  return result.changes > 0;
}
