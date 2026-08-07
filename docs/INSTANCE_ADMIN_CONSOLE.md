# KukGit Instance Admin Console

The KukGit Instance Admin Console gives authorized Kuklabs operators one place to diagnose tenant, delivery, storage, identity and access problems. It is intentionally **read-only by default** and does not provide impersonation, password access or session takeover.

## Authority model

Instance administration is independent from organization and repository roles.

Configure a comma-separated allowlist of verified operator email addresses in
the selected identity mode:

```env
KUKGIT_INSTANCE_ADMIN_EMAILS=support@kuklabs.com,security@kuklabs.com
```

When the variable is empty, KukGit falls back to `KUKGIT_ADMIN_EMAIL` for backward compatibility. Production deployments should set an explicit, tightly controlled allowlist.

A user who is an organization Owner but is not on this allowlist cannot access `/api/instance-admin/*`. An external repository collaborator cannot access it either.

## What the console shows

### Instance overview

- total users and linked external identities, including optional AuthKit links
- organization count
- active, archived and trashed repositories
- active, expiring and permanent external access
- email outbox status counts
- webhook delivery status counts
- Git LFS physical object count and bytes
- verified backup count and latest snapshot timestamp
- audit activity in the last 24 hours

### Bounded search

Operators may search users, organizations and repositories by:

- display name
- email
- organization or repository slug
- exact internal ID

The API limits query length, page size and page number. Results return identifiers and operational metadata only.

### Tenant detail

An organization detail view includes only records scoped to that organization:

- members and roles
- repositories and lifecycle state
- issue and pull-request counts
- direct collaborator counts
- LFS usage
- external repository access and expiry
- failed tenant email and webhook deliveries
- recent redacted audit activity
- instance-admin support notes

Repositories, members or audit events from another organization are not included.

### User detail

A user detail view contains:

- public product-profile fields
- local account source and optional external identity-link state
- organization memberships
- direct repository grants
- active session count
- active personal-access-token count
- active SSH public-key count
- notification counts

It does not return session tokens, password hashes, PAT hashes, AuthKit tokens or SSH private material.

## Secret redaction

Audit metadata is recursively redacted on the server before it is serialized. Credential-like field names—including password, OTP, token, secret, cipher, authorization, cookie, private key, webhook key, API key and session hash—are replaced with `[redacted]`.

Redaction is a defense-in-depth boundary. Producers must still avoid writing secrets into audit metadata in the first place.

The console never returns:

- passwords or password hashes
- OTP codes
- AuthKit access or refresh tokens
- KukGit personal access tokens or hashes
- session cookies or session hashes
- webhook encryption material or signing secrets
- invitation tokens
- SSH private keys
- SMTP credentials
- AI provider credentials

## Support actions

The console has three narrowly scoped write operations.

### Add a support note

The operator must type the exact organization slug. The note is stored in `instance_support_notes` and creates an `instance_support.note_added` audit event.

Use support notes for:

- customer-confirmed symptoms
- investigation findings
- requested access changes
- incident or ticket references
- the next approved action

Do not paste credentials, tokens, full private source files or regulated customer data into notes.

### Retry failed email

Only `failed` or `cancelled` outbox records can be returned to `pending`. The operator must type the exact email delivery ID. The action resets delivery-attempt state and creates `instance_support.email_retried`.

The console does not show SMTP passwords or full provider credentials.

### Retry failed webhook

Only a terminal `failure` delivery can be returned to `pending`. The operator must type the exact webhook delivery ID. The action clears the previous response summary and creates `instance_support.webhook_retried`.

Webhook subscription secrets remain encrypted and are never returned.

All browser writes require same-origin protection.

## Browser routes

The console appears only after `/api/instance-admin/status` confirms the signed-in user is authorized.

Primary routes:

```text
#/instance-admin
#/instance-admin/organizations/<slug>
#/instance-admin/users/<user-id>
#/instance-admin/audit
```

The sidebar entry is not rendered for ordinary users. Hiding the entry is only a usability measure; every API call independently enforces instance-admin authority.

## API

Read operations:

```text
GET /api/instance-admin/status
GET /api/instance-admin/overview
GET /api/instance-admin/search?q=<query>&type=<all|users|organizations|repositories>
GET /api/instance-admin/audit?q=<query>&org=<slug>&action=<text>
GET /api/instance-admin/organizations/:slug
GET /api/instance-admin/users/:userId
```

Confirmed support actions:

```text
POST /api/instance-admin/organizations/:slug/notes
POST /api/instance-admin/email/:outboxId/retry
POST /api/instance-admin/webhooks/:deliveryId/retry
```

The retry confirmation value must equal the target delivery ID. The support-note confirmation value must equal the organization slug.

## Common investigations

### User cannot access a repository

1. Open the user detail.
2. Confirm the account source, relevant identity links and active session count.
3. Review organization membership and direct repository access.
4. Open the tenant detail and check external-access expiry.
5. Search the audit stream for the user ID, repository ID or request ID.
6. Do not impersonate the user. Ask the user to reproduce the request when a fresh request ID is needed.

### Invitation was not received

1. Open the tenant detail.
2. Check failed email delivery for the invited user.
3. Confirm SMTP operations are healthy.
4. Retry only a terminal failed/cancelled delivery with explicit ID confirmation.
5. Do not expose or request the one-time invitation token.

### Webhook integration stopped

1. Open the tenant detail and locate terminal failures.
2. Review event type, HTTP status and bounded error summary.
3. Confirm the receiver is healthy and publicly reachable.
4. Retry the exact delivery after the receiver is fixed.
5. Never reveal or rotate a webhook secret from the support console.

### Storage concern

Use the overview and tenant detail to compare:

- repository counts and lifecycle states
- Git LFS object count and bytes
- backup count and most recent snapshot
- trashed or archived repositories

Use the dedicated backup and LFS administration workflows for integrity verification or garbage collection. The support console does not perform destructive storage operations.

## Audit lookup

The audit lookup supports action, organization, request ID, target ID and metadata-text searches. Results are limited and returned newest first.

Useful identifiers:

- `X-Request-Id` from an API response
- user ID
- organization ID or slug
- repository ID
- email/webhook delivery ID
- action prefix such as `repository_`, `auth.`, `external_` or `instance_support.`

Request IDs make customer-reported failures easier to correlate without disclosing internals.

## Operational safeguards

- Keep the instance-admin allowlist minimal.
- Require MFA on every allowed operator account in the selected identity mode.
- Remove operators immediately when duties change.
- Review `instance_support.*` audit events regularly.
- Never use a shared support login.
- Do not add impersonation as a shortcut; use reproducible request IDs and tenant-scoped diagnostics.
- When diagnostics are not enough, ask the customer for a support access grant — read-only, time-boxed, revocable, and visible to their whole organization. See [SUPPORT_ACCESS.md](SUPPORT_ACCESS.md).
- Keep host time synchronized because access expiry and delivery scheduling use UTC timestamps.
- Back up the metadata database before migration or broad support operations.

## Schema compatibility

The admin read model supports the existing organization onboarding `website` column through a synchronized `website_url` compatibility field. The safe migration creates and updates the compatibility field without changing onboarding behavior.

`instance_support_notes` and compatibility columns are included in normal verified metadata backups.

## Rollback

Rolling application code back leaves the support-note table and compatibility column in place. Older KukGit versions ignore them.

Before rollback:

1. record the reason and affected commit,
2. confirm a recent verified backup,
3. avoid deleting support notes or audit records,
4. keep the instance-admin allowlist configured, and
5. validate that no pending delivery was retried twice during the transition.
