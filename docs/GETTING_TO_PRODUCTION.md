# Getting KukGit to Production

What is finished, what is left, and — specifically — **which parts cannot be
finished by writing code**. Those need a machine, a credential, a decision or a
vendor, and no amount of engineering removes that.

[DEPLOYMENT.md](DEPLOYMENT.md) covers *how* to run an instance. This covers *what
is yours to do*, and in what order.

## 1. Things only you can supply

None of these are code. Every one blocks production.

| | Why it is yours |
| --- | --- |
| **A Linux host** | Bare metal or a VM with nested virtualisation if hosted CI is ever wanted. Everything else can be a plain VM. |
| **AuthKit reachable at a real HTTPS URL** | Production identity is One Kuklabs Account. KukGit does not own a password system and will refuse to start with `KUKGIT_AUTH_MODE=local` in production. |
| **Six independent secret keys** | Listed below. Generating them is a one-time act only you should perform. |
| **An SMTP sender with SPF, DKIM and DMARC** | Invitations and security notifications are useless if they land in spam. The domain reputation is yours. |
| **Off-instance backup storage** | A `.kgbak` on the same disk as the database is not a backup. |
| **A TLS certificate and a domain** | `git.kuklabs.com` or whatever it is called. |

### The keys

```bash
for key in AUTHKIT_ENCRYPTION SECRETS_ENCRYPTION WEBHOOK_ENCRYPTION LFS_AUTH \
           EMAIL_PROVIDER_WEBHOOK_SECRET POSTGRESQL_RUNTIME_SHADOW_SAMPLING; do
  printf 'KUKGIT_%s_KEY=%s\n' "$key" "$(openssl rand -base64 48)"
done
```

**Generate each one separately.** Reusing a key means one compromise opens more
than one kind of stored material.

`KUKGIT_SECRETS_ENCRYPTION_KEY` deserves separate handling: backups contain the
ciphertext, not the key. A restored instance needs the same key, so store it
**with the archives' care but not with the archives**. Losing it means every
stored secret must be re-entered — there is no recovery path, by design.

## 2. Order of work

### Before the first external user

1. **Merge or close [PR #70](https://github.com/amithkukllod777/kukgit/pull/70).**
   It is mergeable and locally green, but its PostgreSQL integration job has never
   executed. The rule in [TODO.md](TODO.md) — *a PR whose jobs never execute
   remains unvalidated* — is the right rule; it just needs the runner back.
2. **Restore GitHub Actions** (or move CI elsewhere). Everything merged recently
   was verified locally because hosted jobs cannot start. That is a survivable
   gap for one person and an unacceptable one for a team.
3. **Run the recovery rehearsal against a production-sized archive**:
   `npm run rehearse`. Sign off the manual checks in the evidence file — the ones
   needing a live AuthKit and a real credential. A drill nobody signed off did not
   happen.
4. **Decide the metadata backend.** SQLite is authoritative and works. Do not
   start the PostgreSQL cutover because it is on a list; start it when SQLite is
   actually the constraint. `storage.database_bytes` in
   `GET /api/instance-admin/health` tells you when.

### Before more than one instance

The single hard blocker: every background worker is an in-process interval, so
**two instances against one volume double-fire all of them** — two copies of each
email, two webhook deliveries, two expiry sweeps.

The fix is designed and not yet built: the `job_leases` model in
[OPERATIONS_BOUNDARY.md](OPERATIONS_BOUNDARY.md). Until it exists, run exactly one
application instance. `GET /api/instance-admin/health` reports
`instance.singleNode: true` so this is visible from the running system.

### Before public signup

- rate limits are in place; **abuse reporting and moderation are not**
- secret scanning and push protection do not exist
- there is no billing, metering or quota enforcement
- object storage is not implemented; repositories and LFS live on the instance
  volume, which is the binding constraint on both scale and recovery time

## 3. CI: what exists and what it needs

Four of the CI pieces are built and tested: the [workflow format](WORKFLOWS.md),
the [secrets vault](SECRETS_VAULT.md), [run scheduling and job
authorization](WORKFLOW_RUNS.md), and [build logs](BUILD_LOGS.md).

**Nothing executes yet.** A runner is missing, and there are two different
runners with two different risk profiles.

### Self-hosted runner — private alpha

The customer runs the agent on their own machine. The code it executes is their
own, so instance isolation is not the boundary being trusted. This is what
GitHub shipped for its first years, and it is enough for alpha.

What it needs: an agent that claims a job, writes each `run:` script to a file and
executes it (never assembling a shell string), streams output to
`/api/workflow-jobs/self/logs`, heartbeats, and honours the cancellation flag in
the heartbeat response. All four server-side halves already exist.

This is ordinary engineering and can be built and tested normally.

### Hosted runner — public beta, not before

Running untrusted code for other people is a different problem, and it cannot be
finished by writing code.

**Do not write the sandbox.** Nobody does. Pick one:

| | Isolation | License |
| --- | --- | --- |
| **Firecracker** microVM | strongest; one VM per job (AWS Lambda, Fly.io) | Apache 2.0 |
| **gVisor** (`runsc`) | user-space kernel, lighter than a VM | Apache 2.0 |
| **Kata Containers** | VM-backed containers | Apache 2.0 |
| Hardened Podman/Docker | weakest — trusted code only | Apache 2.0 |

All four are licence-compatible with commercial use. Writing your own means
repeating ten years of other people's security fixes.

Then, on a real host: escape attempts, egress bypass, resource exhaustion, and a
third-party penetration test before the first untrusted job runs. **An unverified
sandbox is worse than none, because it looks finished.**

## 4. What "done" looks like for the alpha

- [ ] PR #70 resolved
- [ ] CI executing again, on any provider
- [ ] recovery rehearsal run against production data, manual checks signed off
- [ ] six keys generated, stored separately, and the vault key stored apart from backups
- [ ] SMTP sending with SPF/DKIM/DMARC passing
- [ ] backups landing off-instance and pruned on a schedule
- [ ] alerting wired to `GET /api/instance-admin/health`, paging on `critical`
- [ ] self-hosted runner agent shipped
- [ ] one instance, and a written note saying why it is one

Everything above the runner line is operational work. It is not glamorous and it
is the part that decides whether the first outage is a bad afternoon or a bad
quarter.

## 5. Honest state

| | |
| --- | --- |
| Tests | 300, all passing |
| Runtime npm dependencies | none |
| Authoritative metadata store | SQLite |
| Instances supported | one |
| CI | format, secrets, scheduling, authorization and logs — no execution |
| PostgreSQL | Stages 1–6 delivered, Stage 7 unvalidated, cutover not enabled |

Read [TODO.md](TODO.md) for the item-level list and
[ROADMAP.md](ROADMAP.md) for phase direction. Where those two ever disagree,
treat it as a bug in the documents and fix it — one of them is wrong.
