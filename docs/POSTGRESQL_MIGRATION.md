# PostgreSQL Metadata Migration

KukGit currently uses SQLite for metadata and stores Git repositories and Git LFS objects on the filesystem. Moving metadata to PostgreSQL must preserve every user, organization, repository, permission, invitation, session, token record, audit event and delivery record without interrupting Git data.

This migration is intentionally staged. **The Stage 1 tooling in this document does not switch the KukGit runtime to PostgreSQL.** SQLite remains the supported runtime until the PostgreSQL driver, translated schema, verified import and cutover stages are complete.

## Data boundary

The metadata migration includes the SQLite database and its application tables.

It does not move:

- bare Git repositories under `KUKGIT_DATA_DIR/repos`
- Git LFS object files under `KUKGIT_LFS_DIR`
- verified `.kgbak` archives
- reverse-proxy or OpenSSH configuration
- environment secrets

Repository and LFS metadata rows must continue pointing to the same filesystem storage after cutover.

## Safety principles

1. No automatic destructive cutover.
2. Existing SQLite data remains untouched during export/import.
3. PostgreSQL cannot be selected without a verified readiness marker by default.
4. The readiness marker is bound to the exact source manifest fingerprint.
5. Row counts, row checksums, schema fingerprints and foreign keys must pass before approval.
6. Export files are treated as database backups because they contain complete metadata.
7. Passwords, tokens and encrypted credential fields are copied exactly but never printed in reports.
8. Failed import leaves PostgreSQL unready and SQLite remains authoritative.

## Configuration

Stage 1 production and development configuration should remain:

```env
KUKGIT_DATABASE_DRIVER=sqlite
KUKGIT_DATABASE_URL=
KUKGIT_POSTGRESQL_READINESS_MARKER=./data/postgresql-readiness.json
KUKGIT_POSTGRESQL_REQUIRE_VERIFIED_CUTOVER=true
```

A future runtime stage will use a URL similar to:

```env
KUKGIT_DATABASE_DRIVER=postgresql
KUKGIT_DATABASE_URL=postgresql://kukgit:<password>@db.internal:5432/kukgit?sslmode=require
```

Do not commit that URL. CLI/status output redacts username/password and credential-like query parameters.

## Stage 0 — SQL portability audit

Run:

```bash
npm run database -- audit-sql
```

The report is written under `data/database-migration/` by default and identifies:

- `PRAGMA`
- `sqlite_master`
- `rowid`
- SQLite date functions such as `datetime()` and `julianday()`
- `INSERT OR IGNORE/REPLACE`
- `BEGIN IMMEDIATE`
- `?` placeholders
- `COLLATE NOCASE`
- `AUTOINCREMENT`
- `last_insert_rowid()`

Blocking findings require driver abstraction or query translation before PostgreSQL runtime support can be claimed. Translation findings require explicit compilation or transaction behavior in the PostgreSQL adapter.

Use this stricter command only after portability work is expected to be complete:

```bash
npm run database -- audit-sql --fail-on-blocking
```

## Stage 1 — deterministic SQLite inventory

Create a source manifest:

```bash
npm run database -- inventory \
  --output data/database-migration/sqlite-source-manifest.json \
  --tables
```

The manifest records:

- every user-created table
- table schema text and checksum
- column metadata
- deterministic row count and SHA-256 checksum
- total row count
- complete source fingerprint
- `PRAGMA foreign_key_check` results

The canonical checksum sorts rows by their stable JSON representation. It is intended for migration verification, not for exposing data.

Re-check the live SQLite database against the saved manifest:

```bash
npm run database -- verify-live \
  --manifest data/database-migration/sqlite-source-manifest.json
```

Any schema, row-count or row-checksum difference invalidates the comparison.

## Stage 1 — protected metadata export

Create a complete metadata export:

```bash
npm run database -- export \
  --output data/database-migration/kukgit-metadata.kgdb.json
```

KukGit writes the export atomically with mode `0600`. The bundle contains:

- export format identifier
- source manifest
- all table rows
- per-table checksums
- complete bundle checksum

Verify it before copying or importing:

```bash
npm run database -- verify-export \
  --input data/database-migration/kukgit-metadata.kgdb.json
```

A modified row, missing table, changed row count or altered bundle fails verification.

### Export handling

The export may contain:

- password hashes from legacy/local-development users
- encrypted AuthKit access and refresh token ciphertext
- personal-access-token hashes
- webhook encrypted secret fields
- email bodies and delivery metadata
- audit and support records

Therefore:

- never commit it to Git
- never send it in chat or email
- keep it on encrypted storage
- restrict file and directory permissions
- delete temporary copies after verified import
- rotate exposed credentials immediately if handling controls fail

`.gitignore` excludes `data/database-migration/`, `data/postgresql-readiness.json` and `*.kgdb.json`.

## Stage 2 — driver abstraction (next implementation stage)

