# KukGit Repository Access

KukGit combines organization roles, direct collaborator grants and team grants into one effective repository permission.

## Permission levels

Repository permissions are ordered from lowest to highest:

1. `read` — view repository metadata, branches, commits, files, issues, pull requests and analysis results; clone protected repositories with a read-scoped personal access token.
2. `triage` — includes read access and can create or update issues.
3. `write` — includes triage access and can push Git changes, create branches, commit files, open pull requests and run repository analysis.
4. `maintain` — includes write access and can merge pull requests and perform delivery-maintenance actions.
5. `admin` — includes maintain access and can manage repository collaborators and team grants.

## Organization role baseline

Every organization member receives a baseline repository permission:

- Organization `viewer` → repository `read`
- Organization `developer` → repository `write`
- Organization `maintainer` → repository `maintain`
- Organization `admin` or `owner` → repository `admin`

A direct grant or team grant can raise this baseline. It cannot reduce the permission supplied by an organization role.

## Effective permission

KukGit calculates the effective permission from all applicable sources:

- organization role baseline
- direct collaborator grant
- every repository grant assigned to a team the user belongs to

The highest permission wins. For example, a Viewer with a direct Triage grant and a team Write grant receives effective Write permission.

## Direct collaborators

A repository admin can grant a repository-specific permission to an existing organization member. The grant is stored separately from organization membership and can be changed or removed without removing the user from the organization.

Direct grants in this section apply to organization members. Repository admins
may also invite a repository-only external collaborator by exact email, with an
expiry and no visibility into the rest of the organization. That separate flow
is documented in [External Collaborators](EXTERNAL_COLLABORATORS.md).

## Team access

A repository admin can grant a permission to an organization team. Every current team member receives that permission automatically. New users added to the team receive access without a separate repository grant, and users removed from the team lose that access unless another source still grants it.

Deleting a team automatically removes its repository grants through database foreign-key cascading.

## Browser API enforcement

KukGit applies effective repository permissions before the existing repository API executes. The guard uses request-specific access context, so the application can safely honor a repository elevation without changing the user’s organization role.

Examples:

- `GET /api/repos/:org/:repo/...` requires Read.
- Creating or updating issues requires Triage.
- Branch, file, pull-request and analysis writes require Write.
- Pull-request merge requires Maintain.

Repository access-management endpoints require Admin and enforce same-origin protection.

## Git smart HTTP enforcement

Protected clone/fetch requires:

- a personal access token with `repo:read` or `repo:write`; and
- effective repository Read permission.

Push requires:

- a personal access token with `repo:write`; and
- effective repository Write permission.

Git fetch and push audit events record the authentication type and effective repository permission, but never record plaintext personal access tokens.

## Access-management API

Authenticated sessions use:

- `GET /api/repository-access/:org/:repo` — effective permission, sources, members, direct grants, teams and team grants.
- `POST /api/repository-access/:org/:repo/collaborators` — create or update a direct collaborator grant.
- `DELETE /api/repository-access/:org/:repo/collaborators/:userId` — remove a direct grant.
- `POST /api/repository-access/:org/:repo/teams` — create or update a team grant.
- `DELETE /api/repository-access/:org/:repo/teams/:teamId` — remove a team grant.

## Audit events

KukGit records:

- `repository_collaborator.granted`
- `repository_collaborator.revoked`
- `repository_team_access.granted`
- `repository_team_access.revoked`
- `git.fetch`
- `git.push`

Audit metadata contains repository, user/team identifiers and permission values. It does not contain authentication secrets.

## Operational guidance

- Grant the minimum permission required.
- Prefer team grants for stable engineering groups.
- Use direct grants for exceptional or temporary responsibility.
- Review Admin and Maintain access regularly.
- Remove redundant direct grants after a team grant is in place.
- Remember that organization role baseline access remains active after a direct or team grant is removed.
