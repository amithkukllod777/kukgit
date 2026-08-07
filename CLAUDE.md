# CLAUDE.md — KukGit Engineering Instructions

You are working on KukGit, an AI-first Git hosting and developer operating system owned by Kuklabs Inc.

## Product goal

Build a commercial platform that can host and manage repositories for Kuklabs and external customers. It must support SaaS, enterprise and future self-hosted deployment.

## Architecture approach

- Keep the current foundation working.
- Evolve through clear service interfaces rather than a premature full rewrite.
- Use Git as the repository engine.
- Kuklabs owns UI, business logic, identity integration, tenancy, permissions, AI, billing and workflows.
- Third-party libraries require compatible licensing and security review.

## Identity mandate

**KukGit owns its own accounts.** Email and password, verified email, password
reset — production-grade, in this repository. One Kuklabs Account/AuthKit stays
supported as an **optional** sign-in path, not a requirement.

This reverses the earlier mandate, on the owner's decision (2026-08-07), for two
reasons found by reading the AuthKit service rather than its documentation:

- **Blast radius.** AuthKit is not a separate service. It is a router mounted on
  the KukBook ERP — one process, one MySQL database, one deploy, no staging, no
  redundancy. Every ERP deploy restarts authentication; an ERP outage is a
  sign-in outage. A Git host whose login falls over when the accounting system
  ships is not a Git host anybody can rely on.
- **External customers.** KukGit is meant to host repositories for customers
  outside Kuklabs. Requiring an outside developer to create a Kuklabs Account —
  on the same system that runs Kuklabs' own ERP — is not a thing that sells.

A user may belong to multiple organizations. Every repository belongs to one
organization. Authorization must be enforced server-side for every read and
write.

## Engineering standards

- Validate all untrusted input.
- Never construct shell command strings from user input.
- Store token hashes, not plaintext tokens.
- Add tests for authorization boundaries.
- Use structured errors with request IDs.
- Emit audit events for sensitive actions.
- Keep backward-compatible Git URLs and API contracts where possible.
- Document migrations and rollback.

## Commands

```bash
npm run doctor
npm run seed
npm test
npm start
npm run ci             # everything .github/workflows/ci.yml runs — GitHub's
                       # runners are blocked on account billing, so this is
                       # the verdict
npm run postgres:dev   # a disposable PostgreSQL 16, so `ci` skips nothing
npm run deps           # licences and lockfile drift
npm run vulns          # npm advisories
npm run sbom           # CycloneDX bill of materials
```

## Current technology

- Node.js built-in HTTP server
- Node SQLite for MVP metadata
- Git CLI and bare repository storage
- dependency-free web UI; `pg` is the only declared npm dependency, lazily loaded and off by default
- Node test runner

## Next target

Private alpha with Kuklabs Account, invitations, scoped PATs, SSH keys, PostgreSQL, branch protection, review comments, webhooks and production backup/observability.
