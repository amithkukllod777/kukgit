# KukGit

**KukGit is an AI-first Git hosting and developer operating system from Kuklabs Inc.**

This repository contains the working KukGit foundation. It is not a visual mockup: it creates real bare Git repositories, supports Git smart HTTP and SSH clone/push, stores multi-tenant metadata, offers repository browsing, issues, pull requests, governed reviews, verified backups, Git LFS, notifications, transactional email, external repository collaboration, One Kuklabs Account, self-service organization onboarding and local repository-health analysis.

> Product direction: Git hosting + collaboration + AI review + CI/CD + package/container registries + cloud development and deployment.

## What works in v0.2.0

- One Kuklabs Account production authentication through central AuthKit
- Stable central `kuklabs_user_id` mapped one-to-one to KukGit product profiles
- AuthKit password, signup, OTP and Google ID-token flows
- Server-side encrypted access and rotating refresh-token custody
- Central product-access and signed-in device-session validation
- Verified-email identity linking with duplicate-account conflict protection
- Production local-password authentication disabled by default
- Self-service organization workspace creation for authenticated users
- Atomic Owner membership and default Developers-team provisioning
- Configurable organization ownership limits and reserved-slug protection
- Guided zero-organization onboarding without disrupting repository-only collaborators
- Real bare Git repository creation
- Public and private repository metadata
- Git smart HTTP clone and authenticated push
- Git-over-SSH with user keys and repository deploy keys
- Git LFS Batch API, verified uploads, range downloads, quotas and deduplication
- Scoped personal access tokens with browser and CLI lifecycle management
- Token expiry, revocation, last-used tracking and one-time secret display
- Personal-access-token expiry reminders without secret exposure
- Production Git authorization by token scope plus effective repository permission
- Mirror import for public HTTPS/SSH repositories
- Organizations and role-based access control
- Expiring organization invitations with email verification, one-time acceptance links and revocation
- Transactional organization invitation email and secure resend
- Organization member directory
- Teams with maintainers, members and auditable lifecycle management
- Direct repository collaborators and repository team access grants
- Repository-only external collaborators without organization membership
- Expiring exact-email repository invitations, revoke and secure resend
- External collaborator discovery restricted to explicitly shared repositories
- Organization member and team privacy for external users
- Browser, Git HTTP, SSH and Git LFS authorization for external access
- Read, Triage, Write, Maintain and Admin permission hierarchy
- Effective permission calculation across organization role, direct grant and team grants
- Durable per-user notification inbox, unread counts and delivery preferences
- Real-time WebSocket notification delivery with user isolation and session revalidation
- Dependency-free SMTP transport, durable email outbox, retries and delivery history
- Signed provider delivery events, bounce/complaint suppression and Admin review
- SMTP recipient-stage bounce classification as a second suppression signal
- Pull-request, review, merge, status-check and operational notifications
- Repository archive, organization transfer, recoverable Trash, restore and permanent purge
- Exact-branch protection rules
- Pull-request approval and change-request reviews
- Required approval counts and stale-approval detection
- Direct browser commit and Git push protection for guarded branches
- Pull-request merge-policy enforcement
- Git-native unified and side-by-side pull-request diffs
- Actual patch-line and multi-line review anchors
- Threaded replies, resolution, reopening and outdated-thread detection
- Commit status records with Pending, Success, Failure and Error states
- PAT-authenticated CI and integration status publishing
- Exact-branch required status-check policies and current-head freshness
- Repository webhook subscriptions with encrypted secrets and HMAC-signed deliveries
- HTTPS/public-network target enforcement, SSRF protection and bounded retries
- Terminal webhook failure alerts for the instance administrator
- Repository code browser: branches, commits, folders and files
- Browser branch creation and file commits
- Issues with status and priority
- Pull requests with branch comparison and merge
- Verified `.kgbak` snapshots, integrity checks, dry-run restore and disaster recovery
- Backup and Git LFS operational alerts
- KukAI local repository health analysis
- Security, test, CI, documentation and governance checks
- Audit log
- Responsive Kuklabs-branded web interface
- Secure Kuklabs instance-admin console with independent operator allowlist
- Tenant-scoped user, organization, repository, delivery, storage and audit diagnostics
- Redacted support notes plus confirmed failed-email and webhook retry controls
- Deterministic SQLite metadata manifests, row checksums and drift verification
- Protected full-metadata export with atomic writes, `0600` permissions and tamper detection
- SQL portability audit and verified PostgreSQL cutover-readiness gate
- No runtime npm dependencies
- Automated tests for identity, onboarding, API, Git, LFS, backup/restore, collaboration, external access, governance, reviews, checks, webhooks, notifications, SMTP and security helpers

