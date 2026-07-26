# KukGit Git Large File Storage

KukGit Git LFS stores large binary content outside normal Git packfiles while Git commits retain small text pointer files. The implementation uses the Git LFS Batch API, SHA-256 content addressing, repository permissions, quotas and verified disaster-recovery coverage.

## Client setup

Install Git LFS on the developer computer, then enable it once:

```bash
git lfs install
```

Choose file patterns inside a repository:

```bash
git lfs track "*.zip"
git lfs track "*.psd"
git lfs track "*.mp4"
git add .gitattributes
git commit -m "Track large assets with Git LFS"
```

After this, normal `git add`, `git commit`, `git push`, `git clone` and `git pull` commands invoke Git LFS automatically.

## Supported transports

### HTTPS remotes

KukGit exposes the standard repository-scoped LFS endpoint:

```text
<base-url>/git/<organization>/<repository>.git/info/lfs
```

Private downloads and all uploads use the same KukGit Personal Access Token and repository permission model as Git smart HTTP:

- Download requires `repo:read` and effective Repository Read permission.
- Upload requires `repo:write` and effective Repository Write permission.
- Public repositories allow unauthenticated LFS downloads only for objects attached to that repository.

The PAT is supplied as the HTTP Basic password, matching normal KukGit clone and push authentication.

### SSH remotes

For SSH remotes, the Git LFS client invokes:

```text
git-lfs-authenticate '<organization>/<repository>.git' download
git-lfs-authenticate '<organization>/<repository>.git' upload
```

KukGit accepts only this exact command shape. It rejects shell operators, path traversal, arbitrary commands and malformed repository paths.

The forced-command runtime verifies the user or deploy key, repository identity and requested operation. It then returns a repository-scoped signed Bearer credential that expires after five minutes.

- User SSH keys use effective repository Read or Write permission.
- Read-only deploy keys cannot authenticate uploads.
- Deploy keys cannot authenticate against another repository.
- Archived repositories permit downloads but reject uploads.

Set a strong production signing key:

```bash
KUKGIT_LFS_AUTH_KEY=<at-least-32-random-characters>
```

Changing this value invalidates all outstanding short-lived LFS SSH tokens. Stored objects are unaffected.

## Batch API behavior

KukGit supports the `basic` Git LFS transfer adapter and up to 1,000 objects per Batch API request.

### Upload

1. The client submits each object OID and declared size.
2. KukGit validates the SHA-256 format, object limit and projected quotas.
3. A short-lived pending-upload record is created.
4. The client streams bytes to the returned upload action.
5. KukGit writes to a private temporary file while calculating SHA-256.
6. Declared size and calculated OID must both match.
7. The object is moved atomically to content-addressed storage and attached to the repository.
8. The optional verify action rechecks stored size and SHA-256.

Wrong size, wrong hash, expired registration and quota overflow are rejected. Incomplete temporary files are removed.

### Download

Downloads are available only when both conditions are true:

- the physical SHA-256 object exists; and
- the repository-to-object association exists.

This prevents a user who knows an OID from reading an object belonging only to another repository.

KukGit supports:

- `GET` and `HEAD`
- one byte range per request
- `206 Partial Content`
- `ETag` equal to the SHA-256 OID
- immutable caching for public repositories
- private caching for protected repositories
- `application/octet-stream` and `nosniff` headers

## Storage layout

The default storage root is:

```text
data/lfs/
```

Objects are stored by SHA-256:

```text
data/lfs/objects/ab/cd/abcdef...64-hex-characters
```

Pending upload files live under:

```text
data/lfs/tmp/
```

The database stores object size and relative storage path. A second association table connects one physical object to one or more repositories.

One identical object can therefore be reused across repositories without consuming duplicate instance storage. Repository usage counts the object once for every repository that references it.

## Quotas

Configuration:

```bash
KUKGIT_LFS_MAX_OBJECT_BYTES=5368709120
KUKGIT_LFS_REPOSITORY_QUOTA_BYTES=21474836480
KUKGIT_LFS_INSTANCE_QUOTA_BYTES=107374182400
KUKGIT_LFS_UPLOAD_EXPIRY_SECONDS=3600
```

Default meanings:

- Maximum single object: 5 GiB
- Repository LFS quota: 20 GiB
- Instance physical storage quota: 100 GiB
- Pending upload expiry: one hour

Rules:

- Maximum object size cannot exceed the repository quota.
- Repository quota cannot exceed the instance quota.
- Pending uploads are included in projected quota calculations.
- A deduplicated object already present physically does not consume instance quota again.
- Associating the same object with another repository consumes that repository's logical quota.

The production doctor validates directory access, safe path separation, positive integer limits, quota relationships, upload expiry and the LFS signing key.

## Repository Settings

Repository Admins can open **Repository → Settings → Git Large File Storage** to view:

- repository usage and remaining quota
- instance usage and quota
- maximum object size
- attached object count
- OID, size and availability
- last-accessed and last-verified timestamps
- per-object integrity verification

The instance administrator can run orphan garbage collection from this panel.

## Garbage collection

The Admin GC operation performs two tasks:

1. Removes expired pending-upload database records.
2. Deletes physical objects and metadata that are not associated with any repository.

GC never removes an object referenced by at least one repository. Repository deletion naturally removes its associations through database foreign keys; an object shared with another repository remains protected.

Run GC only after a verified backup and normal retention review. The operation is recorded in the audit log.

## Archive and Trash behavior

- Archived repository: LFS downloads remain available; uploads are rejected.
- Trashed repository: normal repository resolution hides it, so Batch API and object endpoints are unavailable.
- Restored repository: existing associations become available again because repository metadata is restored.
- Permanent repository purge: its associations are removed. A later Admin GC may remove newly orphaned physical objects.

## Verified backup coverage

KukGit `.kgbak` snapshots include:

- SQLite metadata, including object and repository associations
- Git repository bundles
- every physical LFS object recorded in metadata
- an LFS manifest containing OID, size, storage path and totals

Backup creation verifies every LFS object's:

- physical presence
- file size
- SHA-256 hash
- content-addressed path

A missing or corrupt LFS object blocks backup creation rather than producing an incomplete recovery archive.

Backup verification rechecks the archive manifest and object checksums. Restore writes each object into the content-addressed LFS layout and verifies it again before reporting success. A failed LFS restore removes the partially restored target directory.

For a strict point-in-time snapshot, enable KukGit maintenance mode before creating the backup so Git pushes and LFS uploads are quiesced:

```bash
npm run backup -- maintenance on --reason "Scheduled verified backup"
npm run backup -- create
npm run backup -- maintenance off
```

## Operational checks

Before public deployment:

```bash
npm run doctor
npm run check
npm test
```

Also verify:

- LFS storage is on durable disk, not ephemeral container storage.
- LFS and Git repository directories are separate.
- LFS and backup directories are separate.
- Filesystem permissions restrict object storage to the KukGit service account.
- Reverse proxies allow required upload sizes and do not buffer multi-gigabyte bodies unnecessarily.
- Off-site backup copies include complete `.kgbak` archives.
- Monitoring covers disk capacity, quota consumption, failed uploads and integrity failures.

## Current limitations

The private-alpha implementation does not yet provide:

- external object storage such as S3-compatible buckets
- resumable multipart transfers
- bandwidth metering and billing
- per-organization quota overrides
- automatic scheduled integrity sweeps
- antivirus or content-policy scanning
- cross-region LFS replication

These can be added without changing Git pointer files because object identity remains the standard SHA-256 OID.
