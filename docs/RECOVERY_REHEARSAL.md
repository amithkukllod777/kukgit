# KukGit Production Recovery Rehearsal

A backup that has never been restored is a hope, not a recovery plan. This drill
restores a real `.kgbak` archive into a throwaway directory, proves the restored
instance is serviceable, and writes an evidence record carrying the measured
recovery time and data-loss window.

The live instance is never modified. Everything is restored and inspected in a
separate target directory.

## Run it

```bash
npm run rehearse
```

That rehearses against the newest snapshot, which is the one a real incident
would reach for. To target a specific archive, keep the restored copy, or file
the evidence somewhere particular:

```bash
npm run rehearse -- --archive kukgit-20260731T182519Z-288f59c9569d.kgbak \
                    --target /srv/kukgit-drill \
                    --operator "amith" \
                    --evidence /srv/evidence/2026-07-31-drill.json \
                    --keep-target
```

The command exits non-zero if any automated check fails.

## What is checked automatically

| Check | What it proves |
| --- | --- |
| Archive verification | The archive is intact: manifest checksums, Git bundles and every Git LFS object match. |
| Repository restore | Every repository in the snapshot exists on disk, passes `git fsck --full`, and carries **exactly** the refs the manifest recorded. |
| Lifecycle coverage | Which states the drill actually exercised — active, archived, empty and trashed are reported separately. |
| Git LFS integrity | Every restored object is re-hashed on disk and compared to its OID and size. |
| Credentials at rest | Personal access tokens restored as SHA-256 hashes, no plaintext token column, passwords hashed, AuthKit session secrets stored as AES-256-GCM envelopes. |
| Data-loss window | The live database is compared against the restored one, table by table, so the drill reports what a restore performed right now would actually cost. |
| Recovery time | Verify, restore and verification phases are timed individually and in total. |

Two of these deserve emphasis:

**Refs, not just fsck.** A repository that restored with a missing branch still
passes `git fsck`. The drill compares the restored ref listing against the
manifest's recorded refs, so an incomplete restore fails.

**Re-hashing, not trusting.** Git LFS objects are hashed again from the restored
disk. Silent corruption that preserves file size is invisible to any check that
compares metadata alone.

## The data-loss window

The drill compares the **live** database against the **restored** one and reports
per-table row deltas and a content digest.

On a quiesced instance — maintenance mode on, snapshot taken, drill run — every
table matches and the window is empty. On a running instance the difference is
the evidence: it is exactly the work a restore would lose. A non-empty delta is
not a failed restore and the drill does not report it as one.

## What cannot be automated

Some checks need a running instance, a reachable AuthKit and a credential only an
operator holds. A backup stores password and token *hashes*, so the drill
deliberately cannot authenticate on your behalf.

These are recorded in every evidence file as `outstanding`, and the record's
`complete` field stays `false` until they are signed off:

- `authkit.login` — sign in with One Kuklabs Account, confirm the local user id is retained
- `authkit.refresh_rotation` — let the access token expire, confirm one refresh rotates both stored secrets
- `authkit.device_revocation` — revoke the central device session, confirm the restored bridge is refused and the cookie cleared
- `git.http_authorization` — clone over Git HTTP with a freshly issued PAT, confirm an unscoped token is refused
- `git.ssh_authorization` — clone over SSH with a restored key, confirm a removed key is refused
- `git.lfs_authorization` — fetch a restored LFS object, confirm cross-repository access is refused
- `email.retry_and_suppression` — force an SMTP failure, confirm the outbox retries and a suppressed address stays cancelled
- `notifications.websocket_recovery` — reconnect the notification socket, confirm delivery resumes without duplicating messages

An automated pass is necessary but not sufficient. A rehearsal is complete only
when the manual checks are signed off against the restored instance too.

## Evidence record

Written to `data/backups/rehearsal-<backupId>.json` unless `--evidence` says
otherwise, in format `kukgit-recovery-rehearsal-v1`:

```json
{
  "format": "kukgit-recovery-rehearsal-v1",
  "operator": "amith",
  "startedAt": "2026-07-31T18:25:19.000Z",
  "archive": { "filename": "…", "backupId": "…", "archiveSha256": "…" },
  "recovery": {
    "recoveryTimeSeconds": 12,
    "dataLossWindowSeconds": 431,
    "timings": { "verifyMs": 0, "restoreMs": 0, "verificationMs": 0 }
  },
  "checks": {
    "repositories": { "checked": 4, "passed": 4, "coverage": { "active": 1, "archived": 1, "empty": 1, "trashed": 1 } },
    "lfs": { "checked": 1, "verified": 1 },
    "credentialsAtRest": true,
    "dataLoss": { "identical": true, "rowsLost": 0 }
  },
  "automatedResult": "passed",
  "complete": false
}
```

The record contains no secrets: no tokens, no password material, no sampled rows.
Table comparison uses row-count deltas and content digests, never row contents.

## Cadence

Rehearse after every change to backup, restore, storage layout or the metadata
backend, and on a fixed schedule regardless. Keep the evidence files — a drill
whose result was not recorded did not happen.

Retain at least the drills covering the current retention window so the trend in
recovery time is visible rather than reconstructed after an incident.
