# Organization Self-Service Onboarding

KukGit allows an authenticated user to create an organization workspace without instance-administrator intervention. The creator becomes the organization Owner and is added as Maintainer of a default Developers team.

## Identity requirement

In AuthKit mode, workspace creation requires:

- an active One Kuklabs Account session
- active KukGit product access
- an active central device session
- a verified central email address

KukGit local-development users may create workspaces in local mode. Production must continue to use central AuthKit.

## User flow

A user with no organization and no repository-only collaboration access is guided to:

```text
#/organizations?onboarding=1
```

The onboarding form collects:

- organization name
- permanent workspace slug
- optional description
- optional HTTPS website
- company-size range

Existing organization members see a **Create organization** action on the Organizations page while they remain below the ownership limit.

Repository-only external collaborators are not forced into workspace creation. They continue to see repositories explicitly shared with them.

## API

```text
GET  /api/onboarding/status
GET  /api/onboarding/organizations/slug/:slug
POST /api/onboarding/organizations
```

All endpoints require authentication. Mutating requests require a same-origin browser request and accept at most 64 KiB of JSON.

### Status response

The status endpoint returns:

- current product user summary
- accessible non-system organizations
- current Owner count
- configured Owner limit
- whether another workspace may be created
- suggested workspace slug
- accepted company-size values

### Create request

```json
{
  "name": "Example Technologies",
  "slug": "example-technologies",
  "description": "Product engineering workspace",
  "website": "https://example.com",
  "companySize": "11-50"
}
```

The first workspace is created on the free plan. Billing and upgraded limits will be added through the subscription and usage-metering milestone.

## Atomic creation

Organization creation runs in one immediate database transaction:

1. reserve and insert the organization slug
2. add the creator with the `owner` role
3. create the default `developers` team
4. add the creator to that team as `maintainer`
5. commit the complete workspace

Any failure rolls back all four records. A partially created organization, Owner membership or default team must never remain.

The successful transaction emits:

```text
organization.self_service_created
```

Audit metadata includes the organization slug, free plan, company-size range, identity source and whether a website was supplied. It does not include passwords, tokens or unnecessary personal data.

## Slug policy

Workspace slugs:

- contain 2 to 63 lowercase letters, numbers or hyphens
- begin with a letter or number
- are globally unique
- are treated as permanent public identifiers in repository paths
- cannot use system or product-reserved names

Examples of reserved slugs include:

```text
admin
api
auth
billing
docs
git
kukgit
kukgit-trash
kuklabs
login
onboarding
organizations
repositories
settings
status
system
```

The database unique constraint is the final authority. The availability endpoint improves usability but does not replace transaction-time collision handling.

## Organization ownership limit

Configure the maximum number of non-system organizations a user may own:

```bash
KUKGIT_ORGANIZATION_OWNER_LIMIT=5
```

The value must be a positive number. KukGit counts organizations where the user has the `owner` role and excludes system-plan organizations.

Changing this value affects future creation attempts only. Existing organizations are not removed or downgraded.

For plan-based limits later, this instance-level setting should become a billing entitlement rather than being removed from the transaction guard.

## Organization profile fields

The onboarding migration adds:

```text
organizations.description
organizations.website
organizations.company_size
organizations.onboarding_completed_at
organizations.created_by
```

Website URLs must use HTTPS and must not contain embedded credentials. URL fragments are removed before storage.

Accepted company-size values:

```text
solo
2-10
11-50
51-200
201-1000
1000+
```

## Existing organization and invitation flows

Self-service creation does not alter:

- organization invitation acceptance
- member roles
- teams and team grants
- repository-only external collaboration
- repository creation and import
- repository transfer rules

An invited user may accept an organization invitation without creating a separate workspace.

## Support procedures

### Slug already taken

Ask the user to choose another slug. Do not rename or delete an unrelated organization to satisfy a request without verified ownership and an approved administrative workflow.

### Reserved slug request

Reserved names protect application routes, system tenants and future product namespaces. Keep them blocked unless the product-routing architecture is deliberately changed and tested.

### Ownership limit reached

Confirm the configured instance limit and the user's Owner memberships. Do not directly insert a new organization to bypass the transaction guard. Use a future plan entitlement or an approved temporary configuration change.

### Identity verification required

The user must verify the email in One Kuklabs Account. KukGit must not mark a central identity as verified locally.

### Failed creation

Check for:

- duplicate slug errors
- invalid HTTPS website values
- company-size validation
- owner-limit enforcement
- database transaction errors

After a failed transaction, verify that no organization with the requested name or slug exists and that no orphan team or membership was created.

## Rollout

1. create and verify a KukGit backup
2. deploy the schema migration and onboarding API
3. set `KUKGIT_ORGANIZATION_OWNER_LIMIT`
4. test a new verified AuthKit user with zero organizations
5. verify Owner membership and the Developers team
6. verify organization invitation acceptance still works
7. verify a repository-only collaborator is not redirected
8. monitor `organization.self_service_created` audit events and error codes

## Important error codes

```text
ORGANIZATION_NAME_INVALID
ORGANIZATION_DESCRIPTION_INVALID
ORGANIZATION_WEBSITE_INVALID
ORGANIZATION_WEBSITE_HTTPS_REQUIRED
ORGANIZATION_WEBSITE_CREDENTIALS
ORGANIZATION_COMPANY_SIZE_INVALID
ORGANIZATION_SLUG_RESERVED
ORGANIZATION_SLUG_TAKEN
ORGANIZATION_OWNER_LIMIT_REACHED
ORGANIZATION_VERIFIED_EMAIL_REQUIRED
ONBOARDING_REQUEST_TOO_LARGE
CSRF_BLOCKED
```

## Automated coverage

Tests verify:

- atomic organization, Owner and default-team creation
- audit output without secrets
- reserved slug rejection
- duplicate slug race handling
- rollback without partial records
- ownership-limit enforcement
- verified AuthKit email requirement
- same-origin protection
- HTTPS website validation
- slug availability responses
