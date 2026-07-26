# One Kuklabs Account and AuthKit

KukGit production authentication uses the central Kuklabs AuthKit contract. KukGit does not own a separate production password system, Google identity, OTP database or primary user identity.

## Identity boundary

AuthKit owns:

- signup and verified-email identity
- password authentication
- email OTP and two-factor completion
- Google account linking
- access JWT issuance
- rotating refresh tokens
- signed-in device sessions
- central logout and session revocation
- product membership status
- the stable `kuklabs_user_id`

KukGit owns:

- repositories, organizations, teams and repository permissions
- KukGit personal access tokens, SSH keys and deploy keys
- product-specific profile fields
- a local product user ID used by existing KukGit foreign keys
- an encrypted server-side bridge from a browser session to AuthKit tokens

Every AuthKit request sends:

```text
X-Kuklabs-Product: kukgit
```

## Why a local product user ID still exists

KukGit repository and audit tables already reference `users.id`. Replacing every foreign key with a central numeric identity would create a high-risk data migration and tightly couple the Git data plane to the identity database.

KukGit therefore keeps a product-local row and maps it one-to-one:

```text
KukGit users.id       = usr_...
Kuklabs Account ID    = users.kuklabs_user_id
```

The central ID is unique and immutable. Production authentication is accepted only from AuthKit; the local row is authorization metadata, not a second account.

## Browser session design

The browser never receives an AuthKit access or refresh token directly.

1. The browser submits login, signup, OTP or Google ID-token data to KukGit.
2. KukGit proxies the request to `/v1/auth/*`.
3. AuthKit returns an access JWT, rotating refresh token and central user payload.
4. KukGit verifies product access.
5. KukGit links the verified central identity to one product user row.
6. Access and refresh tokens are encrypted with AES-256-GCM and stored server-side.
7. The browser receives only a random HttpOnly `kukgit_session` cookie.
8. Protected browser API requests validate the central session through AuthKit and fail closed when validation is unavailable.

The encrypted token envelope is authenticated against the local session hash. Copying ciphertext to another session row does not produce a valid token.

## Required environment variables

Production:

```bash
NODE_ENV=production
KUKGIT_AUTH_MODE=authkit
KUKGIT_AUTHKIT_BASE_URL=https://auth.kuklabs.com
KUKGIT_AUTHKIT_PRODUCT_ID=kukgit
KUKGIT_AUTHKIT_ENCRYPTION_KEY=<at-least-32-random-characters>
KUKGIT_AUTHKIT_TIMEOUT_MS=8000
KUKGIT_AUTHKIT_REFRESH_TTL_DAYS=60
KUKGIT_COOKIE_SECURE=true

# The verified central founder email used for initial Owner bootstrap.
KUKGIT_ADMIN_EMAIL=<founder-email>
```

Generate a dedicated encryption key. Do not reuse SMTP, webhook, LFS or database credentials.

```bash
openssl rand -base64 48
```

Store the key in the deployment secret manager. Losing it invalidates every active KukGit browser bridge session but does not damage repositories or central Kuklabs accounts.

## Production startup rules

- Production defaults to `authkit` even when `KUKGIT_AUTH_MODE` is omitted.
- `KUKGIT_AUTHKIT_BASE_URL` is mandatory in AuthKit mode.
- `KUKGIT_AUTHKIT_ENCRYPTION_KEY` must contain at least 32 characters.
- Local production password authentication is rejected unless `KUKGIT_ALLOW_LOCAL_AUTH_IN_PRODUCTION=true` is deliberately set.
- AuthKit mode does not seed a KukGit-local founder password.
- Local mode remains available for isolated development and automated tests.

The production-local override is an emergency compatibility control, not a supported steady state. Enabling it creates a deviation from the Kuklabs identity mandate and must be logged as an incident/change record.

## Existing user migration

Migration is lazy and preserves current authorization relationships.

When a verified AuthKit user signs in:

1. KukGit looks for the same `kuklabs_user_id`.
2. Otherwise KukGit looks for the exact normalized verified email.
3. An unlinked email row is linked to the central ID.
4. Existing organization membership, repository ownership, issues, pull requests, audit records, PATs and SSH keys remain attached to the same local user ID.
5. If the email is already linked to another central ID, login is blocked with an identity-conflict error.
6. If the central ID and email resolve to different KukGit rows, login is blocked rather than merging data automatically.

Do not repair identity conflicts directly in SQL without a backup and a written ownership decision.

## Founder bootstrap

For a new AuthKit-mode database:

- KukGit creates the `kuklabs` organization without a password user.
- The first verified central login matching `KUKGIT_ADMIN_EMAIL` is assigned `Owner` in that organization.
- Other central users may authenticate but receive no organization access until invited or granted repository-only access.

For an existing database, the founder email row is linked in place and its Owner membership remains unchanged.

## Supported KukGit auth endpoints

KukGit exposes same-origin browser endpoints and proxies them to central AuthKit:

