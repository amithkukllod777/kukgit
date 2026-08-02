# KukGit HTTP API

Base path: `/api`. All responses are JSON unless noted.

This document covers the KukGit v0.2.0 surface. Endpoints are grouped by the service
module that owns them; the owning source file is named in each section so the contract
and the implementation stay findable together.

## Conventions

### Authentication

Every endpoint except `GET /api/health` and the unauthenticated `/api/auth/*` flows
requires a signed-in browser session carried by the `kukgit_session` cookie.

In AuthKit mode the cookie is an opaque random bridge value; the AuthKit access and
refresh tokens are held encrypted server-side and are never sent to the browser.

Some endpoints authenticate differently:

- `POST /api/status-checks/:org/:repo/commits/:sha/statuses` and the Git LFS Batch
  API under `/git/:org/:repo.git/info/lfs` accept a scoped personal access token via
  `Authorization: Bearer kgp_...`.
- `POST /api/email-provider/events` is a machine callback authenticated by HMAC over
  a timestamped raw body, with no session at all.

### CSRF

`POST`, `PUT`, `PATCH` and `DELETE` requests are rejected with `403 CSRF_BLOCKED`
when an `Origin` header is present and does not match `KUKGIT_BASE_URL`.

### Authorization

`/api/repos/:org/:repo/*` is guarded centrally before the handler runs
(`src/repository-access.mjs`). The required effective repository permission is derived
from the method and path:

| Request | Required permission |
|---|---|
| `GET`, `HEAD` | `read` |
| `POST /issues`, `PATCH /issues/:number` | `triage` |
| `POST /pulls/:number/merge` | `maintain` |
| any other `POST`, `PUT`, `PATCH`, `DELETE` | `write` |

Other namespaces call `requireRepositoryAccess` directly and state their own minimum
permission. Effective permission is the highest of the organization role baseline,
a direct collaborator grant and any team grant.

Permission hierarchy: `read` < `triage` < `write` < `maintain` < `admin`.

Organization role hierarchy: `viewer` < `developer` < `maintainer` < `admin` < `owner`.

### Error shape

```json
{
  "error": {
    "code": "REPO_NOT_FOUND",
    "message": "Repository not found.",
    "requestId": "req_..."
  }
}
```

`5xx` responses always return a generic message. Every response carries `X-Request-Id`;
quote it in support requests so the audit trail can be correlated.

---

## Health

`src/app.mjs`, `src/operations-health.mjs`

```text
GET /api/health                    Liveness: is the process up
GET /api/health/ready              Readiness: can this instance serve
```

`/api/health` is unauthenticated and returns service name, version and uptime.

`/api/health/ready` is unauthenticated and returns `200 {"status":"ready"}` or
`503 {"status":"not_ready"}` with **no further detail**. It checks that the
database is reachable and that repository storage and the data volume are
writable. A load balancer needs the status code; which subsystem is failing is
operator information and is available only through
`GET /api/instance-admin/health`.

## Authentication

`src/authkit-identity.mjs`, `src/authkit-secure-login.mjs` (AuthKit mode)
`src/app.mjs` (local development mode)

```text
GET  /api/auth/status          Which auth mode this instance runs
POST /api/auth/login           Password login
POST /api/auth/signup          Create a One Kuklabs Account
POST /api/auth/otp/request     Request an email OTP
POST /api/auth/otp/verify      Verify an email OTP
POST /api/auth/google          Exchange a Google ID token
POST /api/auth/logout          Destroy the local bridge session
GET  /api/auth/me              Current user and organization memberships
```

In AuthKit mode these proxy the central `/v1/auth/*` contract with the
`X-Kuklabs-Product: kukgit` header. In local development mode only `login`,
`logout` and `me` exist and are served by `src/app.mjs`.

## Dashboard and organizations

`src/app.mjs`

```text
GET /api/dashboard   Metrics, recent repositories and activity
GET /api/orgs        Organizations the user belongs to
GET /api/audit       Organization-scoped audit log (100 most recent)
GET /api/issues      Issues across all accessible repositories
GET /api/pulls       Pull requests across all accessible repositories
```

For repository-only external collaborators, `/api/repos`, `/api/issues` and
`/api/pulls` are served by `src/external-collaborator-discovery.mjs` instead and
return only explicitly shared repositories.

