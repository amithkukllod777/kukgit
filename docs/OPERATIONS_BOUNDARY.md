# KukGit Production Operations Boundary

What KukGit operates, how it is watched, and what happens when it breaks. This
document defines the boundary between "runs on one box" and "runs as a service",
and states which side each subsystem is on today.

Nothing here changes the safety rules in [TODO.md](TODO.md). SQLite remains
authoritative and PostgreSQL remains observation-only.

## Where the release actually stands

Every background worker is an in-process `setInterval` on the node serving
traffic, and each one now runs behind a **named lease**:

| Worker | Module | Interval | Lease |
| --- | --- | --- | --- |
| Email outbox | `src/notifications.mjs` | 30s | `email` |
| Webhook delivery | `src/webhooks.mjs` | configurable | `webhooks` |
| Operational notifications | `src/operations-notifications.mjs` | 5m | `operational-alerts` |
| External access reviews | `src/external-access-reviews.mjs` | daily | `external-access-reviews` |
| Workflow schedules | `src/workflow-triggers.mjs` | 60s | `workflow-schedule` |
| Stalled build reaper | `src/workflow-logs.mjs` | 60s | `stalled-jobs` |
| CI storage retention | `src/workflow-storage.mjs` | hourly | `storage-retention` |
| WebSocket heartbeat | `src/realtime-notifications.mjs` | 25s | none — per-process by design |

Two instances against the same volume therefore own one job each rather than both
doing all of them. Verified by running two instances against one volume: each job
had exactly one owner, and killing the owner moved its jobs to the survivor.

`GET /api/instance-admin/health` reports `instance.leases`, so which node owns
which job is visible from the running system rather than only from documentation.

### What is still single-instance

Two things, and neither is fixed by a lease:

- **Real-time WebSocket fan-out.** The socket registry is per process, so a
  notification created on instance A does not reach a socket held by instance B.
  The inbox stays durable either way — the socket is an accelerator, never the
  delivery guarantee — but multi-node real-time needs a shared channel.
- **Concurrent startup migrations.** Two instances starting at the same instant
  race on `ALTER TABLE … ADD COLUMN` and one crashes with `duplicate column
  name`. Found by starting two instances simultaneously during the lease
  verification. A rolling deploy that starts instances sequentially avoids it;
  making migrations safe to run concurrently is separate work, tracked below.

## Background job ownership

The target is one owner per job, chosen by a lease that survives a crash.

### Model

A `job_leases` table holds one row per named job: `job`, `owner` (instance id),
`acquired_at`, `heartbeat_at`, `lease_expires_at`. An instance runs a worker only
while it holds an unexpired lease, renewed on a heartbeat well inside the expiry.
An instance that stops heartbeating loses its lease and another instance takes
over after expiry.

Leases are per *job*, not per instance, so email can run on one node while
webhooks run on another.

### Why a lease rather than a queue service

A lease is a few dozen lines against the metadata database KukGit already has.
An external queue is another dependency to run, secure, back up and restore, and
it would need its own recovery rehearsal. The lease model is enough for the job
count here — five workers, none of them high-frequency — and it does not change
the backup story at all.

The decision to revisit is not "is a queue nicer" but "do jobs need fan-out
across many workers per job". None do today.

### Requirements

- Claim-then-work: a worker claims a row by primary key with a conditional
  update, so two workers cannot process the same row even during a lease handover.
  The outbox and delivery tables already work this way.
- Crash recovery: rows stuck in `processing` past a threshold must return to
  `pending`. Today nothing does this, which is why `*.stuck_processing` is a
  critical signal at a count of one rather than a metric to watch.
- Idempotent effects: an email or webhook delivered twice must be indistinguishable
  from once where the protocol allows, and audit-visible where it does not.
- Fencing: a worker that lost its lease mid-batch must not commit the result.

### Real-time notifications

The WebSocket registry is per-process. A notification created on instance A does
not reach a socket held by instance B. Multi-node real-time therefore needs a
shared fan-out channel, and the notification stays durable in the inbox
regardless — the socket is an accelerator, never the delivery guarantee. That
property must survive whatever fan-out is chosen.

## Object storage

Repositories and Git LFS objects live on the instance volume today. That is the
binding constraint on both horizontal scale and recovery time.

The migration order is set by risk, not convenience:

1. **Git LFS objects first.** Already content-addressed by SHA-256, already
   accessed through a narrow interface (`src/git-lfs.mjs`), already verified by
   digest on read. A storage backend swaps in behind that interface without
   touching Git.
2. **Future artifacts, packages and release assets.** Design them for object
   storage from the start; do not add a second thing to migrate later.
3. **Bare Git repositories last, and only with a proven design.** Git's object
   and pack layout assumes a real filesystem. Object-store-backed Git is a
   substantial engineering problem, not a configuration change, and moving
   repository bytes must never be bundled into a metadata migration.

Requirements for any backend:

- content-addressed keys; verification by digest on read stays mandatory
- server-side encryption at rest and TLS in transit
- credentials scoped to the KukGit bucket only, never account-wide
- backup and restore updated in the same change, and rehearsed with
  `npm run rehearse` before the backend is considered live
