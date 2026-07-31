# KukGit Workflow Runs

What happens between a validated workflow file and a runner that executes it:
trigger matching, run and job records, dependency-aware scheduling, and the
credential a job is given.

Still no execution. This is the scheduling and authorization layer; the runner
itself is the next open item in [TODO.md](TODO.md).

## Trigger matching

`workflowMatchesEvent(workflow, event)` decides whether an event starts a run.

**Ignore filters win over include filters.** An explicit exclusion is the stronger
statement — a rule that an inclusion could override would not be an exclusion at
all. So `branches-ignore` beats `branches`, and `paths-ignore` beats `paths`.

Path filters evaluate against the changed paths of the event. A change touching
both an excluded and an included path **is not excluded**: the build has
something to do. When path information is missing entirely the filter is not
applied, because skipping a run over absent metadata silently drops builds.

Patterns are matched by a small glob matcher — `*` and `?` only — and
deliberately **not** compiled to a regular expression. A filter is untrusted
input written by a repository, and building a regex out of it invites
catastrophic backtracking on the scheduler's thread.

## Runs and jobs

A run holds the event, ref, commit, actor and concurrency group. Each job carries
its `needs`, resolved permissions, timeout and position.

```
pending ──▶ queued ──▶ running ──▶ success | failure | cancelled
   └──────────────────────────────▶ skipped
```

Jobs with no dependencies start `queued`. The rest wait in `pending` until every
dependency reaches a terminal state.

**A job whose dependency did not succeed is `skipped`, not `failure`.** It never
ran. Reporting it as failed would put a defect where there was only an unmet
precondition, and would make a run's failure list misleading.

A run is `success` only when every job is `success` or `skipped`; `failure` if
any job failed; `cancelled` if any was cancelled and none failed.

## Concurrency

`concurrency.group` is interpolated from the event. With `cancel-in-progress`,
creating a run cancels every queued or running run in the same group for the same
repository.

An **unresolved** reference in a group expression stays literal rather than
becoming an empty string. Two different groups collapsing into one would make
unrelated runs cancel each other.

## Claiming work

```js
claimNextJob(db, { runnerId, labels })
```

Returns the oldest queued job matching a label the runner declared, together with
a token — or `null`. The select and the status update happen in one transaction
conditioned on the row still being `queued`, so two runners racing for the same
job produce one winner and one `null`.

## The job token

This is where the security of hosted CI actually lives.

- **Returned once, stored as a SHA-256 hash.** A leaked database cannot be used
  to impersonate a job.
- **Bound to one job**, and refused once that job leaves `running`.
- **One hour, enforced at use** rather than by a sweep — a token that outlived
  its window is refused even if nothing has cleaned it up yet.
- **Destroyed the moment the job finishes or is cancelled**, in the same
  statement that changes the status. A runner that has not noticed a
  cancellation cannot keep acting on the repository.

### Permissions

A token receives the **intersection** of what the workflow asked for and a
ceiling set by the event:

| Event | Ceiling |
| --- | --- |
| `push`, `tag`, `schedule`, `manual` | write on every scope |
| `pull_request` from this repository | write, except `contents` which is read |
| **`pull_request` from a fork** | **read on every scope** |

A workflow can only ever narrow what it gets. Requesting `write` where the
ceiling is `read` yields `read`, not an error and not `write`.

Omitting `permissions:` gives **read**, not the ceiling. Defaulting to the
ceiling would make every workflow maximally privileged by saying nothing.

### Forks

A pull request from a fork runs code written by someone with no write access to
this repository. It receives:

- a **read-only** token, on every scope
- **no secrets at all** — not organization, not repository

This is the "pwn request" class of vulnerability, the single most exploited
weakness in hosted CI. Handing fork code a writable token, or any secret, makes
every credential readable by anyone who can open a pull request.

`secretsForJob()` returns `[]` for a fork job before it reads anything from the
vault.

## Branch governance is unaffected

A job token is not a way around branch protection. Required reviews, required
status checks and push restrictions are enforced server-side on every write, for
every credential — see [BRANCH_GOVERNANCE.md](BRANCH_GOVERNANCE.md). A token with
`contents: write` can push exactly where its permissions and the branch rules
both allow, and nowhere else.

## Limits

| | |
| --- | --- |
| Runs in flight per repository | 50 |
| Job token lifetime | 1 hour |

Exceeding the in-flight limit returns `429 WORKFLOW_RUN_LIMIT_REACHED` rather
than queueing without bound.

## Not here yet

- the runner itself, its isolation, and its egress policy
- build logs and live status
- cache and artifact storage
- `required-check` integration wiring runs into commit statuses
- scheduled (`cron`) dispatch — the filter is validated and stored, but nothing
  fires it

Each is a separate open item in [TODO.md](TODO.md).