## Organization onboarding

`src/organization-onboarding.mjs`

```text
GET  /api/onboarding/status                      Whether the user needs onboarding
GET  /api/onboarding/organizations/slug/:slug    Slug availability check
POST /api/onboarding/organizations               Create a workspace
```

Workspace creation is one transaction: organization, Owner membership, default
Developers team and creator-as-Maintainer. Any failure rolls the whole thing back.
Subject to `KUKGIT_ORGANIZATION_OWNER_LIMIT` and the reserved-slug list.

## Repositories

`src/app.mjs`

```text
GET  /api/repos                              List accessible repositories
POST /api/repos                              Create a repository
POST /api/repos/import                       Mirror-import a public HTTPS/SSH repository
GET  /api/repos/:org/:repo                   Repository summary
GET  /api/repos/:org/:repo/branches          List branches
POST /api/repos/:org/:repo/branches          Create a branch
GET  /api/repos/:org/:repo/commits?ref=      List commits (max 100)
GET  /api/repos/:org/:repo/tree?ref=&path=   List a directory
GET  /api/repos/:org/:repo/blob?ref=&path=   Read a file (max 1 MB)
POST /api/repos/:org/:repo/files             Commit a file from the browser
```

`POST /api/repos` and `POST /api/repos/import` require organization `maintainer`.
Import URLs are validated against private networks, embedded credentials and
non-HTTPS/SSH protocols.

## Issues

`src/app.mjs`

```text
GET   /api/repos/:org/:repo/issues?status=open|closed
POST  /api/repos/:org/:repo/issues
PATCH /api/repos/:org/:repo/issues/:number
```

## Pull requests

`src/app.mjs`

```text
GET  /api/repos/:org/:repo/pulls
POST /api/repos/:org/:repo/pulls
POST /api/repos/:org/:repo/pulls/:number/merge
```

Merge passes through four server-side guards in order: branch governance, review
threads, required status checks, then the merge itself. Any guard can block with
`409`.

## Repository analysis

`src/analysis.mjs`

```text
GET  /api/repos/:org/:repo/analyze   Latest stored analysis
POST /api/repos/:org/:repo/analyze   Run a new analysis
```

Deterministic local repository-health scoring. No source is sent to any AI provider.

## Personal access tokens

`src/token-api.mjs`

```text
GET    /api/settings/tokens            List tokens (metadata only)
POST   /api/settings/tokens            Create a token, plaintext returned once
DELETE /api/settings/tokens/:tokenId   Revoke a token
```

Tokens use the `kgp_` prefix, are stored only as SHA-256 hashes and are revealed
exactly once at creation. Scopes are `repo:read` and `repo:write`.

## Organization collaboration

`src/collaboration.mjs`, `src/collaboration-notifications.mjs`

```text
POST   /api/collaboration/invitations/accept                          Accept an invitation
GET    /api/collaboration/orgs/:org                                   Members, teams, invitations
POST   /api/collaboration/orgs/:org/invitations                       Invite a user
DELETE /api/collaboration/orgs/:org/invitations/:invitationId         Revoke an invitation
POST   /api/collaboration/orgs/:org/invitations/:invitationId/resend  Revoke and resend
POST   /api/collaboration/orgs/:org/teams                             Create a team
DELETE /api/collaboration/orgs/:org/teams/:teamId                     Delete a team
POST   /api/collaboration/orgs/:org/teams/:teamId/members             Add a team member
DELETE /api/collaboration/orgs/:org/teams/:teamId/members/:userId     Remove a team member
```

Invitation tokens are hashed, expiring and single-use. Acceptance requires the exact
invited email. Resend revokes the previous link.

## Repository access

`src/repository-access.mjs`

```text
GET    /api/repository-access/:org/:repo                        Effective permissions and sources
POST   /api/repository-access/:org/:repo/collaborators          Add a direct collaborator
DELETE /api/repository-access/:org/:repo/collaborators/:userId  Remove a direct collaborator
POST   /api/repository-access/:org/:repo/teams                  Grant team access
DELETE /api/repository-access/:org/:repo/teams/:teamId          Revoke team access
```

Requires repository `admin`.

## External repository collaborators

