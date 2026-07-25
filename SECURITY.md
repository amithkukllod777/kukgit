# Security Policy

KukGit v0.1.0 is a development foundation and must not be exposed directly to the public internet without the production hardening described below.

## Report a vulnerability

Do not create a public issue for a suspected vulnerability. Report it privately to the Kuklabs security owner and include:

- affected version and environment
- reproduction steps
- expected and actual behavior
- security impact
- proof of concept with secrets removed

## Production blockers in v0.1.0

- Development Git push token is shared server-wide.
- Local username/password authentication is not yet Kuklabs Account SSO.
- SQLite is used for the single-node MVP metadata store.
- Repository objects are stored on local disk.
- No malware scanning, abuse detection or upload quarantine exists.
- No SSH Git transport or deploy-key lifecycle exists.
- No rate limiting or distributed session revocation exists.
- Secret detection is heuristic and cannot guarantee credential safety.

## Required controls before public beta

1. One Kuklabs Account with SSO, MFA and secure account recovery.
2. Personal access tokens with scopes, expiry, rotation and revocation.
3. SSH keys, deploy keys and signed host keys.
4. PostgreSQL, encrypted object storage and encrypted backups.
5. Per-tenant authorization on every data and Git operation.
6. Rate limiting, WAF, bot mitigation and abuse controls.
7. Secret scanning with verified patterns and push protection.
8. Dependency, container, IaC and license scanning.
9. Centralized logs, immutable audit trail and alerting.
10. Regular penetration testing, incident response and disaster recovery exercises.

## Current secure defaults

- Repository and organization slugs are strictly validated.
- Browser file paths block traversal.
- Import URLs block local/file protocols, embedded credentials and obvious private hosts.
- Git processes are invoked with argument arrays rather than shell command strings.
- Session cookies are HttpOnly and SameSite=Lax.
- State-changing browser requests validate Origin.
- Browser security headers include CSP, frame denial and MIME sniffing protection.
- Passwords use scrypt with random salts.
- Session tokens are random and stored as SHA-256 hashes.
