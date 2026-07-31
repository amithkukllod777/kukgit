# KukGit Verified Backups and Disaster Recovery

KukGit creates portable, checksummed snapshots containing the SQLite metadata database and a Git bundle or empty marker for every active and trashed repository.

## Backup contents

A `.kgbak` snapshot contains:

- `manifest.json`
- `metadata/kukgit.db`
- `metadata/config.json`
- one `repositories/<repository-id>.bundle` for every repository with refs
- one `repositories/<repository-id>.empty.json` for every empty repository

The manifest records:

- backup ID and creation timestamp
- application and format version
- database size and SHA-256 checksum
- repository ID, storage organization, storage slug and default branch
- active, archived or trashed lifecycle state
- Git ref names and object IDs
- bundle size and SHA-256 checksum
- total repositories and refs

The configuration snapshot is deliberately sanitized. It contains endpoint and retention metadata but excludes passwords, tokens, API keys and webhook encryption keys.

The SQLite database remains sensitive because it contains password hashes, token hashes, encrypted webhook secrets, SSH public keys, user data and organization metadata. Store backup archives with the same or stronger protection as the live database.

## Portable archive format

KukGit uses a dependency-free gzip-compressed framed format rather than relying on external tar or zip binaries.

Each archive entry has:

- validated POSIX-relative path
- declared byte size
- SHA-256 checksum
- exact file bytes

Extraction rejects:

- absolute paths
- Windows drive paths
- backslashes
- `..` traversal
- duplicate entries
- oversized headers or entries
- truncated data
- checksum mismatches
- footer count mismatches
- trailing archive data
- files not declared by the manifest

Default archive permissions are `0600` and backup directories are created with restrictive permissions.

## Snapshot consistency

SQLite is copied with:

```text
PRAGMA wal_checkpoint(PASSIVE)
VACUUM INTO <snapshot database>
```

This produces a transactionally consistent metadata database without copying live WAL files.

Each bare Git repository is checked with `git fsck --full`, then bundled from all reachable refs. A repository bundle is internally consistent at the moment Git creates it. Empty repositories receive an explicit marker.

For the strictest cross-service recovery point, enable maintenance mode before creating the snapshot so browser writes and Git pushes are quiesced:

```bash
npm run backup -- maintenance on --reason "Scheduled verified backup"
npm run backup -- create
npm run backup -- maintenance off
```

Maintenance mode preserves reads but blocks browser writes, API writes and Git pushes.

Git bundles preserve objects reachable from refs. Unreachable dangling objects are intentionally not part of the recovery contract.

## Configuration

```text
KUKGIT_BACKUPS_DIR=./data/backups
KUKGIT_BACKUP_RETENTION_COUNT=14
KUKGIT_BACKUP_RETENTION_DAYS=30
KUKGIT_MAINTENANCE_PATH=./data/maintenance.json
KUKGIT_BACKUP_LOCK_PATH=./data/backup.lock
```

The backup directory may be placed on another mounted volume. It must not equal the repository directory.

A lock file prevents concurrent create or restore operations. A stale lock should be removed only after confirming no backup or restore process is running.

## Create a backup

```bash
npm run backup -- create
```

Creation performs all of these steps before reporting success:

1. acquire the operation lock
2. create and verify the SQLite snapshot
3. verify every source repository with `git fsck --full`
4. create Git bundles or empty markers
5. compute payload checksums
6. write the manifest
7. write the compressed portable archive
8. extract the archive into a temporary verification directory
9. verify database integrity, manifest checksums, bundle structure and ref counts
10. write the informational sidecar index

The backup is considered successful only after the final verification pass.

## List snapshots

```bash
npm run backup -- list
```

The list uses `.kgbak.json` sidecar indexes for fast status display. Sidecars are informational; the archive and a fresh verification are authoritative.

The instance administrator also sees recent snapshots in **Settings → Verified backups and recovery**.

## Verify a snapshot

```bash
npm run backup -- verify --archive kukgit-20260726T120000Z-abcdef123456.kgbak
```

The archive argument may be a full path or a filename inside `KUKGIT_BACKUPS_DIR`.

Verification checks:

