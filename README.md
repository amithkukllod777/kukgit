# KukGit

**KukGit is an AI-first Git hosting and developer operating system from Kuklabs Inc.**

This repository is a working Private Alpha foundation, not a visual mockup. KukGit creates real bare Git repositories, supports Git smart HTTP and SSH, provides repository collaboration and governance, uses One Kuklabs Account, and includes verified backup and PostgreSQL-migration tooling.

> Product direction: Git hosting + collaboration + AI review + CI/CD + registries + cloud development and deployment.

## Current capability

### Identity and tenancy

- One Kuklabs Account production authentication through central AuthKit
- Stable `kuklabs_user_id` mapped one-to-one to a KukGit product profile
- Password, signup, OTP and Google ID-token flows
- Server-side encrypted access and rotating refresh-token custody
- Central product-access and active device-session validation
- Verified-email linking with duplicate-account conflict protection
- Production local-password authentication disabled by default
- Self-service organization creation
- Atomic Owner membership and default Developers-team provisioning
- Configurable organization ownership limits and reserved-slug protection
- Guided zero-organization onboarding
- Organizations, roles, invitations, teams and member administration

### Git and repository storage

- Real bare Git repository creation
- Public, internal and private repository metadata
- Git smart HTTP clone, fetch and authenticated push
- Git over SSH with user keys and repository deploy keys
- Scoped Personal Access Tokens
- Token expiry, revocation, last-used tracking and one-time display
- Public HTTPS/SSH repository mirror import
- Browser code, branch, commit, folder and file views
- Browser branch creation and file commits
- Repository archive, transfer, recoverable Trash, restore and purge

### Git Large File Storage

- Git LFS Batch API
- SHA-256 verified streaming uploads
- content-addressed deduplication
- byte-range downloads and ETags
- repository and instance quotas
- HTTPS and SSH authorization
- integrity inspection and orphan cleanup
- LFS-aware verified backups

### Repository access and external collaboration

- Read, Triage, Write, Maintain and Admin permissions
- effective permission calculation across organization, direct and team sources
- direct repository collaborators and team grants
- repository-only external collaborators without organization membership
- expiring exact-email repository invitations
- secure revoke, resend and replay protection
- external-user privacy for organization members, teams and unrelated repositories
- browser, PAT Git HTTP, SSH and LFS enforcement from one access model

### Pull requests and governance

- issues with status and priority
- pull requests with branch comparison and merge
- exact-branch protection policies
- required pull requests and approvals
- stale-approval handling
- protected browser and Git pushes
- Git-native unified and side-by-side diffs
- real patch-line and multi-line review anchors
- threaded review conversations, resolution and outdated detection
- required current-head status checks
- PAT-authenticated status publishing

### Events, notifications and operations

- signed repository webhooks with encrypted secrets
- HTTPS/public-network target enforcement and SSRF protection
- bounded retries, delivery history and manual redelivery
- durable in-app notifications and unread counts
- per-category notification preferences
- dependency-free SMTP transport
- durable email outbox, retries and delivery history
- organization, review, status, webhook, backup and LFS alerts
- audit log
- responsive Kuklabs-branded interface

### Backup and recovery

- portable verified `.kgbak` snapshots
- transactionally consistent SQLite metadata snapshot
- Git bundle creation and `git fsck`
- Git LFS object inclusion and SHA-256 verification
- archive entry checksums and traversal protection
- dry-run and atomic restore
- maintenance mode, operation locks and retention controls

### PostgreSQL migration foundation

- centralized two-phase application migration runner
- explicit KukGit schema version metadata
- actual migrated SQLite schema inventory
- foreign-key-safe import order
- PostgreSQL DDL generation for every current metadata table
- deterministic per-table NDJSON export
- canonical schema and manifest JSON
- SHA-256, byte-size and row-count verification
- symbolic-link and non-regular-file rejection
- permanent PostgreSQL preflight in CI

**Important:** the live KukGit metadata runtime is still SQLite. The PostgreSQL runtime adapter, importer, dual-system rehearsal and production cutover are separate follow-up milestones.

## Scope boundary

KukGit is not yet a full GitHub/GitLab replacement. Major remaining production work includes:

- asynchronous PostgreSQL runtime adapter and controlled cutover
- hosted CI runners and workflow execution
- package and container registries
- subscriptions, quotas and usage metering
- scalable object storage and distributed jobs
- broader tenant-support administration
- abuse controls and moderation
- high availability and regional deployment
- enterprise SSO/SCIM and advanced compliance controls

## Local quick start

Requirements:

- Node.js 22.5+
- Git CLI 2.40+

```bash
cp .env.example .env
npm run doctor
npm run seed
npm start
```

Open:

```text
http://localhost:8787
```

Local development account:

```text
Email: admin@kuklabs.local
Password: KukGit@2026
```

These defaults are for isolated local development only.

## One Kuklabs Account

Production defaults to central AuthKit and sends:

```text
X-Kuklabs-Product: kukgit
```

The browser receives only a random HttpOnly KukGit bridge cookie. AuthKit access and rotating refresh tokens remain encrypted server-side with AES-256-GCM.

Required production configuration:

