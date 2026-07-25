# KukGit Foundation API

Base path: `/api`

All endpoints except health and login require the `kukgit_session` cookie.

## Authentication

```text
POST /auth/login
POST /auth/logout
GET  /auth/me
```

## Dashboard and organizations

```text
GET /health
GET /dashboard
GET /orgs
GET /audit
```

## Repositories

```text
GET  /repos
POST /repos
POST /repos/import
GET  /repos/:org/:repo
GET  /repos/:org/:repo/branches
POST /repos/:org/:repo/branches
GET  /repos/:org/:repo/commits?ref=main
GET  /repos/:org/:repo/tree?ref=main&path=src
GET  /repos/:org/:repo/blob?ref=main&path=README.md
POST /repos/:org/:repo/files
```

## Issues

```text
GET   /repos/:org/:repo/issues
POST  /repos/:org/:repo/issues
PATCH /repos/:org/:repo/issues/:number
GET   /issues
```

## Pull requests

```text
GET  /repos/:org/:repo/pulls
POST /repos/:org/:repo/pulls
POST /repos/:org/:repo/pulls/:number/merge
GET  /pulls
```

## Repository analysis

```text
GET  /repos/:org/:repo/analyze
POST /repos/:org/:repo/analyze
```

## Git smart HTTP

```text
/git/:org/:repo.git/*
```

Public fetch is allowed for public repositories. Private fetch and all pushes require HTTP Basic credentials whose password matches the configured development Git token.

## Error shape

```json
{
  "error": {
    "code": "REPO_NOT_FOUND",
    "message": "Repository not found.",
    "requestId": "req_..."
  }
}
```
