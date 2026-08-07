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

The PostgreSQL program has delivered Stages 1–7. SQLite is still authoritative;
PostgreSQL observation is read-only and disabled by default, and production
cutover remains open under issue #43.

KukGit now owns first-party accounts. Verified email, password reset,
self-service signup, GitHub/Google OAuth, optional phone verification, TOTP and
recovery codes are implemented. AuthKit remains an optional mode.

## Immediate sprint

`docs/TODO.md` holds the ordered queue. The immediate gates are trustworthy
repository CI execution, real-provider validation, production recovery evidence
for the selected identity mode and the remaining PostgreSQL cutover work under
issue #43.

`pg` is KukGit's only declared runtime npm dependency. It is lazily loaded for
PostgreSQL paths and must stay covered by licence, vulnerability and lockfile
checks.

## Structural work worth doing alongside

Not roadmap features, but they compound if deferred:

- **Async Git execution — partly done.** `withWorkingClone`, `commitFile`,
  `mergeBranches`, `createDemoCommit` and `importMirror` now run through
  `execGitAsync` and no longer block the event loop. The read-only plumbing in
  `src/git.mjs` is still `spawnSync`; converting it would cascade `await` through
  twelve modules and seventeen test files for little gain, so it was left alone
  deliberately. What remains is a durable job queue so a long mirror import does
  not occupy its request for minutes.

- **Prove the multi-instance deployment.** Job leases, stranded-row recovery,
  cross-instance notification fan-out, concurrent migration locking and
  connection draining are implemented. They still need a real load balancer,
  shared storage/object store and failure rehearsal before high availability can
  be claimed.
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