```bash
NODE_ENV=production
KUKGIT_AUTH_MODE=authkit
KUKGIT_AUTHKIT_BASE_URL=https://auth.kuklabs.com
KUKGIT_AUTHKIT_PRODUCT_ID=kukgit
KUKGIT_AUTHKIT_ENCRYPTION_KEY=<at-least-32-random-characters>
KUKGIT_COOKIE_SECURE=true
KUKGIT_ADMIN_EMAIL=<verified-founder-email>
```

Read [One Kuklabs Account and AuthKit](docs/ONE_KUKLABS_ACCOUNT.md).

## Organization onboarding

A verified Kuklabs Account user can create a free organization from **Organizations → Create organization**. KukGit creates the organization, Owner membership and default Developers team in one transaction.

```bash
KUKGIT_ORGANIZATION_OWNER_LIMIT=5
```

Read [Organization Self-Service Onboarding](docs/ORGANIZATION_ONBOARDING.md).

## PostgreSQL migration foundation

Inspect the current migrated SQLite schema:

```bash
npm run db:postgres -- inventory
npm run db:postgres -- preflight
```

Create and verify a deterministic metadata bundle:

```bash
npm run db:postgres -- export --out /secure/migrations/kukgit-cutover
npm run db:postgres -- verify --bundle /secure/migrations/kukgit-cutover
```

Generate DDL only:

```bash
npm run db:postgres -- ddl --out /secure/migrations/kukgit-schema.sql
```

The bundle contains sensitive metadata and must be stored encrypted with restricted access. Its SHA-256 values detect corruption; they are not digital signatures.

Bare Git repositories, LFS object bytes and `.kgbak` archives are not copied into the metadata bundle.

Read [PostgreSQL Migration Foundation](docs/POSTGRESQL_MIGRATION.md) before any migration rehearsal.

## Git authentication

Public clone:

```bash
git clone http://localhost:8787/git/kuklabs/kukgit-demo.git
```

Protected clone/fetch requires a `repo:read` PAT plus Repository Read permission. Push requires `repo:write` plus Repository Write permission.

Create tokens from **Settings → Personal access tokens** or:

```bash
npm run token -- create \
  --email admin@kuklabs.local \
  --name "Developer laptop" \
  --scopes repo:read,repo:write \
  --days 90
```

Read [Personal Access Tokens](docs/PERSONAL_ACCESS_TOKENS.md) and [SSH Keys and Git over SSH](docs/SSH_KEYS.md).

## Collaboration and governance guides

- [Organization Collaboration](docs/ORGANIZATION_COLLABORATION.md)
- [External Repository Collaborators](docs/EXTERNAL_COLLABORATORS.md)
- [Repository Access](docs/REPOSITORY_ACCESS.md)
- [Branch Governance](docs/BRANCH_GOVERNANCE.md)
- [Pull Request Diffs](docs/PULL_REQUEST_DIFFS.md)
- [Review Threads](docs/REVIEW_THREADS.md)
- [Required Status Checks](docs/REQUIRED_STATUS_CHECKS.md)
- [Repository Webhooks](docs/WEBHOOKS.md)

## Operations guides

- [Notifications and Transactional Email](docs/NOTIFICATIONS_AND_EMAIL.md)
- [Git Large File Storage](docs/GIT_LFS.md)
- [Verified Backups and Disaster Recovery](docs/BACKUPS_AND_DISASTER_RECOVERY.md)
- [PostgreSQL Migration Foundation](docs/POSTGRESQL_MIGRATION.md)

## Commands

```bash
npm run dev                  # Watch-mode server
npm start                    # Start server
npm run seed                 # Seed local-development data
npm run doctor               # Runtime/configuration checks
npm run token --             # PAT lifecycle
npm run backup --            # Backup, verify, restore and prune
npm run db:postgres --       # PostgreSQL inventory/export/verify/DDL
npm run ssh:authorized-keys  # Generate restricted authorized_keys fallback
npm run check                # JavaScript syntax validation
npm test                     # Automated test suite
```

## Repository layout

```text
kukgit/
├── public/       # Dependency-free web application
├── src/          # Identity, DB, Git, LFS, access, review and operations services
├── scripts/      # Seed, doctor, token, backup, SSH and DB migration commands
├── test/         # Node test suite
├── docs/         # Architecture, security and operations guides
├── infra/        # Container, proxy and OpenSSH deployment files
├── data/         # Local runtime data, never committed
├── server.mjs    # HTTP application entry point
└── CLAUDE.md     # Coding-agent instructions
```

## Architecture decision

- Kuklabs owns the product logic, UI, tenancy, permissions, billing, AI and workflows.
- Proven Git is the repository object engine.
- KukGit does not copy GitHub, GitLab, Gitea or Forgejo product code.
- Storage and database migrations are phased and verified rather than rewritten as a big bang.

See [Architecture](docs/ARCHITECTURE.md), [Roadmap](docs/ROADMAP.md) and [Security](SECURITY.md).

## Ownership

Copyright © 2026 Kuklabs Inc. All rights reserved. This codebase is proprietary unless Kuklabs Inc. explicitly releases a component under another license.
