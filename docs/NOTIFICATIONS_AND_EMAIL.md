# KukGit Notifications and Transactional Email

KukGit provides a durable in-app notification inbox and a transactional email outbox for collaboration, security and operational events. Notification creation is synchronous with the product event, while email delivery is performed by a background worker with bounded retries.

## Notification categories

KukGit currently supports five categories:

- **Organization** — invitations, accepted memberships and organization activity.
- **Security** — personal access token expiry reminders and future account-security events.
- **Pull requests** — opened pull requests, review outcomes and merges.
- **Status checks** — failed or errored checks associated with an open pull request head.
- **Operations** — backup, Git LFS and terminal webhook delivery alerts for the instance administrator.

Every user has separate in-app and email preferences for each category. Default email delivery is enabled for organization, security and operations events; pull-request and status-check email is opt-in. In-app delivery is enabled by default for every category.

## Browser experience

The top bar displays a notification bell with an unread badge. The notification drawer supports:

- latest notifications
- category and relative timestamp
- internal KukGit navigation
- automatic mark-read when opened
- bulk mark-all-read
- unread count refresh

Open **Settings → Notification preferences** to choose in-app and email channels by category.

The KukGit instance administrator also sees **Transactional email delivery** in Settings with:

- SMTP configured/disabled state
- pending, processing, sent, failed and cancelled counts
- delivery attempts
- next-attempt or sent time
- redacted failure details
- manual queue processing
- manual retry for failed messages

## Durable data model

Notification delivery is stored in SQLite:

- `notification_preferences`
- `notifications`
- `email_outbox`
- `email_delivery_attempts`
- `email_provider_events`
- `email_recipient_health`
- `email_suppressions`

Notification and email deduplication keys prevent duplicate delivery when event capture or a background sweep sees the same event more than once.

The email outbox records only the recipient, category, subject, rendered bodies, delivery state and provider response. Access-token secrets, invitation secrets, webhook secrets and SMTP credentials must never be placed in notification metadata, audit metadata or failure messages.

## SMTP configuration

Configure SMTP in the KukGit environment:

```bash
KUKGIT_SMTP_HOST=smtp.example.com
KUKGIT_SMTP_PORT=587
KUKGIT_SMTP_SECURE=false
KUKGIT_SMTP_STARTTLS=true
KUKGIT_SMTP_REJECT_UNAUTHORIZED=true
KUKGIT_SMTP_USER=your-smtp-user
KUKGIT_SMTP_PASSWORD=your-smtp-password
KUKGIT_EMAIL_FROM=noreply@example.com
KUKGIT_EMAIL_FROM_NAME=KukGit
KUKGIT_EMAIL_REPLY_TO=support@example.com
KUKGIT_EMAIL_WORKER_INTERVAL_MS=30000
KUKGIT_EMAIL_MAX_ATTEMPTS=8
KUKGIT_EMAIL_BATCH_SIZE=20
```

### TLS modes

Port 587 normally uses STARTTLS:

```bash
KUKGIT_SMTP_SECURE=false
KUKGIT_SMTP_STARTTLS=true
```

Port 465 normally uses direct TLS:

```bash
KUKGIT_SMTP_PORT=465
KUKGIT_SMTP_SECURE=true
KUKGIT_SMTP_STARTTLS=false
```

Production configuration must use direct TLS or STARTTLS. Keep `KUKGIT_SMTP_REJECT_UNAUTHORIZED=true` so certificate validation remains enabled.

SMTP authentication uses `AUTH PLAIN` when credentials are configured. The SMTP server must support this mechanism after TLS negotiation. Username and password must either both be set or both be empty.

## Email construction and security

KukGit builds RFC-style transactional messages with:

- text and optional HTML alternatives
- UTF-8 subjects
- generated Message-ID and Date headers
- `Auto-Submitted: auto-generated`
- `X-Auto-Response-Suppress: All`
- dot stuffing for SMTP DATA safety

Recipient, sender, reply-to, display-name and subject fields reject CR/LF characters to prevent email-header injection. Message bodies and headers have bounded size limits.

SMTP credentials are read from process configuration only. They are not written into the database, browser responses, audit entries or email-delivery history.

Delivery errors are redacted before persistence. Common token, password and secret patterns are replaced with `[REDACTED]`.

## Worker behavior

The notification worker starts with the KukGit server and stops during graceful shutdown.

For every tick it:

1. Recovers email records left in `processing` for more than fifteen minutes.
2. Claims due pending or failed email records atomically.
3. Sends a bounded batch through SMTP.
4. Records one delivery-attempt row.
5. Marks successful messages as sent.
6. Schedules failed messages with exponential backoff.