## Important scope boundary

This is the **Private Alpha foundation**, not yet a GitHub/GitLab replacement. Production work still required includes hosted CI runners and workflow execution, the PostgreSQL runtime driver/import/cutover stages and distributed jobs, package/container registries, billing and usage metering, abuse controls, scalable object storage, broader administration, enterprise SSO/MFA policy controls and high-availability deployment.

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

Development account:

```text
Email: admin@kuklabs.local
Password: KukGit@2026
```

These defaults are strictly for isolated local development. Local password authentication is rejected by default in production.

## One Kuklabs Account

Production defaults to central AuthKit. KukGit sends `X-Kuklabs-Product: kukgit` to the shared `/v1/auth/*` contract and never creates or verifies a separate production password.

The browser receives only a random HttpOnly KukGit bridge cookie. AuthKit access and rotating refresh tokens remain encrypted server-side with AES-256-GCM. Protected requests validate the central account, KukGit product membership and the current AuthKit device session; centrally revoked sessions are removed locally and require a new login.

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

Existing KukGit users are linked lazily by verified normalized email while keeping the same local product user ID, repository ownership, organization membership, PATs and SSH keys. Conflicting identities fail closed instead of being automatically merged.

Read [One Kuklabs Account and AuthKit](docs/ONE_KUKLABS_ACCOUNT.md) before staging or production deployment.

## Organization self-service onboarding

A verified Kuklabs Account user can create a free organization workspace from **Organizations → Create organization**. A user with no organization and no repository-only access is guided automatically to the onboarding screen after sign-in.

Workspace creation is one database transaction: KukGit creates the organization, assigns the creator as Owner, creates a default Developers team and adds the creator as Team Maintainer. Any failure rolls back the complete workspace.

Configure the maximum number of non-system organizations one user may own:

```bash
KUKGIT_ORGANIZATION_OWNER_LIMIT=5
```

Workspace slugs are globally unique and protect system/product names such as `kuklabs`, `kukgit`, `admin`, `api`, `auth`, `git`, `repositories` and `settings`. Optional organization websites must use HTTPS.

Repository-only external collaborators are not forced to create an organization; they continue to see only repositories explicitly shared with them.

Read [Organization Self-Service Onboarding](docs/ORGANIZATION_ONBOARDING.md) for API contracts, slug policy, rollout and support procedures.

## Git clone and push authentication

Public repositories can be cloned without authentication:

```bash
git clone http://localhost:8787/git/kuklabs/kukgit-demo.git
```

For local development, Git smart HTTP accepts `KUKGIT_DEV_GIT_TOKEN` as the HTTP Basic password:

```bash
git push http://developer:<KUKGIT_DEV_GIT_TOKEN>@localhost:8787/git/kuklabs/kukgit-demo.git main
```

The shared development token is disabled automatically in production. Protected clone/fetch requires a read-capable personal access token plus effective Repository Read permission. Push requires a `repo:write` personal access token plus effective Repository Write permission.

Create a token from **Settings → Personal access tokens** or from the server CLI:

```bash
npm run token -- create \
  --email admin@kuklabs.local \
  --name "Developer laptop" \
  --scopes repo:read,repo:write \
  --days 90
```

