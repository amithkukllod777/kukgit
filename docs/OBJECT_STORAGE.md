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
objects are already on a volume to a bucket would make every existing object
unreadable — the rows still point at keys nothing serves. **Moving them is a
migration, not a configuration change**, and KukGit does not yet ship one.

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
`src/object-storage.mjs` rather than taken from an SDK — KukGit ships with no
runtime dependencies, and an SDK for this would be the largest thing in the
product for one signing algorithm.

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

## What is not done yet

- **No migration command.** Moving an existing instance's objects from a volume
  into a bucket needs a copy, a verification pass and a cutover. Until that
  exists, object storage is for instances that start with it.
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
