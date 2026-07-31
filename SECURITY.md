# Security Policy

KukGit v0.2.0 is a Private Alpha and must not be exposed directly to the public
internet as a commercial service without the hardening described below.

## Report a vulnerability

Do not create a public issue for a suspected vulnerability. Report it privately to the
Kuklabs security owner and include:

- affected version and environment
- reproduction steps
- expected and actual behavior
- security impact
- proof of concept with secrets removed

## Production blockers in v0.2.0

- SQLite is the authoritative metadata store. It is single-node; the PostgreSQL
  program has delivered read-only shadow and live-read stages but no write path or
  cutover.
- Repository objects and Git LFS objects are stored on local disk.
- Rate limiting covers the HTTP surfaces (auth, browser API, Git smart HTTP,
  invitations, webhooks) but **not Git over SSH**, which is served by an OpenSSH
  forced command outside the HTTP server. Limits are also per instance, not per
  cluster, so a multi-instance deployment multiplies the effective allowance.
- No malware scanning, abuse detection or upload quarantine exists.
- Secret detection is heuristic and cannot guarantee credential safety.
- Workers run on in-process timers, so multiple instances against one database will
  double-deliver email and webhooks.
- The real-time notification registry is per process, so WebSocket delivery does not
  fan out across instances.
- Long Git operations have no job queue. Clone-based paths (import, browser commit,
  merge) run off the event loop, so they no longer stall unrelated requests, but a
  large mirror import still occupies its own request for its full duration.

## Required controls before public beta

1. PostgreSQL write path, verified cutover, encrypted object storage and encrypted backups.
2. Rate limiting for Git over SSH, shared cross-instance limit state, plus WAF,
   bot mitigation and broader abuse controls.
3. External worker scheduling with leases, and cross-instance WebSocket fan-out.
4. A durable job queue for long Git operations. The clone-based paths no longer
   block the event loop, but a long mirror import still holds its request open.
5. Secret scanning with verified patterns and push protection.
6. Dependency, container, IaC and license scanning.
7. Malware scanning and upload quarantine.
8. Centralized logs, immutable audit sink and alerting.
9. Signed SSH host keys and documented key rotation.
10. Regular penetration testing, incident response and disaster recovery exercises.

## Delivered security controls

### Identity and session

- Production authenticates against One Kuklabs Account through central AuthKit, and
  local password authentication is rejected in production unless explicitly
  overridden by `KUKGIT_ALLOW_LOCAL_AUTH_IN_PRODUCTION`.
- The browser receives only a random HttpOnly SameSite=Lax bridge cookie.
- AuthKit access and refresh tokens are encrypted at rest with AES-256-GCM.
- Protected requests validate the central account, product membership and the active
  device session; centrally revoked sessions are removed locally.
- Protected browser APIs fail closed during an AuthKit outage.
- Legacy local password hashes are scrubbed once an account is linked to AuthKit.
- Local development passwords use scrypt with random per-user salts.
- Session tokens are random and stored only as SHA-256 hashes.

### Authorization

- Every repository API request resolves an effective permission from organization
  role, direct grant and team grant before the handler runs.
- The same effective permission governs the browser, Git HTTP, Git SSH and Git LFS.
- External collaborators receive only a direct repository grant and cannot discover
  organization members, teams or other repositories.
- External access carries an expiry enforced at request time on every transport
  before authorization is granted.
- Repository transfer and Trash require actual organization Admin or Owner
  membership, not external Repository Admin.
- Instance-administrator authority comes from a separate email allowlist, is
  independent of organization roles and does not permit impersonation.

### Tokens and keys

- Personal access tokens use a `kgp_` prefix, are revealed only at creation and are
  stored only as SHA-256 hashes.
- Git authorization checks token scope, expiry, revocation and effective repository
  permission.
- The shared development Git token is rejected when `NODE_ENV=production`.
- Webhook secrets are shown once and encrypted at rest with AES-256-GCM.
- SSH public keys are fingerprinted with SHA-256 and cannot be reused across user and
  deploy-key scopes while active.
- Git LFS SSH credentials are short-lived and repository-scoped.

### Input and transport

- Repository and organization slugs are strictly validated.
- Branch names are validated against a deny pattern covering `..`, `.lock`, `@{` and
  backslashes.
- Browser file paths block traversal, absolute paths and null bytes.
- Import URLs block non-HTTPS/SSH protocols, localhost, private IPv4 and IPv6 ranges
  and embedded credentials.
- Webhook targets must use HTTPS and resolve to public addresses in production, with
  DNS address pinning.
- Git processes are invoked with argument arrays, never shell command strings.
- The SSH forced command rejects shell injection and unsupported commands.
- State-changing browser requests validate `Origin` against `KUKGIT_BASE_URL`.
- HTTP surfaces are rate limited by token bucket, keyed by authenticated user where
  one exists and by source address otherwise, with separate budgets for auth,
  browser API, Git smart HTTP, invitations and webhooks. `X-Forwarded-For` is only
  honoured when `KUKGIT_TRUST_PROXY` is set, because an untrusted client can
  otherwise forge a fresh identity per request and bypass every limit.
- WebSocket upgrades require a present, same-origin `Origin` header and a valid
  session before the handshake completes. This is what prevents cross-site WebSocket
  hijacking: cookies are attached to upgrades automatically and the browser
  same-origin policy does not restrict WebSocket the way it restricts `fetch`.
- WebSocket connections are capped per user and per instance, inbound frames are
  size-limited, and sessions are re-validated on an interval so a revoked session
  cannot hold a socket open indefinitely.
- Browser responses set CSP, `X-Frame-Options: DENY`, `Referrer-Policy`,
  `Permissions-Policy` and `X-Content-Type-Options: nosniff`.

### Email integrity

- The provider delivery-event callback authenticates by HMAC-SHA256 over a
  timestamped raw body, giving replay protection, and stays disabled until a
  32-character secret is configured.
- Email bodies redact secrets and reject header injection.
- Bounce classification suppresses an address only on a permanent rejection at the
  SMTP `RCPT TO` stage. Rejections at `MAIL FROM`, `AUTH` or `DATA`, quota responses
  and `5.7.x` policy blocks stay retryable, so a sender-side or reputation failure
  cannot blackhole a valid recipient.
- Suppression is enforced in the schema through outbox triggers rather than only in
  the worker, and release requires an instance administrator confirming the address.

### Data handling and audit

- Backup archives verify SHA-256 checksums and reject absolute paths, duplicate
  entries and traversal; restore writes only to a missing or empty directory.
- Metadata exports are written atomically with `0600` permissions and carry row
  checksums for tamper detection.
- PostgreSQL observation is read-only, disabled by default, and never substitutes a
  result for the authoritative SQLite read.
- Instance-admin audit lookup recursively redacts sensitive metadata server-side.
- Material actions emit audit events; token, key and webhook secrets never appear in
  audit metadata.
- `5xx` responses return a generic message; every response carries `X-Request-Id`.

### Verification

Authorization boundaries are covered by the automated test suite (198 tests),
including cross-tenant isolation, external collaborator privacy, expiry enforcement,
scope escalation, WebSocket origin and revocation, SMTP bounce classification, CSRF
and production-boundary behavior.

```bash
npm run doctor
npm run check
npm test
```
