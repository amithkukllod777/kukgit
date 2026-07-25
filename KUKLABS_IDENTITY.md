# Kuklabs Identity and Infrastructure Mandate

KukGit follows the Kuklabs identity mandate.

## One Kuklabs Account

Production authentication must use the shared Kuklabs Account/AuthKit contract. KukGit must not create an independent customer identity silo.

Required production login options:

- mobile number or email
- password
- Google sign-in
- account recovery
- MFA
- organization and tenant membership
- global logout and session revocation

## Tenant model

- `user`: one human identity across Kuklabs products
- `company/organization`: a tenant that owns repositories and subscriptions
- `membership`: user-to-organization role
- `product access`: KukGit entitlement and plan

One user may belong to multiple organizations. A repository belongs to exactly one organization.

## Data architecture

The shared Kuklabs identity, company registry, plans and entitlements remain authoritative. Git objects, build artifacts and package blobs are high-volume product data and may use dedicated KukGit storage services while preserving shared identity and tenant IDs.

## Branding

- Product name: KukGit
- Parent: Kuklabs Inc.
- Universal Kuklabs K logo
- Powered by Kuklabs
- Common profile, version, legal and support patterns across products
