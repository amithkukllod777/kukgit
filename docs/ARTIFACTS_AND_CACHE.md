# KukGit Build Artifacts and Cache

Where the bytes a build produces are kept, who may read them, and why a cache is
the more dangerous of the two.

## The distinction

An **artifact** is evidence. A test report, a coverage file, a signed binary —
something a person may be about to download to decide whether a change is good.

A **cache** is an optimisation. A dependency tree, a compiler output directory —
something a build restores to go faster, and can always rebuild without.

That difference decides everything below, including what happens when the quota
runs out and who is allowed to write one.

## Two credentials

| | Credential | Routes |
| --- | --- | --- |
| **Runner** | job token (`Authorization: Bearer …`) | `/api/workflow-jobs/self/*` |
| **Reader** | session + repository permission | `/api/workflow-runs/:org/:repo/*` |

Every runner route is `self`. There is no repository, run, job or ref anywhere in
a write request — the job token decides all four. A job cannot name another
repository's storage because there is no parameter in which to name it.

### Runner

```text
POST /api/workflow-jobs/self/artifacts    X-Artifact-Name: <name>   body: raw bytes
POST /api/workflow-jobs/self/cache        X-Cache-Key: <key>        body: raw bytes
GET  /api/workflow-jobs/self/cache?key=<key>&restoreKey=<prefix>…   → raw bytes
```

`X-Artifact-Retention-Days` is optional and clamped to the instance maximum.

### Reader

```text
GET    /api/workflow-runs/:org/:repo/:runId/artifacts               metadata only
GET    /api/workflow-runs/:org/:repo/:runId/artifacts/:artifactId   the bytes
DELETE /api/workflow-runs/:org/:repo/:runId/artifacts/:artifactId   free the space
GET    /api/repositories/:org/:repo/ci-storage                      usage vs quota
```

Reading needs repository **read**. Deleting destroys evidence a run produced, so
it needs **write** and a same-origin request.

A run is addressed *through* its repository and must actually belong to it. A
caller who could pass a foreign run id into a path for a repository they do have
access to would turn read access on one repository into read access on all of
them.

Downloads are served as `application/octet-stream` with `nosniff`. A build can
write any bytes it likes, and serving them as something a browser will interpret
would make an artifact upload a way to host content on the instance's own origin.

## Storage

Content is addressed by its SHA-256. Two runs that produce identical bytes share
one file on disk, and the row that points at it is what carries the name, the
run, the ref and the retention.

This matters more for CI than anywhere else: the same dependency cache is written
by every branch, so storing it once per branch would multiply the quota by the
number of branches rather than by the amount of distinct content.

Blobs are deleted by reference count, never by age. A blob shared between a live
artifact and an expired one has to survive the expiry, and content-addressed
storage makes that sharing invisible to whoever deleted the expired row.

Bytes land in `<dataDir>/ci/blobs/<aa>/<bb>/<digest>`, written under a temporary
name and renamed, so a reader never sees a partial file under a digest that
promises complete content.

## Quotas behave differently on purpose

**Artifacts refuse.** At the quota an upload fails with `507` and
`ARTIFACT_QUOTA_EXCEEDED`. Evicting an old artifact to make room for a new one
would delete evidence nobody asked to delete. Somebody frees the space
deliberately — that is what `DELETE` is for — or retention expires it.

**Caches evict.** At the quota the least recently *used* entry is removed until
the repository fits. Losing a cache costs a slower build and nothing else.

Least recently *used*, not oldest: an old cache that every build still restores
is the most valuable one there is.

Per-object uploads are capped well below the quota because they are buffered in
memory before they are hashed. That ceiling is a memory budget, not a storage
one; raising it means moving to a streaming hash first.

## Cache keys

A key is an opaque label the workflow composes, usually from a lockfile hash.
Letters, numbers, dots, underscores, colons, slashes and hyphens are allowed. The
key never becomes a path — content is addressed by digest — so path separators in
a key are harmless.

Lookup order:

1. the exact key on this run's ref
2. each restore key as a prefix on this run's ref
3. the same two, on the repository's default branch

Restore keys are matched with `LIKE`, and `%`, `_` and `\` are escaped before the
pattern is built. `_` is legal in a key and is also SQL's single-character
wildcard, so an unescaped restore key would quietly match a family it was never
meant to reach.

A second write under an existing key is **kept, not overwritten**. A key is
supposed to describe its own contents, so a second write under the same key means
the key is wrong; overwriting would hide that while handing later runs something
they did not ask for.

## Cache poisoning

This is the control worth reading twice.

**A run may only write a cache for its own ref.** The ref comes from the run
record, never from the request. Without this, anyone who could open a pull
request could write a cache that the default branch's next build would restore
and execute.

**A fork pull request may not write a cache at all.** Its ref is a branch name in
somebody else's repository, and two forks can pick the same name — so a fork
write would let one contributor hand another contributor's build content it never
produced.

**Reading across refs stays open.** A branch may read the default branch's cache,
and so may a fork. That is what makes a cache useful on a branch that has never
built before, and it is the safe direction: reading cannot change what anyone
else's build will run.

## Retention

Artifacts expire on a per-artifact deadline, defaulting to 30 days and capped at
90. An hourly worker deletes expired rows and then sweeps unreferenced blobs.
Hourly because retention is measured in days — a sweep that ran more often would
only add load to the instance the runners are already reporting to.

Caches have no expiry. They are removed by eviction when the repository exceeds
its quota, which is the only pressure that matters for content whose whole
purpose is to be reused.

## Migration and rollback

`migrateWorkflowStorage(db)` creates `workflow_blobs`, `workflow_artifacts` and
`workflow_caches` with `CREATE TABLE IF NOT EXISTS`. It adds no column to an
existing table and rewrites no row, so an instance that runs it and is then
rolled back to an earlier build keeps working — the three tables are simply
unread.

To roll back and reclaim the disk: stop the instance, drop the three tables, and
remove `<dataDir>/ci/blobs`. Nothing else references either.

## Related

- [Build Logs](BUILD_LOGS.md) — the other half of the runner surface
- [Workflow Runs](WORKFLOW_RUNS.md) — where a job token comes from
- [Self-hosted Runners](SELF_HOSTED_RUNNERS.md) — what holds the token
- [Secrets Vault](SECRETS_VAULT.md) — why a fork gets none of them
