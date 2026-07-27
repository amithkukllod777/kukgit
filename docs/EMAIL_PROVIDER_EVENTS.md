# Email Provider Events and Recipient Suppression

KukGit can ingest provider-neutral delivery events for transactional email and prevent repeated sends to invalid or complaint-reporting recipients.

The feature is disabled unless `KUKGIT_EMAIL_PROVIDER_EVENTS_ENABLED=true` or a non-empty provider webhook secret is configured. Production deployments should explicitly enable it and set a unique secret of at least 32 random characters.

## Endpoint

```text
POST /api/email-provider/events
```

The reverse proxy must pass the exact raw request body unchanged. Do not parse and re-serialize JSON before it reaches KukGit, because the signature covers the original bytes.

## Signature contract

The provider adapter sends:

```text
X-KukGit-Email-Timestamp: <unix-seconds>
X-KukGit-Email-Signature-256: sha256=<64-character-hex-digest>
Content-Type: application/json
```

KukGit calculates:

```text
HMAC-SHA256(secret, timestamp + "." + raw_request_body)
```

The comparison is timing-safe. Requests are rejected when:

- the timestamp is missing or malformed;
- the timestamp is outside `KUKGIT_EMAIL_PROVIDER_WEBHOOK_TOLERANCE_SECONDS`;
- the signature is missing, malformed or incorrect;
- the body exceeds 256 KiB;
- the JSON or normalized event fields are invalid.

## Provider-neutral event body

```json
{
  "id": "provider-event-01J...",
  "provider": "example-provider",
  "type": "hard_bounce",
  "recipient": "person@example.com",
  "outbox_id": "eml_01J...",
  "severity": "permanent",
  "reason_code": "mailbox_not_found",
  "occurred_at": "2026-07-27T22:30:00.000Z"
}
```

Required fields:

- `id`, `provider_event_id` or `event_id`: stable provider event ID used for idempotency;
- `type`, `event_type` or `event`;
- `recipient`, `email` or `to`.

Optional fields:

- `provider`;
- `outbox_id`: must be an existing KukGit `email_outbox.id`;
- `severity`;
- `reason_code` or `code`;
- `occurred_at` or `timestamp`.

A provider's unrelated `message_id` is ignored and never written into KukGit's outbox foreign key.

## Event normalization

| Provider input | KukGit event |
|---|---|
| `delivery`, `delivered`, `success` | `delivered` |
| `deferred`, `soft_bounce`, `temporary_failure` | `deferred` |
| `bounce`, `bounced`, `hard_bounce`, `permanent_failure` | `bounce` |
| `complaint`, `spam_complaint`, `complained` | `complaint` |

A generic bounce with `severity: "soft"` is normalized to `deferred`.

## Idempotency and replay protection

`provider_event_id` is unique. The first valid delivery returns HTTP `202`; a later signed replay of the same event returns HTTP `200` without applying the event again.

Timestamp freshness protects against delayed signature replay. Provider event ID uniqueness protects against retries within the accepted timestamp window.

## Suppression policy

### Hard bounce

A hard bounce immediately creates a permanent `hard_bounce` suppression.

### Complaint

A spam complaint immediately creates a permanent `complaint` suppression.

### Soft bounce

Soft bounces are counted inside a configurable rolling window:

```text
KUKGIT_EMAIL_SOFT_BOUNCE_THRESHOLD=3
KUKGIT_EMAIL_SOFT_BOUNCE_WINDOW_DAYS=7
KUKGIT_EMAIL_SOFT_BOUNCE_SUPPRESSION_DAYS=30
```

When the threshold is reached, KukGit creates a temporary `soft_bounce_threshold` suppression. A successful delivered event resets the temporary health counter but does not silently remove an existing suppression.

## Outbox enforcement

Suppression is enforced at the database boundary:

- pending and failed messages for a newly suppressed recipient are cancelled;
- a new outbox insert for an actively suppressed recipient becomes cancelled;
- the worker cannot claim a suppressed message for processing;
- browser/Admin retry endpoints reject active suppressions.

Unsuppressing an address does not revive previously cancelled email. A new message must be queued after the review is complete.

## Stored data and privacy

KukGit does not retain the raw provider body. It stores only:

- normalized provider/event metadata;
- recipient required for suppression enforcement;
- an optional verified KukGit outbox ID;
- event time;
- raw-body SHA-256 digest;
- raw-body byte size.

Audit metadata stores a truncated recipient hash instead of the email address. Webhook secrets, message bodies, OTPs, passwords, access tokens and refresh tokens are never written to provider-event audit metadata.

## Instance administration

Open:

```text
#/instance-admin/email-health
```

The view provides:

- active suppression counts;
- hard-bounce, complaint and soft-bounce breakdown;
- suppression search;
- normalized provider-event history;
- controlled unsuppress.

Unsuppress requires an instance administrator to:

1. type the exact email address;
2. enter a review note of 3–1000 characters;
3. confirm the recipient/address is safe for future delivery.

The action is audited. It resets the recipient's soft-bounce counter but does not requeue cancelled messages.

## Configuration

```text
KUKGIT_EMAIL_PROVIDER_EVENTS_ENABLED=true
KUKGIT_EMAIL_PROVIDER_WEBHOOK_SECRET=<at-least-32-random-characters>
KUKGIT_EMAIL_PROVIDER_WEBHOOK_TOLERANCE_SECONDS=300
KUKGIT_EMAIL_SOFT_BOUNCE_THRESHOLD=3
KUKGIT_EMAIL_SOFT_BOUNCE_WINDOW_DAYS=7
KUKGIT_EMAIL_SOFT_BOUNCE_SUPPRESSION_DAYS=30
```

Run:

```bash
npm run doctor
```

The doctor reports whether provider events are enabled and validates all bounds.

## Provider adapter checklist

A provider-specific adapter must:

1. verify the provider's native webhook before translating it;
2. map the event into the provider-neutral body;
3. use a stable native event ID;
4. sign the exact translated raw JSON bytes with the KukGit secret;
5. preserve `outbox_id` only when the provider metadata contains the original KukGit outbox ID;
6. retry non-2xx responses with bounded exponential backoff.

Do not forward provider-controlled headers as trusted KukGit signature headers.

## Secret rotation

Use a maintenance window for rotation because the current contract accepts one active secret.

1. configure the new secret in the provider adapter;
2. deploy the same secret to KukGit;
3. send a signed test delivery event;
4. verify it in Email health;
5. remove the old secret from the secret manager and deployment history.

A future dual-secret rotation window may be added if required by the selected provider.

## Incident response

When signatures fail unexpectedly:

- confirm that the proxy preserved raw bytes;
- compare timestamp units: KukGit requires Unix seconds;
- confirm both systems use the same current secret;
- review request-size and timestamp-tolerance configuration;
- never log the webhook secret or complete signed body.

When complaints spike:

- keep complaint suppressions active;
- review the sending domain, templates, consent and list source;
- do not bulk-unsuppress recipients;
- investigate the provider account before resuming campaigns or high-volume transactional delivery.
