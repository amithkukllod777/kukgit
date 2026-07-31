# Changelog

## Unreleased

### Security

- AuthKit bridge sessions now bind to a specific central device session in every
  case. The device-session id is derived from the access-token claim when the
  login response omits it, and a bridge that still has no id adopts the one
  AuthKit reports on its first validation instead of skipping the comparison.
  Previously a null id downgraded "this device session is still live" to "the
  account has some live session", so revoking the device that created a bridge
  did not end it while the user stayed signed in elsewhere.
- The credential routes (`/api/auth/login`, `/signup`, `/otp/verify`, `/google`)
  have a single owner again. Unreachable duplicates in the identity module
  lacked the verified-email requirement, the product-access preflight and the
  legacy-password scrub, so a change in dispatch order would have silently
  dropped three protections.

## 0.2.0 — 2026-07-29

Private Alpha. Everything below shipped after v0.1.0 and had not previously been
recorded here.

### Identity and access

- One Kuklabs Account authentication through the central AuthKit `/v1/auth/*` contract
- stable one-to-one `kuklabs_user_id` mapping to KukGit product profiles
- password, signup, OTP and Google ID-token flows
- AES-256-GCM encrypted access and rotating refresh tokens held server-side
- random HttpOnly browser bridge cookie with no token exposure to the browser
- central product-access and device-session validation with fail-closed behavior
- verified-email identity linking with duplicate-account conflict protection
- AuthKit made mandatory in production; local password authentication blocked
- hardened AuthKit login form and production session handling
- legacy local passwords scrubbed after AuthKit linking
- self-service organization workspace creation in a single transaction
- atomic Owner membership and default Developers-team provisioning
- configurable organization ownership limit and reserved-slug protection
- guided zero-organization onboarding that exempts repository-only collaborators

### Authentication for Git

- scoped personal access tokens with `repo:read` and `repo:write`
- token expiry, revocation, last-used tracking and one-time secret display
- browser and CLI token lifecycle management
- Git smart HTTP authorization by token scope plus effective repository permission
- Git over SSH with user keys and repository deploy keys
- Ed25519, ECDSA and RSA key support with SHA-256 fingerprints
- forced-command authorization, shell-injection and path-traversal rejection
- dynamic OpenSSH `AuthorizedKeysCommand` integration and static fallback generation

### Collaboration and permissions

- expiring organization invitations with email verification and one-time links
- transactional invitation email with secure resend and old-link revocation
- organization member directory and teams with maintainers and members
- direct repository collaborators and repository team access grants
- Read, Triage, Write, Maintain and Admin permission hierarchy
- effective permission calculation across organization role, direct and team grants
- repository-only external collaborators without organization membership
- exact-email repository invitations with revoke and secure resend
- external collaborator discovery restricted to explicitly shared repositories
- organization member and team privacy for external users
- separate invitation-link expiry and accepted-access duration
- request-time expiry enforcement across browser, Git HTTP, SSH and LFS
- immutable expired/revoked access history with audited renewal
- organization-wide external access review campaigns

### Code review and governance

- exact-branch protection rules
- pull-request approval and change-request reviews
- required approval counts and stale-approval detection
- browser commit and Git push protection for guarded branches
- server-side merge-policy enforcement
- Git-native unified and side-by-side pull-request diffs
- merge-base-correct comparisons with rename, copy and binary metadata
- review threads anchored only to real patch lines, including multi-line ranges
- threaded replies, resolve/reopen lifecycle and outdated-thread detection
- optional active-thread resolution requirement before merge
- commit status records with Pending, Success, Failure and Error states
- PAT-authenticated CI and integration status publishing
- exact-branch required status-check policies with current-head freshness

### Repository operations

- repository archive and unarchive with read-only enforcement
- rollback-protected organization transfer and bare-storage move
- 30-day recoverable Trash, Admin restore and Owner-only permanent purge
- repository webhooks with encrypted secrets and HMAC-SHA256 signed deliveries
- HTTPS and public-network target enforcement with SSRF protection
- bounded exponential retries, ping and manual redelivery
- Git LFS Batch API with SHA-256 verified streaming uploads
- content-addressed deduplication, byte-range downloads and ETags
- per-object, per-repository and per-instance LFS quotas
- LFS over SSH with short-lived repository-scoped signed credentials
- orphan LFS garbage collection

### Notifications and email

- durable per-user notification inbox with unread counts and read lifecycle
- per-category in-app and email delivery preferences
- real-time WebSocket notification delivery with user isolation, connection caps and
  session revalidation
- dependency-free SMTP transport with direct TLS and STARTTLS
- durable email outbox, bounded retries and delivery-attempt history
- email-header injection, body-size and secret-redaction protections
- provider-neutral signed delivery-event ingestion with replay protection
- bounce, complaint, delivered, deferred and rejected normalization
- hard-bounce and complaint suppression, soft-bounce thresholds and expiry
- schema-level suppression enforcement through outbox triggers
- Admin suppression review and confirmed unsuppression
- pull-request, review, merge, status-check and operational notifications
- personal-access-token expiry reminders without secret exposure

