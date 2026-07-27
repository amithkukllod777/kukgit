# AuthKit Implementation Notes

This short file records the implementation boundary for issue #32.

- Production authentication mode is `authkit` only.
- Local password authentication is for development and tests only.
- KukGit keeps its local product user ID solely to preserve product-data foreign keys.
- `users.kuklabs_user_id` is the unique central identity mapping.
- Browser clients receive only an HttpOnly KukGit bridge cookie.
- AuthKit access and rotating refresh tokens are encrypted server-side.
- Protected browser APIs fail closed when central validation is unavailable.
- Verified AuthKit login scrubs any legacy local password hash.
- Git PAT, SSH and deploy-key credentials remain KukGit product credentials and are governed by repository permissions.

See `docs/ONE_KUKLABS_ACCOUNT.md` for the complete deployment and migration runbook.