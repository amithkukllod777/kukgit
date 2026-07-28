# KukGit Engineering TODO

Updated: 2026-07-28

This is the prioritized execution list for KukGit. The phase-level direction is in [ROADMAP.md](ROADMAP.md). GitHub issues and pull requests are authoritative for implementation status.

## Non-negotiable safety rules

- Keep `main` deployable and protect live users from downtime.
- Do not merge failing CI, non-mergeable stale branches or work that weakens an existing authorization contract.
- SQLite remains authoritative until the PostgreSQL cutover milestone is explicitly approved and verified.
- PostgreSQL observers remain read-only and disabled by default.
- Do not enable dual-write, automatic cutover or PostgreSQL restore using Stage 1–6 evidence alone.
- Do not move bare Git repository or Git LFS bytes as part of metadata-database migration.
- Production identity remains One Kuklabs Account/AuthKit; never restore a product-specific production password backend.
- No secrets, tokens, password material, raw provider payloads or sampled database rows in logs, evidence or UI.

## P0 — Current private-alpha critical path

### 1. PostgreSQL production data layer

Parent: [#43 — PostgreSQL-compatible data layer and migration tooling](https://github.com/amithkukllod777/kukgit/issues/43)

Active next stage: [#68 — driver-neutral write service and integration CI foundation](https://github.com/amithkukllod777/kukgit/issues/68)

Completed prerequisites:

- [x] Stage 1 portability inventory, deterministic manifests and protected exports
- [x] Stage 2 translated schema and import plan
- [x] Stage 3 transactional PostgreSQL executor
- [x] Stage 4 guarded offline import and readiness evidence
- [x] Stage 5 read-only shadow parity verification
- [x] Stage 6 driver-neutral selected reads and asynchronous observer

Next work:

- [ ] inventory and classify all remaining synchronous metadata reads and writes
- [ ] move remaining safe read paths behind driver-neutral services without changing caller contracts
- [ ] design a driver-neutral write service with explicit transaction semantics
- [ ] add PostgreSQL-backed integration CI using an isolated disposable database
- [ ] define migration-history ownership and idempotent runtime schema upgrades
- [ ] create dual-run evidence that cannot alter the authoritative response
- [ ] implement maintenance-window cutover command with exact source/target fingerprint approval
- [ ] implement rollback marker, preserved SQLite archive and tested rollback window
- [ ] make verified backup/restore metadata-backend aware before production cutover
- [ ] require explicit operator approval and clean rehearsal evidence before changing `KUKGIT_DATABASE_DRIVER`

Exit gate: PostgreSQL must preserve AuthKit identity links, PATs, SSH keys, invitations, audit history, repository permissions and lifecycle state exactly.

### 2. Production recovery rehearsal

- [ ] restore a fresh instance from a verified `.kgbak` archive
- [ ] confirm active, trashed and empty Git repositories pass `git fsck`
- [ ] verify every restored Git LFS object by SHA-256
- [ ] test AuthKit login, refresh rotation and centrally revoked device sessions
- [ ] test Git HTTP, SSH and Git LFS authorization after restore
- [ ] test SMTP retry, provider suppression and WebSocket notification recovery
- [ ] record recovery time, data-loss window and operator evidence

### 3. Production operations boundary

- [ ] define distributed background-job ownership for email, webhooks, notifications and future CI
- [ ] define scalable object-storage migration for LFS, artifacts, packages and release assets
- [ ] add health, capacity and saturation alerts for metadata, Git storage, LFS and delivery queues
- [ ] publish incident-severity, rollback and customer-communication procedures
- [ ] rehearse zero-downtime application rollout and fast rollback

## P1 — Private-alpha exit features

### Hosted CI and workflows

- [ ] workflow YAML format and validation
- [ ] encrypted repository/organization secrets vault
- [ ] isolated hosted runners and job authorization
- [ ] cancellable build logs and live status
- [ ] cache and artifact storage with quotas and retention
- [ ] runner abuse controls and egress policy
- [ ] required-check integration without bypassing branch governance

### Platform administration

- [ ] broader capacity and queue diagnostics in Instance Admin
- [ ] maintenance scheduling and operator approval records
- [ ] status page and incident timeline
- [ ] tenant export and verified deletion procedures
- [ ] support escalation without impersonation

### Security and abuse readiness

- [ ] rate limits for public/authenticated Git, API, webhook and invitation surfaces
- [ ] repository and account abuse-report workflow
- [ ] malware and dangerous-file handling policy for LFS/artifacts/packages
- [ ] secret scanning and push protection foundation
- [ ] dependency, license and SBOM scanning design

## P2 — Public beta

- [ ] subscriptions, plans, usage metering and invoices
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
- [x] roadmap and issue/PR hygiene synchronized on 2026-07-28

## Triage rules

1. P0 safety and recovery work outranks new product surface.
2. Every new implementation must have an issue, acceptance criteria and explicit non-goals.
3. Every PR must include tests and operational documentation when it changes production behavior.
4. A green test suite is necessary but not sufficient; migration, identity, authorization and recovery contracts require targeted review.
5. Obsolete or superseded PRs are closed rather than force-merged.
