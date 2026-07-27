# PostgreSQL Runtime Shadow Verification — Stage 5

Stage 5 verifies selected KukGit metadata reads against PostgreSQL while the live application continues to serve every authoritative result from SQLite.

This stage does **not** enable PostgreSQL runtime, write to PostgreSQL, dual-write, change user-visible responses or perform cutover.

## Safety boundary

During a shadow run:

- `KUKGIT_DATABASE_DRIVER` must remain `sqlite`;
- the operator confirms the exact current SQLite manifest fingerprint;
- SQLite queries produce the authoritative result;
- PostgreSQL receives equivalent parameterized `SELECT` queries only;
- PostgreSQL runs inside `REPEATABLE READ READ ONLY`;
- mismatches and PostgreSQL errors are evidence, not application responses;
- the transaction is rolled back and the connection is closed;
- runtime cutover remains blocked by the existing database-selection guard.

## Why this stage exists

Stages 1–4 proved export, import, schema translation, checksums and offline recovery. Stage 5 tests the smaller set of metadata reads that the live application depends on most:

- authentication and browser sessions;
- personal access tokens;
- organization access;
- repository lookup;
- direct and team repository permissions.

A successful import is necessary but not sufficient. Runtime parity also requires equivalent column aliases, null behavior, timestamps, integers, booleans and deterministic row ordering.

## Runtime surface inventory

Generate a source-level inventory:

```bash
npm run database:postgresql-shadow -- surface
```

Default output:

```text
data/database-migration/postgresql-shadow/database-runtime-surface.json
```

The inventory records:

- relative source file and line;
- `prepare`, `exec` or `transaction` use;
- read, write, DDL, transaction or unknown classification;
- static SQL fingerprint;
- portability findings;
- a bounded SQL preview for code-review purposes.

Absolute source roots are removed from safe evidence. Dynamic/interpolated SQL is identified but is never admitted automatically into the runtime read catalog.

## Curated read catalog

`src/runtime-read-catalog.mjs` is the only shadow-read allowlist.

Each entry has:

- a stable operation ID;
- `one` or `many` result shape;
- fixed named parameters;
- static SQLite `SELECT` SQL;
- compiled PostgreSQL `$1...` SQL;
- a bounded SQLite sample query;
- explicit sample-to-parameter mapping.

The compiler rejects comments, multiple statements, unknown operations and placeholder-count mismatches. The PostgreSQL adapter independently rejects non-`SELECT` statements.

Adding a catalog entry requires tests for parameter mapping, result order and privacy.

## PostgreSQL account

Use a dedicated shadow-verification account. It needs:

- `CONNECT` to the database;
- `USAGE` on the configured schema;
- `SELECT` on the imported tables used by the catalog.

It does not need:

- `CREATE` on the schema;
- `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE` or DDL rights;
- KukGit's migration advisory lock;
- ownership of imported tables.

Example policy, adapted by the database administrator:

```sql
GRANT CONNECT ON DATABASE kukgit TO kukgit_shadow;
GRANT USAGE ON SCHEMA kukgit_migration TO kukgit_shadow;
GRANT SELECT ON ALL TABLES IN SCHEMA kukgit_migration TO kukgit_shadow;
ALTER DEFAULT PRIVILEGES IN SCHEMA kukgit_migration
  GRANT SELECT ON TABLES TO kukgit_shadow;
```

Prefer `verify-full` TLS with a trusted CA.

## Configuration

```text
KUKGIT_DATABASE_DRIVER=sqlite
KUKGIT_DATABASE_URL=postgresql://shadow_user:secret@db.example.com:5432/kukgit
KUKGIT_POSTGRESQL_SCHEMA=kukgit_migration
KUKGIT_POSTGRESQL_SSL_MODE=verify-full
KUKGIT_POSTGRESQL_SSL_CA=/run/secrets/postgresql-ca.pem

KUKGIT_POSTGRESQL_SHADOW_ENABLED=true
KUKGIT_POSTGRESQL_SHADOW_OUTPUT_DIR=./data/database-migration/postgresql-shadow
KUKGIT_POSTGRESQL_SHADOW_SAMPLE_LIMIT=10
KUKGIT_POSTGRESQL_SHADOW_READ_TIMEOUT_MS=5000
```

