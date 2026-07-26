# PostgreSQL Migration Foundation

KukGit currently runs its metadata plane on synchronous SQLite. This milestone prepares a deterministic, verifiable migration package for PostgreSQL while deliberately leaving the live runtime on SQLite.

It is a foundation, not a production database switch.

## Scope of this milestone

Delivered:

- one central application-migration runner
- explicit KukGit schema version metadata
- actual SQLite schema introspection after every current migration
- PostgreSQL DDL generation for current metadata tables
- foreign-key-safe import ordering
- deterministic per-table NDJSON export
- file checksums, sizes and row counts
- canonical schema and manifest JSON
- hardened bundle verification
- migration inventory, preflight, export, verify and DDL CLI commands
- portability and tamper tests

Not delivered yet:

- a PostgreSQL runtime driver
- asynchronous query adapters
- PostgreSQL-backed application integration tests
- NDJSON import execution
- dual-write or dual-read validation
- a production cutover command
- automatic rollback from PostgreSQL to SQLite

Do not point production KukGit at PostgreSQL using this foundation alone.

## Why the migration is phased

KukGit currently has more than 30 production modules using synchronous calls such as:

```text
db.prepare(...).get(...)
db.prepare(...).all(...)
db.prepare(...).run(...)
db.exec(...)
```

Repository access, Git authorization, lifecycle, reviews, notifications, webhooks, backups, SSH and Git LFS all depend on those semantics. SQLite-specific behavior also includes:

- `BEGIN IMMEDIATE`
- `PRAGMA` schema and integrity operations
- SQLite date functions
- synchronous backup snapshots
- filesystem-coupled disaster recovery

Replacing the driver before migrating and testing each query path would create unacceptable authorization and recovery risk.

## Central migration lifecycle

`src/migrations.mjs` defines two phases:

### Before local-development seed

```text
migrateApplicationSchema(db)
```

This creates and upgrades all product tables required before optional local seeding.

### After seed or central identity bootstrap

```text
migratePostSeedSchema(db)
```

This runs notification preference backfills and records the active schema version.

The schema-version row is updated only when the version changes. Server restarts and repeated preflight runs therefore do not mutate migration metadata unnecessarily.

Current schema version:

```text
2026.07.27.1
```

## CLI commands

### Inventory

```bash
npm run db:postgres -- inventory
```

Prints:

- schema version
- total tables and rows
- foreign-key-safe import order
- dependency cycles
- per-table row, column, foreign-key and index counts
- names of columns requiring sensitive-data handling

It does not print row values.

### Preflight

```bash
npm run db:postgres -- preflight
```

Adds PostgreSQL compatibility errors and warnings to the inventory report.

A non-compatible schema returns exit code `2`. Warnings require operator review but do not automatically block bundle creation.

### Export

```bash
npm run db:postgres -- export \
  --out /secure/migrations/kukgit-2026-07-27
```

An optional deterministic timestamp may be supplied:

```bash
npm run db:postgres -- export \
  --out /secure/migrations/kukgit-2026-07-27 \
  --created-at 2026-07-27T00:00:00.000Z
```

`--created-at` is parsed and normalized as an ISO timestamp. Invalid timestamps are rejected before a default output path is constructed.

The destination must not already exist. KukGit writes to a private temporary directory and atomically renames it only after the export completes.

### Verify

```bash
npm run db:postgres -- verify \
  --bundle /secure/migrations/kukgit-2026-07-27
```

Verification checks:

- bundle format and version
- manifest checksum
- canonical JSON encoding
- every file SHA-256 and byte size
- every NDJSON row parses as JSON
- per-table and total row counts
- regular-file types only
- no symbolic links anywhere in the bundle

### Generate DDL only

```bash
npm run db:postgres -- ddl \
  --out /secure/migrations/kukgit-schema.sql
```

The output file must not already exist.

## Bundle layout

```text
kukgit-2026-07-27/
├── manifest.json
├── manifest.sha256
├── schema.json
├── postgresql.sql
└── tables/
    ├── users.ndjson
    ├── organizations.ndjson
    ├── repositories.ndjson
    └── ... one file per metadata table
```

### `schema.json`

Contains the authoritative migrated SQLite structure:

- columns and declared types
- defaults and nullability
- primary keys
- foreign keys and referential actions
- indexes and partial-index predicates
- check expressions
- row counts
- import order
- compatibility warnings
- sensitive-column names

### `postgresql.sql`

Contains generated PostgreSQL DDL:

- `kukgit` schema creation
- all current metadata tables
- primary and unique constraints
- check constraints
- foreign keys after table creation
- ordinary, unique and partial indexes

The generated DDL is a review artifact. It has not yet been executed by the KukGit runtime or an automated importer. Review every compatibility warning before using it against a PostgreSQL instance.

### Table NDJSON

Each line is one row with columns emitted in schema order. Rows are sorted by primary key; tables without a primary key fall back to all columns.

Special values:

```json
{"$binary":"<base64>"}
```

represents binary data, and:

```json
{"$integer":"<decimal string>"}
```

represents integers that cannot safely pass through ordinary JSON number handling.

A future importer must decode those tagged values explicitly.

## What is and is not exported

Exported:

- all SQLite metadata tables
- users and organization relationships
- repository metadata
- issues, pull requests and review data
- access grants and invitations
- PAT hashes and SSH-key metadata
- encrypted AuthKit bridge tokens
- notification and email outbox records
- webhook metadata and encrypted secrets
- backup metadata
- Git LFS object metadata and repository associations

Not exported by this bundle:

- bare Git repository objects under `KUKGIT_DATA_DIR/repos`
- Git LFS object bytes under `KUKGIT_LFS_DIR`
- verified `.kgbak` archives under `KUKGIT_BACKUPS_DIR`