Retry delay begins at one minute and doubles up to six hours. Delivery stops after the configured maximum attempt count unless the instance administrator manually queues another retry.

The worker does nothing when SMTP is not configured. In-app notifications continue to work, and email records remain in the durable outbox.

## Personal access token expiry reminders

Every six hours KukGit scans active personal access tokens expiring in the next seven days.

Reminder buckets are deduplicated at approximately seven, three and one day before expiry. Messages include:

- token display name
- stored token prefix
- expiry date

The complete personal access token secret is never stored in or rendered by the reminder system.

## Organization invitations

Creating an organization invitation:

- creates an in-app notification when the invited email already belongs to a KukGit user
- queues a transactional email for both existing and external email addresses
- includes the one-time acceptance URL only in the recipient delivery
- records no invitation token in audit metadata

When an invitation is accepted:

- the inviter receives a membership-accepted notification
- the new member receives a welcome notification
- corresponding email is queued according to each user's preferences

Organization Admins can use **Resend email** to create a fresh invitation. Resend revokes the old invitation before issuing a new token and expiry. Accepted invitations cannot be resent.

## Pull-request and status notifications

KukGit uses the authoritative effective repository permission engine when selecting recipients for a new pull request. Users with effective Repository Write, Maintain or Admin access are notified, excluding the actor.

The pull-request author receives notifications when another user:

- approves
- requests changes
- comments through the review endpoint
- merges the pull request

A failed or errored commit status notifies the author only when the reported SHA matches the current head branch of an open pull request.

## Operational alerts

The instance administrator receives deduplicated operations notifications for:

- terminal webhook deliveries after all retry attempts are exhausted
- verified backup creation
- backup verification success
- backup API failure
- Git LFS integrity-operation failure
- Git LFS orphan garbage-collection completion

Webhook failure messages redact secret-like values before storing or emailing them.

## Production validation

Run these checks before deployment:

```bash
npm run doctor
npm run check
npm test
```

The production doctor verifies:

- SMTP host and port
- sender and optional reply-to email addresses
- username/password pairing
- required TLS or STARTTLS
- worker interval
- maximum attempts
- batch size

Operational checklist:

- Use a verified sender domain.
- Configure SPF, DKIM and DMARC through the SMTP provider or domain DNS.
- Keep SMTP credentials in the deployment secret manager.
- Monitor failed and terminal email records.
- Confirm the SMTP provider's sending limits before enabling high-volume workflow email.
- Test invitation acceptance with an external mailbox.
- Confirm application links use the public HTTPS `KUKGIT_BASE_URL`.
- Include the SQLite database in verified KukGit backups so notification and email history can be recovered.

## Real-time delivery

The notification bell updates over a WebSocket at `/api/notifications/socket`
(`src/realtime-notifications.mjs`) instead of waiting for a polling interval. The
transport is implemented directly on Node's HTTP upgrade event; KukGit has no
runtime npm dependencies, so no `ws` package is involved.

The socket authenticates with the same `kukgit_session` cookie as the REST API and
requires a same-origin `Origin` header — a missing `Origin` is rejected. Cookies are
attached to upgrade requests automatically and the browser same-origin policy does
not restrict WebSocket the way it restricts `fetch`, so this check is what prevents
cross-site hijacking.

Sessions are re-validated periodically, so a socket outlives a revoked or expired
session by at most one revalidation interval.

| Setting | Default | Bounds |
|---|---|---|
| `KUKGIT_REALTIME_HEARTBEAT_MS` | 25000 | 1000–120000 |
| `KUKGIT_REALTIME_AUTH_REVALIDATE_MS` | 60000 | 1000–600000 |
| `KUKGIT_REALTIME_MAX_CONNECTIONS_PER_USER` | 10 | 1–50 |
| `KUKGIT_REALTIME_MAX_CONNECTIONS` | 5000 | 10–50000 |
| `KUKGIT_REALTIME_MAX_MESSAGE_BYTES` | 4096 | 256–65535 |

### Reverse proxy

The upgrade fails unless `Upgrade` and `Connection` are forwarded.
`infra/nginx.conf` derives `Connection` per request through a `map`, because
sending `Connection: upgrade` on ordinary requests breaks keepalive. Keep
`proxy_read_timeout` above `KUKGIT_REALTIME_HEARTBEAT_MS`.

If notifications only update on page navigation, check this first.

### Multi-instance caveat

The connection registry is per process. A notification is pushed only to sockets
held by the instance that created it, so behind more than one instance either pin
sockets to an instance or rely on the browser's polling fallback.