The current application is synchronous and widely uses the SQLite `prepare().get/all/run()` contract. PostgreSQL clients are asynchronous, so a safe migration requires more than replacing `openDatabase()`.

The next stage must introduce:

- an asynchronous metadata service/driver boundary
- transaction APIs with explicit isolation and lock semantics
- translated placeholders and SQLite-specific SQL
- ordered schema migrations recorded in a migration-history table
- PostgreSQL pooling, timeouts and health checks
- compatibility tests for every authorization and lifecycle path

Do not emulate synchronous PostgreSQL with blocking subprocesses or worker-thread RPC in production.

## Stage 3 — translated schema and import

The PostgreSQL schema must preserve primary keys and foreign-key identities exactly. In particular:

- `users.id` remains unchanged
- `kuklabs_user_id` one-to-one linking remains unchanged
- organization, repository, issue and pull-request IDs remain unchanged
- PAT, SSH, invitation and session ownership remains unchanged
- audit targets and delivery IDs remain unchanged

The import process should:

1. create an empty PostgreSQL database/schema,
2. apply ordered migrations,
3. import tables in foreign-key-safe order,
4. preserve nulls, timestamps, JSON text and binary values,
5. validate foreign keys,
6. compare per-table row counts and canonical checksums,
7. produce target schema and row fingerprints,
8. leave PostgreSQL marked unready on any mismatch.

No import command in Stage 1 writes to PostgreSQL.

## Stage 4 — dual-read validation

Before cutover, a verification deployment should keep SQLite authoritative and compare selected read models against PostgreSQL:

- current user and organization memberships
- effective repository permissions
- repository listings and lifecycle state
- invitation state
- PAT/SSH authorization metadata
- pending notifications, email and webhook deliveries
- backup/LFS metadata counts

Dual-read comparison must not double-run writes or delivery workers.

Differences should be reported by table/key/request ID without printing sensitive row fields.

## Stage 5 — maintenance cutover

A future cutover command must require:

1. recent verified `.kgbak` snapshot,
2. maintenance mode enabled,
3. notification and webhook workers stopped,
4. final SQLite manifest/export,
5. final PostgreSQL import,
6. row/checksum/foreign-key verification,
7. verified readiness marker,
8. operator confirmation of source fingerprint and target database,
9. application restart in PostgreSQL mode,
10. read/write smoke tests before maintenance mode is removed.

The default readiness gate is controlled by:

```env
KUKGIT_POSTGRESQL_REQUIRE_VERIFIED_CUTOVER=true
```

Disabling it is an emergency bypass and is not an approved normal deployment path.

## Readiness marker

The readiness marker format is `kukgit-postgresql-cutover/1`. It contains:

- exact SQLite source manifest fingerprint
- source table and row totals
- target host, database and schema identifiers
- PostgreSQL schema fingerprint
- PostgreSQL row fingerprint
- verification difference counts
- creation time and optional operator identity
- marker SHA-256 checksum

Tampering or using a marker from a different SQLite source invalidates readiness.

Check status:

```bash
npm run database -- postgresql-status \
  --source-fingerprint <sqlite-manifest-fingerprint>
```

Stage 1 validates marker safety but does not provide the PostgreSQL importer that creates an approved marker.

## Rollback

Until PostgreSQL becomes authoritative, rollback means keeping or returning to:

```env
KUKGIT_DATABASE_DRIVER=sqlite
```

After a future cutover, rollback must be time-bounded and documented because PostgreSQL may receive new writes that SQLite does not have.

Approved rollback preparation must include:

- the pre-cutover verified `.kgbak`
- the final SQLite export and manifest
- cutover timestamp
- PostgreSQL transaction/write boundary
- a policy for preserving post-cutover writes
- operator and incident record

Never point KukGit back to stale SQLite while accepting writes unless the loss window is explicitly understood and approved.

## Backups

Current verified backups snapshot SQLite metadata, Git repositories and LFS objects. A later PostgreSQL runtime stage must add a transactionally consistent PostgreSQL metadata dump/snapshot while retaining Git and LFS coverage.

Do not mark PostgreSQL runtime complete until backup create, verify, dry-run restore and full restore work with the selected metadata backend.

## Useful commands

```bash
npm run database -- status
npm run database -- inventory --tables
npm run database -- export
npm run database -- verify-export --input <file.kgdb.json>
npm run database -- verify-live --manifest <manifest.json>
npm run database -- audit-sql
npm run database -- postgresql-status
npm run database -- readiness-marker
```

## Current milestone boundary

Delivered in Stage 1:

- SQL portability inventory
- deterministic SQLite manifest and drift detection
- complete protected metadata export
- tamper/checksum verification
- PostgreSQL URL validation and redaction
- verified-cutover readiness marker validation
- migration CLI and automated tests

Not yet delivered:

- PostgreSQL runtime driver
- connection pool
- translated PostgreSQL schema
- importer
- dual-read validation
- production cutover
- PostgreSQL backup/restore

Issue #43 remains open until those later stages are complete.
