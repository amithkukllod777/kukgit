# KukGit Roadmap

Updated: 2026-07-28

This document records product phases and safety boundaries. The actionable engineering queue lives in [TODO.md](TODO.md). GitHub issues remain the execution-level source of truth.

## Status legend

- **Delivered** — merged to `main` with CI and documentation.
- **Active** — approved work currently tracked by an open issue or pull request.
- **Planned** — sequenced after the current private-alpha exit work.
- **Blocked by safety boundary** — must not be enabled before its listed prerequisites are verified.

## Phase 0 — Foundation

Status: **Delivered** in v0.1.0.

- custom Kuklabs-owned product architecture using Git as the repository object engine
- real bare repositories and Git smart HTTP
- organizations, role-based access, code browser, issues and pull requests
- browser commits and merges
- KukAI local repository-health analysis
- audit logs, CI, tests and container templates

## Phase 1 — Private alpha

Target: reliable internal use by Kuklabs and controlled external collaboration.

### Identity and tenancy

Status: **Delivered**.

- One Kuklabs Account through central AuthKit `/v1/auth/*`
- stable `kuklabs_user_id` mapping while preserving KukGit product foreign keys
- verified-email account linking and duplicate-identity conflict protection
- production local-password authentication disabled
- encrypted server-side AuthKit token custody, refresh rotation and device-session revocation
- self-service organization onboarding with atomic Owner/default-team provisioning
- organization members, teams, invitations and repository-only external collaborators
- time-bounded external access, expiry enforcement, renewal and access-review campaigns
- independent instance-administrator allowlist and privacy-preserving tenant support console

### Git hosting and repository lifecycle

Status: **Delivered**.

- Git smart HTTP and Git-over-SSH clone/fetch/push
- user SSH keys and read-only/read-write deploy keys
- scoped personal access tokens and transport-wide repository authorization
- Git LFS Batch API, verified streaming, range downloads, quotas and deduplication
- repository archive, organization transfer, recoverable Trash, restore and permanent purge
- public/private/internal visibility and repository-scoped permission hierarchy
- verified backups covering SQLite metadata, Git bundles and Git LFS objects
- dry-run verification, atomic restore, retention pruning and maintenance-mode write quiescing

### Collaboration and governance

Status: **Delivered**.

- exact-branch protection and direct-push/browser-write blocking
- pull-request approvals, change requests and stale-approval handling
- required current-head status checks
- merge-base-correct unified and side-by-side diffs
- actual patch-line and multi-line review anchors
- threaded review conversations, resolution and outdated-thread history
- server-side merge policy for approvals, checks and unresolved active threads
- repository webhooks with encrypted secrets, HMAC signatures, SSRF protection and retries

### Notifications and email reliability

Status: **Delivered**.

- durable notification inbox, preferences and read lifecycle
- real-time WebSocket notification delivery with user isolation and session revocation
- dependency-free SMTP transport, durable outbox, retry history and Admin controls
- organization, repository, pull-request, review, status and operations notifications
- provider-neutral signed delivery-event ingestion
- bounce, complaint, delivered, deferred and rejected normalization
- replay protection, hard-bounce/complaint suppression and soft-bounce thresholds
- queued-message cancellation, Admin review and controlled unsuppression

### PostgreSQL migration program

Status: **Stages 1–6 delivered; production cutover not enabled**. Parent tracking issue: [#43](https://github.com/amithkukllod777/kukgit/issues/43).

Delivered stages:

1. **Portability and evidence foundation** — deterministic SQLite schema/row manifests, checksums, drift verification, protected exports and redacted connection policy.
2. **Schema translation and import planning** — PostgreSQL DDL, foreign-key-safe ordering, parameterized batches and compatibility validation.
3. **Transactional executor** — atomic target creation/import, rollback, cancellation, parameter limits and verified target receipts.
4. **Guarded offline import** — explicit enablement, exact source confirmation, readiness evidence and secret-free operation state.
5. **Read-only shadow verification** — runtime-surface inventory, curated SELECT catalog, least-privilege PostgreSQL adapter and privacy-safe parity reports.
6. **Driver-neutral live reads and asynchronous observation** — selected live reads behind the catalog, optional bounded PostgreSQL observer, deterministic sampling, circuit breaker and no-result-substitution guarantee.

Safety boundary:

- SQLite remains the authoritative runtime.
- PostgreSQL observation is disabled by default and read-only.
- No PostgreSQL write path, dual-write, automatic cutover or backend-aware restore is enabled.
- A verified Stage 5 report does not authorize cutover.
- Bare Git repositories and Git LFS object bytes remain outside the metadata migration.

### Private-alpha exit work

Status: **Active / planned**.

1. Complete the remaining driver-neutral metadata service and PostgreSQL write-path design under #43.
2. Add PostgreSQL-backed integration CI before any write or cutover experiment.
3. Build explicit maintenance-window cutover, rollback evidence and backend-aware backup/restore.
4. Rehearse production recovery for AuthKit, metadata, Git repositories, LFS, SMTP/provider events and WebSockets.
5. Define distributed-job and scalable object-storage boundaries without disrupting live Git traffic.
6. Establish release, incident, capacity and abuse-response runbooks for wider private-alpha use.

## Phase 2 — Public beta

Status: **Planned after private-alpha exit gates**.

- subscriptions, quotas and usage metering
- hosted CI runners
- workflow YAML and secrets vault
- build logs, cache and artifacts
- package registry
- container registry
- release assets
- code search
- secret scanning and push protection
- dependency, license and SBOM scanning
- status page and incident operations
- abuse prevention and moderation

## Phase 3 — AI developer operating system

Status: **Planned**.

- AI pull-request reviewer
- codebase chat with source citations
- issue triage and test generation
- documentation and architecture maps
- security remediation suggestions
- AI CTO technical-debt and roadmap reports
- developer agent that creates branches and pull requests
- DevOps agent for deployment and rollback
- model choice, enterprise privacy and spend controls

## Phase 4 — Developer cloud

Status: **Planned**.

- cloud workspaces and browser IDE
- preview environments
- one-click deployments
- Kubernetes and serverless targets
- observability, logs and traces
- feature flags
- infrastructure-as-code workflows
- marketplace and third-party apps

## Phase 5 — Enterprise and self-hosted

Status: **Planned**.

- dedicated regions and data residency
- SAML and SCIM
- advanced audit, legal hold and retention controls
- customer-managed keys
- high availability and geo replication
- self-hosted enterprise distribution
- government and regulated-industry profiles
- migration tools from GitHub, GitLab, Bitbucket and Azure DevOps

## Release rule

A roadmap item is marked Delivered only after its implementation, security boundary, automated tests, operational documentation and clean CI are merged to `main`.
