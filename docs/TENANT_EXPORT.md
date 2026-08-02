# KukGit Tenant Export

Handing a customer everything they own, in a form that outlives KukGit.

## Why it exists

Deletion is the operation with no undo, and until this existed "we deleted it"
and "you lost it" were the same event. An export is what makes the first one
survivable, so a deletion now refuses to run without one.

It is also the answer to a fair question from anyone deciding whether to host
here: *what happens if we leave?* An export that only KukGit can read is not an
answer.

```bash
npm run export -- --org acme              # export, then open it again and check it
npm run export -- --org acme --out DIR    # somewhere other than the default
npm run export -- --verify PATH           # re-verify an archive you already have
npm run export -- --list                  # what has been exported, and whether it verified
```

## What is in it

```text
manifest.json
metadata/<table>.jsonl        every row the tenant owns, one JSON object per line
metadata/members.jsonl        the member list: email, name and role
repositories/<slug>.bundle    a Git bundle per repository
lfs/objects/aa/bb/<oid>       every Git LFS object the tenant's repositories use
```

**Repositories go in as Git bundles**, because `git clone acme-app.bundle` works.
An export whose repositories can only be opened by KukGit is not an export, it is
a hostage note. The test that proves this runs a real `git clone` against the
file that was handed over.

**LFS objects are copied, not referenced** — even when they live in a bucket. A
backup may point at the bucket, because a restore happens on the instance that
still has it. The customer receiving an export does not, and a manifest telling
them their large files are in somebody else's S3 account is not a copy of their
data.

## The same list as the deletion

The metadata comes from the same schema-derived selectors
[tenant deletion](TENANT_DELETION.md) uses. That is the whole reason it is built
this way: **if a table is exported it is deleted, and if it is deleted it was
exported** — by construction, not because two hand-written lists happen to agree
today. A table added next month is in both or in neither, and a test asserts the
two sets are equal.

An unclassified table fails the export exactly as it fails the deletion.

## What is withheld

This is the difference between an export and a backup. A backup is restored into
the instance that made it, where the encryption key still exists. An export
**leaves the building**: every credential in it becomes a credential outside
anybody's control, in a file that will be emailed, copied to a laptop and kept
for years.

So columns holding credential material are replaced with
`[redacted by KukGit export]` — a visible sentinel rather than `null`, so
somebody reading the file can see something was taken out without finding the
manifest first. The manifest lists every withheld column.

Matched on the column name, for the same reason the table graph is derived: a
table added later is covered without anybody remembering this file exists. A
column that *looks* like a credential and is exported anyway needs a written
reason, and a column that has neither **fails the export**.

### A digest of a credential is a credential

Found by exporting a real instance and reading the file that came out:
`secrets.value_sha256` was in it. It is an unsalted SHA-256 of the secret itself
— brute-forceable for anything short or low-entropy, and for everything else it
answers "is the value X?" for somebody holding a guess.

A digest of *content* is a different thing: `workflow_artifacts.digest` is the
checksum of a file that is in the export beside it. Both are now classified, one
withheld and one exempted with a reason, which is why the mechanism is
classify-or-fail rather than a pattern somebody trusts.

## Verification

Creating and verifying happen in one command, deliberately. An archive nobody has
opened is a belief, and the moment to discover it is wrong is before the original
has been deleted.

Verification unpacks the archive — which checks every entry against the checksum
in its header — and then checks the things a packer could get wrong while still
producing a valid archive:

- the manifest agrees with what is actually in the file
- each table file holds the number of rows the manifest claims, **counted from
  the file** rather than believed from the manifest
- each bundle passes `git bundle verify` and carries the heads it should; fewer
  heads than the repository had means a branch did not make it
- each LFS object still hashes to its own name, which is the one check a
  content-addressed store makes possible and the archive format cannot do itself

Anything recorded as a warning when the export was taken is repeated as a problem
at verification, so a gap cannot be forgotten between the two.

Only a verified record authorises a deletion. Creating the archive is not enough.

## The gate on deletion

```text
No verified export of 'acme' has been taken since this deletion was requested.
Run: npm run export -- --org acme
```

**Since the request**, not merely existing. An export from six months ago
describes a tenant that has changed since, and handing it over would be worse
than admitting there is none.

The override exists — an operator can execute without one — and it is a separate
flag from the one that skips the seven-day wait. Skipping the wait is somebody in
a hurry; skipping the export is the customer losing their data, and one flag for
both would let the second happen while somebody meant the first. A waived export
is written into the deletion's verification record beside the proof, because it
is the most consequential decision anybody makes here and it should not live only
in whoever typed the flag.

## Gaps are recorded, never skipped

A repository with no bytes on disk is recorded as `missing`; a repository with no
commits is recorded as `empty`, which is a true statement about the repository
rather than a gap. An LFS object that cannot be read, or whose copied bytes hash
to something else, is recorded as missing with the reason.

Any of these makes the export **incomplete**, and an incomplete export does not
satisfy the deletion gate. An export that quietly omits a repository is worse
than no export at all, because somebody then deletes the original believing they
have it.

## Why there is no "export" button

```text
GET  /api/instance-admin/tenants/exports
POST /api/instance-admin/tenants/exports/:id/verify
```

The API lists exports and re-verifies them. It does not create them, because an
export copies every repository and every large file a tenant owns — over a real
customer that is minutes to hours of byte copying, and an HTTP request that runs
for an hour is a request that times out halfway through, leaving a half-written
archive nobody knows about.

Instance administrator only, like the deletion routes: an export manifest is a
description of everything a tenant owns.

## Loading one back

`npm run import -- --archive PATH` reads an export into an instance — a different
one, for a migration, or the same one to restore a tenant that was deleted. Two
things do not come back: withheld credentials, and members who have no account on
the target. Both are counted before anything is written. See
[Tenant Import](TENANT_IMPORT.md).

The member list is in the archive for this reason. `org_members` holds user ids
and nothing else, and an id means nothing on another instance, so an import would
restore an organization with no members and no way to get in. Email is what
identifies the same person on two instances, and an organization's own member
list is the organization's data.

## Not done yet

- **Delivery.** The archive lands on the instance's disk. Getting it to the
  customer — signed URL, expiry, a record of who downloaded it — is manual.
- **Encryption at rest.** The archive is `0600` and holds no credentials, but it
  is not encrypted. An operator moving one off the instance should encrypt it in
  transit and at rest themselves.
- **Scheduled exports.** Everything here is run by a person.

## Related

- [Tenant Deletion](TENANT_DELETION.md) — what the export is required before
- [Backups and Restore](BACKUPS_AND_RESTORE.md) — the instance-wide equivalent,
  and why it keeps ciphertext where this does not
- [Secrets Vault](SECRETS_VAULT.md) — why the key does not travel with the data
