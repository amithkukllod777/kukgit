# KukGit Workflow Checks

How a CI run becomes a commit status a branch rule can require.

This is what makes CI *do* something for the product rather than just produce
logs.

## The context is derived, never declared

A run publishes under a context taken from its **file path**:

```
.kukgit/workflows/ci.yml            →  kukgit/ci
.kukgit/workflows/release-deploy.yml →  kukgit/release-deploy
```

**A workflow cannot name its own context.** If it could, a repository could add a
file that declares the exact context a branch rule requires and report success
without running anything — the protection defeated by the thing it protects
against.

The file path is part of the commit, so it is already subject to review and
branch protection. Changing which context a workflow reports means changing a
tracked file.

## States

| Run | Status |
| --- | --- |
| queued, running | `pending` |
| success | `success` |
| failure | `failure` |
| **cancelled** | **`error`** |

A cancelled run is `error`, not `failure`.

`failure` says the code is wrong. A cancellation says nobody found out — an
operator stopped it, a newer commit superseded it, or a runner disappeared.
Reporting that as a code failure sends someone looking for a bug that does not
exist, and makes a legitimate re-run look like a fix.

## Nothing here decides a merge

The required-status policy and the merge guard already decide that, for every
publisher, and they are unchanged. This module only supplies a status they can
read.

Adding a workflow can never **relax** a branch rule. At most it adds another
check that has to pass. To require one, an operator names the context in the
branch's required-status policy — the same way any other check is required.

The status is published **by the server on the run's behalf**, never by the job's
own token. A job must not be able to write the verdict on itself.

## Attribution

The status is attributed to whoever caused the run, with `publisherAuthType:
workflow` so the *how* is never mistaken for a person publishing by hand.

A run with no resolvable actor publishes **nothing** rather than borrowing
someone else's name. For a Git push that means resolving the personal access
token in Basic auth, not just a session cookie — a PAT push is the ordinary case
for CI, and reading only the session would leave almost every run unattributed.

## Failure is contained

A status that cannot be published is logged and dropped. A reporting failure must
not also destroy the run that produced it, and the run's own record stays
authoritative.

The same applies to the observer that drives this: it is a registered callback
rather than a direct import, so the scheduler does not depend on how a run is
reported, and an observer that throws cannot stop a build from running. There is
a test for exactly that.

## Multiple workflows

Each publishes its own independent check. A commit with `ci.yml` and `deploy.yml`
gets `kukgit/ci` and `kukgit/deploy`, and a branch rule can require either, both
or neither.
