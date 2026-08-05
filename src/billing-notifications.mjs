import { createNotification, migrateNotifications, queueTransactionalEmail } from './notifications.mjs';
import { GRACE_DAYS } from './billing.mjs';
import { PLANS, planFor } from './plans.mjs';

/**
 * Telling somebody their payment failed.
 *
 * Until now a customer found out their card had been declined by noticing, two
 * weeks later, that their plan had changed. Everything needed to tell them
 * existed — an outbox, retries, bounce handling, a working transport — and
 * nothing was wired to billing.
 *
 * There are four moments worth a message, and they are the ones where the
 * customer can still do something or needs to know something has happened:
 *
 *   - **a payment failed** — fourteen days to fix a card
 *   - **the grace period ran out** — the plan has actually changed
 *   - **a cancellation was scheduled** — a receipt for a decision, and a way to
 *     find out it was not you who made it
 *   - **the subscription ended**
 *
 * There is deliberately no "your payment succeeded" message. A charge that
 * worked is on the invoice list, and mail nobody reads is mail that teaches
 * people not to read the next one.
 */

/**
 * Who hears about money.
 *
 * Owners and admins: the same people who may start and end a subscription. A
 * developer with push access did not agree to the charge and cannot fix the
 * card, and telling them a payment failed is telling them something they can
 * only worry about.
 */
function billingContacts(db, organizationId) {
  return db.prepare(`
    SELECT u.id, u.email, u.display_name AS displayName
    FROM org_members m JOIN users u ON u.id = m.user_id
    WHERE m.organization_id = ? AND m.role IN ('owner', 'admin')
    ORDER BY CASE m.role WHEN 'owner' THEN 0 ELSE 1 END, u.email
  `).all(organizationId);
}

function organizationOf(db, organizationId) {
  return db.prepare('SELECT id, slug, name FROM organizations WHERE id = ?').get(organizationId) ?? null;
}

function readableDate(value) {
  if (!value) return null;
  const date = new Date(String(value).includes('T') ? value : `${String(value).replace(' ', 'T')}Z`);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : null;
}

/**
 * What each moment says, and whether it can be turned off.
 *
 * `mandatory` messages go out whatever the recipient's email preference says.
 * Somebody who muted organization email did not thereby agree to stop being
 * told that a charge failed or that their plan has changed — those are notices
 * about money already taken or about to stop being taken, and burying them in a
 * preference is how a customer finds out from their bank instead.
 *
 * Everything here is a statement of fact with a link. No offers, no urgency, no
 * "act now" — this is not marketing, and the moment it reads like marketing it
 * gets filtered like marketing.
 */