`src/repository-invitations.mjs`, `src/external-access-reviews.mjs`,
`src/external-access-expiry-guard.mjs`, `src/external-access-invitation-duration.mjs`

```text
POST   /api/repository-invitations/accept                                   Accept a repository invitation
GET    /api/repository-invitations/:org/:repo                               List invitations
POST   /api/repository-invitations/:org/:repo                               Invite an external user
POST   /api/repository-invitations/:org/:repo/:id/revoke                    Revoke an invitation
POST   /api/repository-invitations/:org/:repo/:id/resend                    Revoke and resend
PATCH  /api/repository-invitations/:org/:repo/collaborators/:userId         Change permission
PATCH  /api/external-access-invitations/:org/:repo/:id/duration             Set accepted-access duration

GET    /api/external-access/:org/:repo                                      External grants for a repository
PATCH  /api/external-access/:org/:repo/collaborators/:userId                Update an external grant
GET    /api/external-access/:org/reviews                                    List review campaigns
POST   /api/external-access/:org/reviews                                    Start a review campaign
GET    /api/external-access/:org/reviews/:campaignId                        Campaign detail
POST   /api/external-access/:org/reviews/:campaignId/items/:itemId          Keep, renew, reduce or revoke

GET    /api/external-access-history/:org/:repo                              Immutable access history
POST   /api/external-access-history/:org/:repo/:historyId/renew             Renew expired access
```

External collaborators receive a direct repository grant without an `org_members`
row. Accepted access defaults to 90 days. Expiry is enforced at request time across
browser, Git HTTP, Git SSH and Git LFS before authorization is granted. External
collaborators cannot extend their own access.

## Repository lifecycle

`src/repository-lifecycle.mjs`

```text
GET    /api/repository-lifecycle/trash                            List trashed repositories
POST   /api/repository-lifecycle/trash/:repositoryId/restore      Restore from Trash
DELETE /api/repository-lifecycle/trash/:repositoryId              Permanently purge (Owner only)
GET    /api/repository-lifecycle/:org/:repo                       Lifecycle state
POST   /api/repository-lifecycle/:org/:repo/archive               Archive (read-only)
DELETE /api/repository-lifecycle/:org/:repo/archive               Unarchive
POST   /api/repository-lifecycle/:org/:repo/transfer              Transfer to another organization
POST   /api/repository-lifecycle/:org/:repo/trash                 Move to Trash (30-day recovery)
```

Transfer and Trash require actual organization Admin or Owner membership — an
external Repository Admin cannot perform them.

## SSH keys and deploy keys

`src/ssh-keys.mjs`

```text
GET    /api/ssh-keys                                  List user keys
POST   /api/ssh-keys                                  Add a user key
DELETE /api/ssh-keys/:keyId                           Remove a user key
GET    /api/ssh-keys/:org/:repo/deploy-keys           List repository deploy keys
POST   /api/ssh-keys/:org/:repo/deploy-keys           Add a deploy key
DELETE /api/ssh-keys/:org/:repo/deploy-keys/:keyId    Remove a deploy key
```

Ed25519, ECDSA and RSA are accepted. Keys are fingerprinted with SHA-256 and cannot
be reused across user and deploy-key scopes while active. Deploy-key management
requires repository `admin`.

## Branch governance

`src/branch-governance.mjs`

```text
GET    /api/governance/:org/:repo                          Rules and review state
PUT    /api/governance/:org/:repo/rules/:branch            Create or update a rule
DELETE /api/governance/:org/:repo/rules/:branch            Delete a rule
GET    /api/governance/:org/:repo/pulls/:number            Review state for a pull request
POST   /api/governance/:org/:repo/pulls/:number/reviews    Approve, request changes or comment
```

Rules match an exact branch name. Enforcement covers browser commits, the merge API
and Git pushes through a `pre-receive` hook.

## Review threads

`src/review-threads.mjs`

```text
GET    /api/review-threads/:org/:repo                                              Thread policies
PUT    /api/review-threads/:org/:repo/policies/:branch                             Require resolution before merge
DELETE /api/review-threads/:org/:repo/policies/:branch                             Remove the policy
GET    /api/review-threads/:org/:repo/pulls/:number                                Threads for a pull request
POST   /api/review-threads/:org/:repo/pulls/:number/threads                        Start a thread
POST   /api/review-threads/:org/:repo/pulls/:number/threads/:threadId/replies      Reply
POST   /api/review-threads/:org/:repo/pulls/:number/threads/:threadId/resolve      Resolve
POST   /api/review-threads/:org/:repo/pulls/:number/threads/:threadId/reopen       Reopen
```

