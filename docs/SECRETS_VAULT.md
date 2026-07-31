# KukGit Secrets Vault

Encrypted storage for the values a build needs and nobody should be able to read
back — deploy tokens, registry credentials, signing keys.

Secrets are scoped to an organization or to a single repository. A repository
secret shadows an organization secret of the same name, so a team can override an
inherited value without the organization losing its default.

## The rule that shapes everything else

**There is no read path.** No route returns a stored value, not even to the
person who just set it, not even to an instance operator.

A secret that can be read back is a secret that can be exfiltrated by anyone who
reaches the read path — a session hijack, an authorization slip on one route, a
logging mistake. There is no legitimate need for the API to have one: an operator
who has lost a value replaces it.

The only code that decrypts a secret is `resolveSecrets()`, which the runner
calls directly. It is not reachable over HTTP, so no authorization mistake on a
route can expose a value.

## Storage

AES-256-GCM, with the scope and name authenticated alongside the value:

```
kukgit-secret:v1:<scope>:<scope-id>:<name>
```

A ciphertext copied from one repository's row into another's — or renamed —
**fails to decrypt** rather than silently becoming a different secret.

The key comes from `KUKGIT_SECRETS_ENCRYPTION_KEY` and is deliberately separate
from the AuthKit, webhook and LFS keys: reusing one would mean a single
compromised key opens more than one kind of stored material. An instance with no
key, or a key under 32 characters, returns `503 SECRETS_VAULT_UNAVAILABLE` rather
than storing anything readable.

```bash
openssl rand -base64 48
```

## What a listing shows

Names and metadata only:

```json
{
  "name": "DEPLOY_TOKEN",
  "bytes": 40,
  "digest": "9f86d081884c",
  "createdAt": "…", "updatedAt": "…", "lastUsedAt": "…"
}
```

`digest` is the first 12 characters of the value's SHA-256. That is enough to
confirm two scopes hold the same secret, or that a rotation actually changed
something, and far too little to recover the value from.

A repository listing also reports the **names** of organization secrets it
inherits. Hiding them would make an unexplained value in a build look like a bug.

## API

```text
GET    /api/secrets/orgs/:org                  List organization secret names
PUT    /api/secrets/orgs/:org/:name            Create or replace
DELETE /api/secrets/orgs/:org/:name            Remove

GET    /api/secrets/repos/:org/:repo           List repository names + inherited names
PUT    /api/secrets/repos/:org/:repo/:name     Create or replace
DELETE /api/secrets/repos/:org/:repo/:name     Remove
```

`PUT` takes `{"value": "…"}` and answers `201` (created) or `200` (replaced) with
the name only. `DELETE` answers `204`. There is no `GET` for a single secret —
that route returns `404` by design.

### Authorization

| | Required |
| --- | --- |
| Organization secrets | Organization **Admin** or **Owner** |
| Repository secrets | Repository **Admin** |

Organization membership is checked directly against `org_members` rather than
through the shared `orgAccess()` helper. That helper has a repository-access fast
path which returns before the role rank is compared — it exists so a
repository-only collaborator can read repository context. Letting it satisfy an
organization admin check would hand organization-wide secrets to someone invited
to a single repository, so an organization-scope request made inside a
repository-access context is refused outright.

## Names

`^[A-Za-z_][A-Za-z0-9_]*$`, at most 100 characters.

The prefixes `GITHUB_`, `KUKGIT_`, `RUNNER_` and `CI_KUKGIT` are reserved. A
secret able to take one of those names could impersonate the runner's own
environment to every step in a job.

## Limits

| | |
| --- | --- |
| Value size | 48 KiB |
| Secrets per scope | 100 |
| Name length | 100 characters |

Replacing an existing secret is never blocked by the per-scope limit — an
operator must always be able to rotate.

## How a build receives a secret

Through the environment, never through the command line:

```yaml
- env:
    TOKEN: ${{ secrets.DEPLOY_TOKEN }}
  run: curl -H "Authorization: $TOKEN" https://registry.example
```

The workflow validator **rejects** a secret interpolated into a `run:` script —
see [WORKFLOWS.md](WORKFLOWS.md). A secret on a command line ends up in the
process table, in shell traces and in anything that logs commands. Through `env:`
it does not.

`maskSecrets()` replaces resolved values wherever they appear in build output.
That is a backstop, not the protection: the format already prevents a secret from
becoming command text. Values under five characters are not masked — they would
match ordinary text everywhere and turn a log into a wall of asterisks, hiding
more than they protect.

## Audit

`secret.created`, `secret.updated` and `secret.deleted` record the scope and the
**name**. Never the value, and never its digest.

`lastUsedAt` is stamped whenever a secret is resolved for a job, so an unused
credential is visible and can be removed.

## Operating

- Rotate by `PUT`-ing a new value; the digest in the listing changes, which is
  how a rotation is confirmed without anyone reading either value.
- Treat a suspected exposure as SEV1 per [OPERATIONS_BOUNDARY.md](OPERATIONS_BOUNDARY.md):
  rotate first, investigate second.
- Backups contain the ciphertext, not the key. A restored instance needs the same
  `KUKGIT_SECRETS_ENCRYPTION_KEY` — store it with the same care as the archive
  itself, and separately from it.
- Losing the key means every stored secret must be re-entered. There is no
  recovery path, by design.