function message(kind, { organization, plan, subscription, config, graceUntil, stage }) {
  const link = '#/organizations';
  const open = `Open KukGit: ${String(config.baseUrl).replace(/\/$/, '')}/#/organizations`;
  const who = organization.name || organization.slug;

  switch (kind) {
    case 'payment_failed': {
      const until = readableDate(graceUntil ?? subscription?.graceUntil);
      return {
        mandatory: true,
        title: `Payment failed for ${who}`,
        body: until
          ? `The last payment for the ${plan} plan did not go through. Nothing has changed yet — ${who} stays on ${plan} until ${until}, and every repository stays readable whatever happens. Updating the payment method with the provider is what clears it.`
          : `The last payment for the ${plan} plan did not go through. Updating the payment method with the provider is what clears it.`,
        subject: `Payment failed for ${who} on KukGit`,
        link,
        text: [
          `The last payment for ${who}'s ${plan} plan did not go through.`,
          '',
          until
            ? `Nothing has changed yet. ${who} stays on the ${plan} plan until ${until} — ${GRACE_DAYS} days from the failed charge. Update the payment method with the payment provider and the next attempt clears it.`
            : `Update the payment method with the payment provider and the next attempt clears it.`,
          '',
          'Whatever happens, no repository is deleted and everything stays readable. What stops on a free plan is adding more.',
          '',
          open,
        ].join('\n'),
      };
    }

    case 'payment_reminder': {
      const until = readableDate(graceUntil ?? subscription?.graceUntil);
      const days = stage?.daysLeft ?? null;
      const left = days === 1 ? 'tomorrow' : days ? `in ${days} days` : 'shortly';
      return {
        mandatory: true,
        title: `${who} moves to the free plan ${left}`,
        body: `The payment for the ${plan} plan still has not gone through${until ? `, so ${who} moves to the free plan on ${until}` : ''}. Nothing will be deleted and every repository stays readable — what stops is adding more.`,
        subject: `${who}'s KukGit plan changes ${left}`,
        link,
        text: [
          `The payment for ${who}'s ${plan} plan still has not gone through.`,
          '',
          until
            ? `${who} moves to the free plan on ${until}${days ? ` — ${left}` : ''}. Updating the payment method with the payment provider is what stops that.`
            : 'Updating the payment method with the payment provider is what stops that.',
          '',
          'If it does change, nothing is deleted. Every repository stays there and stays readable, over the web, Git HTTP, SSH and Git LFS. What stops is adding more.',
          '',
          open,
        ].join('\n'),
      };
    }

    case 'grace_expired':
      return {
        mandatory: true,
        title: `${who} is now on the free plan`,
        body: `The payment for the ${plan} plan was not completed in time, so ${who} has moved to the free plan. Nothing has been deleted and every repository is still readable — what stops is adding more. Choosing a plan again restores the limits immediately.`,
        subject: `${who} has moved to the free plan on KukGit`,
        link,
        text: [
          `The payment for ${who}'s ${plan} plan was not completed within ${GRACE_DAYS} days, so the organization has moved to the free plan.`,
          '',
          'Nothing has been deleted. Every repository is still there and still readable, over the web, Git HTTP, SSH and Git LFS. What stops is adding more — new repositories, more storage, more people.',
          '',
          'Choosing a plan again restores the limits immediately.',
          '',
          open,
        ].join('\n'),
      };

    case 'cancellation_scheduled': {
      const until = readableDate(subscription?.cancelsAt);
      return {
        mandatory: false,
        title: `${who} will move to the free plan${until ? ` on ${until}` : ''}`,
        body: `The ${plan} plan for ${who} was cancelled and will not renew${until ? `, ending on ${until}` : ''}. Everything keeps working until then, and nothing is deleted after.`,
        subject: `${who}'s KukGit plan will not renew`,
        link,
        text: [
          `The ${plan} plan for ${who} has been cancelled and will not renew${until ? `. It ends on ${until}.` : '.'}`,
          '',
          'Everything keeps working until then. After that the organization is on the free plan: nothing is deleted, every repository stays readable, and what stops is adding more.',
          '',
          // A cancellation somebody else made is the one thing here worth
          // acting on quickly, and they cannot act on it if nobody tells them.
          'If you did not expect this, an organization owner or admin scheduled it, and it is in the audit log.',
          '',
          open,
        ].join('\n'),
      };
    }

    case 'subscription_ended':
      return {
        mandatory: true,
        title: `${who} is now on the free plan`,
        body: `The ${plan} subscription for ${who} has ended. Nothing has been deleted and every repository is still readable — what stops is adding more.`,
        subject: `${who}'s KukGit subscription has ended`,
        link,
        text: [
          `The ${plan} subscription for ${who} has ended and the organization is now on the free plan.`,
          '',
          'Nothing has been deleted. Every repository is still there and still readable. What stops is adding more — new repositories, more storage, more people.',
          '',
          open,
        ].join('\n'),
      };

    default:
      return null;
  }
}

/**
 * Send one billing notice to the people who can act on it.
 *
 * Deduplicated on the organization, the kind and a period key, because the
 * thing that triggers these is a provider that retries. A customer whose card
 * fails three times in an hour has one problem, and three identical emails
 * about it makes it two.
 *
 * Never throws. A billing event that could not send an email is still a billing
 * event that must be applied — refusing the plan change because the mail server
 * is down would be the more expensive failure by far.
 */
export function notifyBilling(db, config, {
  organizationId, kind, plan, subscription = null, graceUntil = null, period = null, stage = null,
}) {
  try {
    migrateNotifications(db);
    const organization = organizationOf(db, organizationId);
    if (!organization) return { sent: 0 };
    // The label, not the identifier. "your team plan" reads like a typo in a
    // message somebody is already annoyed to be receiving.
    const stored = plan ?? subscription?.plan ?? null;
    const label = stored && PLANS[String(stored).toLowerCase()] ? planFor(stored).label : (stored ?? 'paid');
    const content = message(kind, { organization, plan: label, subscription, config, graceUntil, stage });
    if (!content) return { sent: 0 };

    const stamp = period ?? readableDate(graceUntil ?? subscription?.cancelsAt ?? subscription?.currentPeriodEnd) ?? 'now';
    const dedupeKey = `billing:${kind}:${organization.slug}:${stamp}`.replace(/[^A-Za-z0-9:_./-]/g, '-');

    let sent = 0;
    for (const contact of billingContacts(db, organizationId)) {
      createNotification(db, config, {
        userId: contact.id,
        category: 'organization',
        title: content.title,
        body: content.body,
        link: content.link,
        dedupeKey: `${dedupeKey}:${contact.id}`,
        metadata: { organization: organization.slug, kind, plan: plan ?? subscription?.plan ?? null },
        // Optional notices go through the preference-checked path; mandatory
        // ones are queued below whatever the preference says.
        email: content.mandatory ? null : {
          subject: content.subject,
          text: content.text,
          dedupeKey: `email:${dedupeKey}:${contact.id}`,
        },
      });
      if (content.mandatory) {
        queueTransactionalEmail(db, config, {
          userId: contact.id,
          to: contact.email,
          category: 'organization',
          subject: content.subject,
          text: content.text,
          dedupeKey: `email:${dedupeKey}:${contact.id}`,
        });
      }
      sent += 1;
    }
    return { sent, dedupeKey };
  } catch (error) {
    // Logged, not thrown. See the note above.
    console.error('KukGit billing notification', error.message);
    return { sent: 0, error: error.message };
  }
}