Threads anchor only to real patch lines. Anchors carry the merge-base and head SHA so
threads are marked outdated when the head moves.

## Pull request diffs

`src/pull-request-diffs.mjs`

```text
GET /api/pull-request-diffs/:org/:repo/pulls/:number
```

Merge-base-correct unified diff with parsed hunks, per-file statistics, rename and
binary metadata. Supports paginated file summaries and lazy per-file patch loading
through query parameters.

## Required status checks

`src/status-checks.mjs`

```text
POST   /api/status-checks/:org/:repo/commits/:sha/statuses   Publish a status (PAT or session)
GET    /api/status-checks/:org/:repo/commits/:sha/statuses   Statuses for a commit
GET    /api/status-checks/:org/:repo                         Policies and contexts
PUT    /api/status-checks/:org/:repo/policies/:branch        Require contexts for a branch
DELETE /api/status-checks/:org/:repo/policies/:branch        Remove the policy
GET    /api/status-checks/:org/:repo/pulls/:number           Check state for a pull request
```

Publishing accepts `Authorization: Bearer kgp_...` with `repo:write` plus effective
repository Write. Only the current pull-request head SHA counts; every required
context must report `success`.

```bash
curl -X POST \
  -H "Authorization: Bearer kgp_..." \
  -H "Content-Type: application/json" \
  "$KUKGIT_BASE_URL/api/status-checks/kuklabs/demo/commits/<40-char-sha>/statuses" \
  -d '{"context":"test","state":"success","description":"All tests passed"}'
```

## Webhooks

`src/webhooks.mjs`

```text
GET    /api/webhooks/:org/:repo                                        List webhooks and deliveries
POST   /api/webhooks/:org/:repo                                        Create a webhook
PATCH  /api/webhooks/:org/:repo/:webhookId                             Update a webhook
DELETE /api/webhooks/:org/:repo/:webhookId                             Delete a webhook
POST   /api/webhooks/:org/:repo/:webhookId/ping                        Send a ping event
POST   /api/webhooks/:org/:repo/deliveries/:deliveryId/redeliver       Redeliver
```

Requires repository `admin`. Secrets are shown once and encrypted at rest with
AES-256-GCM. Deliveries carry:

```text
X-KukGit-Event: push
X-KukGit-Delivery: whd_...
X-KukGit-Signature-256: sha256=<HMAC of the exact raw body>
```

Production targets must use HTTPS and resolve to public addresses.

## Notifications and email

`src/notifications.mjs`

```text
GET  /api/notifications                          Inbox and unread count
POST /api/notifications/:id/read                 Mark read
POST /api/notifications/:id/unread               Mark unread
POST /api/notifications/read-all                 Mark all read
GET  /api/notifications/preferences              Per-category delivery preferences
PUT  /api/notifications/preferences              Update preferences
GET  /api/notifications/admin/outbox             Email outbox status
POST /api/notifications/admin/process            Process the outbox now
POST /api/notifications/admin/outbox/:id/retry   Retry a failed email
```

The `admin/*` routes require instance-administrator authority. Categories are
`organization`, `security`, `pull_request`, `status` and `operations`.

Retrying a message whose recipient is suppressed does nothing: outbox triggers
refuse the status change while a suppression is active, so the request reports the
message as not retryable. Release the address first.

## Real-time notifications

`src/realtime-notifications.mjs`

```text
GET /api/notifications/socket    WebSocket upgrade (RFC 6455)
```

Authenticated by the same `kukgit_session` cookie as the REST API. The `Origin`
header must be present and must match `KUKGIT_BASE_URL` — cookies ride along on
upgrade requests and the browser same-origin policy does not restrict WebSocket the
way it restricts `fetch`, so this check is what prevents cross-site hijacking.

The endpoint is push-only; clients send nothing but control frames.

Sessions are re-validated on an interval, so a socket outlives a revoked or expired
session by at most one revalidation period.

