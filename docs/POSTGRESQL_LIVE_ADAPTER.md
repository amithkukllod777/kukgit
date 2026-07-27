# Guarded PostgreSQL Live Migration Adapter

This document covers KukGit PostgreSQL migration **Stage 4**. Stage 4 adds an offline PostgreSQL adapter and guarded import command. The KukGit application runtime still uses SQLite; runtime cutover, dual reads and PostgreSQL-aware backup/restore remain disabled.

## Dependency and transaction model

KukGit pins `pg` to version `8.22.0`. The migration uses one dedicated `Client` for connection validation, advisory locking, transaction begin, schema creation, parameterized inserts, cursor scans, verification, commit and rollback. A pool is deliberately not used for migration transactions.

## Prepare a dedicated target

Use a separate empty database or a dedicated empty schema. Do not import into the PostgreSQL `public` schema unless the explicit public-schema override is approved. The migration role should have only the access required for the target database and schema.

Example setup, executed by a PostgreSQL administrator:

```sql
CREATE ROLE kukgit_migration LOGIN PASSWORD '<store-outside-shell-history>';
CREATE SCHEMA kukgit_migration AUTHORIZATION kukgit_migration;
GRANT CONNECT ON DATABASE kukgit TO kukgit_migration;
GRANT USAGE, CREATE ON SCHEMA kukgit_migration TO kukgit_migration;
```

The target schema must contain zero base tables. The adapter also acquires a session advisory lock scoped to the migration schema so that two KukGit imports cannot run concurrently.

## TLS configuration

Verified TLS is the default:

```dotenv
KUKGIT_POSTGRESQL_SSL_MODE=verify-full
KUKGIT_POSTGRESQL_SSL_CA=/run/secrets/postgresql-ca.pem
```

Optional mutual TLS:

```dotenv
KUKGIT_POSTGRESQL_SSL_CERT=/run/secrets/postgresql-client.pem
KUKGIT_POSTGRESQL_SSL_KEY=/run/secrets/postgresql-client-key.pem
```

Do not place `sslmode`, `sslcert`, `sslkey` or `sslrootcert` in `KUKGIT_DATABASE_URL`; KukGit rejects those parameters so connection-string options cannot override the explicit TLS policy.

`require` mode disables certificate verification and therefore requires `KUKGIT_POSTGRESQL_ALLOW_UNVERIFIED_TLS=true`. Unencrypted transport requires both `KUKGIT_POSTGRESQL_SSL_MODE=disable` and `KUKGIT_POSTGRESQL_ALLOW_INSECURE=true`. Neither override is approved for normal production migration.

## Create and verify the SQLite export

```bash
npm run database -- export \
  --output ./data/database-migration/kukgit-metadata.kgdb.json

npm run database -- verify-export \
  --input ./data/database-migration/kukgit-metadata.kgdb.json
```

Record the exact source fingerprint printed by the verification command. The protected export contains complete KukGit metadata and must be handled like a production database backup.

## Enable one offline import

Keep the application runtime on SQLite:

```dotenv
KUKGIT_DATABASE_DRIVER=sqlite
KUKGIT_POSTGRESQL_IMPORT_ENABLED=true
KUKGIT_DATABASE_URL=postgresql://kukgit_migration:<password>@db.example.com:5432/kukgit
KUKGIT_POSTGRESQL_SCHEMA=kukgit_migration
```

Run the import with the exact source fingerprint:

```bash
npm run database:postgresql-import -- \
  --input ./data/database-migration/kukgit-metadata.kgdb.json \
  --confirm <exact-source-fingerprint> \
  --operator support@kuklabs.com \
  --output-directory ./data/database-migration/postgresql-live-import
```

Disable `KUKGIT_POSTGRESQL_IMPORT_ENABLED` immediately after the operation.

## Execution guarantees

The command performs the following sequence:

1. Verify explicit enablement, SQLite runtime mode and exact source fingerprint.
2. Create a mode-`0700` evidence directory and mode-`0600` state journal.
3. Validate the PostgreSQL schema and migration role privileges.
4. Acquire the schema advisory lock.
5. Confirm the target has no base tables.
6. Start one serializable transaction on the same dedicated client.
7. Set an isolated local search path and bounded transaction timeout.
8. Create dependency-ordered tables and run parameterized insert batches.
9. Scan target rows through bounded cursors.
10. Compare table sets, row counts and deterministic checksums before commit.
11. Commit only after exact verification.

Pre-commit query, state-journal, cancellation, cursor or verification failures cause rollback. Progress and report data never contain row values, credentials, SQL parameter values or raw driver errors.

## Evidence artifacts

The output directory contains:

- `postgresql-offline-import-state.json`
- `postgresql-target-snapshot.json`
- `postgresql-execution-report.json`
- `postgresql-import-receipt.json`

Artifacts contain counts, statuses and fingerprints only. The state journal is updated throughout the operation. Post-commit close or artifact-write failures are reported as warnings instead of falsely claiming that the database rolled back.

## Ambiguous commit incident

A network failure while waiting for the PostgreSQL `COMMIT` response may leave the transaction outcome unknown. Do not automatically retry the import. Keep KukGit runtime on SQLite, stop migration activity, inspect the target schema from an independent administrative session, collect a target snapshot, compare it with the source fingerprint and determine whether the transaction committed. Recreate the dedicated target schema before any clean retry.

## Deliberately not enabled

Stage 4 does not enable:

- PostgreSQL as the KukGit application runtime
- automatic readiness/cutover marker creation
- dual reads or dual writes
- incremental replication
- secondary index and trigger migration
- PostgreSQL metadata backups or restore
- automatic retry after an ambiguous commit
- production cutover or rollback commands

Issue #43 remains open until those stages are implemented and validated.
