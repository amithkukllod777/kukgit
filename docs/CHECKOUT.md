# Checkout

## What this changes

Before this, moving a customer onto a paid plan meant an operator opening the
Razorpay or Stripe dashboard, creating a subscription by hand, and typing the
organization slug into its `notes` or `metadata`. Everything downstream —
webhook verification, entitlement, grace, invoices — already worked. The
purchase itself did not exist.

That is a demo, not a business. It does not run at night, it does not scale past
one operator, and a typo in the notes attributes somebody's payment to somebody
else's organization.

Checkout creates the provider object with those notes already correct and hands
back the URL to send the customer to.

## What it does not do

**Checkout cannot grant a plan.** It starts a purchase. The provider charges the
card, sends a webhook, and `billing.mjs` remains the only writer of
`organizations.plan`. Two ways to change a plan is two answers to "what is this
customer paying for", and they diverge the first time somebody uses the other
one.

A test asserts this directly: after a successful checkout the organization's
plan is unchanged and no subscription row exists.

## No price lives in KukGit

The provider holds the price. KukGit holds **which provider object a KukGit plan
means**:

| Integration | Field | Example |
| --- | --- | --- |
| `billing.razorpay` | `planIdTeam`, `planIdBusiness` | `plan_QxyzTeamMonthly` |
| `billing.stripe` | `priceIdTeam`, `priceIdBusiness` | `price_1QxyzTeamMonthly` |

Set them in **Instance Admin → Integrations**. Changing a price is then done in
the provider's dashboard, with no deploy — and there is only ever one answer to
what Team costs.

A provider with credentials but no plan id for a given plan is **not offered for
that plan**. Somebody setting up the first price and stopping is a real state,
and a button that would fail is worse than no button.

## The route

```
POST /api/orgs/:slug/billing/checkout
{ "plan": "team", "provider": "razorpay" }
→ 201 { "checkout": { "url": "https://rzp.io/i/…", "provider": "razorpay", "plan": "team",
                      "reference": "sub_…", "expiresAt": "…", "reused": false } }
```

`GET /api/orgs/:slug/billing` now also returns `checkout: [{ provider, plan,
label }]` — what **this person** can buy. A member who cannot change the plan
gets an empty list rather than buttons that would refuse them.

### Who may buy

Owner and admin, and no one else. A maintainer can merge to `main`; that is not
the same question as whether they may put the organization on a recurring
charge. External repository collaborators are refused whatever role they appear
to carry — their access is to one repository, granted by somebody else.

A maintainer gets **403**, not 404: they know the organization exists and
telling them otherwise is a lie they can disprove. A non-member gets 404.

The role is read off the membership row rather than asked for as a minimum,
because `orgAccess` returns early for a request already inside a
repository-access context and does not compare roles on that path.

## Attribution

Both adapters put the same two values on the object the provider will echo back:

```
kukgit_org  = organization slug, lowercased
kukgit_plan = plan id
```

Razorpay carries them in `notes`, unchanged from creation to every later event.
Stripe carries them in `metadata` — **on `subscription_data` as well as the
session**. Stripe does not copy a session's metadata to the subscription it
creates, and the webhook reads the subscription. Setting only the session's
produces a paid customer whose events cannot be attributed to anyone.

The alternative — a local table of provider references kept in step with theirs
— will drift, and drift here means somebody's money going to somebody else's
account.

## Clicking twice

A started checkout is offered again for **30 minutes** rather than starting
another. A customer who refreshes the tab must not end up with two
subscriptions to cancel.

Stripe additionally gets an `Idempotency-Key` bucketed to the same 30-minute
window, so two concurrent clicks that both miss the local lookup still produce
one session. **Razorpay's subscriptions API has no equivalent**, so there the
reused session is the only protection.

After the window, a new checkout is created — an abandoned session from this
morning is not what somebody is shown this afternoon.

## Cancelling

`free` is not sold at checkout, and neither is `founder`. Downgrading to free is
a **cancellation**: a different operation with different consequences.

```
POST /api/orgs/:slug/billing/cancel   → 200 { subscription, actions, alreadyRequested }
POST /api/orgs/:slug/billing/resume   → 200 { subscription, actions, alreadyActive }
```

A customer who can start a subscription and cannot end one is a customer whose
only exit is their bank. It is also, in most of the places KukGit will be sold,
the first thing a consumer authority asks about.

**Cancelling ends the subscription, not the access.** The customer paid for this
period and keeps it — Razorpay `cancel_at_cycle_end`, Stripe
`cancel_at_period_end`. Cutting them off the moment they click is charging for
something and then withdrawing it.