Use the returned `kgp_...` value as the HTTP Basic password. Read [Personal Access Tokens](docs/PERSONAL_ACCESS_TOKENS.md).

## Git SSH access

Users can register Ed25519, ECDSA or RSA public keys from **Settings → SSH keys**. Repository Admins can add read-only or read/write deploy keys from **Repository → Settings**.

SSH authorization uses forced commands, repository permissions and the same branch-protection hooks as HTTP pushes. Read [SSH Keys and Git over SSH](docs/SSH_KEYS.md) for OpenSSH deployment, `AuthorizedKeysCommand`, static fallback generation and operational controls.

## Git Large File Storage

Enable Git LFS on a developer machine and track large-file patterns:

```bash
git lfs install
git lfs track "*.zip"
git add .gitattributes
git commit -m "Track archives with Git LFS"
```

KukGit supports HTTPS and SSH remotes, repository-scoped authorization, SHA-256 verified streaming uploads, content-addressed deduplication, byte-range downloads, quotas, Admin integrity checks and LFS-aware verified backups.

Open **Repository → Settings → Git Large File Storage** to review usage and object health. Read [Git Large File Storage](docs/GIT_LFS.md) for protocol, storage, quotas, security, GC and backup behavior.

## Organization collaboration

Open **Organizations → Organization collaboration** to invite users, review invitation status, manage members and create teams. Invitation tokens are shown only once and acceptance requires the exact invited account email.

KukGit queues invitation email for existing and external users. Organization Admins can revoke an old invitation and send a fresh secure link with **Resend email**. Read [Organization Collaboration](docs/ORGANIZATION_COLLABORATION.md).

## External repository collaborators

Open **Repository → Settings → External collaborators** to invite a client, contractor or partner without adding them to the organization. Select Read, Triage, Write, Maintain or Admin permission and a 7-, 14- or 30-day invitation expiry.

Acceptance is restricted to the exact invited email and creates only a direct repository grant. External users discover only explicitly shared repositories, while organization members, teams and other repositories remain hidden. The same permission applies to browser actions, Personal Access Token Git HTTP, SSH Git and Git LFS.

External Repository Admins cannot transfer ownership or move a repository to Trash without actual organization Admin or Owner membership. Read [External Repository Collaborators](docs/EXTERNAL_COLLABORATORS.md).

## Notifications and transactional email

The topbar notification bell provides a durable user inbox with unread counts, internal links and read lifecycle. Open **Settings → Notification preferences** to choose in-app and email delivery for organization, security, pull-request, status-check and operations categories.

Configure SMTP through `KUKGIT_SMTP_*` and `KUKGIT_EMAIL_*` environment variables. KukGit supports direct TLS or STARTTLS, a durable outbox, bounded retries, delivery-attempt history and Admin retry controls. Read [Notifications and Transactional Email](docs/NOTIFICATIONS_AND_EMAIL.md).

## Repository access

Open a repository and select **Settings** to manage direct collaborator permissions, external invitations, team grants and effective permission sources. KukGit combines organization role baseline, direct grants and team grants; the highest permission wins. Read [Repository Access](docs/REPOSITORY_ACCESS.md).

## Branch protection and reviews

Repository Admins can protect exact branches, require pull requests, require approvals, dismiss stale approvals and block direct browser/Git changes. Reviewers with Repository Write permission can approve, request changes or comment. Read [Branch Governance](docs/BRANCH_GOVERNANCE.md).

## Pull-request diffs and review conversations

The Pull requests page provides merge-base-correct unified and side-by-side patches, file navigation, whitespace controls, binary/rename metadata and comments anchored only to real patch lines. Shift-click creates same-side, same-hunk ranges.

Review threads support replies, resolve/reopen actions and outdated history after the head changes. Repository Admins may require all active threads resolved before merge. Read [Pull Request Diffs](docs/PULL_REQUEST_DIFFS.md) and [Review Threads](docs/REVIEW_THREADS.md).