Bounds:

- sample limit: 1–100 per catalog operation;
- per-read timeout: 100–60,000 milliseconds.

Run `npm run doctor` before verification. The doctor validates SQLite authority, output-directory access, sample/timeout bounds and PostgreSQL connection policy.

## Confirm the SQLite source

Create or inspect the current manifest:

```bash
npm run database -- manifest
```

Copy the exact `fingerprint`. The verifier recomputes the live manifest immediately before connecting. It stops when:

- the confirmation differs;
- SQLite changed after the manifest was created;
- foreign-key verification fails;
- runtime is not SQLite.

## Run verification

```bash
npm run database:postgresql-shadow -- verify \
  --confirm <exact-sqlite-fingerprint> \
  --operator "verified.operator@kuklabs.com" \
  --sample-limit 10 \
  --timeout-ms 5000 \
  --progress
```

Limit a diagnostic run to specific operations:

```bash
npm run database:postgresql-shadow -- verify \
  --confirm <exact-sqlite-fingerprint> \
  --operator "verified.operator@kuklabs.com" \
  --ids organizations.access_by_slug_and_user,repositories.by_slug
```

`--enable` may be used as an explicit CLI opt-in instead of the environment flag.

## Evidence

Default files:

```text
postgresql-shadow-state.json
postgresql-shadow-report.json
```

Both are atomically replaced and set to mode `0600`. The containing directory is created with mode `0700` where supported.

Evidence contains:

- operation IDs;
- matched, mismatched, skipped and error counts;
- source/target row counts;
- SHA-256 result fingerprints;
- safe error codes and optional SQLSTATE;
- source manifest fingerprint;
- report fingerprint;
- sample limit and timeout;
- redacted PostgreSQL URL, schema, TLS mode and server version;
- explicit no-cutover boundary.

Evidence does not contain:

- sampled parameters;
- email addresses or token hashes read from rows;
- passwords or password hashes;
- access or refresh tokens;
- PostgreSQL credentials;
- raw database-driver error messages;
- row bodies.

The operator field is intentionally retained for accountability. Use a verified work identity, not a credential or secret.

## Status

```bash
npm run database:postgresql-shadow -- status
```

Status prints a bounded summary of the state and report files. It exits non-zero when the latest evidence failed.

## Result interpretation

### `verified`

Every sampled operation matched or had no sample rows. This is useful Stage 5 evidence but is not authorization for runtime cutover.

### `failed` with mismatches

SQLite and PostgreSQL returned different canonical results. Review:

- aliases and column names;
- timestamp representation;
- integer/bigint conversion;
- boolean normalization;
- null behavior;
- row ordering;
- imported target freshness.

Do not change the application runtime.

### `failed` with sample errors

The target read timed out or PostgreSQL returned a safe error code. Check grants, schema, target availability, connection policy and imported table state.

### `skipped`

The source had no rows for that operation's bounded sample query. A skipped operation is not evidence of parity. Populate a representative staging copy before relying on the report.

## Timeout behavior

The verifier applies an application-level per-read timeout. The node-postgres connection also retains its configured query and statement timeouts.

An application timeout records a safe error and stops waiting for that sample. The enclosing read-only transaction is rolled back at the end. Database administrators should keep server-side statement timeouts no longer than the operational shadow window.

## Rollback and incident response

Shadow verification has no data rollback because it performs no writes.

To stop it:

1. interrupt the CLI;
2. confirm the state file is `cancelled` or `failed`;
3. confirm PostgreSQL shows no long-running shadow transaction;
4. set `KUKGIT_POSTGRESQL_SHADOW_ENABLED=false`;
5. retain mode-0600 evidence for investigation.

The application continues using SQLite throughout.

## Cutover prohibition

A `verified` Stage 5 report does not modify:

```text
KUKGIT_DATABASE_DRIVER=sqlite
```

Production PostgreSQL runtime requires later stages for driver-neutral write paths, dual-run validation, maintenance/cutover orchestration, rollback evidence and explicit approval. The current runtime guard continues to reject PostgreSQL selection.
