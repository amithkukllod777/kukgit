# KukGit Required Status Checks

KukGit required status checks gate pull-request merges on CI and integration results published for the pull request's current head commit.

## Status records

A status is uniquely identified by:

- repository
- full 40-character commit SHA
- context name

Supported states:

- `pending`
- `success`
- `failure`
- `error`

Publishing the same repository, SHA and context updates the existing status. A record may include a short description and an HTTP/HTTPS details URL.

## Branch policies

Repository Admins configure policies from **Repository → Settings → Required status checks**.

A policy is scoped to an exact base branch and contains up to 50 required context names. Example contexts:

- `build`
- `test`
- `security/scan`
- `deploy-preview`

Every selected context must exist on the pull request's current head SHA and report `success`. Missing, pending, failure and error states block merge.

Saving an empty context list preserves the branch policy record but does not gate merge.

## Current-head freshness

KukGit never reuses a successful check from an older pull-request commit. Statuses are keyed by commit SHA, so a new head commit automatically makes prior results stale for merge evaluation. Runners must publish a fresh result for every required context on the new SHA.

## Trusted publisher authentication

CI runners and integrations publish statuses with a KukGit personal access token that has:

- `repo:write` scope
- effective repository Write permission or higher

Bearer authentication:

```bash
curl -X POST \
  -H "Authorization: Bearer <kgp_token>" \
  -H "Content-Type: application/json" \
  https://git.example.com/api/status-checks/kuklabs/project/commits/<40-character-sha>/statuses \
  -d '{
    "context": "test",
    "state": "success",
    "description": "All tests passed",
    "targetUrl": "https://ci.example.com/runs/123"
  }'
```

HTTP Basic is also supported when the PAT is supplied as the password or username. Browser sessions with effective Write permission can publish statuses from the pull-request interface for private-alpha testing.

## Browser API

Authenticated sessions use:

- `GET /api/status-checks/:org/:repo` — policies, known contexts and open pull-request summaries.
- `PUT /api/status-checks/:org/:repo/policies/:branch` — create or replace required contexts.
- `DELETE /api/status-checks/:org/:repo/policies/:branch` — remove a policy.
- `GET /api/status-checks/:org/:repo/commits/:sha/statuses` — list statuses for one commit.
- `POST /api/status-checks/:org/:repo/commits/:sha/statuses` — publish or update a status.
- `GET /api/status-checks/:org/:repo/pulls/:number` — read one pull request's status-check summary.

All browser writes enforce same-origin protection. PAT publishers are additionally verified for token scope and effective repository permission.

## Merge enforcement

The merge endpoint re-evaluates required checks immediately before the existing merge operation. UI indicators are informative; server-side enforcement is authoritative.

Required status checks are independent from:

- approval count
- active change requests
- unresolved review threads

A pull request must satisfy every enabled policy layer before merge.

## Audit events

KukGit records:

- `required_status_policy.updated`
- `required_status_policy.deleted`
- `commit_status.published`

Audit metadata contains repository, SHA, context, state and authentication type. Personal access token plaintext and status details credentials are never logged.

## Security guidance

- Use a separate short-lived PAT for each runner or integration.
- Grant the minimum repository permission required.
- Use stable, namespaced context names.
- Publish `pending` before work starts and a terminal state when it finishes.
- Never reuse a status from another commit SHA.
- Keep target URLs free of embedded credentials or secrets.
- Revoke runner tokens immediately when infrastructure changes.

## Current private-alpha boundaries

- KukGit stores commit statuses but does not yet execute CI jobs.
- There is no runner registration or OIDC workload identity yet.
- Context policies match exact names; wildcard context rules are planned.
- Status history is currently represented by the latest value per repository, SHA and context.
- Check suites, annotations and uploaded artifacts are planned for the hosted CI milestone.
