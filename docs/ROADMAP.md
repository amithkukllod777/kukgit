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

Remaining:

- One Kuklabs Account/AuthKit
- external repository collaborators
- organization signup and invitation email delivery
- token rotation reminders and expiring-token notifications
- SSH keys and deploy keys
- PostgreSQL migration
- repository transfer, archive and delete
- unified diff rendering and diff-hunk anchors
- required CI status checks
- webhooks
- email and in-app notifications
- Git LFS
- backups and restore automation
- admin console and tenant support tools

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
