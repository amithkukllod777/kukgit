# Deployment Guide

## Development

```bash
npm run seed
npm start
```

## Container

```bash
docker compose -f infra/docker-compose.yml up --build
```

The compose file mounts `/app/data` as persistent storage.

## Reverse proxy

The included Nginx template:

- forwards the web/API service
- permits large Git request bodies
- disables response buffering for Git protocol streams
- sets forwarding headers

## Required environment variables for any shared environment

```text
KUKGIT_BASE_URL
KUKGIT_ADMIN_EMAIL
KUKGIT_ADMIN_PASSWORD
KUKGIT_DEV_GIT_TOKEN
KUKGIT_COOKIE_SECURE=true
```

Use secret management rather than committed `.env` files.

## Public deployment warning

Do not expose v0.1.0 as a public commercial service. First complete the production blockers in `SECURITY.md` and Phase 1 of the roadmap.

## Backup

For the foundation MVP, back up together:

- `data/kukgit.db`
- `data/repos/`

A consistent backup should pause writes or snapshot the volume atomically. Production will use PostgreSQL backups plus replicated Git/object storage.
