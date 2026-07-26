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

## Current limitations

The private-alpha implementation does not yet include:

- provider-specific bounce and complaint webhooks
- DKIM signing inside the KukGit process
- email localization or per-organization templates
- notification digests
- mobile push notifications
- real-time WebSocket delivery
- per-repository watch/subscription controls
- review-request assignment notifications
- email analytics or billing metering

These can be added on top of the existing durable preference, inbox and outbox model.
