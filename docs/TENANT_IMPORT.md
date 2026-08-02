# KukGit Tenant Import

Loading an export back into an instance — the other half of being able to leave.

## Why it exists

An export you cannot load is half a promise. Import is what makes three things
real:

- **Moving between instances.** SaaS to self-hosted, or one self-hosted instance
  to another. This is the migration path KukGit is supposed to have.
- **Restoring one tenant.** A whole-instance restore to recover one organization
  destroys everybody else's last hour of work.
- **Proving the export.** A gate on deletion that insists on an archive is only
  worth having if the archive brings the tenant back. There is a test that
  deletes a tenant and restores it from the export that authorised the deletion.

```bash
npm run import -- --archive PATH --plan        # what it would do, without doing it
npm run import -- --archive PATH               # load it
npm run import -- --archive PATH --as newslug  # under a different organization slug
npm run import -- --list                       # what has been imported here
```

## Run the plan first

An import writes into a live instance, and the only undo is deleting the tenant
again. The plan names every row that will *not* be loaded and why — which is the
part that matters, because an import that quietly drops the secrets is one
somebody discovers when a deployment fails a week later.

## Identifiers are kept, not remapped

Every identifier in the archive is random and every reference inside the tenant
uses it, so keeping them makes each foreign key correct with no mapping table to
get wrong. The cost is that importing over a tenant that is still here is
refused, which is the right answer anyway.

Two instances can each hold the other's `acme` — `--as acme-restored` changes the
slug, and the identifier underneath is the tenant's own.

## The two things that do not come back

### Credentials

They were withheld from the export, so a row holding one is **not loaded**. A
secret whose ciphertext is a sentinel would decrypt to nothing, a runner whose
token hash is a sentinel could never authenticate, and both would sit in the
interface looking real. An absent credential is honest; a broken one costs
somebody an afternoon of debugging something that was never going to work.

Every one is counted, by table, in the plan and in the report:

```text
NOT EVERYTHING CAME BACK:
  - 3 secrets row(s) held a withheld credential and were not loaded; they must be recreated
```

### People

An account belongs to the instance, not to the tenant, and was never in the
archive. What the export carries is the organization's **member list** — email,
display name and role — because email is what identifies the same person on two
instances and an organization's member list is the organization's data.

On import each member is looked up by email:

- found → the membership is created against **this instance's** user id
- not found → the membership is **dropped and reported**, never invented

An access list that invents a member is worse than one that is short. Invite the
missing people first if they should keep access; the plan lists them by email.

The same rule applies to every other user reference: nullable ones become null,
and a row that *requires* a user this instance does not have is dropped and
counted.

## Order, and what happens when it fails

Metadata is inserted **parents first**, which is the deletion's order read
backwards. The deletion holds foreign keys by going deepest-first; an import
holds them by going the other way. No constraint is switched off at any point.

Git LFS bytes are written to the object store **before** any row points at them.
`lfs_objects` is not tenant-scoped — objects are content-addressed and shared
between tenants, so the table is not in the archive and `repository_lfs_objects`
would have no parent. Writing bytes first means the worst case is an object with
nothing pointing at it, which the existing LFS garbage collector already handles.
The other order leaves a row promising bytes that are not there.

All metadata is one transaction. Repositories are not, so a failure removes the
bare repositories the import created: a repository directory with no row pointing
at it is invisible to every part of KukGit and would sit on the volume until
somebody went looking.

## Repositories

Each bundle is cloned with `git clone --bare`, then configured the way a
repository created here is configured. The clone's `origin` is **removed** — it
points at a bundle in a temporary directory that is about to be deleted, and
leaving it would make every later fetch fail with a path nobody recognises.

A repository the export recorded as `empty` is created as an empty bare
repository rather than skipped, because its row was loaded and every later push
and read needs the directory to exist.

## The report

The same census the export and the deletion use, run against what was actually
loaded — an import that reports success without counting is making the same
unchecked claim a deletion would. It is stored in `tenant_imports`, which
records where a tenant on this instance came from.

`complete` is true only when every repository was restored and every LFS object
was written. Anything else prints the gaps.

## Version skew between instances

A column the archive has and this instance does not is dropped and **counted by
name**; a table this instance does not recognise as tenant-scoped is skipped and
reported. Both mean the two instances are running different versions, and
somebody needs to know which — silently discarding either would make an import
from a newer instance look clean while losing data.

## Not done yet

- **Merging into an existing organization.** Import creates; it will not add to
  a tenant that is already here.
- **Importing from anything but KukGit.** No GitHub or GitLab archive support.
- **Re-encrypting secrets.** There is no path that takes a customer's secret
  values alongside an archive and loads them; they are recreated by hand.
- **An HTTP surface.** Command line only, for the same reason exports are: this
  copies every repository a tenant owns.

## Related

- [Tenant Export](TENANT_EXPORT.md) — what this reads, and what it withholds
- [Tenant Deletion](TENANT_DELETION.md) — the operation an export is required
  before
- [Backups and Restore](BACKUPS_AND_RESTORE.md) — the whole-instance equivalent
