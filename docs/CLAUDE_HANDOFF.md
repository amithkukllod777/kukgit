# Claude Engineering Handoff

## Mission

Continue KukGit as a production-grade AI-first developer platform without replacing the working foundation with an unrelated rewrite.

## Read first

1. `README.md`
2. `KUKLABS_IDENTITY.md`
3. `docs/PRD.md`
4. `docs/ARCHITECTURE.md`
5. `docs/ROADMAP.md`
6. `SECURITY.md`
7. `CLAUDE.md`

## Immediate sprint

1. Add first-run setup that removes fixed development credentials.
2. Add organization invitations and team management.
3. Add personal access tokens with scopes and expiry.
4. Replace the shared Git push token with PAT validation.
5. Add SSH public-key storage and design the SSH Git gateway.
6. Add branch protection rules.
7. Add pull-request comments, approvals and review threads.
8. Add PostgreSQL storage adapter while preserving tests.
9. Add webhook subscriptions and signed deliveries.
10. Add integration tests for clone, push, branch, PR and merge.

## Non-negotiable rules

- Do not clone or paste code from GitHub, GitLab, Gitea or Forgejo.
- Do not weaken tenant authorization.
- Do not execute shell command strings from user input.
- Do not store plaintext tokens or passwords.
- Do not expose repository source to an AI provider without explicit organization policy.
- Keep Git compatibility.
- Add audit events for material changes.
- Preserve exportability and avoid lock-in.

## Completion report format

For every sprint report:

- completed features
- files changed
- migrations
- tests run and result
- security impact
- remaining risks
- exact next sprint
