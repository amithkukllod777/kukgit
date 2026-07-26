# KukGit

**KukGit is an AI-first Git hosting and developer operating system from Kuklabs Inc.**

This repository contains the working KukGit foundation. It is not a visual mockup: it creates real bare Git repositories, supports Git smart HTTP and SSH clone/push, stores multi-tenant metadata, offers repository browsing, issues, pull requests, governed reviews, verified backups, Git LFS and local repository-health analysis.

> Product direction: Git hosting + collaboration + AI review + CI/CD + package/container registries + cloud development and deployment.

## What works in v0.1.0

- Real bare Git repository creation
- Public and private repository metadata
- Git smart HTTP clone and authenticated push
- Git-over-SSH with user keys and repository deploy keys
- Git LFS Batch API, verified uploads, range downloads, quotas and deduplication
- Scoped personal access tokens with browser and CLI lifecycle management
- Token expiry, revocation, last-used tracking and one-time secret display
- Production Git authorization by token scope plus effective repository permission
- Mirror import for public HTTPS/SSH repositories
- Organizations and role-based access control
- Expiring organization invitations with email verification, one-time acceptance links and revocation
- Organization member directory
- Teams with maintainers, members and auditable lifecycle management
- Direct repository collaborators and repository team access grants
- Read, Triage, Write, Maintain and Admin permission hierarchy
- Effective permission calculation across organization role, direct grant and team grants
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
- Repository code browser: branches, commits, folders and files
- Browser branch creation and file commits
- Issues with status and priority
- Pull requests with branch comparison and merge
- Verified `.kgbak` snapshots, integrity checks, dry-run restore and disaster recovery
- KukAI local repository health analysis
- Security, test, CI, documentation and governance checks
- Audit log
- Responsive Kuklabs-branded web interface
- No runtime npm dependencies
- Automated tests for API, Git, LFS, backup/restore, collaboration, access, governance, reviews, checks, webhooks and security helpers

## Important scope boundary

This is the **Private Alpha foundation**, not yet a GitHub/GitLab replacement. Production work still required includes One Kuklabs Account/SSO/MFA, external collaborators, hosted CI runners and workflow execution, PostgreSQL and distributed jobs, package/container registries, email/in-app notifications, billing and usage metering, abuse controls, scalable object storage, advanced administration and high-availability deployment.

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

These defaults are strictly for local development. Set strong environment values before any shared deployment.

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

Open **Organizations → Organization collaboration** to invite users, review invitation status, manage members and create teams. Invitation tokens are shown only once and acceptance requires the exact invited account email. Read [Organization Collaboration](docs/ORGANIZATION_COLLABORATION.md).

## Repository access

Open a repository and select **Settings** to manage direct collaborator permissions, team grants and effective permission sources. KukGit combines organization role baseline, direct grants and team grants; the highest permission wins. Read [Repository Access](docs/REPOSITORY_ACCESS.md).

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

Snapshots include SQLite metadata, Git bundles and all recorded Git LFS objects. Restore supports dry-run validation and writes only to a missing or empty target directory. Read [Verified Backups and Disaster Recovery](docs/BACKUPS_AND_DISASTER_RECOVERY.md).

## Commands

```bash
npm run dev       # Watch-mode server
npm start         # Start server
npm run seed      # Seed founder, Kuklabs organization and demo repository
npm run doctor    # Check runtime requirements and configuration
npm run token --  # Create, list or revoke personal access tokens
npm run backup -- # Create, verify, restore and prune verified snapshots
npm run ssh:authorized-keys # Generate restricted static authorized_keys fallback
npm run check     # Validate JavaScript source syntax
npm test          # Run automated tests
```

## Repository layout

```text
kukgit/
├── public/                 # Dependency-free web application
├── src/                    # API, auth, access, Git, LFS, backups, reviews and workflow services
├── scripts/                # Seed, doctor, token, SSH and backup administration
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
