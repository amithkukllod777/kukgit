# Changelog

## Unreleased

### Documentation

- Synchronized the identity, deployment, API, onboarding, integrations,
  PostgreSQL, workflow and production-readiness documents with current `main`:
  KukGit-owned accounts are production-capable, AuthKit is optional, Stage 7 is
  merged, self-hosted workflow execution and multi-instance coordination are
  delivered, and hard-coded test counts are no longer release evidence.

### Security

- AuthKit bridge sessions now bind to a specific central device session in every
  case. The device-session id is derived from the access-token claim when the
  login response omits it, and a bridge that still has no id adopts the one
  AuthKit reports on its first validation instead of skipping the comparison.
  Previously a null id downgraded "this device session is still live" to "the
  account has some live session", so revoking the device that created a bridge
  did not end it while the user stayed signed in elsewhere.
- The credential routes (`/api/auth/login`, `/signup`, `/otp/verify`, `/google`)
  have a single owner again. Unreachable duplicates in the identity module
  lacked the verified-email requirement, the product-access preflight and the
  legacy-password scrub, so a change in dispatch order would have silently
  dropped three protections.

### Fixed

- A step whose signal was **already aborted** when `runStep` was called ran to
  completion. The abort listener was attached but nothing checked
  `signal.aborted`, and an already-aborted signal fires no event — so
  cancellation landing in the window between the caller's check and the listener
  being attached was simply lost. A cancelled job ran one more step, and for a
  deployment step that is a deployment nobody asked for.
  Found from the other end: the "one unreproduced test failure" recorded in the
  TODO recurred, and this time the reporter output was captured. The test was
  `an aborted step is stopped and reported as cancelled, not failed`, failing at
  exactly thirty seconds — the step timeout — which is what an abort that never
  arrived looks like. It was a real defect all along rather than a timing-
  sensitive test, and the TODO watch item is closed.

### Added

- Verified tenant deletion (`src/tenant-lifecycle.mjs`): an organization can be
  removed, and the removal can be **proved**.
  - the table list is **derived from the schema**, not written down. A
    hand-maintained list is correct the day it is written and wrong by the next
    migration, and the failure is silent — the tenant is deleted, the report says
    complete, and rows nobody enumerated are still there.
  - an **unclassified table fails the deletion**. A table nobody classified is
    not evidence of a clean deletion; it is evidence that nobody looked.
  - **the derivation found two real gaps on its first run.** `secrets` is scoped
    by `(scope, scope_id)` with no foreign key, so no graph can see it — left
    alone, deleting an organization would have left its encrypted credentials in
    the database forever. And `repositories` linked through the nullable
    `deleted_from_org_id` rather than `organization_id NOT NULL`, because the
    walk took the first matching foreign key; every table reachable through
    repositories was then scoped by a column that is null for every live
    repository, and a deletion would have reported success having removed one
    row. Nullable links are now never preferred over `NOT NULL` ones.
  - a **seven-day wait** before execution, cancellable throughout. Deletion is
    the one operation with no undo, and the most common reason to want one
    reversed is that it was a mistake noticed within the hour.
  - a census before and after, and `complete` is true only when every count is
    zero and nothing went unclassified. Otherwise the request is marked `failed`
    and the evidence is kept.
  - the deletion record outlives the tenant and deliberately has no foreign key
    to it — destroying the record along with the tenant would leave nothing to
    show for it
  - instance administrator only. An organization owner may ask; only the operator
    running the instance carries it out.
  - repository bytes, LFS objects and user accounts are explicitly **not**
    removed here, each with a written reason — content-addressed objects are
    shared between tenants, and deleting one by tenant destroys somebody else's
    data along with your own


- `npm run scan` — finds credentials committed **before** scanning existed. Push
  scanning only sees what a push introduced, so a repository migrated in from
  elsewhere would show an empty findings list and look clean.
  - **current branch tips by default.** A credential in the current tree is the
    one an attacker finds by cloning, and it is the mode that finishes — full
    history on a large repository reads every blob ever written, and a scan
    nobody runs to completion protects nobody.
  - blobs are deduplicated across the whole walk, so a file identical on fifty
    release branches is read once
  - `--history` walks every commit and finds credentials that were committed and
    later removed. Those still need rotating: the bytes are in every clone
    anybody took in between, and removing one from the tip is not a fix.
  - a history scan that hit its per-ref commit limit **reports which refs it did
    not finish**. A bounded scan reported as complete is worse than no scan,
    because somebody then believes the part it never reached is clean.
  - a deleted repository is skipped: reporting findings against it would add work
    nobody can action


- Push protection (`src/push-protection.mjs`): a push that introduces a
  credential is **refused** by the pre-receive hook, before the objects are
  accepted.
  - it has to be the push. Once a credential is in history it is compromised —
    rewriting does not un-send bytes that reached a server, a clone, a CI cache
    or a backup.
  - **off until an administrator enables it** per repository. A control that
    starts rejecting pushes the moment it ships is one that gets switched off
    before anybody reads what it does.
  - only the content the push introduces is scanned. Rejecting a push over a
    credential that was already there is a problem the author usually cannot fix,
    and that is how a control ends up disabled.
  - the rejection message names the file, the line and the redacted preview, and
    gives the exact route to allow it — actionable in the terminal, because that
    is the only place the author is looking. It also says to rotate anyway: the
    push was refused, but the credential was typed, committed and sent.
  - a **bypass is keyed by fingerprint**, expires after 30 minutes, needs a
    written reason and is recorded with who granted it and whether it was used. A
    bypass covering "the next push" would let an unrelated credential ride along
    with the one somebody reviewed.
  - **fails closed.** If the scanner cannot run, the push is refused. An
    administrator who turned this on asked for the strict behaviour, and a
    control that opens on its own failure is not one.
    `KUKGIT_SECRET_PUSH_PROTECTION_FAIL_OPEN=1` inverts it deliberately.
  - the pre-receive hook is now installed on **every** repository, not only those
    with a branch rule — otherwise a repository that enabled protection and had
    no branch rule would have had no hook to enforce it with
  - verified end to end: pushed a credential and confirmed the remote never
    moved, granted a bypass and confirmed the same push then succeeded, added a
    second credential and confirmed it was refused again


