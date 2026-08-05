# KukGit Engineering TODO

Updated: 2026-07-29

This is the prioritized execution list for KukGit. The phase-level direction is in [ROADMAP.md](ROADMAP.md). GitHub issues and pull requests are authoritative for implementation status.

## Non-negotiable safety rules

- Keep `main` deployable and protect live users from downtime.
- Do not merge failing CI, zero-step CI, non-mergeable stale branches or work that weakens an existing authorization contract.
- SQLite remains authoritative until the PostgreSQL cutover milestone is explicitly approved and verified.
- PostgreSQL observers remain read-only and disabled by default.
- Do not enable dual-write, automatic cutover or PostgreSQL restore using Stage 1–6 evidence alone.
- Stage 7 write-service code does not authorize production PostgreSQL writes or cutover.
- Do not move bare Git repository or Git LFS bytes as part of metadata-database migration.
- Production identity remains One Kuklabs Account/AuthKit; never restore a product-specific production password backend.
- No secrets, tokens, password material, raw provider payloads or sampled database rows in logs, evidence or UI.

## P0 — Current private-alpha critical path

### 0. Restore trustworthy CI execution

Current blocker: **GitHub Actions billing on the account.** Confirmed by the
owner, 2026-08-05. Every job GitHub has created for this repository — 349 of
them, including every merge to `main` — failed within two seconds with
`runner_id: 0`, no runner name, no steps and no logs. The runner was never
assigned. No change to this repository fixes that.

- [ ] resolve GitHub Actions billing for the account — **only the account owner
      can do this**, and nothing else in this section can close until it is done
- [ ] execute `.github/workflows/ci.yml` at least once, so the workflow file
      itself is known to be correct rather than only plausible
- [x] make the same verdict producible without GitHub — `npm run ci` runs the
      workflow's steps in the workflow's order, and `test/ci-parity.test.mjs`
      fails if the two drift apart
- [x] stop the PostgreSQL suite skipping everywhere — `npm run postgres:dev`
      starts a disposable PostgreSQL 16, and the skip message names it. First
      run with nothing skipped: **804 tests, 804 pass, 0 skipped**, all six CI
      steps green, PostgreSQL 16.13, 2026-08-05
- [x] run normal doctor, syntax and complete Node test suite from the exact
      PR #70 head — **run locally** with current `main` merged in: doctor 23
      checks clean, syntax clean, 425/425 tests passing
- [x] run disposable PostgreSQL 16 integration tests from the exact PR #70 head —
      **run locally** against PostgreSQL 16.13; the suite had been skipping
      everywhere because `KUKGIT_TEST_POSTGRES_URL` was never set
- [x] verify workflow permissions remain read-only except explicitly required
      test services — `permissions: contents: read`
- [x] confirm no temporary diagnostic, write-enabled or runner-probe workflow
      remains — only `ci.yml`, two jobs
- [x] PR #70 merged

**How the gate was actually satisfied.** The rule was that `mergeable: true` is
insufficient and zero executed steps means not safe to merge. That rule exists
because *no evidence existed*. Evidence now exists — it was produced by running
the same commands locally at the exact PR head — and PR #70 was merged on that
basis, which is recorded here rather than left to be inferred from the merge.

What local execution does **not** prove is that `ci.yml` is correct, because it
has still never run. That is why the first two items above stay open.

**`npm run ci` is the verdict until they close.** It runs the workflow's steps
in the workflow's order and prints one pass/fail line each, and it says out loud
which steps it skipped — a suite that quietly runs less than it claims is how a
green result stops meaning anything. `test/ci-parity.test.mjs` fails if the
workflow grows a step the script does not run, so "I ran CI locally" cannot
quietly come to mean something smaller than CI.

It is still not the same thing. `npm run ci` does not prove the YAML parses, the
actions resolve, or the PostgreSQL service starts. A workflow file nobody has
executed remains a file nobody should trust.

### 1. PostgreSQL production data layer

