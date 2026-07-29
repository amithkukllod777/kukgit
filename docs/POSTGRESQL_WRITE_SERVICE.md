# PostgreSQL Stage 7 — Runtime Write Service Foundation

Status: private-alpha migration foundation

Tracking:

- Parent: [#43 — PostgreSQL-compatible data layer and migration tooling](https://github.com/amithkukllod777/kukgit/issues/43)
- Stage: [#68 — driver-neutral write service and integration CI foundation](https://github.com/amithkukllod777/kukgit/issues/68)

## Purpose

Stage 7 prepares KukGit metadata writes for a future PostgreSQL runtime without changing the live database authority.

The production application still requires:

```text
KUKGIT_DATABASE_DRIVER=sqlite
```

This stage does **not** introduce PostgreSQL production writes, dual-write, request-result substitution, automatic cutover or PostgreSQL restore.

## Delivered boundary

Stage 7 introduces four controlled pieces:

1. A privacy-safe inventory of direct metadata writes and transaction boundaries.
2. A named, validated write catalog with SQLite and PostgreSQL SQL forms.
3. A driver-neutral write/transaction service contract.
4. A disposable PostgreSQL integration CI job for compatibility evidence.

The first migrated live write is the append-only `audit_logs.insert` operation. Existing callers still invoke the synchronous `audit()` helper and receive the same audit ID immediately.

## Runtime authority

### SQLite

SQLite remains the authoritative runtime. The registered SQLite write service is synchronous because existing KukGit request handlers and module APIs are synchronous.

```text
caller
  -> audit()
  -> runRuntimeWrite()
  -> registered SQLite write service
  -> SQLite transaction / statement
  -> authoritative result
```

No network call, PostgreSQL observer or background task can alter this result.

### PostgreSQL

The PostgreSQL write service is compatibility-only and asynchronous. It is used only by isolated integration tests or explicit migration tooling.

```text
isolated test/tool
  -> PostgreSQL compatibility write service
  -> explicit SERIALIZABLE transaction
  -> translated parameterized SQL
  -> commit or rollback
```

It is not registered with the live application and cannot become authoritative through a configuration toggle delivered in this stage.

## Managed write catalog

`src/runtime-write-catalog.mjs` owns named write definitions.

Every entry specifies:

- stable operation ID
- operation type: insert, update or delete
- risk classification
- ordered parameter names
- SQLite SQL
- generated PostgreSQL `$1...$n` SQL
- expected affected-row count

Current entry:

```text
audit_logs.insert
```

Catalog validation rejects:

- unknown operation types
- invalid IDs or parameter names
- SQL comments or multiple statements
- SQL whose leading verb disagrees with the declared operation
- placeholder count mismatches
- invalid expected-row counts
- undefined parameter values

Raw SQL is never supplied by request handlers.

## Transaction contract

### SQLite contract

`createRuntimeWriteService({ sqlite })` provides:

```text
write(id, parameters, options)
transaction(work, options)
status()
stop()
```

Rules:

- transaction callbacks remain synchronous
- nested asynchronous work is rejected
- `BEGIN IMMEDIATE`, `COMMIT` and `ROLLBACK` remain controlled by the database helper
- any thrown error rolls back the complete transaction
- cancellation is checked before and after each managed write
- affected-row count must match the catalog contract

### PostgreSQL compatibility contract

`createPostgresqlCompatibilityWriteService({ adapter })` provides the same conceptual operations with asynchronous transactions.

Rules:

- no nested compatibility transaction
- every write requires an active explicit transaction
- commit happens only after the callback completes and cancellation is rechecked
- every failure attempts rollback
- target SQL remains parameterized
- PostgreSQL row counts must match the catalog contract

## Normalized errors

Database-specific failures are normalized before reaching a service caller.

| Code | Meaning |
|---|---|
| `RUNTIME_WRITE_CANCELLED` | Abort signal stopped the operation |
| `RUNTIME_WRITE_CONFLICT` | Unique or primary-key conflict |
| `RUNTIME_WRITE_FOREIGN_KEY` | Missing/protected referenced record |
| `RUNTIME_WRITE_CHECK_FAILED` | Check constraint violation |
| `RUNTIME_WRITE_RETRYABLE` | Serialization, deadlock or lock conflict |
| `RUNTIME_WRITE_RESULT_MISMATCH` | Unexpected affected-row count/result shape |
| `RUNTIME_WRITE_FAILED` | Safe generic write failure |

PostgreSQL SQLSTATE may be retained as structured diagnostic metadata, but SQL text, row values and credentials are not included in messages or evidence.

## Migration-history ownership

Stage 7 creates:

```text
kukgit_schema_migrations
```

The table records:

- integer version
- stable migration ID
- SHA-256 definition checksum
- applied timestamp

Current version:

```text
1 — runtime-write-foundation-v1
```

Startup applies the SQLite migration idempotently. The PostgreSQL integration test applies the same ownership contract in its disposable schema.

KukGit fails closed when it detects:

- duplicate migration versions
- a future unknown version
- migration ID mismatch
- checksum mismatch

Migration checksum evidence contains definitions only; it does not contain metadata rows or secrets.

## Write-surface inventory

Generate the current write/transaction inventory:

```bash
npm run database:runtime-write-surface
```

Equivalent command:

```bash
npm run database -- runtime-write-surface
```

Default output:

```text
data/database-migration/runtime-write-surface.json
```

The report includes:

- source/runtime fingerprint
- write-surface fingerprint
- direct and catalog-managed operation counts
- write, transaction, schema and dynamic-call classifications
- append-only, mutable, destructive and review-required risk counts
- source-relative file and line locations
- SQL fingerprints

The safe report excludes:

- SQL previews
- absolute filesystem roots
- SQL parameters
- database rows
- credentials or connection URLs

A changed fingerprint is review evidence, not automatic authorization to migrate more writes.

## First migrated slice: audit logs

`src/db.mjs` keeps the existing function:

```js
audit(db, event)
```

The helper now:

1. creates the same `aud_...` ID
2. serializes the existing metadata object
3. calls `runRuntimeWrite(db, "audit_logs.insert", parameters)`
4. returns the audit ID synchronously

This slice was selected because it is append-only and does not control authentication, authorization, repository visibility or lifecycle state.

Not migrated in Stage 7:

- users or AuthKit identity links
- sessions or refresh-token custody
- personal access tokens
- SSH keys
- organization membership and teams
- repository permissions
- invitations and external-access expiry
- issues and pull requests
- branch governance
- webhook/email queue state
- backups, Git repositories or Git LFS objects

## PostgreSQL integration CI

GitHub Actions runs a dedicated job:

```text
postgresql-write-integration
```

The job starts an isolated PostgreSQL 16 service and creates a random schema for the test. It verifies:

- adapter connection and dedicated-schema policy
- idempotent migration-history creation
- audit insert row shape
- timestamp defaults
- commit behavior
- full rollback after callback failure
- foreign-key enforcement
- unique/primary-key conflict normalization
- cancellation before write
- migration checksum mismatch detection

The schema is dropped after the test. No shared database state or persistent credentials are used.

Local opt-in execution:

```bash
export KUKGIT_TEST_POSTGRES_URL='postgresql://user:password@127.0.0.1:5432/kukgit_test'
node --test --test-reporter=spec test/runtime-write-postgresql.test.mjs
```

Without `KUKGIT_TEST_POSTGRES_URL`, the PostgreSQL-specific test is skipped while all SQLite tests continue normally.

## Rollout and rollback

### Rollout

1. Keep `KUKGIT_DATABASE_DRIVER=sqlite`.
2. Deploy the new build normally.
3. Startup creates/verifies the SQLite migration-history row.
4. Observe normal audit creation and application health.
5. Generate and store the privacy-safe write-surface report as engineering evidence.

### Rollback

The managed audit SQL is equivalent to the former direct insert. A previous application build can continue using the same SQLite database because the new migration-history table is additive and unrelated to existing foreign keys.

Do not delete the migration-history table during application rollback. Its checksum records the schema ownership already applied.

### Incident handling

A checksum mismatch or future migration version is a deployment-blocking condition. Do not edit the history row manually. Stop rollout, preserve the database and compare the running build, migration definition and deployment artifact.

## Stage 8 prerequisites

Before more writes move behind the service:

- review the generated risk inventory
- choose only bounded low-risk slices
- preserve synchronous caller behavior or approve an explicit async API migration
- add both SQLite and PostgreSQL constraint/rollback tests
- document identity and authorization impact
- preserve backup/restore behavior
- maintain SQLite as authority until a separate verified cutover milestone

## Non-goals

This document does not approve:

- PostgreSQL as the live metadata driver
- production PostgreSQL writes
- dual-write or write shadowing
- automatic cutover
- maintenance-window cutover
- PostgreSQL-aware production restore
- moving bare Git repositories
- moving Git LFS objects
- deleting or archiving authoritative SQLite