- the existing per-object, per-repository and per-instance quotas preserved

Until then, plan capacity with the volume in mind and alert on
`storage.volume_free`.

## Alerting

`GET /api/instance-admin/health` returns every saturation signal with the
thresholds it was judged against and a verdict of `ok`, `warning` or `critical`.
Thresholds live in configuration (`KUKGIT_SATURATION_*`), so every deployment
alerts on the same numbers and an operator can read the same values the alerts use.

| Signal | Meaning |
| --- | --- |
| `email.backlog_depth` / `webhooks.backlog_depth` | queue depth |
| `email.oldest_waiting_age` / `webhooks.oldest_waiting_age` | how long the oldest item has waited |
| `*.stuck_processing` | claimed by a worker that died; nothing will retry it |
| `storage.database_bytes` | SQLite metadata file size |
| `storage.lfs_quota_used` | percent of the instance LFS quota |
| `storage.volume_free` | percent free on the data volume |
| `backups.newest_age` | age of the newest snapshot |
| `backups.retained` | how many snapshots exist |
| `realtime.connection_capacity` | percent of the socket cap in use |

Depth and age are separate on purpose. A deep queue that is draining is healthy;
a shallow queue that has not moved in an hour is not. Depth alone cannot tell
them apart.

An instance that has never been backed up reports `backups.newest_age` as
critical rather than zero. A missing backup must never read as a fresh one.

`GET /api/health` is liveness (is the process up). `GET /api/health/ready` is
readiness (can it serve): database reachable, repository storage writable, data
volume writable. Readiness is public and returns a status code with no detail —
a load balancer needs the code; nobody else needs to know which subsystem is
failing. The full signal detail requires an instance operator.

Alert on `critical` immediately and on sustained `warning`. Do not alert on a
single `warning` sample; every threshold here is a level, not an event.

## Incident severity

| | Definition | Response | Communication |
| --- | --- | --- | --- |
| **SEV1** | Data loss or exposure risk, or a total outage. Repository corruption, authorization bypass, credential exposure. | Immediately. Maintenance mode on; preserve evidence before repairing. | Notify affected organizations within 1 hour; written follow-up within 5 business days. |
| **SEV2** | Major function unavailable without data risk. Git push failing, login failing, LFS unavailable. | Within the hour. | Status note at declaration and at resolution. |
| **SEV3** | Degraded but usable. Queue backlog, slow diffs, delayed notifications. | Next business day. | Only if customer-visible. |
| **SEV4** | Cosmetic or internal. | Normal backlog. | None. |

Severity is set by impact, not by cause. A one-tenant outage that loses data is
SEV1; a whole-instance slowdown that loses nothing is SEV3.

Standing rules:

- **Preserve before repairing.** On any SEV1 touching data, snapshot the damaged
  state before changing it. `restore` writes only to an empty target and never
  overwrites — keep it that way.
- **No silent data repair.** Direct SQL against production requires a verified
  backup and a written ownership decision, and it emits an audit event.
- **Suspected credential exposure is SEV1** regardless of whether use is
  confirmed. Rotate first, investigate second.

## Rollback

KukGit's rollback safety comes from the same property that makes migrations safe:
schema changes are additive.

- **Application rollback** is redeploying the previous version. Safe whenever no
  migration in the interval removed or narrowed a column. Every migration must be
  written so this holds.
- **Data rollback** is a restore, and it is a last resort — it discards
  everything since the snapshot. The cost is exactly `recovery.dataLossWindow` in
  the most recent rehearsal record.
- **Metadata-backend rollback** is not available and must not be attempted.
  SQLite stays authoritative; there is no PostgreSQL cutover to roll back from.

Before any deploy that could need rolling back: take a verified backup and record
the version being replaced. Rollback that requires a restore is an incident, so
declare it as one.

## Zero-downtime rollout

With a single instance there is a brief gap while the process restarts. That is
the honest position for this release; do not describe it as zero-downtime.

The current procedure:

1. Verified backup.
2. Maintenance mode on — writes are refused with a clear message rather than
   failing halfway.
3. Deploy, run `npm run doctor`, start.
4. Confirm `GET /api/health/ready` returns 200.
5. Maintenance mode off.

Actual zero-downtime rollout requires the job-ownership model above, plus a
proxy that drains connections. Until both exist, the rehearsal to run on a
schedule is the *rollback* one: deploy a version, roll it back, and confirm the
instance is serviceable — not a blue/green cutover that cannot be performed.

## Open work

Tracked as P0.3 in [TODO.md](TODO.md):

- [x] health, capacity and saturation signals with configurable thresholds
- [x] readiness distinct from liveness
- [x] incident-severity, rollback and communication procedures
- [x] `job_leases` table and lease-holding workers
- [x] requeue of rows stranded in `processing`
- [ ] migrations safe to run from two instances starting at the same instant
- [ ] shared fan-out channel for real-time notifications across instances
- [x] object-storage backend behind the Git LFS interface
- [x] migration command for an instance whose objects are already on a volume
- [ ] connection-draining rollout and a rehearsed rollback drill
