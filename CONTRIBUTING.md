# Contributing to KukGit

KukGit is currently a private Kuklabs product.

## Branches

- `main`: releasable foundation
- `feature/<name>`: product features
- `fix/<name>`: bug fixes
- `security/<name>`: private security remediation

## Commit convention

Use concise imperative messages:

```text
feat: add repository invitation flow
fix: prevent invalid branch ref creation
security: scope Git push tokens per repository
chore: update deployment documentation
```

## Pull request requirements

- explain user and business impact
- include tests for behavior changes
- document security implications
- preserve multi-tenant isolation
- avoid introducing dependencies without license review
- update docs and API contracts when relevant

## Definition of done

- tests pass
- input validation is covered
- authorization checks are explicit
- audit events exist for material changes
- UI works on desktop and mobile
- no production secrets or credentials are committed
