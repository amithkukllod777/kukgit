# KukGit Personal Access Tokens

KukGit personal access tokens (PATs) authenticate Git smart HTTP operations without exposing a user's account password.

## Token format

New tokens begin with `kgp_`. KukGit shows the plaintext value only once and stores only its SHA-256 hash, short display prefix, scopes, expiry and lifecycle timestamps.

## Available scopes

- `repo:read` — clone and fetch repositories the user can access.
- `repo:write` — push to repositories where the user has at least the `developer` organization role. This scope also satisfies read operations.

Repository visibility and organization membership are checked in addition to token scope.

## Create and manage tokens in the browser

1. Sign in to KukGit.
2. Open **Settings**.
3. In **Personal access tokens**, enter a device or integration name.
4. Choose an expiry and the minimum required scopes.
5. Select **Create personal access token**.
6. Copy the `kgp_...` value immediately and store it in a secure password manager.

The Settings page lists safe token prefixes, scopes, expiry, last-use time and status. It never displays token hashes or previously issued plaintext values. Revocation takes effect immediately on the next Git authentication attempt.

## Create a token from the server CLI

```bash
npm run token -- create \
  --email admin@kuklabs.local \
  --name "Founder laptop" \
  --scopes repo:read,repo:write \
  --days 90
```

Copy the returned `kgp_...` value immediately. It cannot be displayed again.

## List tokens from the server CLI

```bash
npm run token -- list --email admin@kuklabs.local
```

The list shows token IDs, safe prefixes, scopes, expiry, last use and status. It never shows token plaintext or hashes.

## Revoke a token from the server CLI

```bash
npm run token -- revoke \
  --email admin@kuklabs.local \
  --id pat_example
```

Revocation takes effect on the next authentication attempt.

## Browser API

Authenticated browser sessions can use:

- `GET /api/settings/tokens` — list safe token metadata and available scopes.
- `POST /api/settings/tokens` — create a token. Supported expiry presets are 7, 30, 60, 90, 180 and 365 days.
- `DELETE /api/settings/tokens/:id` — revoke a token owned by the current user.

Write requests enforce same-origin protection. Creation and revocation are recorded in the KukGit audit log without storing or logging plaintext token values.

## Clone and push

Use any non-empty username and the PAT as the HTTP Basic password:

```bash
git clone https://developer:<PAT>@git.example.com/git/kuklabs/example.git
git push https://developer:<PAT>@git.example.com/git/kuklabs/example.git main
```

Avoid leaving tokens in shell history or checked-in remote URLs. Prefer a Git credential helper or an environment-specific secret manager.

## Development compatibility

The shared `KUKGIT_DEV_GIT_TOKEN` remains available only when KukGit is not running in production. Production Git authentication requires a scoped PAT.

## Operational guidance

- Prefer the minimum scope required.
- Use separate tokens for separate devices and automations.
- Choose short expiries and rotate before expiry.
- Revoke tokens immediately when a device, contractor or integration no longer needs access.
- Never log or email plaintext token values.