- Secret scanning (`src/secret-scanning.mjs`). Every push is scanned for
  committed credentials and findings are recorded against the repository.
  - **The secret is never stored.** A scanner's database is a list of where the
    credentials are — a strictly better target than the repository itself,
    because somebody has already done the searching. A finding holds a truncated
    SHA-256 fingerprint and a redacted preview; a match of twelve characters or
    fewer is redacted entirely, because showing four of eight is showing half the
    secret. There is a test that serialises a finding and asserts the credential
    is not in it.
  - **A checksum decides it where a format has one.** A GitHub token carries a
    CRC32 of its own payload, so "looks like a token" becomes "is one". That
    matters more than adding detectors: a scanner that cries wolf is one an
    author learns to ignore, and then it protects nobody.
  - ten detectors, including KukGit's own token formats — a host that scans for
    everybody else's credentials and not its own would be an odd thing to ship
  - `sk_test_` is reported at low severity rather than not at all: a test key is
    still a credential, it just cannot move money
  - **every skip is returned**, not silently applied. A scanner that quietly
    drops a file it could not read lets somebody believe a clean result means a
    clean push.
  - an `.env.example` is still reported, marked `likelyExample`, so a policy can
    warn instead of block — a decision for the repository, not the scanner
  - repeat sightings merge, so the count is credentials to rotate rather than
    times somebody pushed; a resolved finding stays resolved, because a list that
    can never be cleared is a list nobody reads
  - reading findings needs repository **write**, not read: a finding is a map to
    a credential for anyone who can also read the repository
  - scanning runs **after** the push is accepted. A scanner failure is logged and
    the push stands; turning a scanner problem into a rejected push would make it
    the least reliable part of pushing code.
  - verified end to end by pushing a file with four credentials and confirming
    the findings, the severities, the example marking, and that grepping the
    database for the real values finds nothing
  - test fixtures are assembled at runtime rather than written as literals. The
    first attempt to push this change was blocked by GitHub's own push
    protection, which found the Stripe fixtures and was right to — it cannot know
    they are synthetic. A test file full of token literals trips every scanner in
    the ecosystem, this one included.
  - **push protection — blocking a push — is deliberately not included**, and the
    documentation says so. It needs a per-repository policy and an audited
    bypass, and a bypass that is not recorded is a control that is not enforced.


- Real-time notifications now cross instances (`src/notification-fanout.mjs`),
  the last open item in the P0 operations list. A notification created on one
  node reaches a socket held by another.
  - the trigger on `notifications` is **permanent, not `TEMP`**. A `TEMP` trigger
    only fires for writes made on the connection that created it, which is
    exactly why this never worked across instances.
  - it is plain SQL with no custom function, so a backup, a script or
    `npm run seed` can still write a notification. A trigger calling a function
    only the server registers would turn those into crashes.
  - **one delivery path, not two.** The instance that wrote the row reads it back
    from the same log as everybody else. A local fast path plus a remote one
    would be two behaviours to keep in sync, and the local one is the one that
    gets tested.
  - the cursor starts at the newest row and lives in memory only. A client
    fetches its inbox on connect, so persisting the cursor would make every
    restart a burst of stale badges.
  - a failing poll is logged and retried, never thrown. The inbox is the delivery
    guarantee and the socket is an accelerator, so the worst outcome is a badge
    that updates on reload.
  - bursts are bounded at 500 rows per tick; rows are pruned by age without a
    lease, because deleting by age is idempotent and a lease would mean one
    instance's failure stops the table growing
  - `instance.realtime.fanout` reports each instance's cursor, so an instance
    that is stuck is visible rather than silent
  - verified with two instances on one volume: a socket opened on instance B
    received the event for a notification written through instance A's
    connection


- Connection draining on `SIGTERM`, and `npm run drill` to rehearse it —
  the last open item in the P0 operations list.
  - **Readiness fails first, and the listener closes only after a delay.** The
    load balancer needs a few probe intervals to take the instance out of
    rotation; closing the socket before it has is what turns an invisible deploy
    into a burst of 502s. Liveness deliberately keeps answering `200` — a failing
    liveness probe means "restart me", and the process is already leaving.
  - **Git transfers get their own, much longer budget** (5 minutes) than API
    requests (30 seconds). A clone of a large repository legitimately takes
    minutes and killing it wastes every byte already sent; giving every request
    that budget would make an ordinary rollout take five minutes.
  - in-flight requests are counted on `close` as well as `finish`, so a client
    that disconnects mid-response cannot leave the counter above zero and make
    every later shutdown wait out its full budget
  - background workers are stopped **after** the drain. A request still being
    served may queue an email or a webhook, and stopping the worker first would
    strand it.
  - `npm run drill` starts a disposable instance, puts requests in flight, sends
    `SIGTERM`, and checks the sequence actually happens — readiness failing while
    still serving, in-flight requests completing, the listener closing only after
    that, and a replacement instance serving the same volume. Mutation-checked:
    removing the readiness-draining branch makes the drill fail.

