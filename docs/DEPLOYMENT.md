# Deployment Guide

Applies to KukGit v0.2.0.

## Requirements

- Node.js 22.5 or newer (`node:sqlite` is required)
- Git CLI 2.40 or newer
- OpenSSH server, only if Git over SSH is offered
- A persistent volume for `data/`

There are no runtime npm dependencies to install.

## Local development

```bash
cp .env.example .env
npm run doctor
npm run seed
npm start
```

Development defaults to `KUKGIT_AUTH_MODE=local` with the seeded founder account
documented in the README. These defaults are for isolated development only.

## Choosing an authentication mode

This is the decision that most often blocks a first production boot.

| | `local` | `authkit` |
|---|---|---|
| Password store | KukGit `users.password_hash` | One Kuklabs Account (central) |
| Allowed in production | No, unless explicitly overridden | Yes — this is the default |
| Required configuration | `KUKGIT_ADMIN_*` | `KUKGIT_AUTHKIT_*` |

When `NODE_ENV=production`, KukGit defaults to `authkit` and **refuses to start** in
`local` mode. The error comes from `loadConfig()` before the HTTP server binds:

```text
Local KukGit password authentication is disabled in production.
Use KUKGIT_AUTH_MODE=authkit.
```

`KUKGIT_ALLOW_LOCAL_AUTH_IN_PRODUCTION=true` overrides this. Do not use it for a
customer-facing instance.

## Required production environment

```bash
NODE_ENV=production
KUKGIT_BASE_URL=https://git.example.com
KUKGIT_COOKIE_SECURE=true

# Identity — One Kuklabs Account
KUKGIT_AUTH_MODE=authkit
KUKGIT_AUTHKIT_BASE_URL=https://auth.kuklabs.com
KUKGIT_AUTHKIT_PRODUCT_ID=kukgit
KUKGIT_AUTHKIT_ENCRYPTION_KEY=<at least 32 random characters>

# Operator allowlist for the Instance Admin console
KUKGIT_INSTANCE_ADMIN_EMAILS=support@example.com
```

KukGit fails to start if any of these is missing or malformed:

- `KUKGIT_AUTHKIT_BASE_URL` must be absolute, HTTPS in production, and must not
  contain embedded credentials.
- `KUKGIT_AUTHKIT_ENCRYPTION_KEY` must be at least 32 characters. It encrypts
  AuthKit access and refresh tokens at rest; rotating it invalidates every stored
  bridge session and forces re-login.
- `KUKGIT_AUTHKIT_PRODUCT_ID` must be 2–32 characters of `[a-z0-9_-]`.

`KUKGIT_DEV_GIT_TOKEN` is **not** used in production — the shared development Git
token is rejected when `NODE_ENV=production`. Git HTTP authentication uses scoped
personal access tokens instead.

`KUKGIT_ADMIN_EMAIL`, `KUKGIT_ADMIN_PASSWORD` and `KUKGIT_ADMIN_NAME` seed the local
development founder. In AuthKit mode the password is never used;
`KUKGIT_ADMIN_EMAIL` still acts as the fallback instance-admin allowlist entry when
`KUKGIT_INSTANCE_ADMIN_EMAILS` is unset.

## Required before enabling each feature

These are not needed to boot, but the matching feature fails or stays disabled
without them. The server prints a startup warning for each.

| Variable | Needed for |
|---|---|
| `KUKGIT_WEBHOOK_ENCRYPTION_KEY` | Creating repository webhooks (32+ characters) |
| `KUKGIT_LFS_AUTH_KEY` | Git LFS over SSH (32+ characters) |
| `KUKGIT_SMTP_HOST` and `KUKGIT_SMTP_*` | Invitations, notifications, all transactional email |
| `KUKGIT_EMAIL_PROVIDER_EVENTS_ENABLED` + `KUKGIT_EMAIL_PROVIDER_WEBHOOK_SECRET` | Provider bounce/complaint callbacks (32+ characters) |
| `KUKGIT_SSH_HOST`, `KUKGIT_SSH_PORT`, `KUKGIT_SSH_USER` | Correct SSH clone URLs in the UI |
| `KUKGIT_NODE_BINARY`, `KUKGIT_SSH_COMMAND_SCRIPT` | OpenSSH forced-command integration |

Real-time notifications and SMTP-observed bounce suppression need no configuration;
both are on by default. Their tuning knobs (`KUKGIT_REALTIME_*`,
`KUKGIT_EMAIL_SOFT_BOUNCE_*`) are documented in
[Notifications and Transactional Email](NOTIFICATIONS_AND_EMAIL.md).

