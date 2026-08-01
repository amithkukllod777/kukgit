# KukGit Object Storage

Where Git LFS object bytes live, and what changes about backups when they stop
living on the instance volume.

## Two backends

| | `filesystem` | `s3` |
| --- | --- | --- |
| Bytes | on the instance volume | in a bucket |
| Default | **yes** | opt in |
| Backup archive | contains the objects | verifies them, does not contain them |
| Scales past one volume | no | yes |

Filesystem is the default and stays the default. Switching an instance whose
objects are already on a volume to a bucket does **not** move them — the rows
still point at keys nothing serves until they are copied. That copy is
`npm run lfs:storage`, below.

## Configuration

```bash
KUKGIT_OBJECT_STORAGE_DRIVER=s3
KUKGIT_OBJECT_STORAGE_BUCKET=kukgit-lfs
KUKGIT_OBJECT_STORAGE_REGION=eu-central-1
KUKGIT_OBJECT_STORAGE_ENDPOINT=https://s3.eu-central-1.example.com   # omit for AWS
KUKGIT_OBJECT_STORAGE_ACCESS_KEY_ID=…
KUKGIT_OBJECT_STORAGE_SECRET_ACCESS_KEY=…
KUKGIT_OBJECT_STORAGE_PREFIX=production                              # optional
KUKGIT_OBJECT_STORAGE_FORCE_PATH_STYLE=true                          # default
```

Configuration is checked **at startup**, not at the first upload. An instance
that starts happily and then fails on the first `git push` of a large file has
already told its users it is working.

`npm run doctor` reports which backend is active and, for a bucket, which one.
It never prints the credential.

Path-style addressing is the default because most S3-compatible services are
reached that way; a bucket in the hostname breaks against anything that is not
AWS itself.

## Signing

Requests are signed with AWS Signature Version 4, written out in
`src/object-storage.mjs` rather than taken from an SDK. An SDK for this would be
the largest thing in the product for one signing algorithm, and KukGit carries a
single npm dependency as it is.

The two parts that are easy to get wrong are canonicalisation and the
signed-header list, and both are visible in one function rather than three layers
down. The published AWS test vector is in the test suite, because signing is the
one part that cannot be checked by round-tripping against our own code: an
agreed-wrong implementation would pass every self-consistent test and fail
against every real bucket.

Uploads are signed with `UNSIGNED-PAYLOAD`. The body is streamed from a file, and
computing a body hash means buffering the whole object first — not an option for
something that can be gigabytes. The request is still signed; TLS is what
protects the body in transit, so **an endpoint must be HTTPS in production**.

## Keys

A key is a filesystem path on one backend and a URL path on the other, so the
accepted charset is narrow and identical for both: letters, numbers, dot,
underscore, hyphen and slash, no `..`, no leading slash, no empty segment.

LFS keys are `objects/<aa>/<bb>/<oid>` — the same string already stored in
`lfs_objects.storage_path`, so an existing instance's on-disk layout is exactly
preserved and switching backends does not renumber anything.

Objects are addressed by their SHA-256, so a write to an existing key is the same
bytes. Both backends detect that and skip the write rather than replacing a file
a reader may be streaming.

## What changes about backups

This is the part worth reading before turning object storage on.

**With `filesystem`, nothing changes.** A `.kgbak` contains the objects, and a
restore needs only the archive.

**With `s3`, the archive verifies the objects but does not contain them.** Each
object is read out of the bucket and re-hashed at backup time, and the manifest
records the digest, the size and the store it came from — but the bytes stay in
the bucket.

That is a deliberate trade, not an omission. Copying a multi-terabyte bucket into
every snapshot is not a backup strategy, and an operator who believes a 40 GB
archive contains their 4 TB of objects has a recovery plan that fails the first
time it is needed. So the manifest says so explicitly:

```json
"lfs": {
  "selfContained": false,
  "store": { "kind": "s3", "bucket": "kukgit-lfs", "region": "eu-central-1", "prefix": "production" },
  "objects": [{ "oid": "…", "size": 1234, "sha256": "…", "inArchive": false }]
}
```

The descriptor carries a bucket, a region and an endpoint. It carries **no
credential** — an archive that can be read is otherwise an archive that hands
over the object store.

`selfContained` is absent on archives written before object storage existed, and
those are always self-contained: every one of them had the bytes on a volume.

### So what protects the bucket?

The bucket's own durability and versioning, which is a policy on the bucket
rather than something KukGit can assert. **Turn on versioning and a lifecycle
policy before pointing production at it**, and treat the bucket as part of the
backup surface: a `.kgbak` plus a deleted bucket is not a recovery.

## Failure behaviour

- a missing object is a `404`, the same as it is on a volume
- a rejected credential is a `502` with `STORAGE_UNAUTHORIZED`, never a `404` —
  "the object is gone" and "we cannot authenticate" must not look alike to whoever
  is debugging it
- the S3 error body carries a request id and the bucket name, so it goes to the
  operator log and never into a message a user sees

## Migrating an instance that already has objects

```bash
npm run lfs:storage -- plan               # what would move, and what is already wrong
npm run lfs:storage -- copy               # copy to the bucket; deletes nothing
npm run lfs:storage -- verify             # can the bucket serve every recorded object?
# restart the instance with KUKGIT_OBJECT_STORAGE_DRIVER=s3
npm run lfs:storage -- reclaim --confirm  # only once you trust the bucket
```

Four separate commands rather than one, because each answers a different
question and only the last one destroys anything.

**`plan` first, always.** It is the only way to find out that the volume is
missing objects the database still lists, or that one has quietly rotted, *before*
a cutover makes that everyone's problem. Neither is caused by migrating — both
are true today — but a corrupt object is a restore-from-backup decision, and
copying it would move the corruption into the bucket. `copy` refuses to run while
one exists.

**`copy` deletes nothing.** A migration that removes its own source has no
rollback: the moment anything is wrong with the bucket — a wrong region, a
lifecycle rule, a credential that expires — the objects are simply gone. It is
also resumable by construction, because an object is addressed by its digest and
a second run finds the bucket already holding exactly those bytes.

Every object is verified **in the bucket** after it is written, by reading it back
and re-hashing. A `PUT` that returned `200` is a claim; the digest is the proof,
and this is the one moment when checking costs nothing extra. An object that
arrives wrong is removed rather than left in place, so the next run retries
cleanly instead of skipping a plausible-looking object.

**`verify` is the cutover gate**, and a partial run cannot clear it — the objects
it skipped are exactly the ones nobody has looked at.

**`reclaim` re-verifies each object immediately before deleting its local copy.**
Trusting the earlier verification would mean deleting on the strength of a result
from before a lifecycle rule or an accidental delete could have happened. Anything
it cannot confirm is kept, and reported.

Run it during a quiet period. The copy reads the volume and writes the network at
whatever rate both allow, and there is no throttle.

## What is not done yet

- **Bare Git repositories and CI blobs stay on the volume.** Git's own object
  store is not content-addressed in a way that survives being remote, and
  repacking over a network store would be far slower than the storage saving is
  worth. CI artifacts and caches could move next; LFS was chosen first because it
  is the one that actually grows without bound.
- **No multipart upload.** A single `PUT` per object, so the per-object ceiling is
  what the endpoint accepts in one request.

## Related

- [Git LFS](GIT_LFS.md) — the protocol side
- [Backups and Restore](BACKUPS_AND_RESTORE.md) — the archive format
- [Recovery Rehearsal](RECOVERY_REHEARSAL.md) — proving a restore works
- [Operations Boundary](OPERATIONS_BOUNDARY.md) — where this sits in the plan