**The plan still changes only through a provider event.** Cancelling asks the
provider to stop billing; what moves the organization to `free` is the event
that arrives when the period runs out. A test asserts that immediately after
cancelling, the plan and the subscription status are unchanged.

### Who knows the end date

`billing_subscriptions.cancels_at` holds when the subscription is due to end.

- **Stripe is authoritative.** It sends `cancel_at_period_end` and `cancel_at`
  on every subscription event, so an undo done in Stripe's own portal is
  reflected here without KukGit being told separately.
- **Razorpay does not report it**, so what the cancellation request recorded is
  what stands — falling back to the current period end when Razorpay's response
  carries no date. A cancellation with no date reads as "already gone", and
  their repositories are still there.
- Either way it is cleared once the subscription is actually `canceled`. A date
  in the past that says "ends soon" is worse than no date.

### Resume

Stripe only. **Razorpay has no un-cancel** — a subscription cancelled at cycle
end stays cancelled and the customer buys again.

Which buttons a screen may show is decided by `subscriptionActions` on the
server and returned as `actions: { canCancel, canResume }`. Working it out in
the browser would mean the front end holding a copy of what each provider
supports, and being quietly wrong about it.

### What is refused

| Situation | Answer |
| --- | --- |
| No subscription | `404 BILLING_NO_SUBSCRIPTION` |
| Already ended | `409 BILLING_ALREADY_CANCELED` |
| Provider has not confirmed it yet (no reference) | `409 BILLING_NOT_CONFIRMED` |
| `manual` subscription, or a provider that cannot do it | `422 BILLING_ACTION_UNSUPPORTED` |
| Member, not owner/admin | `403 ORG_ADMIN_REQUIRED` |

A `manual` subscription is the interesting one: an operator recorded a bank
transfer or a negotiated agreement, there is no provider to call, and there is
no self-serve way to end an agreement somebody signed. The message says to
contact support, which is more use than a button that fails.

Cancelling twice does not call the provider twice — providers differ on what a
second cancellation of one subscription means, and none of the answers is better
than not asking.

## What is refused, and what is said

| Situation | Answer |
| --- | --- |
| Not signed in | `401 AUTH_REQUIRED` |
| Not a member | `404 ORG_NOT_FOUND` |
| Member, not owner/admin | `403 ORG_ADMIN_REQUIRED` |
| Cross-origin POST | `403 CSRF_BLOCKED` |
| `free`, `founder`, unknown plan | `422 BILLING_CHECKOUT_PLAN_INVALID` |
| Provider unknown **or** unconfigured | `422 BILLING_CHECKOUT_UNAVAILABLE` |
| Provider refused | `400 BILLING_CHECKOUT_REFUSED` |
| Provider unreachable | `502 BILLING_PROVIDER_UNREACHABLE` |
| Provider returned no link | `502 BILLING_CHECKOUT_FAILED` |

An unconfigured provider and an unknown one give the **same** answer. Which
providers an instance has set up is not something a guess should be able to
enumerate.

## Secrets in error messages

Providers echo credentials back in their error bodies. A refusal here is shown
to an operator and pasted into support messages, so the key is removed from the
message inside `providerRequest` — before it leaves the function, not before it
is displayed. By display time it has already been written down.

The audit row (`billing.checkout.started`) carries the provider, the plan and
the provider's reference. **Not the URL.** A checkout link starts a payment and
does not belong in a log somebody can page through.

## What is still missing

- **No purchase or cancellation has completed against a real provider.** Every
  endpoint here has been *called* from a live instance and refused on
  credentials — which proves the paths, the verbs and the auth shape, and
  nothing about what a successful response looks like. Razorpay and Stripe in
  test mode is the next step.
- **No downgrade between paid plans.** Business to Team means cancelling and
  buying, with no proration.
- **No proration.** A plan change takes effect when the provider says so.
- **No tax handling.** GST and VAT are the provider's, and `billing_invoices` is
  not a compliant tax document.
- **No customer portal.** Changing a card means going to the provider.
- **No dunning.** Nothing emails a customer whose payment failed.
- **Currency is the provider's.** A Razorpay plan in INR and a Stripe price in
  USD are two prices somebody has to keep in step by hand.

## Related

- [BILLING.md](BILLING.md) — events, entitlement, grace, webhooks
- [BILLING_AND_QUOTAS.md](BILLING_AND_QUOTAS.md) — what each plan allows
- [INTEGRATIONS.md](INTEGRATIONS.md) — where the keys and plan ids are set
