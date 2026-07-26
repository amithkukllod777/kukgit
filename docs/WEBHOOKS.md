# KukGit Repository Webhooks

Repository webhooks deliver signed JSON events from KukGit to CI systems, deployment platforms and external integrations.

## Supported events

- `push`
- `issues`
- `pull_request`
- `review`
- `status`
- `repository`
- `ping`
- `*` for every supported event

A webhook receives only the events selected on its subscription. Ping deliveries are created explicitly from Repository Settings and do not depend on the normal event filter.

## Creating a webhook

Repository Admins can open **Repository → Settings → Repository webhooks** and provide:

- payload URL
- one or more events
- optional custom signing secret
- active or disabled state

When the secret is omitted, KukGit generates a `kgwhsec_...` secret. The plaintext is displayed only in the creation response. KukGit encrypts the stored value with AES-256-GCM using `KUKGIT_WEBHOOK_ENCRYPTION_KEY`.

Production deployments must configure a stable, high-entropy encryption key before webhooks are created. Losing or changing the key makes existing encrypted secrets unusable and requires secret rotation.

## Delivery envelope

Each POST body has this structure:

```json
{
  "id": "whd_example",
  "event": "push",
  "createdAt": "2026-07-26T12:00:00.000Z",
  "repository": {
    "id": "repo_example",
    "slug": "kukgit-demo",
    "name": "KukGit Demo",
    "visibility": "private",
    "defaultBranch": "main",
    "organizationId": "org_example",
    "organizationSlug": "kuklabs",
    "organizationName": "Kuklabs Inc."
  },
  "data": {}
}
```

The exact `data` object depends on the event. Events captured from KukGit APIs include the action, actor when available, response payload and occurrence timestamp.

## Delivery headers

KukGit sends:

```text
Content-Type: application/json
User-Agent: KukGit-Hookshot/0.1
X-KukGit-Event: push
X-KukGit-Delivery: whd_example
X-KukGit-Signature-256: sha256=<hex digest>
```

## Verifying signatures

Compute an HMAC-SHA256 digest over the exact raw request body using the webhook secret. Compare it with `X-KukGit-Signature-256` using a constant-time comparison.

Node.js example:

```js
import crypto from 'node:crypto';

export function verifyKukGitSignature(rawBody, signatureHeader, secret) {
  const expected = `sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  const received = Buffer.from(String(signatureHeader || ''));
  const wanted = Buffer.from(expected);
  return received.length === wanted.length && crypto.timingSafeEqual(received, wanted);
}
```

Do not parse or act on the JSON before signature verification.

## URL and SSRF controls

Production webhook targets must:

- use HTTPS
- contain no embedded username/password
- contain no URL fragment
- resolve to a public IP address

KukGit rejects loopback, private, link-local, carrier-grade NAT, documentation, multicast and reserved address ranges. DNS is resolved before every delivery, and the validated address is pinned into the outbound request lookup to reduce DNS-rebinding risk.

Local development permits HTTP loopback targets such as `http://127.0.0.1:3000/hook`.

KukGit does not follow redirects. A webhook endpoint should return its final 2xx response directly.

## Retry policy

A 2xx response marks the delivery successful. Network errors, timeouts and non-2xx responses are retried with bounded exponential backoff:

1. 1 minute
2. 5 minutes
3. 30 minutes
4. 2 hours
5. final failure

Each request has a 10-second timeout. Response bodies are truncated to 64 KB for safe inspection.

Repository Admins can manually redeliver any recorded delivery. Manual redelivery resets the attempt counter and immediately sends the same event payload again using the webhook's current secret and URL.

## Delivery history

Repository Settings displays:

- event
- delivery identifier
- pending, processing, success or failure state
- attempt count
- HTTP response status
- selected response headers
- truncated response body
- last error
- lifecycle timestamps

Webhook secrets, authorization headers and full request headers are never written to delivery history or audit logs.

## Browser API

Authenticated Repository Admin sessions can use:

- `GET /api/webhooks/:org/:repo`
- `POST /api/webhooks/:org/:repo`
- `PATCH /api/webhooks/:org/:repo/:webhookId`
- `DELETE /api/webhooks/:org/:repo/:webhookId`
- `POST /api/webhooks/:org/:repo/:webhookId/ping`
- `POST /api/webhooks/:org/:repo/deliveries/:deliveryId/redeliver`

All writes enforce same-origin protection and Repository Admin authorization.

## Operational guidance

- Use a unique webhook secret per endpoint.
- Store secrets in a secret manager, not source code.
- Verify signatures before parsing payloads.
- Make receivers idempotent using `X-KukGit-Delivery`.
- Return a 2xx response quickly and process expensive work asynchronously.
- Rotate secrets when a receiver, employee or vendor changes.
- Disable a failing endpoint before investigating sustained delivery errors.
- Restrict receiver ingress to HTTPS and validate content type, event and delivery headers.