### Fixed

- Two instances starting at the same instant raced on schema migrations and one
  exited with `duplicate column name`. Schema changes now run inside
  `BEGIN IMMEDIATE`, so the second waits for SQLite's writer lock and then finds
  every migration already applied — each one is `IF NOT EXISTS` or checks before
  it alters. This was the last thing making a rolling deploy unsafe.
  - `db.transaction` is **nesting-aware**. SQLite refuses `BEGIN` inside `BEGIN`,
    and twelve modules already open a transaction inside their migration, so
    wrapping them needed savepoints. An inner failure now unwinds only the inner
    work; an outer failure discards everything.
  - `PRAGMA busy_timeout` is set **first and on its own**. It was previously last
    in a single multi-statement `exec`, which meant everything before it —
    including `journal_mode = WAL` — ran with a timeout of zero.
  - WAL mode is established with a **read-then-set** loop rather than a bare
    `PRAGMA journal_mode = WAL`. Changing journal mode needs an exclusive lock
    and does not wait for it the way an ordinary write does, so a second instance
    starting during the first one's migration died before reaching any migration
    at all. Reading the current mode takes only a shared lock, so on an existing
    WAL database there is nothing to do, and on a new one whichever instance wins
    sets it while the rest observe the result.
  - verified by starting **three instances in the same instant** against one
    volume: all three healthy, no schema errors, four runs. Mutation-checked by
    reverting the fix, which brings the failure straight back.

### Changed

- Every background worker now runs behind a named lease (`src/job-leases.mjs`),
  closing the two open P0 items in the operations boundary. Two instances against
  the same volume previously double-fired all of them: two copies of each email,
  two webhook deliveries, two expiry sweeps.
  - one statement decides ownership, so two instances that both read "expired" at
    the same moment cannot both conclude they won. Acquiring and renewing are the
    same call, so a tick *is* the heartbeat and there is no separate heartbeat
    path that could stop while the work carries on.
  - leases are per **job**, not per instance: email can run on one node while
    webhooks run on another. `acquired_at` survives a renewal, so an operator can
    see how long a node has held a job rather than only when it last checked in.
  - a lease that cannot be read is **not** permission to run. Failing open would
    turn a database blip into every instance working at once, which is the one
    thing the lease exists to prevent.
  - the webhook worker re-checks the lease between deliveries. An instance that
    loses it part-way through a batch would otherwise keep sending alongside the
    instance that took over, and every remaining delivery would arrive twice.
  - a clean shutdown releases its leases, so a rolling restart hands work over
    immediately instead of waiting out the expiry.
  - `GET /api/instance-admin/health` now reports `instance.leases` — which node
    owns which job — replacing the `singleNode: true` marker that is no longer
    true.

### Fixed

- Webhook migration reset **every** `processing` delivery. On a second instance's
  startup that resurrected a delivery the first was mid-send on, and the endpoint
  received it twice. Stranded rows are now reclaimed by **age** instead
  (`requeueStranded`), so a row is only requeued once it has been claimed longer
  than any live attempt could still be running.

### Changed

- The "no runtime npm dependencies" claim is corrected everywhere it appeared —
  `README.md`, `BUILD_REPORT.md`, `docs/ARCHITECTURE.md`, `docs/DEPLOYMENT.md`
  and `CLAUDE.md`. The PostgreSQL write service declares `pg`, which arrives with
  14 packages, all MIT or ISC.
  It is imported lazily and only when the PostgreSQL driver is enabled, which is
  off by default: an instance in its default configuration starts and serves with
  `node_modules` removed entirely, which was verified rather than assumed. But it
  is declared, `npm ci` installs it, and it is now part of the supply chain to
  review and patch — so the documentation says one dependency rather than none.
- `docs/TODO.md` records **how** the PR #70 merge gate was satisfied: by running
  doctor, the syntax check, the full Node suite and the disposable PostgreSQL 16
  integration suite locally at the exact PR head with current `main` merged in.
  The PostgreSQL suite had been skipping everywhere because
  `KUKGIT_TEST_POSTGRES_URL` was never set; it was executed against a real
  PostgreSQL 16.13 server and passed.
  No workflow file in this repository has ever run, so `ci.yml` itself remains
  unproven and two CI items stay open. Written down rather than left to be
  inferred from a merge commit.

### Added