## Bounce and complaint processing

A dead address is not retried indefinitely, and a recipient who reports mail as
spam is not emailed again. Two independent signals converge on one
`email_suppressions` table and one admin review workflow.

### Signal 1 — provider feedback webhook

`src/email-provider-events.mjs` ingests normalized delivery events at
`POST /api/email-provider/events`. This covers providers that accept a message and
report the outcome later.

Authentication is an HMAC-SHA256 over `<timestamp>.<raw body>`:

```text
X-KukGit-Email-Timestamp: 1785350000
X-KukGit-Email-Signature-256: sha256=<digest>
```

Binding the timestamp into the signature gives replay protection; requests outside
`KUKGIT_EMAIL_PROVIDER_WEBHOOK_TOLERANCE_SECONDS` are rejected.

Event types normalize to `delivered`, `deferred`, `bounce` and `complaint`. A hard
bounce or complaint suppresses immediately. Repeated soft bounces suppress once they
cross a threshold within a window, and that suppression expires rather than being
permanent.

| Setting | Default | Bounds |
|---|---|---|
| `KUKGIT_EMAIL_PROVIDER_EVENTS_ENABLED` | off | — |
| `KUKGIT_EMAIL_PROVIDER_WEBHOOK_SECRET` | — | 32+ characters when enabled |
| `KUKGIT_EMAIL_PROVIDER_WEBHOOK_TOLERANCE_SECONDS` | 300 | 30–3600 |
| `KUKGIT_EMAIL_SOFT_BOUNCE_THRESHOLD` | 3 | 2–20 |
| `KUKGIT_EMAIL_SOFT_BOUNCE_WINDOW_DAYS` | 7 | 1–90 |
| `KUKGIT_EMAIL_SOFT_BOUNCE_SUPPRESSION_DAYS` | 30 | 1–365 |

### Signal 2 — synchronous SMTP rejection

Not every provider sends webhooks, and some failures are visible during the SMTP
conversation itself. `sendSmtpMessage` tags each failure with the protocol stage
that produced it, and `classifySmtpRejection` suppresses only on a permanent
rejection at the **RCPT TO** stage.

The stage matters: the same status code at `MAIL FROM`, `AUTH` or `DATA` describes
our sender, our credentials or the message body. Suppressing a recipient for a
sender-side fault would silently blackhole a valid address, so classification is
deliberately narrow and anything ambiguous retries.

| Response at RCPT TO | Action |
|---|---|
| `5.1.1`, `5.1.2`, `5.1.3`, `5.1.6`, `5.1.10`, `5.2.1`, `5.4.4` | Suppress — mailbox does not exist |
| `550`, `551`, `553` with no enhanced code | Suppress — conventional "no such mailbox" |
| `5.2.2`, `5.2.3`, `5.3.1`, `5.3.4` (quota, size) | Retry — real address, unusable mailbox |
| `5.7.x` (policy, reputation) | Retry — ambiguous, usually sender reputation |
| `552`, `554` | Retry — widely used for quota and policy blocks |
| Any `4xx` | Retry — transient by definition |
| Any stage other than RCPT TO | Retry — not about the recipient |

An SMTP-observed suppression files a synthetic `email_provider_events` row with
provider `smtp`, so both signals share one audit trail and the admin console
presents them identically.

### Effect of suppression

Enforcement lives in the schema rather than the worker. Outbox triggers cancel a
newly queued message to a suppressed address and refuse any status change back to
`pending`, `failed` or `processing`. A message suppressed mid-flight is cancelled
explicitly so it cannot strand in `processing`.

The failing delivery attempt is recorded before suppression, so the cause stays
visible in delivery history. Retrying a suppressed message fails until the address
is released.

Every suppression emits an `email.suppressed` audit event.

### Operating the suppression list

```text
GET  /api/email-provider/admin/suppressions                      List
GET  /api/email-provider/admin/events                            Recent events
POST /api/email-provider/admin/suppressions/:email/unsuppress    Release
```

Release requires confirming the address. Review the list periodically: a rise in
`hard_bounce` usually means a stale invitation list, while a rise in `complaint`
means sending reputation needs attention before it degrades delivery for everyone.

## Current limitations

The private-alpha implementation does not yet include:

- DKIM signing inside the KukGit process
- email localization or per-organization templates
- notification digests
- mobile push notifications
- per-repository watch/subscription controls
- review-request assignment notifications
- email analytics or billing metering
- cross-instance WebSocket fan-out
- automatic re-validation of suppressed addresses

These can be added on top of the existing durable preference, inbox and outbox model.
