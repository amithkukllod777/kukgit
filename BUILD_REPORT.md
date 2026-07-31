# KukGit Build Report

Owner: Kuklabs Inc.

Per-feature delivery detail lives in [CHANGELOG.md](CHANGELOG.md). This file records
release-level verification.

---

## v0.2.0 — Private Alpha

Date: 29 July 2026

### Delivered

Phase 1 of the roadmap, substantially complete: One Kuklabs Account identity, Git
authentication over HTTP and SSH, the repository permission hierarchy, external
collaborators with time-bounded access, branch governance, review threads, required
status checks, webhooks, repository lifecycle, Git LFS, notifications with real-time
WebSocket delivery and bounce/complaint suppression, verified backups, the
instance-admin console, and PostgreSQL migration Stages 1-6 (read-only; SQLite
remains authoritative).

Built without cloning a competing Git platform repository and with no runtime npm
dependencies.

### Verification completed

```text
npm run doctor    passed
npm run check     passed (globs server.mjs, src/, scripts/, public/)
npm test          passed: 198/198
```

Coverage spans identity and encryption, authorization boundaries, cross-tenant
isolation, external collaborator privacy, access expiry, Git HTTP and SSH auth, LFS,
backup and restore, governance, review threads, status checks, webhooks, WebSocket
origin and revocation, SMTP bounce classification, provider event signing, CSRF and
production-boundary behavior.

### Defects fixed in this release

- `infra/nginx.conf` did not forward `Upgrade` and `Connection`, so the real-time
  notification WebSocket could not connect behind the bundled proxy template.
- a message suppressed mid-flight was stranded in `processing`, where the outbox
  triggers then refused every status transition.
- `test/backups-lfs.test.mjs` restored outside its temporary directory, so every run
  after the first failed on the same machine.
- `docs/API.md`, `docs/DEPLOYMENT.md`, `docs/NOTIFICATIONS_AND_EMAIL.md` and
  `CHANGELOG.md` had drifted materially from the shipped system.

### Open before public beta

PostgreSQL write path and verified cutover, async Git execution behind a job queue,
external worker scheduling, cross-instance WebSocket fan-out, rate limiting, hosted
CI runners, registries, billing and abuse controls. See [SECURITY.md](SECURITY.md)
and [docs/ROADMAP.md](docs/ROADMAP.md).

---

## v0.1.0 — Foundation MVP


Date: 26 July 2026
Owner: Kuklabs Inc.

### Delivered

A working KukGit Foundation MVP was built from the ground up without cloning a competing Git platform repository.

#### Product

- Kuklabs-branded responsive dashboard
- repository, issue, pull-request, AI and audit interfaces
- new repository and public repository import workflows
- browser branch and file commit workflows

#### Git engine

- real bare repositories
- standard Git smart HTTP clone
- authenticated Git smart HTTP push
- branches, commits, tree and blob browsing
- branch creation
- branch comparison
- conflict-aware pull-request merge through temporary working clones

#### Platform

- users, sessions, organizations and role memberships
- public/private/internal repository metadata
- issue priorities and status
- pull-request state
- audit events
- deterministic repository health analysis

#### Engineering

- zero runtime npm dependencies
- Node.js and Git only
- Docker and Nginx templates
- security and deployment documentation
- Claude continuation instructions
- product roadmap and business model

### Verification completed

- source syntax checks passed
- automated test suite passed: 6/6
- API login and repository creation verified
- standard Git clone verified
- authenticated Git push verified
- seeded demo repository verified

### Not yet production ready

The following are explicitly outside v0.1.0 and remain required before public commercial hosting:

- Kuklabs Account SSO/MFA
- invitations and teams
- scoped personal access tokens
- SSH Git protocol and deploy keys
- PostgreSQL and distributed storage
- Git LFS
- branch protection and review approvals
- comments and notifications
- CI runners and workflow engine
- package/container registries
- billing and quotas
- abuse, malware and advanced secret protection
- high availability, observability and disaster recovery

### Recommended next sprint

Private Alpha Identity and Access:

1. First-run administrator setup
2. Kuklabs Account/AuthKit integration
3. Organization invitations
4. Team and repository collaborator roles
5. Scoped PATs with expiry and revocation
6. Replace shared development Git push token
7. Add authorization integration tests
