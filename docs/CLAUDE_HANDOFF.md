# Claude Engineering Handoff

Current release: **v0.2.0** (Private Alpha)

## Mission

Continue KukGit as a production-grade AI-first developer platform without replacing
the working foundation with an unrelated rewrite.

## Read first

1. `README.md`
2. `KUKLABS_IDENTITY.md`
3. `docs/PRD.md`
4. `docs/ARCHITECTURE.md`
5. `docs/ROADMAP.md` — phase direction
6. `docs/TODO.md` — the prioritized execution queue
7. `SECURITY.md`
8. `CLAUDE.md`

## Before writing any code

Fetch first, then check what is already in flight. A stale working copy looks
exactly like an up-to-date one:

```bash
git fetch origin main && git log --oneline HEAD..origin/main
```

Then list open pull requests and remote branches. GitHub issues and pull requests are
authoritative for implementation status, not the local checkout.

This is not hypothetical. Real-time WebSocket notifications and email
bounce/complaint suppression were each built twice here, because the second attempt
started from a checkout two days behind `origin/main` and never fetched before
building. Both features already existed on `main`. The duplicated work was thrown
away.

## Where things stand

Phase 1 (private alpha) is substantially complete. Identity, Git authentication over
HTTP and SSH, permissions, external collaborators, governance, review, status checks,
webhooks, lifecycle, LFS, notifications (including real-time WebSocket delivery and
bounce/complaint suppression), backups and the instance-admin console all ship in
v0.2.0. See `CHANGELOG.md` for the delivery log.

The PostgreSQL program has delivered Stages 1–6. SQLite is still authoritative;
PostgreSQL observation is read-only and disabled by default.

## Immediate sprint

`docs/TODO.md` holds the ordered queue. The headline item is the remaining
PostgreSQL work under issue #43: the write path, PostgreSQL-backed integration CI,
an explicit maintenance-window cutover with rollback evidence, and backend-aware
backup/restore.

If a driver decision is still open, the recorded intent is to adopt `pg` as KukGit's
first runtime npm dependency rather than hand-writing a wire-protocol client. When
that lands, correct the "no runtime npm dependencies" claim honestly in the same
change — it appears in `README.md`, `docs/ARCHITECTURE.md`, `BUILD_REPORT.md` and
`docs/DEPLOYMENT.md`.

## Structural work worth doing alongside

Not roadmap features, but they compound if deferred:

- **Async Git execution — partly done.** `withWorkingClone`, `commitFile`,
  `mergeBranches`, `createDemoCommit` and `importMirror` now run through
  `execGitAsync` and no longer block the event loop. The read-only plumbing in
  `src/git.mjs` is still `spawnSync`; converting it would cascade `await` through
  twelve modules and seventeen test files for little gain, so it was left alone
  deliberately. What remains is a durable job queue so a long mirror import does
  not occupy its request for minutes.

- **Single-node workers.** Email, webhook, notification and access-review workers run
  on in-process timers, and the WebSocket registry is per process. Two instances
  against one database double-fire the workers and split real-time delivery.
- **Fold the `-safe` wrappers into their core modules.** Several modules patch
  behavior from outside rather than being fixed in place.
  `src/instance-admin-safe.mjs` creates SQLite triggers at runtime to reconcile a
  `website` / `website_url` column mismatch; that belongs in a migration.
- **Replace the dispatch if-chain.** `server.mjs` runs a long sequence of handler
  probes. Ordering is load-bearing and a mistake there is an authorization gap, not
  just a bug. A path-pattern router table would make the ordering explicit.

## Non-negotiable rules

- Do not clone or paste code from GitHub, GitLab, Gitea or Forgejo.
- Do not weaken tenant authorization.
- Do not execute shell command strings from user input.
- Do not store plaintext tokens or passwords.
- Do not expose repository source to an AI provider without explicit organization policy.
- Keep Git compatibility.
- Add audit events for material changes.
- Preserve exportability and avoid lock-in.
- Keep SQLite authoritative until the PostgreSQL cutover is explicitly approved and
  verified.

## Keeping documentation honest

Documentation drifted badly during the v0.2.0 cycle. `docs/API.md` covered 8 of 27
namespaces, `docs/DEPLOYMENT.md` described a configuration that could not boot in
production, `docs/NOTIFICATIONS_AND_EMAIL.md` listed two shipped features as not yet
implemented, and `CHANGELOG.md` had no entries after v0.1.0.

When adding a feature, update in the same change:

- `CHANGELOG.md` — what shipped
- `docs/API.md` — any new or changed endpoint
- `docs/DEPLOYMENT.md` and `.env.example` — any new environment variable
- `docs/NOTIFICATIONS_AND_EMAIL.md` or the relevant feature doc — including its
  "current limitations" list, which is the section that goes stale first
- `docs/ROADMAP.md` and `docs/TODO.md` — only when an item opens or closes

A quick check that catches most API drift:

```bash
comm -23 <(grep -rhoE "/api/[a-z-]+" src/*.mjs | sort -u) \
         <(grep -ohE "/api/[a-z-]+" docs/API.md | sort -u)
```

## Completion report format

For every sprint report:

- completed features
- files changed
- migrations
- tests run and result
- security impact
- remaining risks
- exact next sprint
