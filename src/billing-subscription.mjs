import { httpError } from './security.mjs';
import { recordCancellationIntent, subscriptionFor } from './billing.mjs';
import { checkoutProvider } from './billing-checkout.mjs';

/**
 * Leaving.
 *
 * A customer who can start a subscription and cannot end one is a customer
 * whose only exit is their bank. It is also, in most of the places KukGit will
 * be sold, the thing a consumer authority asks about first — and it is not a
 * feature, it is the other half of the one already shipped.
 *
 * Two rules shape everything here:
 *
 * **Cancelling ends the subscription, not the access.** The customer paid for
 * this period and keeps it. Cutting them off the moment they click is charging
 * for something and then withdrawing it, and it turns a routine decision into a
 * support ticket.
 *
 * **The plan still changes only through a provider event.** This asks the
 * provider to stop billing. What moves the organization to `free` is the event
 * that arrives when the period runs out, exactly as before — nothing here is a
 * second writer of `organizations.plan`.
 */

/**
 * A subscription this instance can act on at its provider.
 *
 * `manual` is the interesting refusal. An operator recorded a bank transfer or
 * a negotiated agreement; there is no provider to call and no self-serve way to
 * end an agreement somebody signed. Saying that is more use than a button that
 * fails.
 */
function actionable(db, organizationId, action) {
  const subscription = subscriptionFor(db, organizationId);
  if (!subscription) throw httpError(404, 'This organization has no subscription.', 'BILLING_NO_SUBSCRIPTION');
  if (subscription.status === 'canceled') {
    throw httpError(409, 'This subscription has already ended.', 'BILLING_ALREADY_CANCELED');
  }

  const adapter = checkoutProvider(subscription.provider);
  if (!adapter || typeof adapter[action] !== 'function') {
    throw httpError(
      422,
      subscription.provider === 'manual'
        ? 'This subscription was arranged directly with Kuklabs. Contact support to change it.'
        : `${subscription.provider} cannot ${action} a subscription from here.`,
      'BILLING_ACTION_UNSUPPORTED',
    );
  }
  if (!subscription.reference) {
    // Nothing to name at the provider. Happens between paying and the first
    // subscription event arriving, and it is a wait rather than a failure.
    throw httpError(409, 'This subscription is not confirmed by the provider yet. Try again shortly.', 'BILLING_NOT_CONFIRMED');
  }
  return { subscription, adapter };
}

export async function requestCancellation(db, config, { organization, userId = null, fetchImpl = globalThis.fetch } = {}) {
  const { subscription, adapter } = actionable(db, organization.id, 'cancel');
  if (subscription.cancelsAt) {
    // Already cancelled. Asking the provider again is a second cancellation of
    // one subscription, and providers differ on what that means.
    return { subscription, alreadyRequested: true };
  }
  const result = await adapter.cancel(db, config, { subscription, fetchImpl });
  return {
    subscription: recordCancellationIntent(db, organization.id, {
      // A provider that does not say when leaves the period end, which is what
      // the customer was told. A cancellation with no date reads as "already
      // gone", and their repositories are still there.
      cancelsAt: result?.cancelsAt ?? subscription.currentPeriodEnd ?? null,
      userId,
      provider: subscription.provider,
    }),
    alreadyRequested: false,
  };
}

export async function resumeSubscription(db, config, { organization, userId = null, fetchImpl = globalThis.fetch } = {}) {
  const { subscription, adapter } = actionable(db, organization.id, 'resume');
  if (!subscription.cancelsAt) return { subscription, alreadyActive: true };
  await adapter.resume(db, config, { subscription, fetchImpl });
  return {
    subscription: recordCancellationIntent(db, organization.id, {
      cancelsAt: null,
      userId,
      provider: subscription.provider,
      resumed: true,
    }),
    alreadyActive: false,
  };
}

/**
 * What the screen may offer, decided here rather than guessed at in the browser.
 *
 * `canResume` is false for Razorpay whatever the state, because Razorpay has no
 * un-cancel: a subscription cancelled at cycle end stays cancelled and the
 * customer buys again.
 */
export function subscriptionActions(db, organizationId) {
  const subscription = subscriptionFor(db, organizationId);
  if (!subscription || subscription.status === 'canceled') return { canCancel: false, canResume: false };
  const adapter = checkoutProvider(subscription.provider);
  return {
    canCancel: typeof adapter?.cancel === 'function' && Boolean(subscription.reference) && !subscription.cancelsAt,
    canResume: typeof adapter?.resume === 'function' && Boolean(subscription.reference) && Boolean(subscription.cancelsAt),
  };
}