## Required status checks

Repository Admins can require CI/integration contexts for an exact base branch. Every selected context must report Success for the current pull-request head SHA; missing, Pending, Failure and Error states block merge.

Trusted runners publish with a scoped `repo:write` personal access token:

```bash
curl -X POST \
  -H "Authorization: Bearer <kgp_token>" \
  -H "Content-Type: application/json" \
  http://localhost:8787/api/status-checks/kuklabs/kukgit-demo/commits/<40-character-sha>/statuses \
  -d '{"context":"test","state":"success","description":"All tests passed"}'
```

Read [Required Status Checks](docs/REQUIRED_STATUS_CHECKS.md).

## Repository webhooks

Repository Admins can create webhook subscriptions from **Repository → Settings**. KukGit sends signed JSON events for push, issue, pull-request, review and status activity.

```text
X-KukGit-Event: push
X-KukGit-Delivery: whd_example
X-KukGit-Signature-256: sha256=<HMAC digest>
```

Webhook secrets are displayed once, encrypted at rest and used to sign the exact raw request body. Production URLs must use HTTPS and resolve to public networks. Read [Repository Webhooks](docs/WEBHOOKS.md).

## Verified backups and recovery

Create and verify portable snapshots:

```bash
npm run backup -- maintenance on --reason "Scheduled backup"
npm run backup -- create
npm run backup -- list
npm run backup -- verify --archive <file.kgbak>
npm run backup -- maintenance off
```

Snapshots include SQLite metadata, Git bundles and all recorded Git LFS objects. Restore supports dry-run validation and writes only to a missing or empty target directory. Read [Verified Backups and Disaster Recovery](docs/BACKUPS_AND_RESTORE.md).

Rehearse the recovery rather than assuming it:

```bash
npm run rehearse
```

The drill restores the newest archive into a throwaway directory, confirms every repository passes `git fsck` with the exact refs the snapshot recorded, re-hashes every Git LFS object, asserts no credential was restored in the clear, measures the data-loss window against the live database and files a secret-free evidence record with the measured recovery time. The live instance is never touched. Read [Production Recovery Rehearsal](docs/RECOVERY_REHEARSAL.md).

## PostgreSQL migration readiness

KukGit still runs on SQLite. Stage 1 adds deterministic source manifests, complete protected metadata export, SQL portability findings, PostgreSQL URL redaction and checksummed cutover-readiness validation. Selecting `KUKGIT_DATABASE_DRIVER=postgresql` currently fails closed instead of silently continuing on SQLite.

Use `npm run database -- inventory`, `export`, `verify-export`, `verify-live`, `audit-sql` and `postgresql-status` to prepare migration evidence. Full PostgreSQL runtime, schema import, dual-read validation, cutover and PostgreSQL backup/restore remain open under issue #43. Read [PostgreSQL Metadata Migration](docs/POSTGRESQL_MIGRATION.md).

## Instance administration

Configure `KUKGIT_INSTANCE_ADMIN_EMAILS` with a minimal comma-separated allowlist of verified One Kuklabs Account operators. Authorized operators receive a separate **Instance Admin** navigation entry with adoption metrics, bounded cross-tenant search, tenant and user diagnostics, redacted audit lookup, support notes, and confirmed retry controls for terminal email and webhook failures.

Instance authority is independent from organization roles. The console never exposes passwords, OTPs, AuthKit tokens, PAT material, webhook secrets or SSH private keys, and it does not support impersonation. Read [Instance Admin Console](docs/INSTANCE_ADMIN_CONSOLE.md) before enabling production support access.

## Workflow files

Hosted CI begins with a file format. Workflows live in `.kukgit/workflows/*.yml` and are parsed by KukGit's own YAML subset, which refuses anchors, aliases, merge keys, tags, multiple documents and tab indentation rather than silently reinterpreting them.

