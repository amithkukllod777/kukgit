# KukGit Roadmap

## Phase 0 — Foundation complete

Status: delivered in v0.1.0

- product architecture and business model
- real Git repositories
- Git smart HTTP clone/push
- organizations and RBAC
- code browser
- issues and pull requests
- browser commits and merges
- local repository intelligence
- audit logs
- tests and container templates

## Phase 1 — Private alpha

Target: reliable internal use by Kuklabs

Progress delivered:

- scoped personal access token storage
- `repo:read` and `repo:write` authorization
- token expiry, revocation and last-used tracking
- CLI token lifecycle management
- browser personal-access-token creation, one-time display, listing and revocation
- same-origin protected token API and token lifecycle audit events
- production Git HTTP enforcement by token scope and effective repository permission
- authenticated Git fetch/push audit events
- organization invitations with role, expiry, secure one-time links and revocation
- email-verified invitation acceptance with replay protection
- organization member directory
- teams with maintainers, members and auditable lifecycle management
- direct repository collaborators
- repository team access grants
- Read, Triage, Write, Maintain and Admin permission hierarchy
- effective permission calculation across organization, direct and team sources
- browser repository API enforcement
- Git smart HTTP clone/fetch/push repository enforcement
- repository access-management interface and audit events
- exact-branch protection rules
- pull-request approve, request-changes and comment reviews
- required approval count and stale-approval detection
- server-side merge-policy enforcement
- protected-branch browser commit blocking
- Git pre-receive protection for direct pushes
- branch-governance browser interface and audit events
- changed-file and line anchored review threads
- threaded replies, resolve and reopen lifecycle
- outdated-thread detection by pull-request head SHA
- optional active-thread resolution requirement before merge
- review-thread API, browser interface and audit events
- commit status records keyed by repository, SHA and context
- pending, success, failure and error status states
- PAT-authenticated trusted status publishing API
- exact-branch required status-check policies
- current-head freshness and stale-result isolation
- server-side merge blocking for missing, pending, failed or errored checks
- status-check Settings and pull-request browser interfaces
- status policy and publisher audit events
- repository webhook subscriptions and event filters
- AES-256-GCM encrypted webhook secrets
- HMAC-SHA256 signed JSON deliveries
- HTTPS and public-network target enforcement
- DNS address pinning and SSRF protection
- pending, processing, success and failure delivery lifecycle
- bounded exponential retries, ping and manual redelivery
- automatic push, issue, pull-request, review and status event capture
- webhook Settings and delivery-history browser interface
- webhook lifecycle and redelivery audit events
- archive and unarchive repository workflow
- read-only enforcement across browser APIs and Git pushes
- rollback-protected organization transfer and bare-storage move
- team-grant and incompatible collaborator cleanup during transfer
- 30-day recoverable repository Trash
- Admin restore with slug-collision protection
- Owner-only permanent purge with storage quarantine rollback
- repository lifecycle Settings and Trash interfaces
- lifecycle audit and repository webhook events
- Ed25519, ECDSA and RSA user SSH public keys
- SHA-256 fingerprint validation and active-key reuse prevention
- repository-scoped read-only and read/write deploy keys
- effective repository permission enforcement for user SSH keys
- forced-command Git upload-pack and receive-pack authorization
- shell-injection and path-traversal command rejection
- archived repository and branch-protection enforcement for SSH pushes
- dynamic OpenSSH AuthorizedKeysCommand integration
- restricted static authorized_keys generation fallback
- SSH clone URL and key-management browser interfaces
- SSH key last-used timestamps and Git SSH audit events
- merge-base-correct pull-request comparisons
- Git-native added, modified, deleted, renamed, copied and binary file metadata
- per-file addition and deletion statistics
- parsed unified diff hunks with old and new line numbers
- unified and side-by-side Files Changed browser views
- paginated file summaries and lazy per-file patch loading
- whitespace display toggle and raw patch copy
- actual-patch-only inline review anchors
- same-side, same-hunk multi-line review ranges
- file-level binary review threads
- stable anchor hashes with merge-base and head SHA history
- large diff safety limits and phantom-line sanitization
- diff API permission, path, anchor and CSRF enforcement
- transactionally consistent SQLite metadata snapshots
- active, trashed and empty repository snapshot coverage
- Git bundle creation, ref manifests and source `git fsck` verification
- dependency-free compressed portable backup archives
- SHA-256 entry checksums, footer validation and manifest enforcement
- absolute-path, duplicate-entry and traversal protection
- SQLite integrity, foreign-key and repository-count verification
- Git bundle verification and restored repository `git fsck`
- dry-run and atomic empty-directory restore workflows
- operation locks and maintenance-mode write quiescing
- retention listing and two-condition pruning policy
- backup create, list, verify, restore, prune and maintenance CLI
- instance-admin backup API and Settings status interface
- backup operation audit events and disaster-recovery runbook
- Git LFS Batch API with the basic transfer adapter
- SHA-256 content-addressed streamed uploads
- declared-size, content-hash and verify-action enforcement
- public downloads and PAT-protected private LFS access
- single byte-range downloads, ETags and safe content headers
- user SSH-key and deploy-key `git-lfs-authenticate` support
- short-lived repository-scoped signed SSH LFS credentials
- strict LFS SSH command and repository-path validation
- maximum object, repository and instance LFS quotas
- pending-upload projected quota accounting and expiry cleanup
- cross-repository physical-object deduplication
- repository-to-object associations and usage accounting
- archived upload blocking and repository lifecycle integration
- repository LFS usage, object inventory and integrity Settings interface
- instance-admin orphan LFS garbage collection
- LFS objects included in verified backup manifests
- LFS SHA-256 verification during backup creation, verification and restore
- durable per-user notification inbox and unread counts
- notification read, unread and bulk mark-read lifecycle
- organization, security, pull-request, status and operations categories
- per-category in-app and email preferences
- durable transactional email outbox and delivery-attempt history
- dependency-free SMTP transport with direct TLS and STARTTLS
- SMTP authentication, MIME alternatives and Unicode subjects
- email-header injection, body-size and secret-redaction protections
- bounded retries, exponential backoff and interrupted-attempt recovery
- instance-admin email queue status, processing and retry interface
- organization invitation email delivery for existing and external users
- secure invitation resend with old-link revocation
- invitation acceptance and membership notifications
- personal-access-token expiry reminders without token-secret exposure
- effective-permission pull-request recipient targeting
- pull-request opened, reviewed and merged notifications
- current-head failed and errored status-check notifications
- terminal webhook failure alerts
- backup and Git LFS operational alerts for the instance administrator
- topbar notification bell, unread badge and notification drawer
- Settings notification preferences and email administration
- notification, email and SMTP production runbook

Remaining:

- One Kuklabs Account/AuthKit
- external repository collaborators
- organization self-service signup
- PostgreSQL migration
- broader admin console and tenant support tools
- real-time WebSocket notification delivery
- provider bounce and complaint processing

## Phase 2 — Public beta

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

- AI PR reviewer
- AI codebase chat with source citations
- AI issue triage
- AI test generation
- AI documentation and architecture maps
- AI security remediation suggestions
- AI CTO technical-debt and roadmap reports
- AI developer agent that creates branches and pull requests
- AI DevOps agent for deployment and rollback
- model choice, enterprise privacy and spend controls

## Phase 4 — Developer cloud

- cloud workspaces and browser IDE
- preview environments
- one-click deployments
- Kubernetes and serverless targets
- observability, logs and traces
- feature flags
- infrastructure-as-code workflows
- marketplace and third-party apps

## Phase 5 — Enterprise and self-hosted

- dedicated regions and data residency
- SAML/SCIM
- advanced audit and legal hold
- customer-managed keys
- high availability and geo replication
- self-hosted enterprise distribution
- government and regulated-industry profiles
- migration tools from GitHub, GitLab, Bitbucket and Azure DevOps
