# KukGit Architecture

## Current foundation

```text
Browser
  │
  ├── KukGit Web UI (HTML/CSS/ES modules)
  │
  └── HTTP API / Git Smart HTTP
          │
          ├── Auth and sessions
          ├── Organization RBAC
          ├── Repository metadata
          ├── Issues and pull requests
          ├── Audit service
          ├── KukAI local analyzer
          ├── SQLite metadata store
          └── Git CLI + bare repositories on disk
```

The foundation intentionally carries almost no runtime npm dependencies. This
reduces setup risk and proves the core product workflows before service
extraction.

The single exception is `pg`, added with the PostgreSQL write service. It is
imported lazily and only when that driver is enabled, so an instance in its
default configuration runs with no dependency loaded at all — but it is declared,
installed and therefore part of the supply chain to review and patch. Anything
proposed after it should have to argue against that same bar.

## Production target

```text
Edge / WAF / CDN
      │
API Gateway + Kuklabs AuthKit
      │
 ┌────┼─────────────┬──────────────┬───────────────┐
 │    │             │              │               │
Web  Core API    Git Gateway    Event Bus       Webhooks
 │    │             │              │               │
 │ PostgreSQL    Git Storage    Job Workers     Deliveries
 │                  │              │
 │              Object Store   AI / CI / Security
 │                  │              │
 └──────────── Search / Analytics / Audit ─────────┘
```

## Planned service boundaries

### Identity and tenant service

Authoritative Kuklabs Account users, organizations, memberships, entitlements and billing identity.

### Repository service

Repository metadata, visibility, branch protection, collaborators, mirrors, forks and transfer.

### Git gateway

HTTP and SSH Git protocol, authentication, authorization, rate limiting and repository routing.

### Git storage

Sharded Git object storage, replication, maintenance, garbage collection, LFS and disaster recovery.

### Collaboration service

Issues, pull requests, reviews, comments, checks, releases, discussions and wiki.

### Automation service

Workflow parsing, queues, runners, artifacts, logs, caches and environments.

### AI service

Repository indexing, embeddings, code graph, agents, model routing, policy and usage metering.

### Registry service

Packages, containers, provenance, SBOM and retention.

### Search service

Code, issue, commit, symbol and semantic search.

## Multi-tenancy

Every business record carries an organization ID. Every request resolves:

```text
user identity → organization membership → product entitlement → repository permission → action policy
```

Repository visibility never replaces explicit authorization for write operations.

## Storage strategy

- PostgreSQL: metadata and transactional collaboration data
- Redis: cache, sessions, rate limits and short-lived coordination
- Object storage: LFS, artifacts, packages, releases and backups
- Git storage nodes: repository objects and packfiles
- Search index: code and metadata search
- immutable audit sink: governance and security events

## Build strategy

KukGit does not clone a competing product repository. It builds Kuklabs product layers while using Git and compatible open-source infrastructure as components. Each third-party dependency requires license, security and maintenance review.
