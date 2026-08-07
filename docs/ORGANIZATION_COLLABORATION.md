# KukGit Organization Collaboration

KukGit organizations group users, repositories and teams under one company or project workspace.

## Organization roles

KukGit currently supports these organization roles:

- `owner` — full organization authority. Created during organization provisioning and not assignable through normal invitations.
- `admin` — manages invitations, teams and organization collaboration settings.
- `maintainer` — manages repositories and delivery workflows.
- `developer` — creates branches, commits, issues and pull requests.
- `viewer` — read-only organization access.

Roles are ordered. Higher roles satisfy lower-role checks.

## Invitations

Owners and admins can create an invitation from **Organizations → Organization collaboration**.

Each invitation contains:

- exact normalized email address
- organization role
- 7, 14 or 30-day expiry
- one-time secure `kgi_...` token
- safe token prefix for administration
- invited, accepted, expired or revoked status
- inviter and lifecycle timestamps

KukGit displays the secure acceptance URL only when the invitation is created. Only its SHA-256 hash and safe prefix are stored. The full token is not available from invitation lists, audit logs or later API responses.

Creating a new pending invitation for the same organization and email automatically revokes the older pending invitation.

## Accepting an invitation

The recipient opens the generated URL and signs in to KukGit. Acceptance succeeds only when:

- the token exists
- the invitation is pending
- it has not expired or been revoked
- the signed-in account email exactly matches the invitation email

The membership write and invitation acceptance update run in a database transaction. Replaying an accepted token is rejected.

The recipient may use an existing account or create a KukGit-local account when
self-service signup and email delivery are configured. Acceptance still requires
the one-time invitation token and an exact account-email match; the separate
self-service verification gate applies when that account creates its own
organization. AuthKit-mode instances use the verified central account instead.

## Teams

Owners and admins can create teams and add organization members.

A team has:

- unique organization-scoped slug
- name and description
- `maintainer` or `member` team roles
- auditable membership changes

The creator is automatically added as a team maintainer. Deleting a team removes team memberships but does not remove organization members.

Repository team grants, direct organization-member grants and time-bounded
repository-only external collaborators are implemented on top of this team
model. See [Repository Access](REPOSITORY_ACCESS.md) and
[External Collaborators](EXTERNAL_COLLABORATORS.md).

## Browser API

Authenticated browser sessions use:

- `GET /api/collaboration/orgs/:org` — members, safe invitations and teams.
- `POST /api/collaboration/orgs/:org/invitations` — create an invitation.
- `DELETE /api/collaboration/orgs/:org/invitations/:id` — revoke a pending invitation.
- `POST /api/collaboration/invitations/accept` — accept an invitation for the current account.
- `POST /api/collaboration/orgs/:org/teams` — create a team.
- `DELETE /api/collaboration/orgs/:org/teams/:teamId` — delete a team.
- `POST /api/collaboration/orgs/:org/teams/:teamId/members` — add or update a team member.
- `DELETE /api/collaboration/orgs/:org/teams/:teamId/members/:userId` — remove a team member.

All writes enforce same-origin protection and authorization. Creation, acceptance, revocation, team creation/deletion and membership changes are recorded in the audit log.

## Operational guidance

- Invite with the minimum organization role required.
- Use short invitation expiries.
- Revoke unused invitations promptly.
- Never send invitation links in public channels.
- Review admin and team-maintainer membership regularly.
- Use separate teams for engineering responsibility boundaries rather than assigning broad admin access.