### Backups and recovery

- verified `.kgbak` snapshots with SQLite metadata, Git bundles and LFS objects
- SHA-256 entry checksums, manifest enforcement and footer validation
- absolute-path, duplicate-entry and traversal protection
- source and restored `git fsck` verification
- dry-run and atomic empty-directory restore workflows
- operation locks, maintenance-mode write quiescing and retention pruning

### Administration

- Instance Admin console with an operator allowlist independent of organization roles
- adoption, repository, external-access, delivery, LFS, backup and audit metrics
- bounded cross-tenant search and tenant/user diagnostics
- recursive server-side audit metadata redaction
- confirmed support notes and confirmed email/webhook retry controls
- no-impersonation and no-credential-exposure support boundary
- email delivery health interface

### PostgreSQL migration program (Stages 1–6, cutover not enabled)

- deterministic SQLite schema, row-count and SHA-256 row-checksum manifests
- atomic `0600` metadata export bundle with tamper detection and drift comparison
- SQL portability audit and PostgreSQL URL credential redaction
- PostgreSQL schema translation, foreign-key-safe import planning
- transactional executor with rollback, cancellation and verified target receipts
- guarded offline import requiring explicit enablement and exact source confirmation
- read-only shadow verification with a curated SELECT catalog and least-privilege adapter
- driver-neutral live reads with deterministic sampling, circuit breaker and no
  result substitution
- fail-closed behavior when an undelivered PostgreSQL runtime is selected

SQLite remains the authoritative runtime. PostgreSQL observation is read-only and
disabled by default; no write path, dual-write or cutover is enabled.

### Engineering

- CI workflow running doctor, syntax check and the full test suite
- test suite grown from 6 to 198 tests

### Changed in this release

- Git operations that clone an entire repository — `importMirror`, and
  `withWorkingClone` behind `commitFile`, `mergeBranches` and `createDemoCommit` —
  now run through a non-blocking `execGitAsync` instead of `spawnSync`. Previously a
  browser commit or merge froze the event loop for its whole duration, stalling every
  other request on the instance. Measured on a small repository: a commit takes the
  same wall-clock time either way, but the event loop went from zero ticks during the
  operation to staying responsive throughout, with a worst-case stall of 6 ms. The
  read-only plumbing (branch, commit, tree and blob listing) is deliberately still
  synchronous — each is a single fast command, and converting it would cascade
  `await` through twelve modules and seventeen test files for no measurable gain.

- the release version is defined once in `src/version.mjs` and consumed by the
  server banner, `GET /api/health` and backup manifests, replacing three
  independently hardcoded copies
- `npm run check` globs `server.mjs src/*.mjs scripts/*.mjs public/*.js` instead of a
  4 KB hand-maintained file list that silently missed newly added files
- SMTP failures are tagged with the protocol stage that produced them, and permanent
  rejections at `RCPT TO` now suppress the recipient as a second signal alongside
  provider webhooks. Rejections at `MAIL FROM`, `AUTH` or `DATA`, quota responses and
  `5.7.x` policy blocks stay retryable, so a sender-side fault cannot blackhole a
  valid address.

### Fixed in this release

- `infra/nginx.conf` did not forward `Upgrade` and `Connection`, so the real-time
  notification WebSocket could not connect behind the bundled reverse-proxy
  template. The header value is derived per request through a `map` so ordinary
  keepalive is unaffected.
- a message suppressed while mid-flight was left in `processing`, where the outbox
  triggers then refused every status transition, stranding the row permanently. It
  is now cancelled explicitly.
- `docs/API.md` documented 8 of 27 API namespaces and described Git push
  authentication as using the shared development token rather than scoped personal
  access tokens.
- `docs/DEPLOYMENT.md` listed a required-variable set that cannot start a production
  instance, omitting every AuthKit variable, and `infra/docker-compose.yml` set
  `NODE_ENV=production` without passing any AuthKit configuration.
- `docs/NOTIFICATIONS_AND_EMAIL.md` listed real-time WebSocket delivery and provider
  bounce/complaint webhooks as not yet implemented after both had shipped.
- `test/backups-lfs.test.mjs` restored into a fixed path outside its temporary
  directory, so the directory survived cleanup and every run after the first failed
  with `RESTORE_TARGET_NOT_EMPTY` on the same machine.

## 0.1.0 — 2026-07-26

### Added

- Kuklabs-branded responsive web application
- local founder authentication and sessions
- Kuklabs organization seed
- real bare Git repository creation
- Git smart HTTP clone and push
- public repository mirror import
- branch, commit, tree and file browsing
- browser branch and file commit workflows
- issue tracking
- pull request comparison and merge
- deterministic KukAI repository health analysis
- audit logging
- Docker and reverse-proxy templates
- automated tests and operating documentation