Tuning lives in `KUKGIT_REALTIME_*` (heartbeat, revalidation interval, per-user and
per-instance connection caps, maximum inbound message size). Defaults and bounds are
in [Notifications and Transactional Email](NOTIFICATIONS_AND_EMAIL.md).

Behind a reverse proxy, `Upgrade` and `Connection` must be forwarded; see
`infra/nginx.conf`.

## Email delivery events

`src/email-provider-events.mjs`

```text
POST /api/email-provider/events                                  Provider callback
GET  /api/email-provider/admin/suppressions                      List suppressions
GET  /api/email-provider/admin/events                            Recent events
POST /api/email-provider/admin/suppressions/:email/unsuppress    Release an address
```

The callback is machine-to-machine, so there is no session and no CSRF context.
Authentication is an HMAC-SHA256 over `<timestamp>.<raw body>`:

```text
X-KukGit-Email-Timestamp: 1785350000
X-KukGit-Email-Signature-256: sha256=<digest>
```

Binding the timestamp into the signature gives replay protection; requests outside
`KUKGIT_EMAIL_PROVIDER_WEBHOOK_TOLERANCE_SECONDS` (default 300) are rejected. The
endpoint stays disabled until `KUKGIT_EMAIL_PROVIDER_EVENTS_ENABLED` is set with a
32-character `KUKGIT_EMAIL_PROVIDER_WEBHOOK_SECRET`.

Event types normalize to `delivered`, `deferred`, `bounce` and `complaint`. A hard
bounce or complaint suppresses the address immediately; repeated soft bounces
suppress once they cross a threshold inside a window, and that suppression expires.

A second suppression signal needs no endpoint: permanent SMTP rejections observed
at the `RCPT TO` stage during delivery are classified by `classifySmtpRejection` and
filed as a synthetic event with provider `smtp`. Rejections at other stages, quota
responses and policy blocks stay retryable. See
[Notifications and Transactional Email](NOTIFICATIONS_AND_EMAIL.md) for the full
classification table.

The `admin/*` routes require instance-administrator authority. Release requires
confirming the address in the request body.

## Git Large File Storage

`src/git-lfs.mjs`

Git-facing protocol endpoints (PAT or SSH-issued credentials):

```text
POST /git/:org/:repo.git/info/lfs/objects/batch          Batch API
PUT  /git/:org/:repo.git/info/lfs/objects/:oid           Upload
GET  /git/:org/:repo.git/info/lfs/objects/:oid           Download (supports Range)
POST /git/:org/:repo.git/info/lfs/objects/:oid/verify    Verify
```

Administration endpoints (browser session):

```text
GET  /api/lfs/:org/:repo                          Usage, objects and integrity
POST /api/lfs/:org/:repo/objects/:oid/verify      Re-verify one object
POST /api/lfs/gc                                  Collect orphaned objects (instance admin)
```

Objects are content-addressed by SHA-256, deduplicated across repositories and
subject to per-object, per-repository and per-instance quotas.

## Backups

`src/backups.mjs`, `src/backups-lfs.mjs`

```text
GET  /api/backups                      List snapshots and retention state
POST /api/backups                      Create a verified snapshot
POST /api/backups/prune                Apply the retention policy
POST /api/backups/:filename/verify     Verify an archive
```

Requires instance-administrator authority. Snapshots are `.kgbak` archives containing
SQLite metadata, Git bundles and all recorded LFS objects with SHA-256 checksums.
Restore is CLI-only (`npm run backup -- restore`) and writes only to a missing or
empty target directory.

## Runners

`src/runners.mjs`

```text
GET    /api/runners/orgs/:org              List runners (never their tokens)
POST   /api/runners/orgs/:org              Register a runner, token returned once
DELETE /api/runners/orgs/:org/:runnerId    Remove a runner

POST   /api/runners/claim                  Agent claims the next job
```

Registration requires organization **Admin**. The runner token is stored only as
a SHA-256 hash and carries its organization, so a runner cannot claim work for a
tenancy it was not registered for. An idle claim answers `204`, not an error — an
idle runner polls constantly and a `4xx` would make every quiet minute look like
a fault. Read [Self-Hosted Runners](SELF_HOSTED_RUNNERS.md).

## Workflow runs and build logs

`src/workflow-logs.mjs`

