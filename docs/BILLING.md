# KukGit Billing

Subscriptions, invoices, and the one path that changes what an organization is
entitled to.

What is being counted is in [BILLING_AND_QUOTAS.md](BILLING_AND_QUOTAS.md). This
is the part that takes money for it.

```bash
GET  /api/orgs/:slug/billing                        # any member of that organization
POST /api/billing/webhooks/:provider                # the provider, verified by signature
POST /api/instance-admin/billing/subscriptions      # an operator, for anything off-provider
POST /api/instance-admin/billing/invoices           # an operator
GET  /api/instance-admin/billing/events             # an operator
```

## One writer

`organizations.plan` is written in `src/billing.mjs` and nowhere else.

Two ways to change a plan is two answers to "what is this customer paying for",
and they diverge the first time somebody uses the other one. Everything that
changes a plan — a provider webhook, an operator recording a bank transfer —
arrives as a **billing event**, is recorded, and is applied from there. "What
changed this plan" therefore always has an answer, and it is the same kind of
answer whoever changed it.

There is no endpoint that sets a plan directly. There was deliberately none
before this existed either.

## Providers are adapters

Razorpay and Stripe verify differently, name their events differently, and
disagree about what a subscription is. None of that belongs in the part that
decides what an organization is entitled to.

An adapter implements two functions and touches no database:

```js
verify(rawBody, headers, config)   // → { eventId, type, payload } or null
normalize(verified, { db, config })// → { organizationId, plan, status, … } or null
```

A provider that could write directly is a provider that can grant plans. The
registry exists so that none of them can.

**Verification runs on the raw bytes, before anything reads the payload.**
Parsing and re-serialising changes key order and whitespace, and the signature
then fails for reasons nobody can see. Anything that reads the body first is
trusting a stranger to say who they are.

## Idempotency

Every provider retries. A retry that applied a change twice would be
indistinguishable from two real changes.

Events are unique on `(provider, provider_event_id)` — the provider's own
identifier, because it is the only one both sides agree on, and per provider
because providers do not coordinate their identifiers with each other.

A duplicate returns **`200`**. Anything else and the provider retries, and a
queue that never drains is the provider's problem becoming ours.

A **failed** event stays recorded with why it failed. Deleting it would make the
retry look like a first delivery, and the failure would repeat silently instead
of being visible once.

## Grace

A failed payment does not take the plan away that hour. A card expires, a bank
declines a legitimate charge, a webhook arrives late — and same-hour enforcement
turns a payment problem into an outage the customer did not cause.

`past_due` keeps its plan for **14 days**. After that, and on `canceled`, the
entitlement is `free`.

Nothing is deleted, ever. Enforcement refuses growth and never a read, so a
lapsed customer keeps every repository, every object and every setting they had.
They cannot add more until they are current.

A worker expires grace hourly, because the provider sends `past_due` once and
then goes quiet — nothing else is watching the clock.

## Off-provider subscriptions

An operator can record a subscription with no provider involved: a bank
transfer, an invoice paid by purchase order, a negotiated agreement. It goes in
as a `manual` event like any other, and the operator is named in the audit row.

That path has to exist before a provider is wired up, and it is how an
enterprise agreement will always work.

`founder` cannot be bought. It is the unlimited plan, and a provider event that
could select it would be a way to buy everything for the price of the cheapest
thing the provider will sell. It is set by hand, in the database.

## Money is stored as whole minor units

`amount_minor` plus a three-letter currency. ₹1,499.00 is `149900` and `INR`.

A float amount is how a rounding difference becomes a recurring complaint nobody
can reproduce.

## What is not stored

No card data. No provider secret. No raw provider payload.

What is kept is the reference the provider issued, the event id, the type and
the outcome. The audit row carries the plan change and nothing else — it is read
by more people than a billing record is.

## What this does not do

- **No provider adapters yet.** The registry, the verification contract and the
  webhook route exist; Razorpay and Stripe are the next change. Until then the
  only working path is the operator one.
- **No prices.** Nothing here knows what a plan costs. With a provider, the
  provider holds the price; without one, the operator types the amount.
- **No checkout.** Nothing generates a payment link or a hosted page.
- **No tax handling.** GST, VAT, invoice numbering and the legal format of an
  invoice are not addressed. `billing_invoices` records what was charged; it is
  not a compliant tax document.
- **No dunning.** Nothing emails a customer whose payment failed. They find out
  when their plan changes, which is not good enough for anybody being charged.
- **No proration.** A plan change takes effect immediately and no partial period
  is computed.

## Related

- [Billing and quotas](BILLING_AND_QUOTAS.md) — what is measured and enforced
- [Operations boundary](OPERATIONS_BOUNDARY.md) — the lease the grace worker uses
- [Roadmap](ROADMAP.md)
