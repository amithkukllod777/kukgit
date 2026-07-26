# KukGit Repository Lifecycle

KukGit provides controlled repository archive, organization transfer, Trash restore and permanent purge workflows.

## Archive

Repository Admins can archive a repository from **Repository → Settings → Repository lifecycle**.

An archived repository remains readable:

- code, branches and commits
- issues and pull requests
- review history
- analyses and audit history
- clone and fetch operations

The following operations are blocked until unarchive:

- browser branch and file writes
- issue, pull-request and review changes
- status publishing and webhook management
- Git smart HTTP pushes

KukGit returns `REPOSITORY_ARCHIVED` for blocked writes. Unarchive restores normal write operation.

## Organization transfer

A transfer requires:

- Repository Admin permission in the source organization
- Admin or Owner role in the target organization
- archived repository state
- no repository with the same slug in the target organization

KukGit moves the bare Git directory from the source organization namespace to the target namespace. The filesystem move and database update are rollback-protected.

During transfer:

- repository ID and history remain unchanged
- issues, pull requests, reviews, statuses, webhooks and audit history remain attached
- organization-scoped team grants are removed
- direct collaborator grants are preserved only for users who belong to the target organization
- clone URL changes to the target organization slug

Both source and target organizations receive audit entries.

## Move to Trash

A repository must be archived before deletion. The Admin must type the exact value:

```text
organization/repository
```

KukGit then:

- removes the repository from normal listings
- disables browser and Git access
- records the original organization and slug
- records the deleting user and deletion time
- schedules purge after 30 days
- retains Git objects and repository metadata for recovery

The internal Trash organization has no user memberships and cannot be used as a transfer target.

## Restore

An Admin or Owner of the original organization can restore a repository from **Settings → Repository Trash**.

Restore requires exact typed confirmation. It fails when the original organization already contains a repository with the same slug. After restore, the repository remains archived so an Admin can inspect it before enabling writes.

## Permanent purge

Only an Owner of the original organization can permanently purge a trashed repository.

Purge requires exact typed confirmation and deletes:

- bare Git storage
- issues and pull requests
- reviews and review threads
- status checks and branch rules
- repository collaborators and team grants
- webhooks and delivery logs
- analyses and repository metadata

The storage directory is moved into a temporary quarantine location before database deletion. If the database transaction fails, KukGit restores the storage path. After successful deletion, quarantine is destroyed.

Permanent purge cannot be undone.

## Browser API

Repository lifecycle:

- `GET /api/repository-lifecycle/:org/:repo`
- `POST /api/repository-lifecycle/:org/:repo/archive`
- `DELETE /api/repository-lifecycle/:org/:repo/archive`
- `POST /api/repository-lifecycle/:org/:repo/transfer`
- `POST /api/repository-lifecycle/:org/:repo/trash`

Trash management:

- `GET /api/repository-lifecycle/trash`
- `POST /api/repository-lifecycle/trash/:repositoryId/restore`
- `DELETE /api/repository-lifecycle/trash/:repositoryId`

All write requests enforce same-origin protection. Archive, transfer, Trash and purge actions are audited.

## Webhook events

Repository lifecycle operations enqueue the `repository` webhook event with one of these actions:

- `archived`
- `unarchived`
- `transferred`
- `trashed`
- `restored`

Permanent purge removes the webhook subscription with the repository, so the irreversible operation is represented in KukGit audit history rather than delivered through a deleted subscription.

## Operational guidance

- Archive before planned maintenance, ownership transfer or deletion.
- Review target organization membership before transfer.
- Treat Trash as recovery protection, not as long-term storage.
- Restore and inspect a repository before unarchiving it.
- Restrict permanent purge to organization Owners.
- Include repository storage and database state in the same backup schedule.