See `.env.example` for the complete variable list including LFS quotas, backup
retention and email worker tuning.

## Verify configuration before starting

```bash
npm run doctor
```

`doctor` loads the real configuration and checks Node, Git, data/LFS/backup
directories, quota sanity, signing keys, SMTP reachability, the notification worker
and the SSH forced-command runtime. It also runs `doctor-database.mjs`, which
validates the metadata driver selection and any PostgreSQL readiness marker.

A failing `doctor` run means the server will not start correctly. Fix it first.

## Container

```bash
docker compose -f infra/docker-compose.yml up --build
```

The compose file reads configuration from the environment (or a sibling `.env`) and
mounts `kukgit_data` at `/app/data`. It sets `NODE_ENV=production`, so the AuthKit
variables above are required. For a local production-shaped trial without AuthKit,
set `KUKGIT_AUTH_MODE=local` and `KUKGIT_ALLOW_LOCAL_AUTH_IN_PRODUCTION=true`.

The image installs Git and runs as the unprivileged `node` user. It does not include
an SSH server; run Git over SSH as a separate service against the same volume.

## Reverse proxy

The included Nginx template (`infra/nginx.conf`):

- forwards the web and API service
- allows large Git request bodies (`client_max_body_size 2g`)
- disables request and response buffering for Git protocol streams
- forwards `Upgrade` and `Connection` for WebSocket upgrades
- sets `X-Forwarded-Proto` and `X-Forwarded-For`

Terminate TLS at the proxy and set `KUKGIT_BASE_URL` to the external HTTPS URL. The
Origin check that protects state-changing requests compares against
`KUKGIT_BASE_URL`, so a mismatch surfaces as `403 CSRF_BLOCKED` on every write — and
also rejects WebSocket upgrades.

Adjust `client_max_body_size` if `KUKGIT_LFS_MAX_OBJECT_BYTES` is raised above 2 GB.

### Rate limiting and X-Forwarded-For

Rate limiting is on by default. Anonymous callers are bucketed by source address,
so **`KUKGIT_TRUST_PROXY=true` is required behind a reverse proxy**:

```bash
KUKGIT_TRUST_PROXY=true
```

Without it, every request arrives from the proxy's address and all anonymous
callers share a single bucket — one noisy client throttles everyone, and the auth
limit stops being per-attacker. The bundled Nginx template already sets
`X-Forwarded-For`, so any deployment using it must set this.

The inverse is worse: never set it when KukGit is reachable directly, because
`X-Forwarded-For` is client-supplied and a caller could mint a fresh identity per
request, bypassing every limit.

Default budgets, all per identity per minute with a burst allowance:

| Surface | Per minute | Burst | Covers |
|---|---|---|---|
| `auth` | 20 | 10 | login, signup, OTP, Google exchange |
| `api` | 600 | 120 | authenticated browser API |
| `git` | 1200 | 240 | Git smart HTTP |
| `invitation` | 30 | 10 | organization and repository invitations, resends |
| `webhook` | 60 | 20 | webhook create, ping, redeliver |

Tune with `KUKGIT_RATE_LIMIT_<SURFACE>_PER_MINUTE` and `_BURST`, or disable
entirely with `KUKGIT_RATE_LIMIT_ENABLED=false`. An exhausted budget answers `429`
with `Retry-After` and `RateLimit-*` headers.

Two limits to plan around: **Git over SSH is not covered**, because it is served by
an OpenSSH forced command rather than the HTTP server, and **state is per
instance**, so running two instances doubles the effective allowance.

### WebSocket upgrades

Real-time notifications use a WebSocket at `/api/notifications/socket`. The upgrade
fails unless the proxy forwards the hop-by-hop upgrade headers:

```nginx
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection $connection_upgrade;
```

`$connection_upgrade` comes from a `map` in the http context, which the template
includes. Hard-coding `Connection: upgrade` instead would break keepalive on
ordinary requests.

Keep `proxy_read_timeout` above `KUKGIT_REALTIME_HEARTBEAT_MS`; the template's
`3600s` covers the 25-second default. If notifications only update on page
navigation, check this first.

## Git over SSH

`infra/sshd_config.kukgit` is a hardened drop-in: public-key only, no forwarding, no
TTY, `AuthorizedKeysFile none` and dynamic key resolution through
`AuthorizedKeysCommand`.

```bash
cp infra/sshd_config.kukgit /etc/ssh/sshd_config.d/kukgit.conf
systemctl reload sshd
```

The command runs as the `git` user and must be able to read the KukGit database. If
dynamic resolution is unavailable, generate a restricted static fallback:

