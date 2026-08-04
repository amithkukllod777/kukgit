# KukGit Billing and Quotas

What an organization is using, and what its plan allows.

```bash
GET /api/plans                          # the plans somebody can be on
GET /api/orgs/:slug/usage               # any member of that organization
GET /api/orgs/:slug/usage/history       # closed periods, kept for invoicing
GET /api/instance-admin/usage           # every organization, for an operator
GET /api/instance-admin/usage/history   # a closed period across the instance
```

Measurement and enforcement. It bills nobody — see
[What this does not do](#what-this-does-not-do).

## Why this exists first

Nothing could be charged for, because nothing was counted. Quotas existed, but
one number applied to every repository on the instance regardless of who owned
it: `KUKGIT_LFS_REPOSITORY_QUOTA_BYTES`, set by the operator, identical for a
trial account and a paying customer. `organizations.plan` had existed since the
first schema and no code had ever read it.

A price needs a number behind it. This is that number.

## Measured, not counted

Everything is derived from the database and the disk at the moment it is asked.
Nothing increments a running total.

A counter is wrong the first time a process dies between the write and the
increment, and it stays wrong. A number that drifts is worse than one that costs
a directory walk, because the walk is slow and visible and the drift is neither.

The walk is cached per repository against the bare repository's mtime, so a
repository nobody has pushed to is measured once.

## The decisions worth knowing about

**Trashed repositories count.** A delete that has not been purged still occupies
the disk. Excluding Trash would make "delete it and restore it next month" a way
to store data for nothing.

**One LFS object in two repositories is charged once.** Both numbers are
reported — `lfsBytes` deduplicated, `lfsLinkedBytes` not — because the
difference is what deduplication is saving that customer, and a bill that hides
its own discount looks arbitrary.

**A running CI job is already costing.** Job time is counted per job, rounded up
to the minute, including jobs that have not finished. A workflow that has been
running for six hours is six hours of machine. Showing zero until it ends is how
a runaway stays invisible until the invoice.

**Storage is one limit.** Git, LFS, artifacts and caches land on the same disk,
so a plan limits their total. The breakdown is still reported — being over needs
to say what filled it — but four separate limits is four conversations where
there should be one.

**Symlinks are not followed.** They are not counted at all. The bytes belong to
whatever they point at, and following a link out of the tree would let anybody
who can write into a repository bill themselves for the operating system, or for
another tenant.

**An unknown plan is `free`, and says so.** A plan string that no longer exists —
renamed, mistyped in a migration — must not take somebody's Git hosting down.
The report carries `plan.recognised: false` and the string it did not recognise,
so it looks wrong rather than looking fine.

**Unlimited is not zero.** A `null` limit reports `ratio: null` and can never be
`over`. Returning `0` would draw a full bar on every unlimited plan.

## Plans

Limits live in `src/plans.mjs`, not in configuration. A limit that differs
between two instances of the same plan is a limit nobody can quote.

| | Free | Team | Business |
| --- | --- | --- | --- |
| Seats | 5 | 50 | 500 |
| Repositories | 20 | 500 | unlimited |
| Storage | 5 GiB | 100 GiB | 1 TiB |
| CI minutes / month | 500 | 10,000 | 50,000 |
| External collaborators | 5 | 50 | unlimited |

`founder` exists and is not purchasable. It is unlimited, and it is how Kuklabs'
own organization and any negotiated agreement are represented — a row somebody
set, rather than a limit quietly edited in code.

There are no prices here. Pricing is not an engineering decision, and a number
in this file would become the one somebody quotes.

`KUKGIT_LFS_REPOSITORY_QUOTA_BYTES` is unchanged and still applies. It is a
per-repository ceiling an operator sets for their own instance, which is a
different question from what an organization has bought.

## Who can see it

| | |
| --- | --- |
| `/api/plans` | any signed-in user |
| `/api/orgs/:slug/usage` | **any member**, down to `viewer` |
| `/api/instance-admin/usage` | instance administrators |

Every member, not only owners: people are asked to stay inside a limit they
cannot otherwise see, and the person who fills the disk is rarely the person who
bought the plan. An organization the caller is not in returns `404`, the same as
one that does not exist — otherwise the endpoint enumerates customers.

## Enforcement

Two rules shape all of it.

**Only growth is refused.** Clone, fetch, pull, read, browse and download all
continue when an organization is over its limit. What stops is adding: a new
repository, a new member, a new Git LFS object. A customer locked out of code
they have already pushed has lost work over an invoice, and no limit is worth
that. It is also what makes a downgrade survivable — what exists stays.

**The check is cheap, or it is not on the hot path.** Seats, repositories and
collaborators are one `COUNT(*)`. Storage needs the directory walk, so it is
cached for sixty seconds and enforced where the size is known before the bytes
arrive.

A refusal is **`402 Payment Required`**, code `PLAN_LIMIT_EXCEEDED`. Not `403`:
that would say the caller is not allowed to do this at all, and send somebody
looking for a permissions problem that does not exist. The request is well
formed and authorized; the plan does not cover it.

| Enforced at | Limit |
| --- | --- |
| `POST /api/repos` | repositories — before the bare repository is created, so a refusal leaves nothing behind |
| Invitation acceptance | seats — only for somebody who is not already a member; an existing member changing role takes no new seat |
| Git LFS batch `upload` | storage — the size is declared before the bytes arrive, and an object already held is not charged again |

The cached storage figure is dropped the moment an upload commits. Without that,
an organization could push past its limit once every cache window.

### Not enforced yet

- **Git pack size on push.** The size is not known until the pack has arrived,
  and measuring the repository on every push is the walk on the hot path. It
  needs a cheaper measure, and until then a plain `git push` is not limited.
- **CI minutes.** The limit is measured and reported; no job is refused for it.
- **External collaborators.** Measured and reported, not enforced.

## History, and why the peak

The current figure cannot be invoiced from. Storage is a **level**, not a total:
measure it once, at the end of the month, and the bill is whatever happened to
be on disk that day — which anybody who works it out answers by deleting on the
30th.

So every organization is sampled through the period, and the period closes on
the **peak**. The average and the last reading are kept beside it, because a
disputed invoice should be something to look at rather than something to argue
about.

CI minutes are a total rather than a level. They accumulate inside the period,
so the closing figure is the period's own sum.

| | |
| --- | --- |
| Sampled | every 6 hours, one instance at a time (`usage-sample` lease) |
| Closed | hourly check, closes the month that has ended (`usage-period-close` lease) |
| Kept | `usage_samples` per reading, `usage_periods` per closed month |

**A closed period never changes.** Closing again does nothing at all — not an
update, not an error. A figure that can be recomputed into a different number is
not evidence of anything, and somebody has already been invoiced for the first
one.

**A period with no samples is recorded as unknown, not as zero.** `samples: 0`
and `billable: false`. The instance being down for a month is not the same as a
customer having used nothing, and a bill for zero would say it was.

## What this does not do

- **No billing.** No prices, no invoices, no payment provider, no plan changes.
  `organizations.plan` is still set by hand. There is deliberately no endpoint
  that writes it: until money changes hands somewhere, an endpoint that could
  set a plan is a way to give the product away.
- **No cross-instance totals.** One instance measures itself.
- **Egress is not measured.** Clone and LFS download bandwidth is real cost and
  is not counted here.

## Related

- [Business model](BUSINESS_MODEL.md)
- [Git LFS](GIT_LFS.md) — the per-repository quota that already existed
- [Artifacts and cache](ARTIFACTS_AND_CACHE.md) — retention and per-repository limits
- [Roadmap](ROADMAP.md) — Phase 2 is where subscriptions and metering sit
