# KukGit Build Logs and Live Status

How a runner reports what a job is doing, how a person watches it, and how a run
is stopped.

## Two sides

| | Credential | Routes |
| --- | --- | --- |
| **Runner** | job token (`Authorization: Bearer …`) | `/api/workflow-jobs/self/*` |
| **Reader** | session + repository permission | `/api/workflow-runs/:org/:repo/*` |

The runner routes are all `self`. A job token identifies exactly one job, and
there is no job id in the path — so a runner cannot name another job, correctly
or otherwise. That is one fewer authorization check to get wrong.

## Runner

```text
POST /api/workflow-jobs/self/logs        {"chunks": [{"stream":"stdout","content":"…"}]}
POST /api/workflow-jobs/self/heartbeat   → {"cancelled": false, "heartbeatIntervalSeconds": 60}
POST /api/workflow-jobs/self/complete    {"status": "success" | "failure" | "cancelled"}
```

`complete` destroys the job token in the same statement that records the outcome.
Anything the runner sends afterwards is refused.

## Reader

```text
GET  /api/workflow-runs/:org/:repo/:runId                       run + every job
GET  /api/workflow-runs/:org/:repo/:runId/jobs/:jobId/logs      a page of the log
POST /api/workflow-runs/:org/:repo/:runId/cancel                stop the run
```

Reading needs repository **read**. Cancelling stops work on the repository, so it
needs **write**.

A run is addressed *through* its repository, and the run must actually belong to
that repository. Otherwise a caller with access to one repository could read
another's logs by naming a foreign run id under a path they can reach.

## Masking happens at ingestion

Secret values are replaced **before the bytes are stored**, never when they are
read.

Masking on read would mean the raw value is on disk, in every backup and in every
replica, and one query that forgets to mask would expose it. Masking once, on the
way in, means the value was never written down.

Values under five characters are not masked — see
[SECRETS_VAULT.md](SECRETS_VAULT.md) for why.

## Output is sanitized

Build output is whatever a build printed, and a build prints whatever a
repository's code chooses to.

**Terminal escape sequences are stripped.** A log viewer where a build can move
the cursor, clear the screen or rewrite earlier lines is a viewer where a failure
can be made to look like a pass. Carriage returns are dropped for the same
reason: a progress bar that overwrites its own line would let later output erase
earlier output.

Colour is lost. That is the deliberate trade — a log has to be trustworthy before
it is pretty.

Newlines, tabs and all printable Unicode survive. A single line over 32 KiB is
truncated with a marker, because one unbroken line of many megabytes is a denial
of service against every viewer that ever renders it.

## Limits

| | |
| --- | --- |
| Per job | 8 MiB |
| Per chunk | 256 KiB |
| Chunks per request | 200 |
| Per line | 32 KiB |

At the per-job cap a `system` chunk is written **once** saying the log was
truncated, and further appends are accepted-but-ignored with `truncated: true` in
the response. A build that silently stops logging is worse than one that says it
stopped.

Chunks are validated before anything is written, so a malformed request is
rejected on its own terms rather than depending on how much has already been
stored.

## Live status

Reading is cursor-paged: `?after=<sequence>` returns what came next, plus the new
cursor and whether there is `more`.

Cursor paging rather than a pushed stream, because a log has to be readable after
the run finished and from an instance other than the one that recorded it — and a
cursor works in both cases where a socket does not.

`complete: true` means the job has finished **and** there is nothing left to
fetch, which is how a viewer knows to stop polling rather than guessing from a
timeout.

## Cancellation

`cancelRun` marks everything unfinished as cancelled and destroys the token of
every running job in the same statement, so a runner that has not noticed cannot
keep acting on the repository. A job that already succeeded keeps its outcome.

The runner learns about it **as the answer to a heartbeat**, not as a push. A
runner that has lost its connection cannot be pushed to; one that is still
talking asks on every beat. Worst case is one heartbeat interval of wasted work
rather than a job that never learns it was cancelled.

## Stalled runners

A runner that crashes would otherwise leave its job `running` forever, holding
its dependants in `pending` and a run in flight against the repository's limit.

`startStalledJobWorker` fails jobs with no heartbeat for five minutes, which lets
the run conclude. The check runs once a minute: reaping is a correctness
backstop, not a latency-sensitive path.

Like every other worker in this release it is an in-process interval, so two
instances against one volume would both reap — see
[OPERATIONS_BOUNDARY.md](OPERATIONS_BOUNDARY.md).

## Not here yet

Artifact and cache storage, commit-status integration, and the runner agent
itself. Each is a separate open item in [TODO.md](TODO.md).
