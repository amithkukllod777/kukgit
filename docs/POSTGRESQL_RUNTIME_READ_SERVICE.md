# PostgreSQL Stage 6 — Live Read Service and Asynchronous Shadow Sampling

Stage 6 moves selected KukGit metadata reads behind a driver-neutral catalog service while SQLite remains the only authoritative runtime database.

An optional PostgreSQL observer may compare a deterministic sample after the SQLite result has already been produced. It never substitutes a PostgreSQL result, never blocks the caller waiting for PostgreSQL and never writes to PostgreSQL.

## Delivered live reads

The first selected helpers are:

- organization access by organization slug and user ID;
- repository lookup by organization slug and repository slug.

Callers continue using `orgAccess()` and `findRepo()`. Their result shapes and permission behavior remain unchanged.

The service resolves operations through `src/runtime-read-catalog.mjs`. Unknown operation IDs fail closed; no dynamic SQL fallback exists.

## Request path

```text
request
  ↓
runRuntimeRead(...)
  ↓
SQLite catalog SELECT — authoritative synchronous result
  ↓
caller receives the SQLite result
  ↓
setImmediate schedules optional observation
  ↓
PostgreSQL read-only comparison
```

The observer runs outside the authoritative call stack. Synchronous throws and rejected observer promises are isolated and cannot change the SQLite result.

## Stage 5 approval requirement

Stage 6 may start only with:

- a Stage 5 report using `kukgit-postgresql-shadow-read-report/1`;
- report status `verified`;
- the exact 64-character Stage 5 report fingerprint configured as approval;
- SQLite still selected as runtime;
- a sampling key of at least 32 characters.

This binds live sampling to a specific verified imported target rather than whichever PostgreSQL database happens to be configured later.

## Configuration

```text
KUKGIT_DATABASE_DRIVER=sqlite

KUKGIT_POSTGRESQL_RUNTIME_SHADOW_ENABLED=true
KUKGIT_POSTGRESQL_RUNTIME_SHADOW_STAGE5_REPORT=./data/database-migration/postgresql-shadow/postgresql-shadow-report.json
KUKGIT_POSTGRESQL_RUNTIME_SHADOW_APPROVAL=<exact-stage-5-report-fingerprint>
KUKGIT_POSTGRESQL_RUNTIME_SHADOW_STATE_PATH=./data/database-migration/postgresql-runtime-shadow-state.json
KUKGIT_POSTGRESQL_RUNTIME_SHADOW_SAMPLE_RATE=0.05
KUKGIT_POSTGRESQL_RUNTIME_SHADOW_SAMPLING_KEY=<at-least-32-random-characters>
KUKGIT_POSTGRESQL_RUNTIME_SHADOW_MAX_QUEUE=500
KUKGIT_POSTGRESQL_RUNTIME_SHADOW_CONCURRENCY=1
KUKGIT_POSTGRESQL_RUNTIME_SHADOW_READ_TIMEOUT_MS=1500
KUKGIT_POSTGRESQL_RUNTIME_SHADOW_CIRCUIT_ERRORS=5
KUKGIT_POSTGRESQL_RUNTIME_SHADOW_CIRCUIT_COOLDOWN_MS=60000
```

Recommended rollout:

1. start with a 1% sample rate;
2. use one worker;
3. keep a short PostgreSQL read timeout;
4. review match/error/drop metrics;
5. increase gradually only after sustained parity.

A sample rate of `0` records observation eligibility but opens no PostgreSQL connection.

## Deterministic sampling

Sampling uses HMAC-SHA256 over:

- operation ID;
- canonicalized operation parameters;
- a deployment-only sampling key.

This provides stable sampling for the same operation/parameters without writing those values to evidence. The sampling key must be stored in the secret manager and rotated independently from database credentials.

## PostgreSQL transaction model

Each sampled operation runs in a fresh:

```text
REPEATABLE READ READ ONLY
```

transaction. The adapter accepts one parameterized `SELECT` from the catalog and rolls back after comparison.

The dedicated PostgreSQL account requires only:

- database `CONNECT`;
- schema `USAGE`;
- table `SELECT`.

It does not require CREATE, write or ownership permissions.

## Queue and overload

Observation uses a bounded in-memory queue.

When the queue is full:

- the observation is dropped;
- `droppedQueue` increases;
- the authoritative SQLite result remains unchanged;
- the request is not retried or delayed.

Concurrency is limited to 1–4 workers. Higher concurrency should not be enabled until the target and connection pool are sized for it.

## Circuit breaker

Consecutive PostgreSQL errors open a circuit after the configured threshold.

While open:

- new observations are dropped;
- `droppedCircuit` increases;
- no request result changes;
- the circuit remains open until the cooldown expires.

The next eligible observation after cooldown acts as a half-open probe. A successful comparison closes the circuit and resets the consecutive error count.

## Evidence

Default state file:

```text
data/database-migration/postgresql-runtime-shadow-state.json
```

It is atomically replaced and set to mode `0600` where supported. The containing directory is created with mode `0700`.

Stored evidence includes:

- approved Stage 5 report fingerprint;
- sample/queue/concurrency/timeout/circuit policy;
- aggregate observed, sampled, matched, mismatched, error and drop counts;
- per-operation aggregate counts;
- queue depth and active worker count;
- last operation ID, status, row counts and SHA-256 result fingerprints;
- safe error codes;
- the explicit SQLite-authoritative boundary.

Evidence excludes:

- operation parameters;
- user IDs, emails, repository slugs and token hashes read from rows;
- row bodies;
- passwords, access tokens and refresh tokens;
- PostgreSQL credentials;
- raw driver error messages.

## Status

Run:

```bash
node scripts/postgresql-runtime-status.mjs
```

The command prints aggregate state only. It returns non-zero when the observer is enabled but has not started or the circuit is not closed.

Run `npm run doctor` before startup. The database doctor validates:

- SQLite remains authoritative;
- Stage 5 report format and verified status;
- exact approval fingerprint;
- state/report path separation;
- sampling key and bounded policy values;
- PostgreSQL TLS/schema configuration.

## Shutdown

KukGit stops accepting new HTTP connections, then drains the observer for a bounded period. Remaining queued observations are dropped and counted. Worker adapters are closed before SQLite is closed.

A hard process-exit timeout prevents shutdown from hanging indefinitely.

## Mismatch response

A mismatch records aggregate fingerprints and counts only. It does not fail the request.

Investigate:

- target import freshness;
- aliases and column casing;
- timestamp and integer conversion;
- null behavior;
- deterministic ordering;
- Stage 5 report/database mismatch.

Disable Stage 6 immediately when mismatch volume is unexpected:

```text
KUKGIT_POSTGRESQL_RUNTIME_SHADOW_ENABLED=false
```

Restart KukGit. SQLite behavior remains unchanged.

## Prohibited actions

Stage 6 does not authorize:

- `KUKGIT_DATABASE_DRIVER=postgresql`;
- PostgreSQL writes or dual-write;
- PostgreSQL-backed sessions, PATs, organizations or repository mutations;
- cutover or rollback automation;
- backend-aware backup changes.

Those require later stages with write-path abstraction, consistency guarantees, maintenance orchestration and explicit cutover approval.