- `npm run lfs:storage` — moves an existing instance's Git LFS objects from the
  volume into a bucket, which is what makes object storage usable by an instance
  that did not start with it.
  Four commands rather than one, because each answers a different question and
  only the last destroys anything: `plan`, `copy`, `verify`, `reclaim --confirm`.
  - **`copy` deletes nothing.** A migration that removes its own source has no
    rollback: the moment anything is wrong with the bucket — a wrong region, a
    lifecycle rule, a credential that expires — the objects are simply gone.
  - **`plan` refuses to hide what is already broken.** Objects the database lists
    that are missing from the volume, or that no longer match their own digest,
    are reported rather than copied. Neither is caused by migrating, but a
    corrupt object is a restore-from-backup decision and copying it would move
    the corruption into the bucket. `copy` will not run while one exists.
  - **every object is verified in the bucket after it is written**, by reading it
    back and re-hashing. A `PUT` that returned `200` is a claim; the digest is
    the proof. An object that arrives wrong is removed rather than left in place,
    so the next run retries cleanly instead of skipping something that looks
    plausible.
  - **resumable by construction** — an object is addressed by its digest, so a
    second run finds the bucket already holding exactly those bytes
  - **a partial `verify` cannot clear a cutover**: the objects it skipped are
    exactly the ones nobody has looked at
  - **`reclaim` re-verifies each object immediately before deleting its local
    copy.** Trusting the earlier verification would mean deleting on the strength
    of a result from before a lifecycle rule or an accidental delete could have
    happened. Anything it cannot confirm is kept and reported.
  - verified end to end against a running instance: uploaded objects to a
    filesystem instance, pointed it at a bucket, ran plan/copy/verify, restarted
    it and confirmed it served the objects from the bucket with the volume copies
    still intact, then reclaimed and confirmed it still served them


- Object storage behind the Git LFS interface (`src/object-storage.mjs`), closing
  the third of the four P0 operations items. LFS objects can now live in an
  S3-compatible bucket instead of the instance volume, which is what stops one
  disk from being the ceiling on how much a customer can store.
  - **Filesystem stays the default.** Switching an instance whose objects are
    already on a volume to a bucket would make every existing object unreadable,
    so moving them is a migration rather than a configuration change. That
    migration does not exist yet and the documentation says so.
  - AWS Signature Version 4 written out rather than taken from an SDK — KukGit
    ships with no runtime dependencies, and an SDK for this would be the largest
    thing in the product for one signing algorithm. The published AWS test vector
    is in the test suite, because signing is the one part that cannot be checked
    by round-tripping against our own code.
  - uploads sign `UNSIGNED-PAYLOAD`: the body is streamed from a file, and
    computing a body hash means buffering a possibly multi-gigabyte object first
  - configuration is validated **at startup**. An instance that starts happily and
    then fails on the first `git push` of a large file has already told its users
    it is working.
  - a rejected credential is a `502 STORAGE_UNAUTHORIZED`, never a `404` — "the
    object is gone" and "we cannot authenticate" must not look alike to whoever is
    debugging it. The S3 error body carries a request id and the bucket name, so
    it goes to the operator log and never into a user-facing message.
  - keys are validated identically for both backends, because a key is a
    filesystem path on one and a URL path on the other
  - LFS keys are unchanged (`objects/<aa>/<bb>/<oid>`), the same string already
    in `lfs_objects.storage_path`, so an existing layout is exactly preserved
  - `npm run doctor` and the startup banner report which backend is active, never
    the credential
  - verified end to end: a real instance configured for object storage, against a
    bucket that refuses any request without a well-formed SigV4 header. Upload,
    verify, download and range read all succeeded, and **zero files** were written
    to the volume.

### Changed

- A backup taken with object storage enabled **verifies** every LFS object by
  reading it out of the bucket and re-hashing it, but does not copy it into the
  archive. Copying a multi-terabyte bucket into every snapshot is not a backup
  strategy, and an operator who believes a 40 GB archive contains their 4 TB of
  objects has a recovery plan that fails the first time it is needed.
  - the manifest records `lfs.selfContained: false` and an `lfs.store` descriptor
    naming the bucket, region and endpoint — with **no credential**, since an
    archive that can be read would otherwise hand over the object store
  - archives written before object storage existed have no `selfContained` field
    and are treated as self-contained, which every one of them is
  - archive verification refuses an archive that claims to be self-contained but
    is missing an object, so the two states cannot be confused



- Scheduled, manual and pull-request-`closed` dispatch (`src/workflow-triggers.mjs`),
  the last open item in the P1 CI list.
  - **Schedules are read from the default branch only.** Honouring one on any ref
    would let anyone who can push a branch install recurring work on the instance
    that outlives their branch. They are re-read whenever a request could have
    changed a ref, so adding or deleting a schedule is an ordinary commit.
  - cron is evaluated in **UTC**. A schedule read in a local zone would run twice
    on one day each year and not at all on another, with nothing in the workflow
    file to explain it. A restricted day-of-month with a restricted day-of-week is
    a union, which is cron's own rule — read as an intersection, `0 0 1 * 1` would
    mean "never" instead of "the 1st, and every Monday".
  - **missed ticks are not backfilled.** An instance down overnight owes one run
    per schedule, not one per minute it was asleep.
  - a scheduled run has no actor. Attributing it to whoever last touched the file
    would put their name on work they did not start.
  - new `job_leases` table. Every instance runs the sweep; one statement decides
    who holds the lease, so two instances that both read "expired" cannot both
    conclude they won and fire every schedule twice. The lease expires on its own,
    so losing an instance does not stop schedules.
  - manual dispatch (`POST /api/repos/:org/:repo/workflow-dispatch`) needs
    repository **write** and a same-origin request — starting a workflow runs the
    repository's own code with its own secrets on a runner the organization owns.
    It is the only trigger that names its workflow and ref, so both are checked:
    the ref is resolved through Git, and the workflow must exist at that commit
    and declare `manual`. Inputs must be declared in the file; the audit event
    records input names only.
  - `pull_request` `closed` is asked as a question about state — which closed
    pull requests have no `closed` run — rather than by reacting to a close
    event, which can arrive through a merge, an API call, a branch deletion or a
    lifecycle sweep. New nullable `workflow_runs.event_action` column makes that
    question answerable; without it a `closed` run and the `opened` run at the
    same commit are the same row.
  - `dispatchWorkflows` gained an `only` filter. Schedules are recorded per
    workflow, so firing every workflow at the commit would start each of them
    once per schedule row due in the same minute.
  - verified against a running instance: a push registered the schedule, the
    worker took the lease and fired it a minute later, manual dispatch created a
    run through the full chain, and a workflow that does not declare `manual` was
    refused

