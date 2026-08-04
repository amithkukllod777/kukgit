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
verify(rawBody, headers, { config, db })  // → { eventId, type, payload } or null
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

## Razorpay

```
Webhook URL   https://git.kuklabs.com/api/billing/webhooks/razorpay
Secret        Instance Admin → Integrations → Razorpay → Webhook secret
```

Razorpay signs the body with HMAC-SHA256 and the webhook secret, hex encoded, in
`x-razorpay-signature`. It also sends **`x-razorpay-event-id`**, stable across
its retries — that is what the core deduplicates on. Hashing the body instead
would make a retry look new whenever Razorpay changed a byte of it, which is the
opposite of what deduplication is for.

**A missing secret verifies nothing rather than everything.** An instance that
has not been configured refuses the webhook; it does not accept any body that
arrives at the URL.

Which organization and which plan come from the subscription's `notes`, which
Razorpay carries unchanged from creation to every later event:

```json
"notes": { "kukgit_org": "kuklabs", "kukgit_plan": "team" }
```

A note naming an organization that does not exist resolves to nothing rather
than to the first row — a webhook must not be able to pick a customer by being
wrong. `founder` in a note is refused like any other route to the unlimited
plan.

| Razorpay event | Status |
| --- | --- |
| `subscription.activated`, `.charged`, `.resumed` | `active` |
| `subscription.authenticated` | `trialing` |
| `subscription.pending`, `.halted`, `.paused` | `past_due` |
| `subscription.cancelled`, `.completed`, `.expired` | `canceled` |

`pending` is a charge that failed and will be retried; `halted` is Razorpay
giving up. Both are `past_due` here — the customer's payment has not gone
through, and the grace period is what decides how long that is survivable, not
the difference between those two names.

`subscription.charged` also records an invoice. Razorpay reports **paise**,
which is already the minor unit, so nothing is converted. If the invoice cannot
be recorded the plan change still applies: the customer paid, and refusing to
activate them over our own bookkeeping would be punishing them for it.

The adapter is registered whether or not it is configured. A `404` would tell a
stranger which providers an instance has set up.

## Stripe

```
Webhook URL   https://git.kuklabs.com/api/billing/webhooks/stripe
Secret        Instance Admin → Integrations → Stripe → Webhook signing secret
```

Stripe signs `${timestamp}.${rawBody}` and sends `stripe-signature: t=…,v1=…`.

The timestamp is **inside the signed material**, so a delivery captured off a
proxy log is not a working request tomorrow. Anything outside five minutes is
refused, in both directions — a delivery from the future is as much a sign of a
forged header as one from last week. Razorpay has no equivalent, which is worth
knowing when comparing the two.

Stripe sends **more than one `v1`** while a signing secret is being rotated, and
both are valid. Taking only the first would break exactly the deployment that is
trying to rotate safely, so every `v1` is tried.

Organization and plan come from the subscription's `metadata`:

```json
"metadata": { "kukgit_org": "kuklabs", "kukgit_plan": "team" }
```

| Stripe status | Status |
| --- | --- |
| `trialing` | `trialing` |
| `active` | `active` |
| `past_due`, `unpaid`, `incomplete`, `paused` | `past_due` |
| `incomplete_expired`, `canceled` | `canceled` |

`customer.subscription.deleted` is `canceled` **from the event, not the object**.
Stripe sends the subscription as it last was, which may still read `active`;
taking the status from the object there would keep a cancelled customer on their
plan.

`invoice.paid` records an invoice and moves nothing — the subscription event
does that. `invoice.payment_failed` moves the subscription to `past_due`, which
opens the grace period rather than taking the plan away. Amounts are Stripe's
minor units already: cents in USD, paise in INR, converted nowhere.

## What this does not do

- **No checkout.** Nothing creates a Razorpay subscription or generates a
  payment link, so the `notes` above have to be set by whatever does — today,
  the Razorpay dashboard.
- **No prices.** Nothing here knows what a plan costs. With a provider, the
  provider holds the price; without one, the operator types the amount.
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
