# KukGit Dangerous File Handling

Stopping a file from serving, without destroying anybody's repository.

## The problem with "delete the malware"

An abuse case names a repository. But the file itself — a trojan, a stolen
credential dump, a piece of illegal material — is **content**, and KukGit stores
content by its SHA-256. The same object can be attached to fifty repositories
across a dozen organizations, and most of those are people who cloned something
in good faith.

Two obvious answers are both wrong:

- **Delete by hash.** Destroys evidence and a dozen victims' repositories in one
  motion, and cannot be undone when the analysis turns out to be wrong.
- **Disable each repository.** Punishes the victims, misses the copies uploaded
  tomorrow, and does nothing about the object itself.

So the unit of action is the **hash**, and the action is **block**, not delete.

## Blocking

```text
GET  /api/instance-admin/blocked-content?all=true
POST /api/instance-admin/blocked-content                        {"digest": "…", "reason": "…"}
POST /api/instance-admin/blocked-content/:digest/unblock        {"reason": "…"}
```

Instance administrator only. A written reason of at least twenty characters is
required to block **and** to unblock.

A block returns what it touches:

```json
{"digest": "f394…", "blocked": true,
 "affected": {"lfsRepositories": ["kuklabs/kukgit-demo"], "artifacts": []}}
```

"This hash" is an opaque decision. "This hash, attached to nine repositories
across four organizations" is one an operator can weigh — and afterwards, it is
the list of who to tell.

## What a block does

Every serving path checks the digest before it hands over bytes:

| Path | Where |
| --- | --- |
| Git LFS batch, upload and download | `src/git-lfs.mjs` |
| Direct LFS `PUT` and `GET` | same |
| Workflow artifacts | `src/workflow-storage.mjs` |

Uploads are refused as well as downloads. Refusing the download stops the copies
already here; refusing the upload means the instance never holds the bytes again.
The check is one primary-key lookup, cheap enough to sit on every request without
anybody weighing whether to call it.

**Caches are deliberately not checked.** A cache is only ever restored into the
workspace of the repository that wrote it, so it is not a distribution channel.

## What a block does not do

**It does not delete the bytes.** The object stays in storage and the row stays
in the database. That is what makes a block reversible, and reversibility is the
whole reason an operator can act quickly on a plausible report instead of waiting
for certainty.

Verified live: after a block the file is still on disk, byte for byte, while
every request for it returns `451`.

## The refusal says almost nothing

```json
{"code": "CONTENT_BLOCKED",
 "message": "This Git LFS object (sha256:f39492916011…) has been blocked by the KukGit operator."}
```

Twelve characters of the hash, and nothing else. Not the reason, not the abuse
case, not who decided.

A download error is shown to whoever is fetching, and for malware that is as
likely to be the person who uploaded it checking whether their payload still
serves. The operator's reasoning belongs in the operator's queue.

`451` rather than `403`: the content exists and is being withheld deliberately,
which is exactly what that status was defined for.

## Unblocking

The block row is kept, with who removed it and why. Re-blocking the same digest
**revives the row** rather than replacing it, so the history of a hash that was
blocked, cleared and blocked again is one record rather than three unrelated
ones.

Verified live: unblock, and the same request that returned `451` returns `200`.

## What this is not

- **Not a scanner.** Nothing here looks at a file and decides. Every block is
  placed by a person, from an abuse report or an external feed. Automatic
  blocking would need a detection engine, and a detection engine that is wrong
  takes down customer repositories on its own initiative.
- **Not a feed integration.** The `source` field accepts `feed`, so a hash from a
  vendor list is distinguishable from one an operator typed — but nothing
  imports one.
- **Not extension or type policy.** Blocking `.exe` uploads is a different
  control with different trade-offs, and mostly an annoyance to the people it
  does not stop.

## Not done yet

- **Telling the affected repositories.** A block makes somebody's file stop
  working, and the `affected` list is exactly who should hear about it. The
  abuse workflow already notifies owners on a repository disable; this should do
  the same.
- **Blocking at push time**, so a blocked object cannot enter a Git tree at all.
  Today the object is refused at the LFS layer, which covers the way large binary
  content actually travels.
- **Feed import** with its own audit trail and a way to review what a feed
  claimed.

## Related

- [Abuse Reports](ABUSE_REPORTS.md) — where most blocks come from, and the
  repository-level action
- [Git LFS](GIT_LFS.md) — how the objects are stored and addressed
- [Artifacts and Cache](ARTIFACTS_AND_CACHE.md) — the other content-addressed
  store
