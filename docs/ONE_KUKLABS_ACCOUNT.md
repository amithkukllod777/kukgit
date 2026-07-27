# One Kuklabs Account and AuthKit

KukGit production authentication uses central Kuklabs AuthKit. KukGit does not own a separate production password system, Google identity, OTP database or primary user identity.

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

## Product-local identity mapping

KukGit retains `users.id` so repository, organization, issue, pull-request, PAT, SSH-key and audit foreign keys remain stable. It maps one-to-one to the central identity:

```text
KukGit users.id       = usr_...
Kuklabs Account ID    = users.kuklabs_user_id
```

The central ID is unique and immutable. The local row is authorization metadata, not a second account.

## Browser session design

The browser never receives an AuthKit access or refresh token directly.

1. The browser submits login, signup, OTP or Google ID-token data to KukGit.
2. KukGit proxies the request to `/v1/auth/*`.
3. AuthKit returns an access JWT, rotating refresh token and verified central user.
4. KukGit verifies `kukgit` product access.
5. KukGit links the central identity to one product-local user row.
6. Access and refresh tokens are encrypted with AES-256-GCM and stored server-side.
7. The browser receives only a random HttpOnly `kukgit_session` cookie.
8. Protected browser API requests validate central identity and session state through AuthKit.

The encrypted token envelope is authenticated against the local session hash. Copying ciphertext to another session row does not produce a valid token.

## Required production configuration

```bash
NODE_ENV=production
KUKGIT_BASE_URL=https://git.kuklabs.com
KUKGIT_AUTH_MODE=authkit
KUKGIT_AUTHKIT_BASE_URL=https://auth.kuklabs.com
KUKGIT_AUTHKIT_PRODUCT_ID=kukgit
KUKGIT_AUTHKIT_ENCRYPTION_KEY=<at-least-32-random-characters>
KUKGIT_AUTHKIT_TIMEOUT_MS=8000
KUKGIT_AUTHKIT_REFRESH_TTL_DAYS=60
KUKGIT_COOKIE_SECURE=true
KUKGIT_ADMIN_EMAIL=<verified-founder-email>
```

Generate a dedicated key:

```bash
openssl rand -base64 48
```

Do not reuse SMTP, webhook, LFS, database or other application secrets.

## Mandatory production rules

- Production defaults to `authkit` when `KUKGIT_AUTH_MODE` is omitted.
- Production rejects `KUKGIT_AUTH_MODE=local` unconditionally.
- There is no emergency environment flag that enables KukGit-local production passwords.
- `KUKGIT_AUTHKIT_BASE_URL` must use HTTPS in production.
- `KUKGIT_AUTHKIT_ENCRYPTION_KEY` must contain at least 32 characters.
- AuthKit production cookies must be Secure.
- AuthKit mode never seeds a KukGit-local founder password.
- Local password mode remains available only in isolated development and automated tests.

Run before deployment:

```bash
npm run doctor
npm run check
npm test
```

## Existing-user migration

Migration is lazy and preserves authorization relationships.

When a verified AuthKit user signs in:

1. KukGit looks for the same `kuklabs_user_id`.
2. Otherwise it looks for the exact normalized verified email.
3. An unlinked email row is linked to the central ID in place.
4. Existing organization memberships, repository ownership, issues, pull requests, audit records, PATs and SSH keys remain attached to the same local ID.
5. An email already linked to another central ID is rejected.
6. Central ID and email resolving to different KukGit rows is rejected instead of silently merging data.
7. After successful linking, any legacy local password hash is replaced with the non-authenticating `authkit$managed` sentinel.

Do not repair identity conflicts directly in SQL without a verified backup and a written ownership decision.

## Founder bootstrap

For a new AuthKit-mode database:

- KukGit creates the `kuklabs` organization without a password user.
- The first verified central login matching `KUKGIT_ADMIN_EMAIL` receives Owner membership when no Owner exists.
- Other users receive no organization access until invited, onboarded or granted repository-only access.

For an existing database, the founder email row is linked in place and existing Owner membership remains unchanged.

## KukGit browser auth endpoints

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

Google sign-in uses the shared Kuklabs Google web adapter to obtain an ID token. Central AuthKit verifies and links that identity. KukGit must not create a separate Google OAuth project or account-linking rule.

## AuthKit upstream endpoints

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
GET  /v1/auth/sessions
GET  /v1/auth/products/kukgit/access
```

Access-token expiry triggers one refresh attempt. AuthKit rotates the refresh token and KukGit atomically replaces both encrypted values. Invalid or expired refresh tokens delete the local bridge and require sign-in.

## Outage and revocation behavior

KukGit fails closed for protected browser APIs when AuthKit cannot validate the session.

- repository data is not returned under an unvalidated browser session
- write operations do not fall back to local passwords
- central device-session revocation deletes the local bridge and clears the cookie
- blocked or inactive product membership denies access
- public static assets and health checks remain available
- logout always removes the local bridge even when central logout is unavailable

KukGit PAT and SSH credentials remain product credentials governed by repository permission. They are not substitutes for browser login.

## Rollout procedure

### Pre-deployment

- verify `/v1/auth/status` returns `kuklabs-authkit-rest/1`
- verify OTP, password, Google, refresh, session and product-access flows in staging
- take and verify a KukGit backup
- confirm the founder's verified central email exactly matches `KUKGIT_ADMIN_EMAIL`
- configure a dedicated AuthKit encryption key

### Staging

- run KukGit with `KUKGIT_AUTH_MODE=authkit`
- sign in with an existing KukGit email and verify its local user ID is retained
- confirm organizations, repositories, PATs and SSH keys remain visible
- test refresh-token rotation
- revoke the central device session and confirm a new login is required
- test AuthKit outage behavior

### Production

- enable maintenance mode for the deployment window
- create and verify a backup
- deploy AuthKit-mode configuration
- sign in as founder and verify Owner membership
- verify repository browser, Git HTTP, SSH and LFS workflows
- disable maintenance mode
- monitor authentication latency, revocation and identity-conflict audit events

## Rollback

A rollback must preserve central identity mappings.

1. Enable maintenance mode.
2. Preserve the current database and create a verified backup.
3. Restore the last approved application image that supports AuthKit.
4. Restore AuthKit connectivity or configuration.
5. Do not enable local production passwords as a fallback.
6. Do not delete `kuklabs_user_id` mappings.

A legacy build that requires local production authentication is not an approved rollback target.

## Encryption-key rotation

Changing `KUKGIT_AUTHKIT_ENCRYPTION_KEY` makes existing encrypted bridge sessions unreadable.

Safe rotation:

1. announce a forced sign-in event
2. delete AuthKit-mode rows from KukGit `sessions`
3. deploy the new key
4. require users to sign in again

Repository data, identity mappings, PATs and SSH keys remain intact.

## Incident codes

```text
AUTHKIT_UNAVAILABLE
AUTHKIT_VALIDATION_FAILED
AUTHKIT_SESSION_EXPIRED
AUTHKIT_SESSION_INVALID
AUTHKIT_SESSION_IDENTITY_CHANGED
AUTHKIT_SESSION_IDENTITY_MISMATCH
AUTHKIT_IDENTITY_CONFLICT
AUTHKIT_EMAIL_REQUIRED
AUTHKIT_EMAIL_ALREADY_LINKED
AUTHKIT_EMAIL_CONFLICT
KUKGIT_PRODUCT_ACCESS_DENIED
```

Never log passwords, OTP codes, access tokens, refresh tokens or decrypted token values. Authentication audit metadata may contain only the product ID, local user ID, central user ID and non-secret lifecycle information.