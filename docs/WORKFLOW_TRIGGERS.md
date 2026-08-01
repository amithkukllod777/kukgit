# KukGit Scheduled, Manual and Close Triggers

Three ways a run starts that are not a push. Ref-driven dispatch is described in
[WORKFLOW_DISPATCH.md](WORKFLOW_DISPATCH.md); this is everything else.

## Schedules

```yaml
on:
  schedule:
    cron: ['0 3 * * 1-5']
```

**Read from the default branch only.** A schedule honoured on any ref would let
anyone who can push a branch — or, once forks exist, open a pull request —
install recurring work on the instance that outlives their branch. The default
branch is the one a repository's maintainers control.

Schedules are re-read whenever a request could have changed a ref, so adding,
editing or deleting one is an ordinary commit rather than an operator task. A
workflow whose file stops validating keeps no schedule: the broken file is
already reported as a failed run by the push that broke it, and firing an old
schedule from a file nobody can read would be work with no definition.

### Cron

Five fields, evaluated in **UTC**. A schedule interpreted in a local zone changes
when that zone changes — a nightly build would run twice on one day each year and
not at all on another, with nothing in the workflow file to explain it.

`*`, `a`, `a-b`, comma lists and `/step` are supported. A restricted
day-of-month together with a restricted day-of-week is a **union**, which is
cron's own rule: `0 0 1 * 1` means "the 1st, and every Monday", not "never".

**Missed ticks are not backfilled.** An instance that was down overnight owes one
run per schedule, not one per minute it was asleep — coming back and starting a
night's worth of builds at once would take the instance down again for the same
reason it went down.

The commit is resolved at fire time from the default branch, so a scheduled run
always builds what is on the branch now rather than what was there when the
schedule was recorded.

A scheduled run has **no actor**. Nobody asked for it at that moment, and
attributing it to whoever last touched the file would put their name on work they
did not start.

### One instance fires it

Every instance runs the sweep; the one that holds the `workflow-schedule` lease
does the work.

```sql
INSERT INTO job_leases (name, owner, acquired_at, expires_at) VALUES (…)
ON CONFLICT(name) DO UPDATE SET …
WHERE job_leases.expires_at <= :now OR job_leases.owner = :owner
```

One statement decides it. Two instances that both read "expired" at the same
moment both attempt the write, and the `WHERE` clause means exactly one row
changes — a read-then-write would let both conclude they had won and fire every
scheduled workflow twice.

The lease expires on its own, so losing an instance does not stop schedules: the
next tick is simply won by somebody else. `job_leases` is generic and named, so
any future single-instance worker can use it.

## Manual runs

```yaml
on:
  manual:
    inputs:
      environment: {required: true}
      dry_run: {default: 'true'}
```

```text
POST /api/repos/:org/:repo/workflow-dispatch
     {"workflow": ".kukgit/workflows/deploy.yml", "ref": "main", "inputs": {"environment": "staging"}}
```

Needs repository **write** and a same-origin request. Starting a workflow runs
the repository's own code with the repository's own secrets on a runner the
organization owns — that is a write, not a read.

Unlike every other trigger this one names both its workflow and its ref, because
a person is choosing both. Both are therefore checked against what exists:

- the ref is resolved through Git rather than trusted as text
- the workflow must be present **at that commit** and declare `manual` — a
  workflow that never asked to be started by hand is not started by hand

Inputs must be **declared**. An undeclared input reaching a job would be an
environment variable the file's author never wrote and never reviewed, chosen by
whoever pressed the button. A declared `default` fills in for an input nobody
supplied; a declared `required` input that is missing is a `400`.

The audit event records input **names** only. A value is whatever the person
typed, including something that should not be written down.

## Closed pull requests

```yaml
on:
  pull_request:
    types: [opened, synchronize, closed]
```

Asked as a question about state — *which closed pull requests have no `closed`
run?* — rather than reacting to a close event. A pull request can close through a
merge, an API call, a branch deletion or a lifecycle sweep, and a dispatcher that
had to enumerate those routes would miss whichever one was added next.

`workflow_runs.event_action` is what makes the question answerable. Without it a
`closed` run and the `opened` run at the same head commit are the same row, and
every sweep would start another.

The head branch is usually deleted with the merge, so the commit comes from the
run that already built it. A `closed` run has to describe the commit the pull
request proposed, not the base it landed on.

## Routes

```text
POST /api/repos/:org/:repo/workflow-dispatch    start one workflow (write, same-origin)
GET  /api/repos/:org/:repo/workflow-schedules   what is registered and when it next fires (read)
```

## Migration and rollback

`migrateWorkflowTriggers(db)` creates `job_leases` and `workflow_schedules` with
`CREATE TABLE IF NOT EXISTS`, and adds a nullable `event_action` column to
`workflow_runs`.

Rolling back to an earlier build is safe: the two tables go unread and the extra
column goes unwritten. Nothing existing is rewritten, and no column is dropped or
retyped. To reclaim the space, drop the two tables; SQLite cannot drop the
column, and a nullable column no code reads costs nothing.

## Related

- [Workflow Dispatch](WORKFLOW_DISPATCH.md) — push, tag and pull-request triggers
- [Workflow Format](WORKFLOWS.md) — where `on:` is validated
- [Workflow Runs](WORKFLOW_RUNS.md) — what a run becomes once it exists