```text
GET  /api/auth/status
POST /api/auth/login
POST /api/auth/signup
POST /api/auth/otp/request
POST /api/auth/otp/verify
POST /api/auth/google
POST /api/auth/logout
GET  /api/auth/me
```

The production password is sent only over HTTPS to KukGit and immediately proxied to AuthKit. KukGit does not hash, compare or persist it.

Google sign-in uses the shared Kuklabs Google web adapter to obtain an ID token. KukGit then sends that ID token to central AuthKit for audience, issuer, signature and account-link verification. KukGit must not create a separate Google OAuth project or account-linking rule.

## AuthKit upstream endpoints used

```text
GET  /v1/auth/status
POST /v1/auth/login
POST /v1/auth/signup
POST /v1/auth/otp/request
POST /v1/auth/otp/verify
POST /v1/auth/google
POST /v1/auth/token/refresh
POST /v1/auth/logout
GET  /v1/auth/me
GET  /v1/auth/products/kukgit/access
```

Access-token expiry triggers one refresh attempt. AuthKit rotates the refresh token; KukGit atomically replaces both encrypted values. Invalid or expired refresh tokens delete the local bridge session and require a new login.

## Outage behavior

KukGit fails closed for protected browser APIs when AuthKit cannot validate the session.

- repository data is not returned under an unvalidated browser session
- write operations do not fall back to local passwords
- the UI reports that Kuklabs Account is temporarily unavailable
- public static assets and health checks remain available
- logout always deletes the local bridge even when central logout cannot be reached

Git operations authenticated with a KukGit PAT or SSH key continue according to repository permission. Those credentials are product credentials, not browser login sessions. A future enterprise policy can bind PAT/SSH operation to central-account suspension checks.

## Rollout procedure

### 1. Pre-deployment

- deploy the required AuthKit `/v1/auth/*` contract
- confirm `GET /v1/auth/status` returns `kuklabs-authkit-rest/1`
- confirm Google, OTP, refresh and product-access flows in staging
- take a verified KukGit backup
- confirm the founder's central verified email exactly matches `KUKGIT_ADMIN_EMAIL`
- set a dedicated AuthKit encryption key

### 2. Staging

- run KukGit with `KUKGIT_AUTH_MODE=authkit`
- sign in with an existing KukGit email and verify the same local user ID is retained
- confirm organizations, repositories, PATs and SSH keys remain visible
- test access-token refresh
- revoke/log out the central device session and confirm a new login is required
- test a repository-only external collaborator invitation
- test AuthKit outage behavior

### 3. Production

- enable maintenance mode for the short deployment window
- create and verify a backup
- deploy AuthKit-mode configuration
- sign in as the founder and confirm Owner membership
- verify repository browser, Git HTTP, SSH and LFS operations
- disable maintenance mode
- watch authentication errors, AuthKit latency and identity-conflict audits

## Rollback

A code/config rollback does not require reversing the identity columns.

1. Put KukGit in maintenance mode.
2. Preserve the current database and create a backup.
3. Roll back the application image.
4. Use local mode only when the approved rollback build requires it.
5. Treat `KUKGIT_ALLOW_LOCAL_AUTH_IN_PRODUCTION=true` as a temporary emergency deviation.
6. Remove the override after AuthKit service is restored.

Do not delete `kuklabs_user_id` mappings during rollback. They are needed for the next AuthKit deployment and do not interfere with repository data.

## Key rotation

Changing `KUKGIT_AUTHKIT_ENCRYPTION_KEY` makes existing encrypted bridge sessions unreadable.

Safe rotation:

1. announce a forced sign-in event
2. delete AuthKit-mode rows from KukGit `sessions`
3. deploy the new key
4. require users to sign in again

Repository data, user mappings, PATs and SSH keys remain intact.

## Incident checks

Investigate these error codes:

```text
AUTHKIT_UNAVAILABLE
AUTHKIT_VALIDATION_FAILED
AUTHKIT_SESSION_EXPIRED
AUTHKIT_SESSION_INVALID
AUTHKIT_SESSION_IDENTITY_CHANGED
AUTHKIT_SESSION_IDENTITY_MISMATCH
AUTHKIT_IDENTITY_CONFLICT
AUTHKIT_EMAIL_ALREADY_LINKED
AUTHKIT_EMAIL_CONFLICT
KUKGIT_PRODUCT_ACCESS_DENIED
```

For repeated identity conflicts:

- freeze changes to the affected user rows
- verify central account ownership and verified email
- inspect organization memberships, repository grants, PATs and SSH keys for both local rows
- restore from backup if an unauthorized manual merge occurred

Never log access tokens, refresh tokens, passwords, OTP codes or encrypted-token plaintext. Auth audit metadata may include the product ID and central user ID only.

## Validation

Automated coverage includes:

- central identity linking
- founder bootstrap
- encrypted token custody
- token-envelope authentication
- protected-request validation
- product access denial
- refresh-token rotation
- signup OTP and Google proxy flows
- central logout and local bridge removal
- CSRF enforcement
- duplicate identity conflict protection
- production local-auth restrictions
