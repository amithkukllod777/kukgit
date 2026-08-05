import { leaseGate } from './job-leases.mjs';

/**
 * The reminders between a failed payment and the plan changing.
 *
 * The failure notice goes out the moment the provider says so, and then —
 * until now — nothing, for fourteen days, until a worker quietly moved the
 * organization to the free plan. Most of what a dunning sequence recovers is
 * recovered in those fourteen days, from people who meant to fix the card and
 * forgot, and the whole of it was silence.
 *
 * Two reminders, not five. The point is to be remembered, and a message every
 * day is a message that gets a filter rule.
 *
 * Nothing here changes a plan or touches a provider. It reads the grace period
 * that `billing.mjs` already wrote and sends a message about it.
 */

/**
 * When to say something, and what it is called.
 *
 * Ordered most urgent first, because the stage somebody is in is the first one
 * whose threshold their remaining days have crossed. A worker that had not run
 * for a week must send the *final* notice, not the one it missed on day seven —
 * a reminder that arrives after the deadline it warns about is worse than none.
 */
export const DUNNING_STAGES = Object.freeze([
  { id: 'final', withinDays: 2 },
  { id: 'reminder', withinDays: 7 },
]);

function parseStamp(value) {
  if (!value) return null;
  const text = String(value);
  const date = new Date(text.includes('T') ? text : `${text.replace(' ', 'T')}Z`);
  return Number.isFinite(date.getTime()) ? date : null;
}

/**
 * The stage a grace period is in, or `null`.
 *
 * Derived from the dates, never counted. A counter is wrong the first time a
 * process dies between incrementing it and sending, and it is wrong in the
 * other direction the first time somebody replays a month of events.
 */
export function dunningStage(graceUntil, now = new Date()) {
  const ends = parseStamp(graceUntil);
  if (!ends) return null;
  const msLeft = ends.getTime() - now.getTime();
  // Already over. The grace worker owns what happens then, and a reminder about
  // a deadline that has passed is a message about nothing.
  if (msLeft <= 0) return null;
  const daysLeft = msLeft / 86_400_000;
  const stage = DUNNING_STAGES.find((candidate) => daysLeft <= candidate.withinDays);
  return stage ? { ...stage, daysLeft: Math.max(1, Math.ceil(daysLeft)), endsAt: ends.toISOString() } : null;
}

/**
 * Send whichever reminder is due, to whoever has not had it.
 *
 * `notify` is passed in rather than imported so this stays testable without an
 * outbox and so the dependency keeps pointing one way, the same arrangement
 * `billing.mjs` uses for its own notifier.
 */
export function runDunning(db, { now = new Date(), notify } = {}) {
  if (typeof notify !== 'function') return { due: 0, sent: 0 };

  let rows;
  try {
    rows = db.prepare(`
      SELECT organization_id AS organizationId, plan, grace_until AS graceUntil
      FROM billing_subscriptions
      WHERE status = 'past_due' AND grace_until IS NOT NULL AND grace_until > ?
    `).all(now.toISOString());
  } catch {
    // Before the billing migration has run there is nothing to remind anybody
    // about, and that is not an error worth a log line every hour.
    return { due: 0, sent: 0 };
  }

  let sent = 0;
  let due = 0;
  for (const row of rows) {
    const stage = dunningStage(row.graceUntil, now);
    if (!stage) continue;
    due += 1;
    // The grace date is part of the key, so a customer whose card fails again
    // next month gets the sequence again. Without it the second failure would
    // be silently deduplicated against the first one, months earlier.
    const result = notify(db, {
      organizationId: row.organizationId,
      kind: 'payment_reminder',
      plan: row.plan,
      graceUntil: row.graceUntil,
      period: `${stage.id}-${String(row.graceUntil).slice(0, 10)}`,
      stage,
    });
    if (result?.sent) sent += 1;
  }
  return { due, sent };
}

/**
 * Hourly, and behind the same kind of lease as every other worker.
 *
 * Hourly is enough for a fourteen-day window and it means a restart does not
 * skip a stage: the stage is derived from the dates, so whenever the worker
 * next runs it sends whatever is due rather than whatever it would have sent
 * had it been running.
 */
export function startBillingDunningWorker(db, { intervalMs = 3600_000, notify, gate = leaseGate(db, 'billing-dunning') } = {}) {
  const tick = () => {
    try {
      if (!gate()) return;
      runDunning(db, { notify });
    } catch (error) { console.error('KukGit billing dunning worker', error.message); }
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return () => { clearInterval(timer); gate.release?.(); };
}
