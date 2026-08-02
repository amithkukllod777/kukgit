# KukGit Support Access

How a Kuklabs operator helps with a problem they cannot reproduce, without
becoming the customer.

## The problem impersonation solves, and what it costs

A customer says pushes are being rejected. The Instance Admin Console is
read-only and tenant-scoped by design, and sometimes it is not enough: the answer
is in a file, a branch rule interaction, a specific commit. The usual industry
answer is a "log in as this user" button.

That button is cheap to build and impossible to bound. Once it exists:

- the audit trail says the *customer* did it, so nothing distinguishes support
  from a compromised support account
- it carries the user's full permission, including write and admin
- nobody outside the operator's own company can see it happened
- it needs no agreement from anybody who owns the data

KukGit does not have that button and is not going to. Support access is the
replacement.

## What it is

A **customer-granted, time-boxed, read-only** grant to a named operator, who acts
as themselves throughout.

```text
POST /api/orgs/:org/support-access          {"operatorEmail": "…", "reason": "…", "hours": 24, "repoSlug": "app"}
GET  /api/orgs/:org/support-access
POST /api/orgs/:org/support-access/:id/revoke
GET  /api/instance-admin/support-access     what this operator currently holds
```

Five rules, each of which is the answer to one of the costs above.

**The customer grants it.** An organization **owner**, with a written reason of at
least twenty characters. An operator cannot grant it to themselves, and there is
no route that would let them. This single rule is the whole difference between
this and impersonation: the access exists because somebody who owns the data said
so.

**It is read-only.** Always, whatever the ticket says. An escalation path that can
also write is a way to change a customer's repository with nobody in the
organization having agreed to it. There is a test that asserts the grant confers
`read` and refuses `triage`, `write`, `maintain` and `admin`.

**It expires.** Between one and 72 hours, defaulting to 24. Three days is long
enough to work an escalation across a weekend and short enough that nobody has to
remember to take it away — a grant somebody forgot about is not still open next
month.

**It is revocable instantly**, by any organization admin, and by the operator
themselves. Nobody should have to wait for a customer to take away access support
has finished with.

**It is the operator's own identity.** Logs say who read what. Nothing anywhere
says "acting as".

## What the customer can see

`GET /api/orgs/:org/support-access` returns every grant with what was done under
it, and **any member of the organization can read it** — not only the owner who
granted it. Support having read a repository is something the people whose work
it is are entitled to know, and restricting the record to whoever already knew
would make it evidence for nobody.

Uses are bucketed to the minute per repository and action. One `git clone` is many
HTTP requests, and a log a person cannot read is not transparency. What matters is
*that* support read this repository at this time.

A grant with **zero uses** is visible too. "We asked for access and never needed
it" is worth being able to show.

## Scope

`repoSlug` limits the grant to one repository; without it the grant covers the
organization. A repository-scoped grant does not open anything else, which is what
makes it safe to answer "can you look at this one repo" with yes.

## How it is enforced

The grant is an ordinary **source** in repository access resolution, alongside
organization membership, direct collaborators and teams — not a bypass placed
before the check. So it appears wherever access is explained, and the customer can
see that a read was allowed by support's grant rather than wonder.

Two conditions are re-checked on **every** access, not trusted from the grant row:

- the grant is unexpired and unrevoked
- the holder is **still** on the instance's operator list

The second matters more than it looks. Somebody leaving support should not keep
reading customer repositories until every grant they happen to hold expires.

An operator who is also a member of the organization — a Kuklabs engineer working
on Kuklabs' own repositories — reads as the member. Their grant is not consumed
and nothing is logged against it. Otherwise a customer's record would say
"support read your repository" about somebody doing their day job.

Where the operator list is unavailable to the code doing the check, there is **no
support access at all**. A check that cannot be performed fails closed.

## What it still does not reach

- **Secrets.** Reading the vault needs organization admin, and this grant is
  `read`.
- **Anything that writes.** Settings, members, branch rules, merges, pushes.
- **Other tenants.** A grant names one organization.
- **Deleting or exporting a tenant.** Those are instance-administrator
  operations with their own records — see [Tenant Deletion](TENANT_DELETION.md).

## Not done yet

- **Notifying the organization** when a grant is created or first used. It is
  visible on request; it should arrive uninvited.
- **A console for the operator** to see and end their own grants beyond the JSON
  route.
- **Approval by a second owner** for organization-wide grants. Worth it for
  larger customers, unnecessary for a two-person team.
- **A standing "never grant support access" organization setting**, for
  customers whose answer is always no.

## Related

- [Instance Admin Console](INSTANCE_ADMIN_CONSOLE.md) — the read-only,
  tenant-scoped diagnostics that come first
- [Repository Access](REPOSITORY_ACCESS.md) — the sources a permission is
  resolved from
- [Operations Boundary](OPERATIONS_BOUNDARY.md) — what Kuklabs operates and how
  it is watched
