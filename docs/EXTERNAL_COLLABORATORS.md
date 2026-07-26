# KukGit External Repository Collaborators

KukGit can grant a user access to one repository without adding that user to the owning organization. This is intended for clients, agencies, contractors, auditors and other partners who need a narrow collaboration boundary.

## Access model

A user's effective repository permission is the highest permission available from:

- organization role baseline, when the user is an organization member
- direct repository collaborator grant
- repository team grants, when the user belongs to an organization team

An **external collaborator** is a user who has a direct repository grant but no membership in the repository's organization.

Supported permissions:

- **Read** — browse and clone repository content.
- **Triage** — Read plus issue-management actions.
- **Write** — Triage plus branches, files, pull requests and Git/LFS uploads.
- **Maintain** — Write plus maintenance operations such as pull-request merge where policy permits.
- **Admin** — repository settings, access grants, webhooks, keys, protection rules and archive state.

Repository Admin does not imply organization Admin.

## What an external collaborator can discover

External users see only repositories explicitly shared with them.

The combined dashboard, repositories page, global issues page and global pull-request page include:

- repositories where the user is an organization member
- repositories with a direct collaborator grant for the user

For an external-only repository, KukGit does not disclose:

- organization member directory
- organization teams
- team repository grants
- other organization repositories
- organization administration
- organization billing or plan controls

The repository-access API returns a sanitized view to external collaborators. It lists only external repository collaborators relevant to the shared repository.

## Creating an invitation

A Repository Admin opens **Repository → Settings → External collaborators** and provides:

- recipient email address
- repository permission
- expiry of 7, 14 or 30 days

KukGit creates a one-time token beginning with `kgr_`. Only its SHA-256 hash and short prefix are stored in SQLite.

The recipient receives:

- an in-app notification when the email already belongs to a KukGit user
- transactional email through the durable email outbox
- a secure acceptance URL
- the exact repository and permission scope
- a notice that organization membership is not created

The plaintext invitation token is returned only in the create or resend response so an administrator may copy the link manually when required. It is not written into audit metadata, notification metadata or server logs.

## Accepting an invitation

The recipient must:

1. Sign in with the exact email address invited.
2. Open the acceptance URL.
3. Select **Accept repository invitation**.

Acceptance performs one transaction:

- verifies token hash, expiry, revocation and replay state
- verifies the signed-in email
- marks the invitation accepted
- creates or updates the direct repository collaborator grant
- creates no `org_members` record

The token cannot be accepted again.

## Revoke and resend

A pending invitation can be revoked immediately.

Resend:

1. revokes the previous invitation
2. creates a new token
3. applies a fresh expiry
4. queues a new email
5. displays the new one-time link

The old link remains unusable. Accepted invitations cannot be revoked or resent as invitations; remove the active collaborator grant instead.

## Updating and removing access

Repository Admins can change an active external collaborator's permission from Repository Settings.

Removing the direct grant immediately removes:

- repository discovery
- browser API access
- private Git smart HTTP access
- SSH Git access
- private Git LFS access

Existing sessions and personal access tokens remain valid for the user's other repositories, but no longer authorize the removed repository.

## Browser authorization

KukGit's repository access guard calculates the required permission for the exact route and method before the main repository handler runs.

The approved decision is stored in request-scoped context. Internal repository handlers reuse that decision without treating the external user as a real organization member.

Examples:

- `GET` repository/code routes require Read.
- issue creation requires Triage.
- branch, file and pull-request creation requires Write.
- merge requires Maintain.
- settings operations require Admin where implemented.

The scoped context applies only to the exact repository request. It does not authorize organization APIs.

## Git smart HTTP

Private Git HTTP authentication uses a scoped personal access token plus effective repository permission:

- fetch/clone requires `repo:read` and Repository Read
- push requires `repo:write` and Repository Write

An otherwise valid token returns no authorization for an unrelated repository. The Git HTTP layer responds with an authentication failure rather than exposing repository details.

## SSH Git access

A registered user SSH key uses the same effective repository permission calculation:

- `git-upload-pack` requires Read
- `git-receive-pack` requires Write

Forced-command parsing and repository path validation remain unchanged. A key does not gain access to other repositories merely because its owner is an external collaborator somewhere else.

## Git LFS access

SSH `git-lfs-authenticate` also uses effective repository permission:

- download requires Read
- upload requires Write

HTTPS LFS uses the existing Personal Access Token and repository permission model. Object associations still prevent an external user from reading an LFS object that is not attached to the shared repository.

## Repository lifecycle authority

External Repository Admins may perform repository-scoped administration, including archive and unarchive where allowed.

Two ownership-sensitive operations require actual organization Admin or Owner membership:

- transfer to another organization
- move to Repository Trash

This check is performed before the normal lifecycle API. A direct Repository Admin grant cannot be used to transfer ownership or initiate destructive retention workflows.

Permanent purge and Trash restore remain controlled by their existing organization and instance authority checks.

## Audit and notifications

KukGit records events such as:

- `repository_invitation.created`
- `repository_invitation.revoked`
- `repository_invitation.resent`
- `repository_invitation.accepted`
- `repository_collaborator.permission_updated`
- `repository_collaborator.revoked`

Audit metadata may include repository ID, email, permission and expiry. It must not contain the invitation token or acceptance URL.

The inviter receives an acceptance notification. The recipient receives confirmation that repository-only access is active.

## Security checks

Before public deployment, run:

```bash
npm run doctor
npm run check
npm test
```

The automated suite verifies:

- exact-email acceptance
- token hashing, expiry, revocation and replay protection
- CSRF enforcement
- no organization membership on acceptance
- one-repository discovery boundary
- organization directory privacy
- browser permission enforcement
- Git HTTP authorization
- SSH Git authorization
- Git LFS authorization
- lifecycle transfer and Trash blocking
- invitation-token absence from audit metadata

## Operational guidance

- Grant the lowest permission required.
- Prefer short invitation expiry for temporary engagements.
- Remove external access promptly when a contract ends.
- Review repository collaborators periodically.
- Use branch protection and required status checks for external Write users.
- Require strong Personal Access Token expiry and SSH key hygiene.
- Keep invitation email delivery and failed-email queues monitored.
- Use audit logs when investigating access changes.

## Current limitations

The private-alpha implementation does not yet include:

- account creation from the invitation screen
- external collaborator billing or seat metering
- access expiration after invitation acceptance
- per-directory or per-branch access restrictions
- mandatory MFA for external collaborators
- access review campaigns
- legal agreement acceptance
- IP allowlists per collaborator
- real-time WebSocket invitation updates

These controls can be layered on the direct repository grant model without changing Git repository data.