- Built-in `kukgit/cache@v1` and `kukgit/upload-artifact@v1` steps, so a workflow
  can actually reach the artifact and cache storage added alongside them. Both
  are implemented by the runner agent — nothing is fetched, so there is no
  third-party code on the machine to pin or review.
  - the cache step restores where it appears and **saves after the job**, which
    is what makes a cache a cache: the content it holds does not exist when the
    step runs. The save is skipped on an exact key hit (those are already the
    bytes we would write) and skipped when the job failed (a cache written from
    a broken build is one every later build restores).
  - a cache service that is unreachable never fails a build. Turning a slow build
    into a broken one would be the wrong trade for an optimisation.
  - paths are resolved and *then* checked against the workspace root, so
    `a/../../etc` and a symlinked parent are caught by the same comparison. A
    path that escaped would let a workflow archive the runner's own files —
    including its registration token.
  - `tar` is invoked with an argument vector, never a command string, and content
    is packed relative to a `-C` directory so nothing from a workflow can look
    like an option. A cache is unpacked into staging and copied in only once tar
    has succeeded, so a half-extracted archive never reaches a workspace.
  - inputs are validated strictly in both directions: a missing required input
    and an unrecognised one are both errors. An unrecognised input on a real
    action is a typo the build ignores; on a built-in it would silently change
    nothing about what is cached, and nobody would find out.
  - `${{ secrets.* }}` is refused in these inputs (`WORKFLOW_SECRET_IN_METADATA`)
    — they become a cache key or an artifact name, stored metadata readable by
    anyone with repository read
  - only the two exact references are claimed, not the `kukgit` owner. Reserving
    an owner would break any real action published under it.
  - verified end to end against a running instance: pushed a workflow, watched
    the first build miss the cache and upload an artifact, then pushed again and
    watched the second build restore the first build's cache by prefix and store
    a new one under its own key