```bash
npm run ssh:authorized-keys
```

Read [SSH Keys and Git over SSH](SSH_KEYS.md) for the full procedure.

## Backups

Use the verified snapshot workflow rather than copying files from a running
instance:

```bash
npm run backup -- maintenance on --reason "Scheduled backup"
npm run backup -- create
npm run backup -- verify --archive <file.kgbak>
npm run backup -- maintenance off
```

A `.kgbak` snapshot contains SQLite metadata, Git bundles and all recorded LFS
objects with SHA-256 checksums. Maintenance mode quiesces writes so the snapshot is
transactionally consistent.

Copy snapshots off the instance volume. Restore is deliberately CLI-only and writes
only to a missing or empty target directory:

```bash
npm run backup -- restore --archive <file.kgbak> --target /srv/kukgit-restore --dry-run
```

Read [Verified Backups and Disaster Recovery](BACKUPS_AND_RESTORE.md).

## Recovery rehearsal

Prove the backups on a schedule instead of during an incident:

```bash
npm run rehearse -- --operator "<name>" --evidence /srv/evidence/$(date -u +%Y-%m-%d).json
```

The drill restores into a throwaway directory and never touches the live
instance. It exits non-zero if any automated check fails, so it is safe to run
from cron with alerting on the exit code. Keep the evidence files — they carry
the measured recovery time and data-loss window.

Read [Production Recovery Rehearsal](RECOVERY_REHEARSAL.md) for the manual
sign-off steps that a backup deliberately cannot cover.

## Metadata database

KukGit runs on SQLite. The PostgreSQL program has delivered offline import and
read-only shadow/live-read stages, but **SQLite remains authoritative** and no write
path or cutover is enabled. PostgreSQL observation is disabled by default and
read-only.

```bash
npm run database -- inventory
npm run database -- export
npm run database -- verify-export
npm run database -- audit-sql
npm run database -- postgresql-status
```

Read [PostgreSQL Metadata Migration](POSTGRESQL_MIGRATION.md) and the safety
boundary in [ROADMAP.md](ROADMAP.md).

## Monitoring

Two probes and one operator surface:

```text
GET /api/health           liveness  — is the process up
GET /api/health/ready     readiness — can this instance serve (200 / 503, no detail)
GET /api/instance-admin/health      saturation signals, operator-only
```

Point the load balancer at `/api/health/ready`. Point alerting at
`/api/instance-admin/health`: every signal carries the thresholds it was judged
against and a verdict of `ok`, `warning` or `critical`, with an overall `status`.
Alert immediately on `critical` and on sustained `warning`; these are levels, not
events.

Thresholds are configuration (`KUKGIT_SATURATION_QUEUE_DEPTH_WARNING`,
`..._QUEUE_AGE_CRITICAL_SECONDS`, `..._DISK_FREE_WARNING_PERCENT`,
`..._BACKUP_AGE_CRITICAL_SECONDS` and the rest), so every deployment alerts on
the same numbers.

Two signals deserve attention:

- `*.stuck_processing` is critical at a count of one. A row stuck in `processing`
  was claimed by a worker that died, and nothing currently requeues it.
- `backups.newest_age` reports an instance that has never been backed up as
  critical, not as zero. A missing backup must never read as a fresh one.

Read [Operations Boundary](OPERATIONS_BOUNDARY.md) for the full signal list,
incident severities and the rollback procedure.

## Operational limits of this release

Plan capacity with these in mind:

- **Single node.** Sessions, the email outbox, webhook deliveries, notifications and
  access-review campaigns run on in-process `setInterval` workers. Two instances
  against one volume double-fire them.
- **Per-process WebSockets.** The real-time registry is not shared between
  instances, so a notification reaches only sockets held by the instance that
  created it.
- **Partially synchronous Git.** The expensive operations — mirror import, browser
  commits and merges, all of which clone a whole repository — run off the event
  loop. The read-only plumbing (branch, commit, tree and blob listing) is still
  synchronous; each is a single fast command, but a very large repository can
  still stall a request briefly. There is no job queue yet, so a long import still
  occupies its request for the full duration.
- **Local storage.** Repositories and LFS objects live on the instance volume.
- **Per-instance rate limits.** The limiter is in-process, so limits are enforced
  per instance rather than per cluster, and Git over SSH is not covered at all.
- **No rate limiting.** No per-user, per-token or per-IP limits exist on any surface.

## Public deployment warning

Do not expose this release as a public commercial service. Complete the production
blockers in [SECURITY.md](../SECURITY.md) and the private-alpha exit work in
[ROADMAP.md](ROADMAP.md) first.
