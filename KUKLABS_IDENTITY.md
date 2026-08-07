# Kuklabs Identity and Infrastructure Mandate

KukGit follows the Kuklabs identity mandate.

## KukGit accounts and optional One Kuklabs Account

KukGit owns its first-party customer accounts. Production may use KukGit-local
email/password identity or the optional shared Kuklabs Account/AuthKit contract.
The choice is explicit per instance; neither mode may silently fall back to the
other.

Current identity capabilities:

- email and password in local mode
- optional Google and GitHub sign-in in local mode
- optional AuthKit delegation
- email verification and password recovery
- TOTP MFA with recovery codes
- optional verified phone link; phone-number sign-in is not implemented
- organization and tenant membership
- logout and session revocation within the selected identity boundary

## Tenant model

- `user`: one KukGit product identity; optional provider links may connect it to a verified external identity
- `company/organization`: a tenant that owns repositories and subscriptions
- `membership`: user-to-organization role
- `product access`: KukGit entitlement and plan

One user may belong to multiple organizations. A repository belongs to exactly one organization.

## Data architecture

KukGit is authoritative for its users, organizations, plans and entitlements.
Verified AuthKit, GitHub, Google, phone and future provider links attach to that
product user without replacing repository foreign keys or silently merging
unverified addresses. Git objects, build artifacts and package blobs use
dedicated KukGit storage boundaries.

## Branding

- Product name: KukGit
- Parent: Kuklabs Inc.
- Universal Kuklabs K logo
- Powered by Kuklabs
- Common profile, version, legal and support patterns across products