The rule that matters most: a value supplied by whoever triggered the workflow — a pull-request title, a fork branch name — **cannot be interpolated into a `run:` script**, because there it is code rather than data. Only an allow-list of repository-controlled fields may appear inline; everything else, including every secret, goes through `env:`.

```yaml
# rejected                                    # accepted
- run: echo "${{ github.event.issue.title }}" # - env:
                                              #     TITLE: ${{ github.event.issue.title }}
                                              #   run: echo "$TITLE"
```

Nothing executes yet — this is the format and its validator. Runners, scheduling, logs and artifacts remain open. Read [Workflow Format](docs/WORKFLOWS.md).

Secrets live in an encrypted vault scoped to an organization or a single repository. AES-256-GCM, with the scope and name authenticated alongside the value, so a ciphertext copied between rows fails to decrypt rather than quietly becoming a different secret. **There is no read path** — no route returns a stored value, not even to the person who set it, because a secret that can be read back can be exfiltrated by anyone who reaches that route. Listings show names and a truncated digest, which is enough to confirm a rotation and far too little to recover a value. Read [Secrets Vault](docs/SECRETS_VAULT.md).

Between a validated file and a runner sits scheduling and authorization: trigger matching, dependency-aware job queueing, concurrency groups, and the credential a job receives. A job token is returned once, stored as a hash, bound to one job, expires in an hour and is destroyed the moment the job finishes. Its permissions are the intersection of what the workflow asked for and a ceiling set by the event — and a pull request from a fork gets a read-only token and **no secrets at all**, which is the "pwn request" class closed by construction. Read [Workflow Runs](docs/WORKFLOW_RUNS.md).

A runner reports through `self` routes authenticated by its job token — it cannot name another job, because there is no job id in the path. Secret values are masked **before the bytes are stored**, so the raw value is never on disk or in a backup. Terminal escape sequences are stripped from output: a viewer where a build can move the cursor or rewrite earlier lines is a viewer where a failure can be made to look like a pass. Read [Build Logs](docs/BUILD_LOGS.md).

## Commands

```bash
npm run dev       # Watch-mode server
npm start         # Start server
npm run seed      # Seed local-development founder and demo repository
npm run doctor    # Check runtime requirements and configuration
npm run token --  # Create, list or revoke personal access tokens
npm run backup -- # Create, verify, restore and prune verified snapshots
npm run rehearse  # Restore a snapshot into a throwaway copy and prove it is serviceable
npm run database -- # Inventory, export, verify and audit metadata migration readiness
npm run ssh:authorized-keys # Generate restricted static authorized_keys fallback
npm run check     # Validate JavaScript source syntax
npm test          # Run automated tests
```

## Repository layout

```text
kukgit/
├── public/                 # Dependency-free web application
├── src/                    # Identity, onboarding, Git, LFS, access, reviews, backups, notifications and email services
├── scripts/                # Seed, doctor, token, SSH, backup and database migration administration
├── test/                   # Node test suite
├── docs/                   # Product, architecture, operations and security docs
├── infra/                  # Container, reverse-proxy and OpenSSH deployment files
├── data/                   # Local runtime data (not committed)
├── server.mjs              # HTTP application entry point
└── CLAUDE.md               # Coding-agent operating instructions
```

## Architecture decision

KukGit is built with a hybrid approach:

- Kuklabs owns product logic, UI, tenancy, permissions, billing, AI, workflows and integrations.
- Proven Git itself is used as the repository object engine.
- No GitHub/GitLab/Gitea/Forgejo product repository is cloned or copied.
- Open-source building blocks may be integrated later under compatible licenses.

See [Architecture](docs/ARCHITECTURE.md) and [Roadmap](docs/ROADMAP.md).

## Security

Read [SECURITY.md](SECURITY.md) before deploying. Development defaults are intentionally easy to run and are not approved for internet exposure.

## Ownership

Copyright © 2026 Kuklabs Inc. All rights reserved. This codebase is proprietary unless Kuklabs Inc. explicitly releases a component under another license.
