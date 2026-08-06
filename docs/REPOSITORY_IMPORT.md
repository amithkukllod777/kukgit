# Importing a repository from another host

KukGit can take a repository off GitHub, GitLab, Bitbucket, Gitea, or anything
else that speaks Git over HTTPS, and host it here instead. A mirror clone: every
branch, every tag, the whole history.

```
POST /api/repos/import
{
  "orgSlug":     "kuklabs",
  "slug":        "platform",
  "name":        "KukGit Platform",
  "sourceUrl":   "https://github.com/kuklabs/platform.git",
  "accessToken": "github_pat_…"        // only for a private repository
}
```

In the UI: **New repository → Import existing**.

## The token

A private repository needs credentials, and where the credentials go is most of
what this feature is.

**It is never stored.** The token is used for one clone and is gone when that
clone finishes. There is no table for it, no encryption key to rotate, and
nothing in a database backup to leak. This is the reason importing a private
repository does not require the secrets vault to be configured. It is also the
reason there is no re-sync yet: a repeated fetch would need a stored credential,
and that is a larger piece of work than a one-shot import.

**It never goes in the URL.** `validateRemoteUrl` refuses a URL with credentials
in it, and always has. A URL is written into `remote.origin.url` in the clone's
config, appears in reflogs, and is echoed back in Git's own error output — so a
token in a URL is a token on disk for the repository's whole life.

**It never goes on the command line.** `/proc/<pid>/cmdline` is world-readable on
Linux: any user on the machine can read the arguments of any running process.
`/proc/<pid>/environ` is readable only by the process owner. The token is passed
as `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_n` / `GIT_CONFIG_VALUE_n`, which Git
reads as configuration for that one invocation and does not write anywhere.
There is a test that clones a real repository with a token set and then reads the
resulting config file to prove nothing was written into it.

**It is scoped to the URL being cloned.** `http.extraHeader` attaches a header to
every HTTP request Git makes, including one to a host it was redirected to.
KukGit sets `http.<the exact URL>.extraHeader`, so a redirect somewhere
unexpected carries no token. `credential.helper` is set to empty at the same
time, which clears any helper the machine has configured globally — so nothing
can hand the token to something that writes it to disk.

**It is validated before it is used.** A token containing a carriage return and a
newline would not extend the `Authorization` header, it would end it, and
everything after it would become headers of the caller's choosing. Control
characters are refused, in a millisecond, before any network call.

**It is redacted from anything shown to a person**, and the audit event records
`authenticated: true` rather than the token. An audit row is read by more people
than a database row, and it is exported.

### Which token

| Host | What to use | Scope |
| --- | --- | --- |
| GitHub | fine-grained PAT | Contents: read |
| GitLab | project access token | `read_repository` |
| Bitbucket | app password | Repositories: read |
| Gitea / Forgejo | access token | `read:repository` |

Read access to the contents, and nothing else. An import does not need to write,
and does not need anything outside the repository.

## SSH

An SSH remote authenticates with a key at the transport layer, so there is no
header to put a token in. Supplying `accessToken` with an `ssh://` or `git@` URL
is refused rather than ignored — a silently dropped token produces a clone that
fails for a reason nobody can see from the form. Use a deploy key on the server
for SSH imports.

## What it refuses

- **`file://` and local paths** — an import that could read the server's own disk
  is a way to read the server's own disk.
- **`localhost` and private network addresses** — including IPv6 link-local and
  unique-local. The server can reach hosts on its network that the caller cannot.
- **Credentials embedded in the URL**, as above.
- **An organization at its plan's repository limit.** This used to be enforced on
  *Create new* and not on *Import existing* — the same resource, billed the same,
  reached by a different button. It is enforced on both, and the check runs before
  the clone rather than after it.

## Importing everything an account owns

One URL at a time is fine for one repository and hopeless for forty. **New
repository → Import from another host** asks GitHub or GitLab what an
organization or user owns and brings the lot.

```
POST /api/repository-imports/preview   # says what would happen, imports nothing
POST /api/repository-imports           # 202 and a job to watch
GET  /api/repository-imports/:jobId    # progress
DELETE /api/repository-imports/:jobId  # stop what has not started
```

**Preview first, always.** Forty repositories arriving in an organization — each
one counted against the plan — is not something to discover afterwards. The
preview lists what would be imported and, separately, everything it would skip
and why: forks, archived repositories, ones with no commits, and names that
collide once reduced to a KukGit slug. Nine missing out of forty is nine named
reasons, not a smaller number and a shrug. Those reasons are stored on the job
too, so they are still there a week later.

**The forge is picked from a list, not supplied as a URL.** `github.com` and
`gitlab.com`, with the API base hard-coded. There is no host field to point at an
internal address, which is why this needs none of the DNS-resolution defence that
webhook delivery does. A self-hosted forge will need an instance-level allow-list;
it is deliberately not "any host you like".

**Listing your own account uses the endpoint that can see private repositories.**
GitHub's `/users/{owner}/repos` never returns private repositories, even to a
token that owns every one of them — only `/user/repos` does. So when the token
belongs to the owner being listed, that is the endpoint used. Without that,
"import all my repositories" silently skips exactly the ones anybody was worried
about moving.

**One repository at a time, and one failure is one failure.** A clone saturates
whatever it is given, so running six at once makes all six slow. A repository
that will not clone is recorded as failed and the queue carries on — nobody is
watching a forty-repository import, and stopping at number three would mean
finding out tomorrow.

**The plan limit is re-checked before every repository**, not once for the batch.
A job that takes an hour can cross the limit partway through.

**The token stays in memory for the life of the job.** Everything above about
never writing it down still holds, and a background worker needs the credential
after the request that carried it has gone. Keeping it in memory preserves the
property at a real cost: if the server restarts mid-job, the private repositories
still queued fail, and say they failed because the token went with the process.
Start the import again for what is left.

**Limits.** 500 repositories enumerated per listing and 500 per job. An owner
with more is reported as truncated rather than quietly cut off.

## What it does not do yet

- **Issues, pull requests, labels, releases, wikis.** Only Git objects are
  imported. Everything else stays on the old host.
- **LFS objects.** A mirror clone brings the pointer files, not the contents.
  See [GIT_LFS.md](GIT_LFS.md) for uploading them afterwards.
- **Re-sync.** One-shot. See "It is never stored", above.
- **Bitbucket**, and self-hosted GitHub Enterprise or GitLab. The single-URL
  import works with any of them today; the bulk listing does not.
- **Resuming a job across a restart**, for the reason given above.