Those storage planes require a separate synchronized transfer and verification step during final cutover.

## Confidentiality and integrity

The migration bundle is highly sensitive.

Although many credential fields contain hashes or encrypted ciphertext, the bundle may also contain:

- user email addresses
- audit metadata
- notification bodies
- email outbox bodies
- invitation links already stored in email records
- repository and organization names
- SSH public keys
- access-token prefixes

Store the bundle in encrypted storage with tightly restricted access. Do not upload it to a repository, issue, chat, public object bucket or ordinary shared drive.

Recommended directory permissions:

```text
bundle directory: 0700
bundle files:     0600
```

The SHA-256 files detect corruption and unexpected changes. They are not digital signatures. An attacker who can replace the bundle can also regenerate its checksums. Authenticity therefore depends on protected storage, access logs and an independently recorded manifest hash.

Record the reported `manifestSha256` in a separate deployment record or secrets-controlled change ticket.

## Symbolic-link protection

Verification rejects:

- a symbolic-link bundle root
- symbolic-link subdirectories
- symbolic-link table or manifest files
- non-regular filesystem entries

This prevents an apparently valid bundle from redirecting verification or future import reads outside its root.

## Production export procedure

### 1. Preflight before the maintenance window

```bash
npm run doctor
npm run db:postgres -- inventory
npm run db:postgres -- preflight
```

Resolve compatibility errors. Document every warning.

### 2. Create a verified backup

```bash
npm run backup -- maintenance on --reason "PostgreSQL migration export"
npm run backup -- create
npm run backup -- list
npm run backup -- verify --archive <snapshot.kgbak>
```

Keep maintenance mode enabled through metadata export so table rows cannot change while files are being written.

### 3. Export and verify

```bash
npm run db:postgres -- export --out /secure/migrations/kukgit-cutover
npm run db:postgres -- verify --bundle /secure/migrations/kukgit-cutover
```

Record:

- schema version
- table count
- total row count
- manifest SHA-256
- compatibility warnings
- backup archive name and checksum

### 4. Resume SQLite service when no cutover follows

```bash
npm run backup -- maintenance off
```

This foundation can be used repeatedly for migration rehearsals without changing the runtime database.

## Generated compatibility warnings

Examples include:

```text
TABLE_WITHOUT_PRIMARY_KEY
SQLITE_WITHOUT_ROWID
SQLITE_NOCASE_COLLATION
DEFAULT_REQUIRES_REVIEW
FOREIGN_KEY_DEPENDENCY_CYCLE
```

Blocking errors include missing foreign-key targets and unsupported expression indexes.

A warning does not mean the schema is safe without review. For example, an omitted SQLite-specific default may require an equivalent PostgreSQL trigger, generated value or application-side write.

## Planned runtime migration phases

### Phase A — asynchronous database contract

- define a database interface independent of SQLite statement objects
- migrate authorization-critical reads first
- preserve transaction boundaries explicitly
- add query-level tests for SQLite and PostgreSQL

### Phase B — PostgreSQL adapter and importer

- add a supported PostgreSQL driver
- implement parameterized queries and transactions
- import NDJSON in manifest order
- decode binary and large-integer tags
- reset identity sequences after import
- validate foreign keys and row counts

### Phase C — dual-system rehearsal

- restore a recent verified backup into an isolated environment
- export the migration bundle
- import into PostgreSQL
- run full application and Git transport tests
- compare authorization and aggregate query results
- test backup and disaster recovery against the new metadata engine

### Phase D — controlled production cutover

- enter maintenance mode
- create and verify the final SQLite backup
- create and verify the final migration bundle
- transfer Git and LFS storage consistently
- import into PostgreSQL
- run row-count, foreign-key and application smoke checks
- switch the runtime only after all gates pass

### Phase E — rollback window

- retain the final SQLite database and verified backup read-only
- prevent writes to both engines simultaneously without a defined dual-write protocol
- document the rollback decision window
- archive the old SQLite source only after stable PostgreSQL operation

## Rollback boundary

This foundation changes only schema management and export tooling. The live runtime remains SQLite, so rollback is the ordinary application rollback:

1. stop KukGit if required
2. deploy the previous application image
3. retain the new schema metadata table; it does not interfere with older product data
4. restore a verified `.kgbak` snapshot only when the SQLite database itself was damaged

Do not delete generated bundles until the migration rehearsal or change record is formally closed.

## Important error codes

```text
DB_PORTABILITY_IDENTIFIER_UNSUPPORTED
DB_PORTABILITY_TOO_MANY_TABLES
DB_PORTABILITY_TOO_MANY_COLUMNS
POSTGRES_SCHEMA_INCOMPATIBLE
DB_EXPORT_CONCURRENT_CHANGE
DB_BUNDLE_DESTINATION_EXISTS
DB_BUNDLE_PATH_ESCAPE
DB_BUNDLE_MANIFEST_MISSING
DB_BUNDLE_MANIFEST_CORRUPT
DB_BUNDLE_CHECKSUM_MISMATCH
DB_BUNDLE_ROW_COUNT_MISMATCH
DB_BUNDLE_TOTAL_ROWS_MISMATCH
DB_BUNDLE_SYMLINK_UNSUPPORTED
DB_BUNDLE_FILE_TYPE_UNSUPPORTED
```

## Automated coverage

Tests verify:

- full current schema inventory
- stable schema-version metadata across repeated migration runs
- foreign-key-safe table ordering
- PostgreSQL DDL coverage for every table
- absence of SQLite runtime statements in generated DDL
- deterministic repeated exports
- canonical schema and manifest JSON
- sensitive-column metadata without secret values in the manifest
- table and manifest checksum failures
- row-count verification
- destination-collision rejection
- symbolic-link substitution rejection