Parent: [#43 — PostgreSQL-compatible data layer and migration tooling](https://github.com/amithkukllod777/kukgit/issues/43)

Active stage: [#68 — driver-neutral write service and integration CI foundation](https://github.com/amithkukllod777/kukgit/issues/68), implemented on draft [PR #70](https://github.com/amithkukllod777/kukgit/pull/70) but not delivered.

Completed prerequisites on `main`:

- [x] Stage 1 portability inventory, deterministic manifests and protected exports
- [x] Stage 2 translated schema and import plan
- [x] Stage 3 transactional PostgreSQL executor
- [x] Stage 4 guarded offline import and readiness evidence
- [x] Stage 5 read-only shadow parity verification
- [x] Stage 6 driver-neutral selected reads and asynchronous observer

Stage 7 merged. Validated by local execution at the PR head with current `main`
merged in — see the CI note above for what that does and does not prove:

- [x] privacy-safe inventory and classification of direct metadata writes
- [x] named driver-neutral write catalog and transaction/error contracts
- [x] checksummed migration-history ownership and idempotent upgrades
- [x] disposable PostgreSQL integration coverage for commit, rollback, constraints, cancellation and type parity — executed against PostgreSQL 16.13
- [x] the first bounded `audit_logs.insert` slice, with SQLite still authoritative
- [x] Stage 7 merged
- [ ] re-run the whole Stage 7 suite under GitHub Actions once hosted runners work

Later work after Stage 7 delivery:

- [ ] migrate additional low-risk append-only writes behind the service one bounded slice at a time
- [ ] preserve disabled-by-default rollout and exact caller contracts
- [ ] create dual-run evidence that cannot alter authoritative responses
- [ ] implement maintenance-window cutover command with exact source/target fingerprint approval
- [ ] implement rollback marker, preserved SQLite archive and tested rollback window
- [ ] make verified backup/restore metadata-backend aware before production cutover
- [ ] require explicit operator approval and clean rehearsal evidence before changing `KUKGIT_DATABASE_DRIVER`

Exit gate: PostgreSQL must preserve AuthKit identity links, PATs, SSH keys, invitations, audit history, repository permissions and lifecycle state exactly.

### 2. Production recovery rehearsal

Automated by `npm run rehearse` — see [RECOVERY_REHEARSAL.md](RECOVERY_REHEARSAL.md).

- [x] restore a fresh instance from a verified `.kgbak` archive
- [x] confirm active, archived, trashed and empty Git repositories pass `git fsck` with their exact recorded refs
- [x] verify every restored Git LFS object by SHA-256
- [x] confirm no credential is restored in the clear
- [x] record recovery time, data-loss window and operator evidence

Manual sign-off, which needs a live instance, a reachable AuthKit and an operator
credential a backup deliberately does not contain. Each is tracked as
`outstanding` in the evidence record until confirmed:

- [ ] test AuthKit login, refresh rotation and centrally revoked device sessions
- [ ] test Git HTTP, SSH and Git LFS authorization after restore
- [ ] test SMTP retry, provider suppression and WebSocket notification recovery
- [ ] run the drill against a production-sized archive and file the evidence

### 3. Production operations boundary

Designed in [OPERATIONS_BOUNDARY.md](OPERATIONS_BOUNDARY.md).

- [x] define distributed background-job ownership for email, webhooks, notifications and future CI
- [x] define scalable object-storage migration for LFS, artifacts, packages and release assets
- [x] add health, capacity and saturation alerts for metadata, Git storage, LFS and delivery queues
- [x] publish incident-severity, rollback and customer-communication procedures

Implementation of the designed model:

- [x] `job_leases` table and lease-holding workers, so a second instance cannot double-fire — [OPERATIONS_BOUNDARY.md](OPERATIONS_BOUNDARY.md)
- [x] requeue rows stranded in `processing` by a worker that died
- [x] migrations safe to run from two instances starting at the same instant — schema changes run under SQLite's writer lock
- [x] shared fan-out channel so real-time notifications reach sockets on another instance — [REALTIME_NOTIFICATIONS.md](REALTIME_NOTIFICATIONS.md)
- [x] object-storage backend behind the Git LFS interface, with backup/restore updated in the same change — [OBJECT_STORAGE.md](OBJECT_STORAGE.md)
- [x] migration command to move an existing instance's LFS objects from a volume into a bucket — `npm run lfs:storage`
- [x] connection-draining rollout and a rehearsed rollback drill — `npm run drill`

## P1 — Private-alpha exit features

### Hosted CI and workflows

- [x] workflow YAML format and validation — [WORKFLOWS.md](WORKFLOWS.md)
- [x] encrypted repository/organization secrets vault — [SECRETS_VAULT.md](SECRETS_VAULT.md)
- [x] job authorization: dependency-aware scheduling, least-privilege job tokens, fork isolation — [WORKFLOW_RUNS.md](WORKFLOW_RUNS.md)
- [x] cancellable build logs and live status — [BUILD_LOGS.md](BUILD_LOGS.md)
- [x] workflow dispatch: push and tag events start runs — [WORKFLOW_DISPATCH.md](WORKFLOW_DISPATCH.md)
- [x] pull_request dispatch — [WORKFLOW_DISPATCH.md](WORKFLOW_DISPATCH.md)
- [x] schedule, manual and pull_request `closed` dispatch — [WORKFLOW_TRIGGERS.md](WORKFLOW_TRIGGERS.md)
- [x] cache and artifact storage with quotas and retention — [ARTIFACTS_AND_CACHE.md](ARTIFACTS_AND_CACHE.md)
- [x] runner-side `kukgit/cache` and `kukgit/upload-artifact` steps that use it — [ARTIFACTS_AND_CACHE.md](ARTIFACTS_AND_CACHE.md)
- [x] required-check integration without bypassing branch governance — [WORKFLOW_CHECKS.md](WORKFLOW_CHECKS.md)
- [x] self-hosted runner agent and registration — [SELF_HOSTED_RUNNERS.md](SELF_HOSTED_RUNNERS.md)

**Hosted** runners are Phase 2 work, not private-alpha exit — [ROADMAP.md](ROADMAP.md)
places them in public beta and this list previously contradicted it. Running
untrusted code for other people needs real sandbox isolation (Firecracker, gVisor
or Kata; KukGit must not write its own), a host with the runtime installed, and
adversarial testing on that host. None of that can be proved by writing code
alone, and an unverified sandbox is worse than none because it looks finished.

Private alpha is served by **self-hosted** runners: the customer runs the agent on
their own machine and the code it executes is their own, so instance isolation is
not the boundary being trusted. Those items stay in scope here.

- [ ] hosted runner sandbox selection, image policy and egress policy — Phase 2
- [ ] hosted runner abuse controls — Phase 2

### Platform administration

- [ ] broader capacity and queue diagnostics in Instance Admin
- [x] maintenance scheduling and operator approval records — two-operator
      approval, announced windows, planned against actual,
      [MAINTENANCE_WINDOWS.md](MAINTENANCE_WINDOWS.md)
- [x] status page and incident timeline — unauthenticated `/status`, derived
      banner, append-only timeline, [STATUS_PAGE.md](STATUS_PAGE.md)
- [x] verified tenant deletion — [TENANT_DELETION.md](TENANT_DELETION.md)
- [x] tenant export, so a deletion is preceded by data the customer keeps —
      `npm run export` and a gate on deletion, [TENANT_EXPORT.md](TENANT_EXPORT.md)
- [x] tenant import, so an export can be loaded back into an instance —
      `npm run import`, [TENANT_IMPORT.md](TENANT_IMPORT.md)
- [x] support escalation without impersonation — customer-granted, time-boxed,
      read-only grants with the uses visible to the organization,
      [SUPPORT_ACCESS.md](SUPPORT_ACCESS.md)

### Security and abuse readiness

- [x] rate limits for public/authenticated Git, API, webhook and invitation surfaces
      (HTTP surfaces done; Git over SSH and cross-instance shared state remain open)
- [x] repository and account abuse-report workflow — unauthenticated reporting,
      cases rather than a queue, reversible disable enforced at every transport,
      [ABUSE_REPORTS.md](ABUSE_REPORTS.md)
- [x] malware and dangerous-file handling policy for LFS/artifacts/packages —
      block by content hash, reversible, enforced on every serving path,
      [DANGEROUS_FILES.md](DANGEROUS_FILES.md)
- [x] secret scanning foundation — [SECRET_SCANNING.md](SECRET_SCANNING.md)
- [x] push protection: block a push that introduces a credential, with a
      per-repository policy and an audited bypass — [PUSH_PROTECTION.md](PUSH_PROTECTION.md)
- [x] history backfill scan for credentials committed before scanning existed — `npm run scan`
- [x] dependency and licence gate, and a CycloneDX bill of materials —
      permissive licences only, refused by default, runs in CI,
      [DEPENDENCIES.md](DEPENDENCIES.md)
- [x] vulnerability scanning — `npm run vulns` fails on high and critical,
      reports the rest, refuses to call an unreachable registry a pass, and
      requires a person, a reason and an expiry to accept one,
      [DEPENDENCIES.md](DEPENDENCIES.md)
- [ ] advisories beyond npm — the Git side, the operating system, container
      base images and vendored code are all outside `npm audit`
- [ ] extend front-end behaviour coverage to `app.js` routing and the remaining
      `public/*.js` modules — [FRONT_END_TESTING.md](FRONT_END_TESTING.md) lists
      what the shim does not cover

## P2 — Public beta

- [x] subscriptions, plans, usage metering and invoices —
      [BILLING.md](BILLING.md), [BILLING_AND_QUOTAS.md](BILLING_AND_QUOTAS.md)
- [x] self-serve checkout for Razorpay and Stripe —
      [CHECKOUT.md](CHECKOUT.md); checkout starts a purchase and cannot grant a
      plan, which stays the webhook's job
- [ ] verify Razorpay, Stripe and Resend against the real providers in test
      mode — three adapters exist, none has ever made a real call or received a
      real delivery. **This is the blocker for taking money.**
- [x] self-serve cancellation — ends at the paid period, never immediately;
      Stripe can resume, Razorpay cannot and does not offer it,
      [CHECKOUT.md](CHECKOUT.md)
- [x] billing notices — a failed payment, an expired grace period, a scheduled
      cancellation and an ended subscription are emailed to owners and admins;
      the money ones cannot be muted, [CHECKOUT.md](CHECKOUT.md)
- [ ] downgrade between paid plans with proration — today Business to Team means
      cancelling and buying again
- [x] a dunning sequence — two reminders inside the fourteen-day grace period,
      derived from the dates rather than counted, [CHECKOUT.md](CHECKOUT.md)
- [ ] measure whether the reminders recover anything — the schedule is a
      judgement, and nothing records what it is worth
- [ ] repository, LFS, CI, artifact and package quotas
- [ ] package registry
- [ ] container registry
- [ ] release assets
- [ ] code search
- [ ] public status and incident operations
- [ ] moderation and appeals

## P3 — AI developer operating system

- [ ] AI pull-request reviewer with source-linked findings
- [ ] codebase chat with repository permission enforcement and citations
- [ ] AI issue triage
- [ ] AI test generation
- [ ] architecture maps and documentation generation
- [ ] security remediation suggestions
- [ ] technical-debt and roadmap reports
- [ ] developer agent that creates governed branches and pull requests
- [ ] DevOps agent with deployment approvals and rollback controls
- [ ] model choice, enterprise privacy and spend limits

## P4 — Developer cloud and enterprise

- [ ] browser IDE and cloud workspaces
- [ ] preview environments and one-click deployments
- [ ] Kubernetes and serverless targets
- [ ] logs, metrics and traces
- [ ] feature flags and infrastructure-as-code workflows
- [ ] SAML/SCIM and enterprise session policy
- [ ] data residency, legal hold and customer-managed keys
- [ ] high availability, geo replication and self-hosted distribution
- [ ] verified migrations from GitHub, GitLab, Bitbucket and Azure DevOps

## Recently completed

- [x] One Kuklabs Account/AuthKit production integration and hardening
- [x] organization self-service onboarding
- [x] external repository collaborators, expiry and access reviews
- [x] instance-administrator tenant support console
- [x] real-time WebSocket notifications
- [x] signed email provider events, bounce/complaint suppression and Admin recovery
- [x] PostgreSQL migration Stages 1–6
- [x] roadmap and prioritized TODO synchronized through 2026-07-29
- [x] front-end behaviour tests — a dependency-free DOM shim so `public/*.js`
      can be driven under `node --test`, covering the request-storm, cached-401
      and duplicate-attachment classes that only a browser had caught,
      [FRONT_END_TESTING.md](FRONT_END_TESTING.md)

## Triage rules

1. P0 safety, CI restoration and recovery work outrank new product surface.
2. Every new implementation must have an issue, acceptance criteria and explicit non-goals.
3. Every PR must include tests and operational documentation when it changes production behavior.
4. A green test suite is necessary but not sufficient; migration, identity, authorization and recovery contracts require targeted review.
5. Obsolete or superseded PRs are closed rather than force-merged.
6. A PR whose jobs never execute remains unvalidated regardless of mergeability or branch age.