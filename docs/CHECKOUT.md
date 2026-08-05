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

## Downgrading

`free` is not sold at checkout, and neither is `founder`.

Downgrading to free is a **cancellation**: a different operation with different
consequences, and calling it a purchase would hide that. It is not implemented —
today a customer cancels in the provider's own portal and the resulting
`subscription.cancelled` / `customer.subscription.deleted` webhook moves them to
free, with the usual grace behaviour.

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

- **Nothing here has run against a real provider.** The adapters are written to
  the documented APIs and tested against a recorded fetch. Razorpay and Stripe
  in test mode is the next step, and until it happens this is unproven.
- **No cancellation or downgrade in KukGit.** See above.
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