- Build artifact and cache storage (`src/workflow-storage.mjs`), closing the P1
  CI item "cache and artifact storage with quotas and retention". Content is
  addressed by SHA-256 and shared: the same dependency cache written by every
  branch is one file, so the quota counts distinct content rather than branches.
  - **A run may only write a cache for its own ref.** The ref is taken from the
    run record, never from the request. Without this, anyone who could open a
    pull request could write a cache the default branch's next build would
    restore and execute.
  - **A fork pull request may not write a cache at all.** Its ref is a branch
    name in somebody else's repository and two forks can pick the same one, so a
    fork write would let one contributor hand another's build content it never
    produced. Restoring stays open — reading cannot change what anyone else's
    build runs.
  - artifacts **refuse** at the quota (`507`) and caches **evict** least recently
    *used*. An artifact is evidence somebody may be about to download; a cache
    costs a slower build and nothing else. Least recently *used* rather than
    oldest, because an old cache every build restores is the most valuable one.
  - a second write under an existing cache key is kept, not overwritten: a key
    describes its own contents, so a second write means the key is wrong, and
    overwriting would hide that while handing later runs the wrong bytes
  - restore keys are matched with `LIKE` and `%`, `_` and `\` are escaped first.
    `_` is legal in a cache key and is also SQL's single-character wildcard, so
    an unescaped restore key would silently match a family it never named.
  - `ORDER BY created_at` is tie-broken by `rowid` everywhere ordering is
    load-bearing. SQLite timestamps have one-second granularity, so two entries
    written in the same second would otherwise order arbitrarily and "newest
    match wins" would mean "whichever the planner returned".
  - no write request names a repository, run, job or ref — the job token decides
    all four, so there is nothing for a job to name incorrectly. Reading needs
    repository read; deleting an artifact needs write and a same-origin request.
  - downloads are served `application/octet-stream` with `nosniff`, so an
    artifact upload cannot become a way to host interpretable content on the
    instance's own origin
  - uploads are refused on the declared `Content-Length` before a byte is read,
    and re-checked while reading because a chunked upload declares nothing
  - blobs are collected by reference count, never by age, so expiring one
    artifact never removes content another still points at
  - hourly retention worker; 30-day default, 90-day maximum
  - `GET /api/repositories/:org/:repo/ci-storage` reports usage against quota
  - 21 tests including the authorization boundaries: cross-repository artifact
    reads, run ids from a foreign repository, delete-needs-write, CSRF on delete,
    forged and absent job tokens, and the fork cache write
  - documented in [ARTIFACTS_AND_CACHE.md](docs/ARTIFACTS_AND_CACHE.md), with
    migration and rollback

- Rate limiting on the HTTP surfaces (`src/rate-limit.mjs`), closing the first item
  of the TODO's "Security and abuse readiness" section. Token bucket rather than a
  fixed window, because a fixed window lets a caller spend a full allowance at the
  end of one window and again at the start of the next — exactly the burst an abuse
  control exists to stop. Refill is lazy, so there is no timer per key, and idle
  buckets are swept on an interval to bound memory.
  - separate budgets for `auth`, `api`, `git`, `invitation` and `webhook`, so
    exhausting one does not lock a caller out of the product
  - keyed by authenticated user where one exists, so a shared office address does
    not throttle everyone behind it and rotating addresses does not mask one
    abusive account; Git HTTP callers are keyed by a hash of their credential, and
    the credential never enters the key space
  - `X-Forwarded-For` honoured only when `KUKGIT_TRUST_PROXY` is set. Trusting it
    unconditionally would let any caller forge a fresh identity per request and
    bypass every limit; the startup banner warns when it is unset
  - `429` responses carry `Retry-After` and `RateLimit-Limit`/`-Remaining`/`-Reset`
  - verified end to end against a running server: with a burst of 3, the fourth
    failed login in a row returns `429` while `/api/health` is unaffected

### Known limits

- Git over SSH is not rate limited; it is served by an OpenSSH forced command
  outside the HTTP server.
- Limit state is per instance, so a multi-instance deployment multiplies the
  effective allowance.

### Operations

- saturation and readiness surface: `GET /api/health/ready` (public, status code
  only) and `GET /api/instance-admin/health` (operator-only), reporting queue
  depth and backlog age separately, rows stranded by a dead worker, storage and
  quota headroom, backup freshness and WebSocket capacity — each with the
  configurable threshold it was judged against and a verdict. Contains no user
  data, so it is safe to forward to a monitoring system.
- production operations boundary documented: background-job ownership model,
  object-storage migration order, alerting rules, incident severities, rollback
  and rollout procedure.
- automated production recovery rehearsal (`npm run rehearse`): restores a real
  `.kgbak` archive into a throwaway directory, confirms every repository passes
  `git fsck` with the exact refs the snapshot recorded, re-hashes every Git LFS
  object on disk, asserts no credential was restored in the clear, measures the
  data-loss window against the live database, and writes a secret-free evidence
  record carrying the recovery time. Live-protocol checks that need an operator
  credential are tracked as outstanding so a drill is never reported complete on
  automated evidence alone.

### Hosted CI

- pull requests are built, by reconciliation rather than by reacting to a
  particular action: for every open pull request, does a run exist for its
  current head? That question makes it idempotent and correct whether the head
  moved by a push, a browser commit or a reopen. Path filters see the whole
  change from the merge base, not just the newest commit — a filter asking
  whether a pull request touches `src/**` means the whole pull request.
- a run publishes a commit status a branch rule can require. The context is
  derived from the workflow's file path and cannot be declared by the workflow —
  a file that could name its own context could declare the one a branch rule
  requires and report success without running anything. Nothing here decides a
  merge: the required-status policy and the merge guard are unchanged, so adding
  a workflow can only ever add a check that has to pass.
- a cancelled run publishes `error`, not `failure`. `failure` says the code is
  wrong; a cancellation says nobody found out, and reporting it as a failure
  sends someone looking for a bug that is not there.
- a Git push authenticated by a personal access token now resolves its actor, so
  a run triggered by CI's ordinary path has someone to attribute its status to. A
  run with no resolvable actor publishes nothing rather than borrowing a name.
- workflow dispatch: a push or tag now starts runs. Workflow files are read at the
  commit being built rather than from a branch tip, so a change to a workflow
  cannot silently rewrite how already-pushed commits are built. Runs are created
  from a ref snapshot taken before and after the request, which is exact for
  every path that can move a ref without any of them agreeing on a format.
- a workflow file that fails validation becomes a failed run carrying the error
  and its line number, not a skipped one — an author who sees no run at all
  cannot tell a typo from a filter that legitimately did not match. One broken
  file never stops the others.
- a deleted ref produces no event and cancels its queued runs.
- the runner substitutes the repository-controlled fields the validator allows
  inside a `run:` script. Found by running the chain end to end: `${{ github.sha }}`
  reached bash untouched and produced `bad substitution`, while unit tests on
  either side of the seam were green.
- self-hosted runners: organization-scoped registration with a token shown once
  and stored as a hash, an agent that claims work, prepares a workspace, executes
  steps and reports back, and a `npm run runner` command. Each `run:` script is
  written to a file and executed as `bash <file>`, so nothing in a job definition
  can escape into the agent's own command line. Only the secrets a step names
  reach that step's environment. A fork job is not offered unless the runner
  opted in, and opting in to running the code never means opting in to the
  credentials.
- a job claim now requires the organization it is for. Previously any runner with
  a matching label could have claimed any organization's queued job; tenancy is a
  required argument rather than an option, because a claim that can be made
  without naming a tenancy is a claim that can cross one.
- job definitions are persisted with the run, so a runner receives the steps and
  a single merged environment rather than having to know the precedence rule.
- build logs and live status. Runner routes are all `self`, authenticated by the
  job token, so a runner cannot name another job. Reading needs repository read
  and cancelling needs write, and a run must belong to the repository it is
  addressed through. Cursor-paged reads work after a run finishes and from an
  instance other than the one that recorded it, which a socket does not.
- secret values are masked at ingestion, before the bytes are stored — masking on
  read would leave the raw value on disk and in every backup.
- terminal escape sequences are stripped from build output. A viewer where a
  build can move the cursor or rewrite earlier lines is a viewer where a failure
  can be made to look like a pass. Colour is lost deliberately.
- cancellation reaches a runner as the answer to a heartbeat rather than a push,
  and a runner that stops reporting for five minutes has its job failed so the
  run can conclude instead of holding its dependants forever.
- workflow runs: trigger matching with ignore-beats-include filters, run and job
  records, dependency-aware scheduling, concurrency groups that cancel what they
  supersede, and single-claim job dispatch. A job whose dependency did not
  succeed is skipped rather than failed — it never ran.
- job tokens are returned once and stored only as a hash, bound to one job,
  expire in an hour enforced at use, and are destroyed in the same statement that
  finishes or cancels the job. Permissions are the intersection of what the
  workflow asked for and a ceiling set by the event; omitting `permissions:`
  gives read, not the ceiling. A pull request from a fork receives a read-only
  token and no secrets at all, which closes the "pwn request" class.
- encrypted repository and organization secrets vault. AES-256-GCM with the scope
  and name authenticated alongside the value, so a ciphertext copied between rows
  or renamed fails to decrypt rather than silently becoming a different secret.
  There is deliberately no read path: no route returns a stored value, and the
  only code that decrypts one is not reachable over HTTP. Listings show names, a
  truncated digest and usage metadata. A repository secret shadows an
  organization secret of the same name; a repository listing reports the names it
  inherits so an unexplained value in a build does not look like a bug.
- workflow file format and validation (`.kukgit/workflows/*.yml`), parsed by a
  dependency-free YAML subset that refuses anchors, aliases, merge keys, tags,
  multiple documents and tab indentation rather than reinterpreting them, with
  the line number and the reason.
- validation refuses unknown keys instead of ignoring them, requires action
  references to be pinned to a tag or commit, rejects reserved environment
  prefixes, resolves `needs` into a topological order and reports a dependency
  cycle with its actual path.
- untrusted values cannot be interpolated into a `run:` script. Only an
  allow-list of repository-controlled fields may appear there; event content,
  fork branch names and secrets must go through `env:`, where the runner passes
  them as data rather than as command text. Nothing executes yet — this release
  is the format and its validator only.

## 0.2.0 — 2026-07-29

Private Alpha. Everything below shipped after v0.1.0 and had not previously been
recorded here.

### Identity and access

- One Kuklabs Account authentication through the central AuthKit `/v1/auth/*` contract
- stable one-to-one `kuklabs_user_id` mapping to KukGit product profiles
- password, signup, OTP and Google ID-token flows
- AES-256-GCM encrypted access and rotating refresh tokens held server-side
- random HttpOnly browser bridge cookie with no token exposure to the browser
- central product-access and device-session validation with fail-closed behavior
- verified-email identity linking with duplicate-account conflict protection
- AuthKit made mandatory in production; local password authentication blocked
- hardened AuthKit login form and production session handling
- legacy local passwords scrubbed after AuthKit linking
- self-service organization workspace creation in a single transaction
- atomic Owner membership and default Developers-team provisioning
- configurable organization ownership limit and reserved-slug protection
- guided zero-organization onboarding that exempts repository-only collaborators

### Authentication for Git

- scoped personal access tokens with `repo:read` and `repo:write`
- token expiry, revocation, last-used tracking and one-time secret display
- browser and CLI token lifecycle management
- Git smart HTTP authorization by token scope plus effective repository permission
- Git over SSH with user keys and repository deploy keys
- Ed25519, ECDSA and RSA key support with SHA-256 fingerprints
- forced-command authorization, shell-injection and path-traversal rejection
- dynamic OpenSSH `AuthorizedKeysCommand` integration and static fallback generation

### Collaboration and permissions

- expiring organization invitations with email verification and one-time links
- transactional invitation email with secure resend and old-link revocation
- organization member directory and teams with maintainers and members
- direct repository collaborators and repository team access grants
- Read, Triage, Write, Maintain and Admin permission hierarchy
- effective permission calculation across organization role, direct and team grants
- repository-only external collaborators without organization membership
- exact-email repository invitations with revoke and secure resend
- external collaborator discovery restricted to explicitly shared repositories
- organization member and team privacy for external users
- separate invitation-link expiry and accepted-access duration
- request-time expiry enforcement across browser, Git HTTP, SSH and LFS
- immutable expired/revoked access history with audited renewal
- organization-wide external access review campaigns

### Code review and governance

- exact-branch protection rules
- pull-request approval and change-request reviews
- required approval counts and stale-approval detection
- browser commit and Git push protection for guarded branches
- server-side merge-policy enforcement
- Git-native unified and side-by-side pull-request diffs
- merge-base-correct comparisons with rename, copy and binary metadata
- review threads anchored only to real patch lines, including multi-line ranges
- threaded replies, resolve/reopen lifecycle and outdated-thread detection
- optional active-thread resolution requirement before merge
- commit status records with Pending, Success, Failure and Error states
- PAT-authenticated CI and integration status publishing
- exact-branch required status-check policies with current-head freshness

### Repository operations

- repository archive and unarchive with read-only enforcement
- rollback-protected organization transfer and bare-storage move
- 30-day recoverable Trash, Admin restore and Owner-only permanent purge
- repository webhooks with encrypted secrets and HMAC-SHA256 signed deliveries
- HTTPS and public-network target enforcement with SSRF protection
- bounded exponential retries, ping and manual redelivery
- Git LFS Batch API with SHA-256 verified streaming uploads
- content-addressed deduplication, byte-range downloads and ETags
- per-object, per-repository and per-instance LFS quotas
- LFS over SSH with short-lived repository-scoped signed credentials
- orphan LFS garbage collection

### Notifications and email

- durable per-user notification inbox with unread counts and read lifecycle
- per-category in-app and email delivery preferences
- real-time WebSocket notification delivery with user isolation, connection caps and
  session revalidation
- dependency-free SMTP transport with direct TLS and STARTTLS
- durable email outbox, bounded retries and delivery-attempt history
- email-header injection, body-size and secret-redaction protections
- provider-neutral signed delivery-event ingestion with replay protection
- bounce, complaint, delivered, deferred and rejected normalization
- hard-bounce and complaint suppression, soft-bounce thresholds and expiry
- schema-level suppression enforcement through outbox triggers
- Admin suppression review and confirmed unsuppression
- pull-request, review, merge, status-check and operational notifications
- personal-access-token expiry reminders without secret exposure

### Backups and recovery

- verified `.kgbak` snapshots with SQLite metadata, Git bundles and LFS objects
- SHA-256 entry checksums, manifest enforcement and footer validation
- absolute-path, duplicate-entry and traversal protection
- source and restored `git fsck` verification
- dry-run and atomic empty-directory restore workflows
- operation locks, maintenance-mode write quiescing and retention pruning

### Administration

- Instance Admin console with an operator allowlist independent of organization roles
- adoption, repository, external-access, delivery, LFS, backup and audit metrics
- bounded cross-tenant search and tenant/user diagnostics
- recursive server-side audit metadata redaction
- confirmed support notes and confirmed email/webhook retry controls
- no-impersonation and no-credential-exposure support boundary
- email delivery health interface

### PostgreSQL migration program (Stages 1–6, cutover not enabled)

- deterministic SQLite schema, row-count and SHA-256 row-checksum manifests
- atomic `0600` metadata export bundle with tamper detection and drift comparison
- SQL portability audit and PostgreSQL URL credential redaction
- PostgreSQL schema translation, foreign-key-safe import planning
- transactional executor with rollback, cancellation and verified target receipts
- guarded offline import requiring explicit enablement and exact source confirmation
- read-only shadow verification with a curated SELECT catalog and least-privilege adapter
- driver-neutral live reads with deterministic sampling, circuit breaker and no
  result substitution
- fail-closed behavior when an undelivered PostgreSQL runtime is selected

SQLite remains the authoritative runtime. PostgreSQL observation is read-only and
disabled by default; no write path, dual-write or cutover is enabled.

### Engineering

- CI workflow running doctor, syntax check and the full test suite
- test suite grown from 6 to 198 tests

### Changed in this release

- Git operations that clone an entire repository — `importMirror`, and
  `withWorkingClone` behind `commitFile`, `mergeBranches` and `createDemoCommit` —
  now run through a non-blocking `execGitAsync` instead of `spawnSync`. Previously a
  browser commit or merge froze the event loop for its whole duration, stalling every
  other request on the instance. Measured on a small repository: a commit takes the
  same wall-clock time either way, but the event loop went from zero ticks during the
  operation to staying responsive throughout, with a worst-case stall of 6 ms. The
  read-only plumbing (branch, commit, tree and blob listing) is deliberately still
  synchronous — each is a single fast command, and converting it would cascade
  `await` through twelve modules and seventeen test files for no measurable gain.

- the release version is defined once in `src/version.mjs` and consumed by the
  server banner, `GET /api/health` and backup manifests, replacing three
  independently hardcoded copies
- `npm run check` globs `server.mjs src/*.mjs scripts/*.mjs public/*.js` instead of a
  4 KB hand-maintained file list that silently missed newly added files
- SMTP failures are tagged with the protocol stage that produced them, and permanent
  rejections at `RCPT TO` now suppress the recipient as a second signal alongside
  provider webhooks. Rejections at `MAIL FROM`, `AUTH` or `DATA`, quota responses and
  `5.7.x` policy blocks stay retryable, so a sender-side fault cannot blackhole a
  valid address.

### Fixed in this release

- `infra/nginx.conf` did not forward `Upgrade` and `Connection`, so the real-time
  notification WebSocket could not connect behind the bundled reverse-proxy
  template. The header value is derived per request through a `map` so ordinary
  keepalive is unaffected.
- a message suppressed while mid-flight was left in `processing`, where the outbox
  triggers then refused every status transition, stranding the row permanently. It
  is now cancelled explicitly.
- `docs/API.md` documented 8 of 27 API namespaces and described Git push
  authentication as using the shared development token rather than scoped personal
  access tokens.
- `docs/DEPLOYMENT.md` listed a required-variable set that cannot start a production
  instance, omitting every AuthKit variable, and `infra/docker-compose.yml` set
  `NODE_ENV=production` without passing any AuthKit configuration.
- `docs/NOTIFICATIONS_AND_EMAIL.md` listed real-time WebSocket delivery and provider
  bounce/complaint webhooks as not yet implemented after both had shipped.
- `test/backups-lfs.test.mjs` restored into a fixed path outside its temporary
  directory, so the directory survived cleanup and every run after the first failed
  with `RESTORE_TARGET_NOT_EMPTY` on the same machine.

## 0.1.0 — 2026-07-26

### Added

- Kuklabs-branded responsive web application
- local founder authentication and sessions
- Kuklabs organization seed
- real bare Git repository creation
- Git smart HTTP clone and push
- public repository mirror import
- branch, commit, tree and file browsing
- browser branch and file commit workflows
- issue tracking
- pull request comparison and merge
- deterministic KukAI repository health analysis
- audit logging
- Docker and reverse-proxy templates
- automated tests and operating documentation
