# External Access Expiry and Access Reviews

KukGit external collaborators are repository-only users who are not members of the owning organization. This document defines how their access expires, how it is renewed, and how organization administrators periodically certify that access.

## Security objective

External access should last only as long as the client, contractor, agency or partner relationship requires it.

An expired external grant is removed from the active authorization table before the request continues. The same effective repository permission engine is then used by:

- browser repository APIs
- Git smart HTTP clone, fetch and push
- personal-access-token authorization
- Git-over-SSH user keys
- SSH Git LFS authentication
- HTTPS Git LFS downloads and uploads
- repository discovery, issues and pull-request lists

There is no separate “expired but still usable” transport path.

## Invitation link expiry versus access expiry

These are separate controls:

- **Invitation link expiry** limits how long the one-time acceptance link can be used. Existing choices remain 7, 14 or 30 days.
- **Accepted access duration** starts when the invitation is accepted. Choices are 7, 30, 90, 180 or 365 days.

New browser invitations default to 90 days of accepted access. The invitation record stores the selected duration. Acceptance creates a direct repository grant with the calculated expiry, invitation origin and next-review date.

Invitation secrets remain one-time and hashed. Access-duration configuration never returns or stores the plaintext invitation token.

## Existing grants

Grants created before this feature have no expiry and remain marked **Permanent**. They are not silently removed during migration.

Repository Admins should replace permanent access with a time-bounded duration from **Repository → Settings → External access lifecycle**. External Repository Admin grants should be certified by an organization Admin or Owner.

## Expiry enforcement

Before normal HTTP dispatch, KukGit finds external direct grants whose `expires_at` is due. Each grant is:

1. copied into immutable grant history,
2. removed from `repository_collaborators` in the same database transaction,
3. audited as `external_repository_access.expired`, and
4. notified to the affected user without exposing credentials or invitation tokens.

The forced SSH command performs the same expiry sweep before authorizing `git-upload-pack`, `git-receive-pack` or `git-lfs-authenticate`.

After removal, the effective repository permission becomes `none` unless the user has a separate valid organization, team or internal direct source. Internal organization and team access are not affected by external-grant expiry.

## Renewal

Repository Admins can renew an archived grant from the history panel. Renewal:

- reuses the same KukGit and One Kuklabs Account identity,
- creates a fresh active direct grant,
- sets a new 7, 30, 90, 180 or 365-day expiry,
- records the reviewer and review timestamp,
- marks the history entry restored, and
- notifies the collaborator.

An external collaborator cannot renew or extend their own access. An organization Admin or Owner must certify any external `admin` permission.

## Repository lifecycle controls

**Repository → Settings → External access lifecycle** shows:

- active, permanent and expiring grants,
- permission and exact expiry,
- last-review timestamp,
- permission and duration update controls,
- archived expired/revoked grant history, and
- renewal controls.

Updating duration replaces the expiry from the current time; it does not add days to an old expiry. This avoids repeatedly extending stale access accidentally.

## Organization access-review campaigns

Organization Admins and Owners can start a review campaign from the organization collaboration page.

A campaign snapshots every active external direct grant in the organization. Only one campaign may remain open at a time. Due-date choices are 7, 14 or 30 days.

Each item supports:

- **Keep** — retain the current permission and expiry while recording review completion.
- **Renew** — set a fresh duration.
- **Reduce** — lower permission and optionally replace the duration.
- **Revoke** — remove active access immediately.

The campaign becomes complete after every item has a decision. An open campaign past its due date is shown as overdue.

Campaign snapshots preserve what was reviewed even when the live grant changes later.

## Notifications

The hourly worker creates deduplicated security notifications for access expiring within seven days. Expired access is also notified when the enforcement sweep archives the grant.

Notifications contain repository, permission and expiry metadata only. They never contain:

- passwords
- OTP codes
- AuthKit access or refresh tokens
- personal access token secrets
- SSH private keys
- repository invitation tokens

## API

Repository lifecycle:

- `GET /api/external-access/:org/:repo`
- `PATCH /api/external-access/:org/:repo/collaborators/:userId`
- `GET /api/external-access-history/:org/:repo`
- `POST /api/external-access-history/:org/:repo/:historyId/renew`
- `PATCH /api/external-access-invitations/:org/:repo/:invitationId/duration`

Organization campaigns:

- `GET /api/external-access/:org/reviews`
- `POST /api/external-access/:org/reviews`
- `GET /api/external-access/:org/reviews/:campaignId`
- `POST /api/external-access/:org/reviews/:campaignId/items/:itemId`

All browser writes require an authenticated same-origin request. Repository lifecycle writes require Repository Admin permission. Campaigns require organization Admin or Owner membership.

## Audit events

Important events include:

- `repository_invitation.access_duration_set`
- `external_repository_access.updated`
- `external_repository_access.expired`
- `external_repository_access.renewed`
- `external_access_review.created`
- `external_access_review.keep`
- `external_access_review.renew`
- `external_access_review.reduce`
- `external_access_review.revoke`

Audit metadata may contain user IDs, repository IDs, permission and expiry timestamps. It must not contain authentication or invitation secrets.

## Operations

### Recommended cadence

- Use 30–90 day grants for contractors and agencies.
- Use 7–30 day grants for temporary incident or migration work.
- Run organization-wide reviews quarterly.
- Review external Admin grants monthly or avoid them entirely.

### Expiry incident check

When a user reports unexpected denial:

1. Check active grant status in Repository Settings.
2. Check `external_access_grant_history` for an expired entry.
3. Confirm the user is still external rather than an organization member.
4. Renew only after confirming the business owner and required permission.
5. Review audit logs for the expiry and any later renewal.

### Clock correctness

Expiry relies on database and host UTC time. Production hosts must use reliable time synchronization. A materially incorrect host clock can expire access early or late.

### Backup and restore

Expiry columns, campaign records, review decisions and grant history are stored in the KukGit metadata database and are included in verified `.kgbak` snapshots.

After restoring an older snapshot, run an authenticated request or restart the server. The expiry guard immediately archives grants that became due while the snapshot was offline.

## Rollback

Rolling application code back does not remove the added columns or campaign/history tables. Older code ignores them.

Do not restore expired grants by directly editing `expires_at`. Use the renewal API or browser workflow so history, audit and notifications remain consistent.
