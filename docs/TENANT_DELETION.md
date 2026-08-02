# KukGit Tenant Deletion

Removing an organization, and being able to prove it.

## The problem with a delete list

The obvious implementation is a list of tables to delete from. It is correct on
the day it is written and wrong by the next migration — and the failure is
silent: the tenant is deleted, the report says complete, and rows nobody
enumerated are still in the database.

So the list is **derived from the schema** instead. `tenantTableGraph` walks
foreign keys outward from `organizations` and produces:

- a **delete order**, deepest first, so children go before the rows they point at
  and foreign keys hold at every step rather than being switched off
- an **unreachable** list, each entry with a written reason
- an **unclassified** list — tables that are neither reachable nor explained

A non-empty `unclassified` list **fails the deletion**. A table nobody has
classified is not evidence of a clean deletion; it is evidence that nobody
looked. Adding a table to the schema either includes it automatically or breaks
the test that asserts the list is empty.

### Two things this found immediately

**`secrets` was invisible.** It is scoped by `(scope, scope_id)` with no foreign
key, so no graph can see it. Left alone, deleting an organization would have left
its encrypted credentials in the database forever. Polymorphic tables now carry a
hand-written clause, and the derivation reports any that lack one.

**`repositories` linked through the wrong column.** It has
`organization_id NOT NULL` and a nullable `deleted_from_org_id` left by the trash
workflow, and taking the first matching foreign key picked the nullable one —
which is null for every live repository. Every table reachable *through*
repositories was then scoped by that column, and a census printed almost nothing.
A deletion would have reported success having removed a single row.

The fix is to prefer a `NOT NULL` link: a nullable foreign key is optional and
cannot be the ownership path.

## The census

```text
GET /api/instance-admin/tenants/:slug/census
```

Every row the tenant owns, table by table. Run before a deletion it is what
somebody is agreeing to destroy; run after, every number must be zero.

## Requesting

```text
POST /api/instance-admin/tenants/deletions   {"slug": "acme", "reason": "…"}
POST /api/instance-admin/tenants/deletions/:id/cancel
GET  /api/instance-admin/tenants/deletions
```

**Instance administrator only**, all of it. Deleting a tenant destroys other
people's work; an organization owner can *ask*, but only the operator running the
instance carries it out. The record of who asked and who executed is why that
distinction is worth keeping.

A reason of at least twenty characters is required, and two scheduled deletions
for one tenant are refused — two of them means two people believe different
things about when it happens.

## The seven-day wait

A request schedules; it does not delete. The delay is the whole feature: deletion
is the one operation with no undo, and the most common reason to want one
reversed is that it was a mistake noticed within the hour. A request that
executed immediately would be correct and useless.

Cancellation is available for the whole window and is recorded.

## The proof

After execution a second census runs against the same schema-derived list, and
the request stores it:

```json
"verification": {
  "verifiedAt": "2026-08-01T21:40:00.000Z",
  "remainingRows": 0,
  "remaining": {},
  "unclassifiedTables": [],
  "complete": true
}
```

`complete` is true only when every count is zero **and** no table went
unclassified. Anything else marks the request `failed` and keeps the evidence —
"we deleted it" is a claim anybody can make, and this is the check that fails
loudly when something was missed.

The request row itself outlives the tenant, deliberately, and has no foreign key
to the organization for exactly that reason. Destroying the record along with the
tenant would leave nothing to show for it.

## What this does not delete

**Repository bytes and LFS objects.** Those are removed by the repository
lifecycle, which already knows how to do it safely. LFS objects and CI blobs are
content-addressed and shared between tenants — deleting one by tenant is a way to
destroy somebody else's data while destroying your own.

**Users.** A person is not owned by an organization and usually belongs to
others. Their membership rows go; their account does not.

**Email delivery records.** They are addressed to a person, not to an
organization.

Each of these is in the `unreachable` list with its reason, which is how they are
distinguished from something nobody thought about.

## The export it will not run without

```text
No verified export of 'acme' has been taken since this deletion was requested.
Run: npm run export -- --org acme
```

Deletion is preceded by a verified export the customer keeps — see
[Tenant Export](TENANT_EXPORT.md). Without one, "we deleted it" and "you lost it"
are the same event.

Required **since the request**, not merely existing: an export from six months
ago describes a tenant that has changed since. And required to be *verified* —
an archive nobody has opened is a belief, not a copy.

An operator can execute without one. That override is a separate flag from the
one that skips the seven-day wait, because skipping the wait is somebody in a
hurry and skipping the export is the customer losing their data. It is recorded
in `verification.exportWaived` beside the proof of deletion, along with the
archive and its checksum when there was one.

## Not done yet

- **Repository byte removal in the same operation.** Today the metadata goes and
  the bare repositories are removed separately through the lifecycle.
- **Scheduled execution.** Nothing runs a due deletion automatically yet; an
  operator executes it. That is deliberate for now — the first few should be
  watched by a person.

## Related

- [Repository Lifecycle](REPOSITORY_LIFECYCLE.md) — how repository bytes are removed
- [Operations Boundary](OPERATIONS_BOUNDARY.md) — where the operator surface sits
- [Tenant Export](TENANT_EXPORT.md) — the export this will not run without
- [Backups and Restore](BACKUPS_AND_RESTORE.md) — the instance-wide equivalent