```text
POST /api/workflow-jobs/self/logs                          Runner appends output
POST /api/workflow-jobs/self/heartbeat                     Runner reports in, learns about cancellation
POST /api/workflow-jobs/self/complete                      Runner reports the outcome

GET  /api/workflow-runs/:org/:repo/:runId                  Run and every job
GET  /api/workflow-runs/:org/:repo/:runId/jobs/:jobId/logs Cursor-paged log
POST /api/workflow-runs/:org/:repo/:runId/cancel           Stop the run
```

Runner routes are authenticated by a job token (`Authorization: Bearer`) and are
all `self` — the token identifies exactly one job and there is no job id in the
path to point elsewhere. Reader routes need repository read; cancelling needs
write. Read [Build Logs](BUILD_LOGS.md).

## Tenant deletion

`src/tenant-lifecycle.mjs`

```text
GET  /api/instance-admin/tenants/:slug/census          What a deletion would destroy
POST /api/instance-admin/tenants/deletions             Schedule one (7-day wait)
POST /api/instance-admin/tenants/deletions/:id/cancel  Cancel while it waits
GET  /api/instance-admin/tenants/deletions             History and verification reports
```

Instance administrator only. The table list is **derived from the schema** rather
than written down, so a table added later is included automatically or reported
as unclassified — and an unclassified table fails the deletion. Read
[Tenant Deletion](TENANT_DELETION.md).

## Tenant export

`src/tenant-export.mjs`

```text
GET  /api/instance-admin/tenants/exports               What has been exported and whether it verified
POST /api/instance-admin/tenants/exports/:id/verify    Open the archive and read it back
```

Instance administrator only. Exports are **created from the command line**
(`npm run export -- --org acme`), not over HTTP: copying every repository and
every large file a tenant owns takes minutes to hours, and a request that runs
that long times out leaving a half-written archive. A deletion refuses to
execute until a verified export has been taken since it was requested. Read
[Tenant Export](TENANT_EXPORT.md).

Loading one back is `npm run import -- --archive PATH`, also command line only
and with no HTTP surface at all. Read [Tenant Import](TENANT_IMPORT.md).

## Push protection

`src/push-protection.mjs`

```text
GET  /api/repos/:org/:repo/push-protection             Policy (repository write)
PUT  /api/repos/:org/:repo/push-protection             Change it (admin, same-origin)
POST /api/repos/:org/:repo/push-protection/bypasses    Allow one finding (admin)
GET  /api/repos/:org/:repo/push-protection/bypasses    Who allowed what, and why
```

Off until an administrator enables it per repository. A bypass names the
**fingerprint** it covers, expires after 30 minutes, and requires a written
reason — a bypass that is not recorded is a control that is not enforced. Read
[Push Protection](PUSH_PROTECTION.md).

## Secret scanning

`src/secret-scanning.mjs`

```text
GET   /api/repos/:org/:repo/secret-scanning?status=open|all   Findings and summary
PATCH /api/repos/:org/:repo/secret-scanning/findings/:id      Resolve one finding
```

Reading needs repository **write**, not read: a finding names a file and a line
where a credential is, and a private repository's read list is usually wider than
the set of people who should be handed that map. Resolving needs **admin** and a
same-origin request.

No response, and no stored row, ever contains a credential — only a truncated
fingerprint and a redacted preview. Read [Secret Scanning](SECRET_SCANNING.md).

## Workflow triggers

`src/workflow-triggers.mjs`

```text
POST /api/repos/:org/:repo/workflow-dispatch    Start one workflow by hand
GET  /api/repos/:org/:repo/workflow-schedules   Registered schedules and next fire time
```

Manual dispatch needs repository write and a same-origin request — starting a
workflow runs the repository's own code with its own secrets. The workflow must
exist at the resolved commit and declare `manual`, and inputs must be declared in
the file. Schedules are read from the default branch only. Read
[Workflow Triggers](WORKFLOW_TRIGGERS.md).

## Build artifacts and cache

`src/workflow-storage.mjs`

