# KukGit Branch Governance

KukGit branch governance protects critical branches and enforces pull-request review policy before merge.

## Protection rules

Rules are repository-scoped and currently match an exact branch name. Repository Admin permission is required to create, update or delete a rule.

A rule contains:

- `requirePullRequest` — changes should arrive through a KukGit pull request.
- `requiredApprovals` — active approvals required before merge, from 0 to 10.
- `dismissStaleApprovals` — approvals against an older pull-request head SHA become inactive after new commits.
- `blockDirectPushes` — browser file commits and Git smart HTTP pushes cannot update the protected branch directly.

Rules are managed from **Repository → Settings → Branch protection**.

## Review states

A repository user with Write permission can submit one current review per pull request:

- `approved`
- `changes_requested`
- `commented`

Submitting another review replaces that reviewer's previous state and records the current pull-request head SHA. Pull-request authors may comment but cannot approve or request changes on their own pull request.

## Merge policy

KukGit evaluates the protection rule for the pull request's base branch.

A merge is blocked when:

- the pull request is not open
- an active change request exists
- the number of active approvals is below the rule requirement

When stale approval dismissal is enabled, a review is active only when its stored head SHA matches the current head branch SHA.

The merge endpoint re-evaluates policy immediately before the existing merge workflow executes. UI state is informative; server-side enforcement is authoritative.

## Direct-write enforcement

KukGit uses multiple enforcement layers:

1. The repository API guard blocks browser file commits to protected branches.
2. The pull-request merge guard blocks merges that do not satisfy review policy.
3. A repository `pre-receive` hook blocks direct Git smart HTTP pushes to protected branches.

The hook receives the repository ID and database path through the authenticated Git HTTP process environment. It reads only branch-protection rules and rejects protected `refs/heads/*` updates. Internal approved merge workflows may use the explicit `KUKGIT_BYPASS_BRANCH_PROTECTION=1` environment flag.

## Browser API

Authenticated sessions use:

- `GET /api/governance/:org/:repo` — list rules and open pull-request governance status.
- `PUT /api/governance/:org/:repo/rules/:branch` — create or update a protection rule.
- `DELETE /api/governance/:org/:repo/rules/:branch` — remove a protection rule.
- `GET /api/governance/:org/:repo/pulls/:number` — read reviews and current merge policy.
- `POST /api/governance/:org/:repo/pulls/:number/reviews` — submit or replace the current user's review.

Writes enforce same-origin protection and effective repository permission. Rule and review actions are recorded in the audit log.

## Security guidance

- Protect the default branch before inviting broad Write access.
- Require at least one independent approval for production repositories.
- Keep stale-approval dismissal enabled.
- Keep direct pushes blocked for branches used for releases or deployment.
- Do not treat comments as approvals.
- Review branch-protection changes in the audit log.
- Run KukGit with a database path accessible to repository hooks.

## Current private-alpha boundaries

- Rules match exact branches; glob and ruleset matching are planned.
- Reviews are pull-request-level, not code-line review threads.
- Required status checks and CI attestations are not yet part of merge policy.
- Administrators do not yet have a separately audited emergency bypass workflow.
