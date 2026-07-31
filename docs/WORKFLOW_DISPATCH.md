# KukGit Workflow Dispatch

What turns a push into a run. Without this the CI chain is complete but
unreachable: nothing ever starts.

## Where workflows come from

`.kukgit/workflows/*.yml` and `*.yaml`, read **at the commit being built** —
never from the current default branch.

Reading from a branch tip would let a change to a workflow file silently rewrite
how already-pushed commits are built. A workflow must describe what *that commit*
asked for.

Limits: 25 files per repository, 128 KiB each.

## What starts a run

A ref snapshot before the request and after it. Whatever moved is what happened.

Comparing snapshots rather than parsing the receive-pack protocol, because the
snapshot is exact for **every** path that can update a ref — a Git push, a
browser commit, a branch created through the API — and none of them have to agree
on a format for it to work.

| Ref | Event |
| --- | --- |
| `refs/heads/*` updated | `push` |
| `refs/tags/*` updated | `tag` |
| any ref deleted | none |

**A deleted ref produces no event.** There is nothing to build at a commit nobody
can reach, and running a workflow from a deleted branch would execute code the
repository has just decided to remove. Its queued and running work is cancelled
instead — leaving it would hold a slot against the repository's in-flight limit.

Path filters are evaluated against the actual diff between the previous and new
commit. A newly created ref has nothing to diff against, so filters see no path
information — and `workflowMatchesEvent` does not drop a build for missing
metadata.

## Dispatch happens after the response, not before

The middleware registers on the response **finishing**, not on the handler
returning.

Git smart HTTP streams through a spawned backend, and its handler resolves as
soon as the pipe is wired — long before Git has written any ref. Awaiting it
would compare the repository against itself and find no push at all. That is not
theoretical: it is what the first end-to-end test of this code did, and it
produced no runs.

A finished response is the one moment every path agrees the work is done. It also
means a build is never started for a push that branch protection then rejected,
and the push is not made slower by reading workflow files.

A dispatch failure is logged and never surfaced to the client. The push happened
and has already been acknowledged.

## A broken workflow file becomes a failed run

Not a skipped one.

Skipping is much worse: the author sees no run at all and cannot tell a typo from
a filter that legitimately did not match. A failed run carrying the validation
error — with its line number — is a bug report addressed to the person who caused
it.

```
.kukgit/workflows/broken.yml: jobs.a.steps[0].run: 'github.event.issue.title'
may not be interpolated into a run script…
```

**One broken file never stops the others.** Each is validated on its own, so a
typo in a deployment workflow does not silently disable the test workflow beside
it.

A file over the size limit fails the same way rather than being ignored.

## Expressions in a run script

The validator allows an allow-list of repository-controlled fields inside `run:`
— `github.sha`, `github.ref_name`, `github.repository` and the rest. The runner
substitutes exactly those before writing the script to disk.

Anything else is left **exactly as written**. Every other context is refused by
the validator, so a script reaching a runner with an unrecognised expression is a
validator bug — quietly substituting something would hide it.

This was found by running the chain end to end: `${{ github.sha }}` reached bash
untouched and produced `bad substitution`. Unit tests on either side of the seam
were green.

## Audit

`workflow.dispatched` records the event, the ref and the workflow paths that
started or failed. Never their contents.

## Not dispatched yet

- **`pull_request`** — the event, filters and fork handling all exist; only the
  trigger from a pull-request action is missing.
- **`schedule`** — cron is validated and stored, but nothing fires it. That needs
  the job-lease model first, or two instances would fire every schedule twice
  ([OPERATIONS_BOUNDARY.md](OPERATIONS_BOUNDARY.md)).
- **`manual`** — no dispatch endpoint yet.
