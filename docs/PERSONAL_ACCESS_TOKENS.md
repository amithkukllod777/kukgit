# KukGit Personal Access Tokens

KukGit personal access tokens (PATs) authenticate Git smart HTTP operations without exposing a user's account password.

## Token format

New tokens begin with `kgp_`. KukGit shows the plaintext value only once and stores only its SHA-256 hash, short display prefix, scopes, expiry and lifecycle timestamps.

## Available scopes

- `repo:read` — clone and fetch repositories the user can access.
- `repo:write` — push to repositories where the user has at least the `developer` organization role. This scope also satisfies read operations.

Repository visibility and organization membership are checked in addition to token scope.

## Create a token

```bash
npm run token -- create \
  --email admin@kuklabs.local \
  --name "Founder laptop" \
  --scopes repo:read,repo:write \
  --days 90
```

Copy the returned `kgp_...` value immediately. It cannot be displayed again.

## List tokens

```bash
npm run token -- list --email admin@kuklabs.local
```

The list shows token IDs, safe prefixes, scopes, expiry, last use and status. It never shows token plaintext or hashes.

## Revoke a token

```bash
npm run token -- revoke \
  --email admin@kuklabs.local \
  --id pat_example
```

Revocation takes effect on the next authentication attempt.

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
