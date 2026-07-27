# PostgreSQL Executor Contract

This document covers KukGit PostgreSQL migration **Stage 3**. It defines the transaction and target-collection contract a future live PostgreSQL adapter must satisfy. It does not provide a network driver, production command, runtime database switch or cutover.

## Adapter interface

The executor accepts an adapter with these asynchronous methods:

- `listUserTables()` — return user-table names visible in the target schema
- `begin()` — start the import transaction
- `query(sql, values)` — execute one generated DDL or parameterized insert statement
- `commit()` — commit only after target checksum verification succeeds
- `rollback()` — roll back every schema and data change after a pre-commit failure
- `scanTable(name, columns, options)` — return an async iterable of rows or row batches for checksum collection

The caller owns adapter connection creation and disposal. Connection strings, credentials and TLS state must never be included in adapter errors, progress events or execution reports.

## Transaction guarantees

The executor performs this sequence:

1. Validate source manifest and import-plan consistency.
2. Confirm the target has zero user tables.
3. Begin one transaction.
4. Set the transaction time zone to UTC.
5. Create dependency-ordered tables.
6. Execute parameterized row batches.
7. Scan every target table inside the same transaction.
8. Compare target table set, row counts and deterministic row checksums with the SQLite source manifest.
9. Commit only after exact verification.

Query errors, cancellation, progress-checkpoint failures, target-scan failures and checksum differences trigger rollback. A rollback error is attached to the original failure without replacing it.

A progress callback failure after `commit()` is treated as a warning, not an import failure. Once the database commits, KukGit must not report that the import rolled back. Conversely, a database driver may encounter an ambiguous network outcome while sending `COMMIT`; the future live adapter and operator runbook must treat that as an incident requiring target inspection rather than assuming either success or rollback.

## SQL controls

The executor accepts only:

- a single generated `CREATE TABLE` statement whose parsed table name matches the schema plan
- a single generated `INSERT INTO` statement whose parsed table name matches the operation
- sequential positional parameters from `$1` through the exact value count

SQL comments and multiple statements are rejected. The configurable parameter safety limit may not exceed 65,535 and defaults to 60,000.

## Target normalization

The target collector validates exact source column names and canonicalizes common driver representations before checksumming:

- PostgreSQL `BIGINT` strings are converted to safe JavaScript integers where possible
- larger integer strings remain bigint values
- numeric strings for SQLite real/numeric affinity are converted to finite numbers
- `BYTEA`/blob values remain binary
- `Date` values are converted to ISO strings

Adapters should still configure deterministic type parsers. The collector is a verification safety net, not a replacement for explicit driver configuration.

## Progress events

Progress callbacks receive only bounded operational metadata:

- phase
- table name
- batch number
- row count
- completed and total operation counts
- source/target fingerprints where applicable
- timestamp

They never receive SQL values, raw rows, passwords, tokens, encrypted credentials or connection details. Progress callback failures before commit abort and roll back the import because durable operator evidence is part of the safety gate. Post-commit callback failure is returned as a warning code.

## Target snapshot

The target collector emits:

- engine and format identifiers
- source fingerprint
- table and total-row counts
- per-table row counts and SHA-256 row checksums
- an overall target fingerprint

The collector currently canonicalizes and sorts each table's rows in memory. This is acceptable for contract validation but not approved for very large production metadata databases. A future live adapter must add bounded external sorting or server-assisted deterministic checksums before large-scale migration.

## Deliberately not included

Stage 3 does not include:

- PostgreSQL package/client selection
- connection pooling or TLS configuration
- live schema or import CLI execution
- target-schema namespace management
- secondary index or trigger installation
- durable migration-job persistence
- automatic retry after ambiguous commit
- dual-read or dual-write runtime behavior
- PostgreSQL-aware backup and restore
- cutover or rollback commands

Keep `KUKGIT_DATABASE_DRIVER=sqlite`. The server and doctor continue to fail closed when PostgreSQL runtime is selected.
