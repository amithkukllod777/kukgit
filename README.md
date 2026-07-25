# KukGit

**KukGit is an AI-first Git hosting and developer operating system from Kuklabs Inc.**

This repository contains the first working KukGit foundation. It is not a visual mockup: it creates real bare Git repositories, supports Git smart HTTP clone/push, stores multi-tenant metadata, offers repository browsing, issues, pull requests, browser commits, audit logs and local repository-health analysis.

> Product direction: Git hosting + collaboration + AI review + CI/CD + package/container registries + cloud development and deployment.

## What works in v0.1.0

- Real bare Git repository creation
- Public and private repository metadata
- Git smart HTTP clone and authenticated push
- Mirror import for public HTTPS/SSH repositories
- Organizations and role-based access control
- Repository code browser: branches, commits, folders and files
- Browser branch creation and file commits
- Issues with status and priority
- Pull requests with branch comparison and merge
- KukAI local repository health analysis
- Security, test, CI, documentation and governance checks
- Audit log
- Responsive Kuklabs-branded web interface
- No runtime npm dependencies
- Automated tests for API, Git engine, analysis and security helpers

## Important scope boundary

This is the **Foundation MVP**, not yet a GitHub/GitLab replacement. Production work still required includes SSH transport, personal access tokens, SSO/MFA, large-scale object storage, distributed job queues, CI runners, package/container registries, LFS, webhooks, email, billing, abuse controls and high-availability deployment.

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

## Clone and push test

Public clone:

```bash
git clone http://localhost:8787/git/kuklabs/kukgit-demo.git
```

Push over Git smart HTTP uses HTTP Basic authentication. The username may be any non-empty value and the password must match `KUKGIT_DEV_GIT_TOKEN`.

```bash
git push http://developer:<KUKGIT_DEV_GIT_TOKEN>@localhost:8787/git/kuklabs/kukgit-demo.git main
```

The development token model must be replaced by personal access tokens/deploy keys before production.

## Commands

```bash
npm run dev       # Watch-mode server
npm start         # Start server
npm run seed      # Seed founder, Kuklabs organization and demo repository
npm run doctor    # Check runtime requirements and configuration
npm test          # Run automated tests
```

## Repository layout

```text
kukgit/
├── public/                 # Dependency-free web application
├── src/                    # API, auth, database, Git and analysis services
├── scripts/                # Seed and environment doctor
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
