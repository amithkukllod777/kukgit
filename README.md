# KukGit

**KukGit is an AI-first Git hosting and developer operating system from Kuklabs Inc.**

This repository contains the first working KukGit foundation. It is not a visual mockup: it creates real bare Git repositories, supports Git smart HTTP clone/push, stores multi-tenant metadata, offers repository browsing, issues, pull requests, browser commits, audit logs and local repository-health analysis.

> Product direction: Git hosting + collaboration + AI review + CI/CD + package/container registries + cloud development and deployment.

## What works in v0.1.0

- Real bare Git repository creation
- Public and private repository metadata
- Git smart HTTP clone and authenticated push
- Scoped personal access tokens with browser and CLI lifecycle management
- Token expiry, revocation, last-used tracking and one-time secret display
- Production Git authorization by token scope plus effective repository permission
- Mirror import for public HTTPS/SSH repositories
- Organizations and role-based access control
- Expiring organization invitations with email verification, one-time acceptance links and revocation
- Organization member directory
- Teams with maintainers, members and auditable lifecycle management
- Direct repository collaborators
- Repository team access grants
- Read, Triage, Write, Maintain and Admin permission hierarchy
- Effective permission calculation across organization role, direct grant and team grants
- Browser API and Git clone/push repository-permission enforcement
- Repository access-management interface
- Exact-branch protection rules
- Pull-request approval and change-request reviews
- Required approval counts and stale-approval detection
- Direct browser commit and Git push protection for guarded branches
- Pull-request merge-policy enforcement
- File and line anchored review threads
- Threaded replies, resolution and reopening
- Outdated-thread detection when the pull-request head changes
- Optional unresolved-thread merge blocking per base branch
- Repository code browser: branches, commits, folders and files
- Browser branch creation and file commits
- Issues with status and priority
- Pull requests with branch comparison and merge
- KukAI local repository health analysis
- Security, test, CI, documentation and governance checks
- Audit log
- Responsive Kuklabs-branded web interface
- No runtime npm dependencies
- Automated tests for API, Git engine, collaboration, repository access, branch governance, review threads, analysis and security helpers

## Important scope boundary

This is the **Foundation MVP**, not yet a GitHub/GitLab replacement. Production work still required includes SSH transport, One Kuklabs Account/SSO/MFA, external collaborators, true unified diff rendering and code-line patch context, required CI checks, large-scale object storage, distributed job queues, CI runners, package/container registries, LFS, webhooks, email, billing, abuse controls and high-availability deployment.

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

The shared development token is disabled automatically in production. Protected clone/fetch requires a read-capable personal access token plus effective repository Read permission. Push requires a `repo:write` personal access token plus effective repository Write permission.

Create a token from **Settings → Personal access tokens** in the KukGit interface, or create a 90-day read/write token from the server CLI:

```bash
npm run token -- create \
  --email admin@kuklabs.local \
  --name "Developer laptop" \
  --scopes repo:read,repo:write \
  --days 90
```

Then use the returned `kgp_...` value as the HTTP Basic password. Read [Personal Access Tokens](docs/PERSONAL_ACCESS_TOKENS.md) for browser management, listing, revocation and operational guidance.

## Organization collaboration

Open **Organizations → Organization collaboration** to:

- invite existing KukGit users with admin, maintainer, developer or viewer roles
- issue secure 7, 14 or 30-day acceptance links
- review pending, accepted, expired and revoked invitations
- manage the organization member directory
- create teams and assign team maintainers and members

Invitation tokens are shown only once and acceptance requires the exact invited account email. Read [Organization Collaboration](docs/ORGANIZATION_COLLABORATION.md) for the complete security and workflow model.

## Repository access

Open a repository and select **Settings** to manage:

- direct collaborator permissions
- team repository grants
- effective permission sources
- Read, Triage, Write, Maintain and Admin access

KukGit combines organization role baseline, direct grants and every applicable team grant. The highest permission wins. Read [Repository Access](docs/REPOSITORY_ACCESS.md) for the complete authorization and Git enforcement model.

## Branch protection and reviews

Repository Admins can protect exact branches from **Repository → Settings**. A rule can:

- require changes through a pull request
- require 0–10 active approvals
- dismiss approvals when the pull-request head changes
- block browser commits and direct Git pushes

Reviewers with repository Write permission can approve, request changes or comment from the repository Pull requests page. KukGit records each review against the current head SHA and blocks merge until the active policy is satisfied. Read [Branch Governance](docs/BRANCH_GOVERNANCE.md) for API, hook and merge-policy details.

## Code review conversations

The repository Pull requests page supports:

- changed-file review threads
- left-side, right-side and file-level anchors
- line validation against the selected Git ref
- threaded replies
- resolve and reopen actions
- outdated-thread visibility after new commits

Repository Admins can optionally require all active threads to be resolved for a base branch before merge. Outdated threads remain visible for history but do not block merge. Read [Review Threads](docs/REVIEW_THREADS.md) for the data, permission and merge-policy model.

## Commands

```bash
npm run dev       # Watch-mode server
npm start         # Start server
npm run seed      # Seed founder, Kuklabs organization and demo repository
npm run doctor    # Check runtime requirements and configuration
npm run token --  # Create, list or revoke personal access tokens
npm run check     # Validate JavaScript source syntax
npm test          # Run automated tests
```

## Repository layout

```text
kukgit/
├── public/                 # Dependency-free web application
├── src/                    # API, auth, access, governance, reviews, database, Git and analysis services
├── scripts/                # Seed, environment doctor and token administration
├── test/                   # Node test suite
├── docs/                   # Product, architecture, business and security docs
├── infra/                  # Container and reverse-proxy deployment files
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

Read [SECURITY.md](SECURITY.md) before deploying. The current development defaults are intentionally easy to run and intentionally not approved for internet exposure.

## Ownership

Copyright © 2026 Kuklabs Inc. All rights reserved. This codebase is proprietary unless Kuklabs Inc. explicitly releases a component under another license.