- archive framing and entry checksums
- manifest schema and declared files
- SQLite `integrity_check`
- SQLite `foreign_key_check`
- database and manifest repository counts
- every Git bundle with `git bundle verify`
- bundle ref counts
- empty-repository markers

Browser administrators can also run **Verify archive** for an existing snapshot.

## Dry-run restore

Always perform a dry run first:

```bash
npm run backup -- restore \
  --archive /secure/backups/kukgit-example.kgbak \
  --target /srv/kukgit-restore-test \
  --dry-run
```

A dry run fully extracts and verifies the archive but does not create the target directory.

## Full restore

Restore writes only to a missing or empty directory:

```bash
npm run backup -- restore \
  --archive /secure/backups/kukgit-example.kgbak \
  --target /srv/kukgit-restored
```

KukGit builds the restored data directory in a temporary sibling path. It then:

- copies the verified SQLite snapshot
- initializes each bare repository
- fetches all bundled refs
- restores the default `HEAD`
- configures Git smart HTTP receive behavior
- runs `git fsck --full` on every restored repository
- verifies the restored database again
- writes `RESTORE.json`
- atomically renames the completed build into the requested target

Any failure removes the temporary build. A non-empty target is never modified.

## Production recovery runbook

1. Identify the most recent snapshot meeting the incident recovery point.
2. Copy the archive to isolated recovery storage.
3. Run archive verification.
4. Run a dry-run restore.
5. Enable maintenance mode on the live instance.
6. Stop the KukGit application and SSH service.
7. Restore into a new sibling data directory.
8. Preserve the damaged data directory for investigation; do not overwrite it.
9. Point `KUKGIT_DATA_DIR` to the restored directory.
10. Run `npm run doctor`.
11. Start KukGit and confirm database, repositories, clone, fetch and protected push behavior.
12. Confirm startup reinstalls current branch-protection hooks.
13. Re-enable traffic only after smoke testing.
14. Record the recovery time, selected backup ID and any data-loss window.

Do not attempt an online in-place restore over the active data directory.

## Maintenance mode

Enable:

```bash
npm run backup -- maintenance on --reason "Disaster recovery"
```

Status:

```bash
npm run backup -- maintenance status
```

Disable:

```bash
npm run backup -- maintenance off
```

While enabled:

- GET, HEAD and OPTIONS requests remain available
- backup creation remains available
- browser and API writes return HTTP 503
- Git smart HTTP pushes return HTTP 503
- repository reads and fetches remain available

The marker is read for every request, so no application restart is required.

## Retention and pruning

```bash
npm run backup -- prune --keep 14 --days 30
```

A snapshot is removed only when it is:

- outside the newest `keep` snapshots, and
- older than the selected number of days

This two-part rule prevents a low-activity installation from losing its minimum recovery set.

The Settings panel provides the same explicit pruning operation. Schedule creation and pruning through the host scheduler appropriate for the deployment.

## Browser administration

Only the user whose email matches `KUKGIT_ADMIN_EMAIL` can access the instance-wide backup API and panel.

Available browser actions:

- view backup and maintenance status
- create and immediately verify a snapshot
- verify an existing archive
- apply the retention policy

Full restore is CLI-only to prevent an authenticated browser session from replacing live instance data.

All browser writes enforce same-origin protection. Backup create, verify and prune operations generate audit events without recording secret values.

## Off-site and encryption policy

The built-in archive provides integrity and compression, not encryption.

Production policy should:

- copy verified archives to independent off-site or object storage
- encrypt storage at rest
- restrict archive access to recovery administrators
- enable immutability or object lock for critical recovery points
- test restores regularly in an isolated environment
- monitor failed backup and verification runs
- keep at least one recovery copy outside the primary cloud account or failure domain

Never treat a locally stored archive on the same disk as the only backup.

## Recovery objectives

KukGit does not choose business RPO or RTO automatically.

- RPO is determined by backup frequency and whether maintenance mode is used for a quiesced snapshot.
- RTO is determined by archive size, storage throughput, repository count and smoke-test requirements.

Measure both with scheduled restore drills rather than estimates alone. The drill
itself is automated — see [RECOVERY_REHEARSAL.md](RECOVERY_REHEARSAL.md), which
restores a real archive into a throwaway directory, proves the restored instance
is serviceable and writes an evidence record carrying the measured RTO and
data-loss window.
