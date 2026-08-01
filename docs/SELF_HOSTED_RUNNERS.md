# KukGit Self-Hosted Runners

A runner is a machine you own that executes your organization's jobs.

**There is no sandbox.** Jobs run as the user running the agent, with that user's
privileges, on that machine. That is the honest description and the reason this
is the runner KukGit ships first: the code being executed is your own, so
instance isolation is not the boundary being trusted.

Hosted runners — running other people's untrusted code — are Phase 2 work and
need real sandbox isolation. See [GETTING_TO_PRODUCTION.md](GETTING_TO_PRODUCTION.md).

## Register

**Settings → Runners**, or:

```http
POST /api/runners/orgs/:org
{"name": "build-box-1", "labels": ["kukgit-linux"]}
```

Organization **Admin** is required: registering a runner decides what machine
executes an organization's code.

The token is returned **once** and stored only as a SHA-256 hash. An operator who
loses it registers a new runner rather than recovering the old one.

## Run

```bash
npm run runner -- --url https://git.kuklabs.com --token kgr_...
```

| | |
| --- | --- |
| `--labels a,b` | claim only for these; defaults to every registered label |
| `--work <dir>` | keep workspaces here instead of a temporary directory |
| `--poll <seconds>` | idle poll interval, default 5 |
| `--once` | run one job and exit |

`KUKGIT_URL` and `KUKGIT_RUNNER_TOKEN` work instead of the flags.

`SIGINT` or `SIGTERM` finishes the current job and stops. A second one exits
immediately.

## What a runner can and cannot reach

A runner token carries its **organization**, taken from the stored row and never
from the request. A runner cannot claim work for a tenancy it was not registered
for — there is no organization field in the claim to get wrong.

The labels it may claim for are the ones it registered with. Asking for a label
it does not hold returns nothing rather than an error, so a misconfigured agent
idles instead of quietly picking up other work.

## Fork pull requests

**A fork job is not offered to a runner unless it opted in.**

A pull request from a fork runs code written by someone with no write access to
the repository. On a self-hosted runner that is untrusted code on *your* machine.

Opting in (`allowForkJobs`) means opting in to running the code. It never means
opting in to the credentials: a fork job receives a read-only token and **no
secrets at all**, checked before the vault is read. See
[WORKFLOW_RUNS.md](WORKFLOW_RUNS.md).

## How a job runs

1. **Claim.** One request returns the job definition, merged environment, the
   secrets the job may use, and a job token valid for an hour.
2. **Workspace.** A shallow fetch of the exact commit the run was created for —
   a runner needs the tree that was built, not the history. The credential goes
   in an `http.extraHeader` argument, **not in the URL**: a URL with a token in it
   ends up in the remote config, in reflogs and in error output.
3. **Steps**, in order, stopping at the first failure unless the step is marked
   `continue-on-error`.
4. **Post-job caches.** A `kukgit/cache@v1` step registers a save that runs here,
   after the last step and only if the job succeeded — the content a cache is
   meant to hold does not exist when the step itself runs.
5. **Report.** Logs are flushed *before* the outcome is sent, because completing
   the job destroys the token and anything still buffered would have nowhere to
   go.

The workspace is removed afterwards unless `--work` was given.

## Scripts are files, never command strings

Each `run:` script is written to a file and executed as `bash <file>`.

The script's own contents are the only thing the shell parses, so nothing in a
job definition can escape into the agent's command line. There is a test that
puts shell metacharacters in a script and asserts they stayed text.

`set -eo pipefail` is prepended, so a failing command in the middle of a script
stops the rest rather than letting a later success mask it.

## Secrets reach a step through its environment

Only the secrets a step actually **names**. A step that never mentions a
credential does not receive one, which bounds what a compromised dependency in
that step can read.

Expressions are resolved for declared `env:` values only. **Nothing is
substituted into the script itself** — the format forbids untrusted interpolation
there, and doing it in the agent would reintroduce exactly what the format
prevents.

The runner's own names (`KUKGIT_*`, `RUNNER_*`) cannot be overwritten by a job. A
job that could set them could lie to its own steps about where it is running.

## Logs

Batched rather than one request per line, split at 64 KiB, and **never dropped**:
a failed flush puts the output back at the front of the buffer. A log that
silently loses the failing lines is worse than a slow one.

The server masks secret values before storing and strips terminal escape
sequences — see [BUILD_LOGS.md](BUILD_LOGS.md).

## Cancellation and timeouts

Cancellation arrives as the answer to a heartbeat. The running step gets
`SIGTERM`, then `SIGKILL` ten seconds later — a step that ignores `SIGTERM` does
not get to outlive its cancellation.

A step exceeding its timeout is killed and reported as a timeout, not as an
ordinary failure. The job deadline is checked between steps too, so a job cannot
overrun by starting one more step just before its limit.

A missed heartbeat does **not** abandon the job. The server reaps a runner that
stops reporting for five minutes; abandoning on one blip would turn a network
hiccup into a failed build.

## Built-in actions

`kukgit/cache@v1` and `kukgit/upload-artifact@v1` are implemented by this agent.
Nothing is fetched for them, so there is no third-party code on the machine to
review.

Both need `tar` on the `PATH`. It is invoked with an argument vector and never a
command string, and content is packed relative to a `-C` directory so nothing
arriving from a workflow can look like an option. A cache is unpacked into a
staging directory and copied in only once `tar` has succeeded — a half-extracted
archive never reaches a workspace a build is about to compile, and the workspace
is never the directory `tar` is pointed at.

A path from a workflow is resolved and then checked against the workspace root,
so `a/../../etc` and a symlinked parent are caught by the same comparison. A path
that escaped would let a workflow archive this machine's own files — including
this runner's registration token.

`kukgit/cache@v1` saves after the job, and only when the job succeeded. Read
[Artifacts and Cache](ARTIFACTS_AND_CACHE.md).

## What this runner does not do yet

- **Third-party `uses:` steps are skipped**, and say so in the log. Pretending an
  unimplemented step ran would make a build look green that never happened. The
  two built-ins above are the exception — they are this agent, not fetched code.
- no container or service steps
- no sandbox, as stated at the top

## Operating advice

- Run the agent as a **dedicated unprivileged user**, not as root and not as your
  own account.
- Give it a machine you are willing to lose. A build is arbitrary code.
- Do not run one runner for repositories with different trust levels. Register
  one per trust boundary; the label is how a workflow picks.
- Leave `allowForkJobs` off unless you have thought about what a fork's code
  running on that machine can reach.
- Remove a runner the moment its machine is decommissioned. Deleting the row
  invalidates the token.
