# KukGit Review Threads

KukGit review threads provide file and line anchored conversations for pull-request changes.

## Thread anchors

A new thread must reference a file included in the current pull-request comparison.

Supported anchors:

- `right` — a line in the pull request head branch.
- `left` — a line in the pull request base branch.
- `file` — the changed file without a line number.

Line anchors are validated against the selected Git ref. Binary files support file-level threads only. File paths are normalized as safe repository-relative paths.

Each thread stores the pull-request head SHA that existed when it was created. This makes thread freshness deterministic without depending on browser state.

## Conversation lifecycle

A thread begins with one root comment. Users with effective repository Write permission may:

- create a thread
- add threaded replies
- resolve a thread
- reopen a thread

Comments are append-only in the current private-alpha implementation. Resolution records the resolver and timestamp. Reopening clears the resolution fields while retaining the complete conversation.

## Active, resolved and outdated states

A thread is:

- **Active open** when it is unresolved and its stored head SHA matches the current pull-request head SHA.
- **Resolved** when it has a resolution timestamp.
- **Outdated** when the pull-request head SHA has changed since the thread was created.

Outdated threads remain visible for review history. They do not count as active unresolved conversations because their original code anchor may no longer represent the current change.

## Merge policy

Repository Admins can configure a base-branch policy that requires every active review thread to be resolved before merge.

The policy is stored separately from approval rules but is evaluated as an additional server-side merge guard. A pull request may therefore need to satisfy all of these independently:

- required approvals
- no active change requests
- all active review threads resolved

The browser disables the merge button when it knows active threads block the merge, but the server-side merge guard remains authoritative.

## Browser API

Authenticated sessions use:

- `GET /api/review-threads/:org/:repo` — list review-thread policies.
- `PUT /api/review-threads/:org/:repo/policies/:branch` — create or update a base-branch policy.
- `DELETE /api/review-threads/:org/:repo/policies/:branch` — delete a policy.
- `GET /api/review-threads/:org/:repo/pulls/:number` — read changed files, threads, comments and merge summary.
- `POST /api/review-threads/:org/:repo/pulls/:number/threads` — create an anchored thread.
- `POST /api/review-threads/:org/:repo/pulls/:number/threads/:threadId/replies` — add a reply.
- `POST /api/review-threads/:org/:repo/pulls/:number/threads/:threadId/resolve` — resolve a thread.
- `POST /api/review-threads/:org/:repo/pulls/:number/threads/:threadId/reopen` — reopen a thread.

All writes enforce same-origin protection. Thread actions require Write permission. Policy management requires Admin permission.

## Audit events

KukGit records:

- `review_thread_policy.updated`
- `review_thread_policy.deleted`
- `review_thread.created`
- `review_thread.replied`
- `review_thread.resolved`
- `review_thread.reopened`

Audit metadata includes repository, pull-request number, thread ID and anchor details without duplicating the private comment body.

## Security guidance

- Require resolved threads for production and release branches.
- Use line anchors only when the selected side contains the file.
- Treat outdated threads as historical context, not proof that current code was reviewed.
- Combine thread resolution with independent approvals.
- Avoid placing credentials, customer data or secrets in review comments.
- Review resolve/reopen events through the audit stream.

## Current private-alpha boundaries

- The UI lists changed files but does not yet render a complete unified diff.
- Threads are anchored by path, side, line and head SHA rather than a diff hunk identifier.
- Comment editing, deletion, reactions and mentions are not implemented.
- Outdated threads cannot yet be manually re-anchored onto a new head commit.
- Email and in-app review notifications are not implemented.