```text
POST   /api/workflow-jobs/self/artifacts                     Runner uploads an artifact
POST   /api/workflow-jobs/self/cache                         Runner saves a cache entry
GET    /api/workflow-jobs/self/cache?key=&restoreKey=        Runner restores a cache entry

GET    /api/workflow-runs/:org/:repo/:runId/artifacts        Artifact metadata for a run
GET    /api/workflow-runs/:org/:repo/:runId/artifacts/:id    Download the bytes
DELETE /api/workflow-runs/:org/:repo/:runId/artifacts/:id    Delete one artifact
GET    /api/repositories/:org/:repo/ci-storage               Usage against quota
```

Uploads carry raw bytes; the name is `X-Artifact-Name` and the cache key is
`X-Cache-Key`. No write request names a repository, a run or a ref — the job
token decides all three, so a job cannot write to another repository's storage.

Reading needs repository read; deleting needs write and a same-origin request. A
fork pull request may restore a cache but never save one. Read
[Artifacts and Cache](ARTIFACTS_AND_CACHE.md).

## Secrets

`src/secrets-vault.mjs`

```text
GET    /api/secrets/orgs/:org                  List organization secret names
PUT    /api/secrets/orgs/:org/:name            Create or replace
DELETE /api/secrets/orgs/:org/:name            Remove

GET    /api/secrets/repos/:org/:repo           List repository names and inherited names
PUT    /api/secrets/repos/:org/:repo/:name     Create or replace
DELETE /api/secrets/repos/:org/:repo/:name     Remove
```

Organization secrets require organization Admin; repository secrets require
repository Admin.

**There is no read path.** No route returns a stored value — not to the caller who
set it, not to an instance operator. `GET` of a single secret returns `404` by
design. Listings carry names, a 12-character digest of the value and usage
metadata only. Read [Secrets Vault](SECRETS_VAULT.md).

## Instance administration

`src/instance-admin.mjs`

```text
GET  /api/instance-admin/status                            Whether the caller is an operator
GET  /api/instance-admin/overview                          Adoption and delivery metrics
GET  /api/instance-admin/search                            Bounded cross-tenant search
GET  /api/instance-admin/audit                             Redacted audit lookup
GET  /api/instance-admin/organizations/:slug               Tenant diagnostics
POST /api/instance-admin/organizations/:slug/notes         Add a confirmed support note
GET  /api/instance-admin/users/:userId                     User diagnostics
POST /api/instance-admin/email/:outboxId/retry             Retry a terminal email
POST /api/instance-admin/webhooks/:deliveryId/retry        Retry a terminal webhook
GET  /api/instance-admin/health                            Saturation signals and readiness
```

`GET /api/instance-admin/health` returns every saturation signal with the
thresholds it was judged against and a verdict of `ok`, `warning` or `critical`,
plus an overall `status` and the list of degraded signal names. It carries counts,
ages, sizes and percentages only — no user data — so it is safe to forward to a
monitoring system. Thresholds come from `KUKGIT_SATURATION_*`. See
[Operations Boundary](OPERATIONS_BOUNDARY.md) for the signal list and alerting
rules.

Authority comes from `KUKGIT_INSTANCE_ADMIN_EMAILS` and is independent of
organization roles. The console never exposes passwords, OTPs, AuthKit tokens, PAT
material, webhook secrets or SSH private keys, and does not support impersonation.

## Git smart HTTP

`src/git-http.mjs`

```text
/git/:org/:repo.git/*
```

Public repositories allow unauthenticated fetch. Private fetch and every push require
HTTP Basic credentials whose password is a scoped personal access token:

- fetch/clone — `repo:read` plus effective repository Read
- push — `repo:write` plus effective repository Write

```bash
git clone "https://<email>:kgp_...@kukgit.example.com/git/kuklabs/demo.git"
```

Outside production only, `KUKGIT_DEV_GIT_TOKEN` is also accepted as the Basic
password. It is rejected when `NODE_ENV=production`.

## Git over SSH

`scripts/ssh-command.mjs`, `scripts/authorized-keys-command.mjs`

```text
git clone git@<KUKGIT_SSH_HOST>:<org>/<repo>.git
```

OpenSSH resolves keys through `AuthorizedKeysCommand` and runs a forced command that
authorizes `git-upload-pack`, `git-receive-pack` and `git-lfs-authenticate` against
the same effective repository permission, archive state and branch protection rules
used by HTTP. See [SSH Keys and Git over SSH](SSH_KEYS.md).
