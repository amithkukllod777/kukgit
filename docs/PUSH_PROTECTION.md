# KukGit Push Protection

Refusing a push that introduces a credential, before it becomes history.

## Why it has to be the push

Once a credential is in a repository's history it is compromised. Rewriting the
history does not un-send the bytes: they reached a server, they may be in a
clone, a fetch, a CI cache or a backup. The only intervention that actually
prevents the leak is the one that happens *before* the objects are accepted.

That is a pre-receive hook, which is the one place in KukGit that can say no to a
push and have it mean something.

## Off by default

```text
GET /api/repos/:org/:repo/push-protection                 policy (repository write)
PUT /api/repos/:org/:repo/push-protection                 change it (admin, same-origin)
    {"enabled": true, "blockSeverities": ["critical","high"], "allowExampleFiles": true}
```

A control that starts rejecting pushes the moment it ships is one that gets
switched off before anybody reads what it does. An administrator turns it on per
repository, and the policy says what counts as blocking.

`critical` and `high` block by default. A medium-severity JSON Web Token is worth
showing in the findings list and is not worth stopping somebody's work for.

`allowExampleFiles` is on by default: a credential in `.env.example` is still
recorded as a finding, it just does not stop the push.

## Only the new content

The hook scans what the push introduces, not the repository.

Scanning everything would reject a push because of a credential that was already
there — a problem the author of *this* push usually cannot fix. Being unable to
push because of somebody else's old mistake is exactly how a control ends up
disabled.

## The rejection

```text
remote: KukGit push protection: this push introduces credentials.
remote:
remote:   critical GitHub token
remote:            deploy.sh:1  ghp_********************cpLR
remote:            fingerprint d40b9fae21943a5a
remote:
remote: Remove the credential and rewrite the commit that introduced it, then
remote: rotate it at the provider — a credential that reached a push should be
remote: treated as exposed even if the push was refused.
remote:
remote: If this is not a credential, a repository administrator can allow it:
remote:   POST …/api/repos/kuklabs/kukgit-demo/push-protection/bypasses
```

The message has to be actionable **in the terminal**, because that is the only
place the author is looking. A rejection that says only "blocked" gets worked
around with `--no-verify`, a disabled feature, or a second remote.

It tells the author to **rotate anyway**. The push was refused, but the
credential was typed, committed, and sent over a network to a server that logged
a request. Treating a refused push as "no harm done" is how a credential stays
live in somebody's `.env` for another year.

The preview is redacted here as everywhere: a rejection message goes to a
terminal and, very often, straight into a CI log.

## The bypass

```text
POST /api/repos/:org/:repo/push-protection/bypasses      (admin, same-origin)
     {"fingerprint": "d40b9fae21943a5a", "reason": "why this is not a credential"}
GET  /api/repos/:org/:repo/push-protection/bypasses      (repository write)
```

Three properties, each load-bearing:

**Keyed by fingerprint.** A bypass covers the one credential it names. A bypass
that waved through "the next push" would let an unrelated credential ride along
with the one somebody actually reviewed.

**It expires**, after 30 minutes. A standing bypass is the control being off,
without anybody having decided to turn it off.

**It is a record.** A row with a person, a time, a reason of at least ten
characters, and whether it was actually used — plus an audit event. *A bypass
that is not recorded is a control that is not enforced*, because nobody can tell
afterwards whether it was used once or a hundred times.

Granting one needs **admin**. The person blocked is often not the person who
should decide the credential is safe.

The "used" flag is set after the push lands, not by the hook. A pre-receive hook
runs while the push is still in flight, so it opens the database **read-only** —
a hook that writes can leave state behind for a push that is then rejected.

## When the scanner itself breaks

Push protection **fails closed**: if it cannot run, the push is refused with an
explicit message.

An administrator who turned this on asked for the strict behaviour, and a control
that opens on its own failure is not a control — an attacker who can make the
scanner crash could otherwise push anything.

The trade is real: a bug in the scanner stops pushing on protected repositories.
So the inverse is available, per instance:

```bash
KUKGIT_SECRET_PUSH_PROTECTION_FAIL_OPEN=1
```

Set it if availability matters more than the guarantee for your instance. It is
off by default because that choice should be made deliberately rather than
inherited.

Note the asymmetry with plain scanning, which is deliberate: **detection** runs
after the push is accepted and never affects it, while **protection** runs before
and is the point. A scanner failure must not break pushing for repositories that
never opted in.

## Hooks are now installed everywhere

Previously the pre-receive hook was installed only on repositories with a branch
protection rule, because that was all it enforced. It now also enforces push
protection, so a repository that enabled protection and had no branch rule would
have had no hook to enforce it with. Every repository gets the hook; it does
nothing measurable where no policy applies.

## Verified

The end-to-end check is the only thing that proves any of this, because a hook
that is not actually invoked by Git looks identical to one that is:

1. enable protection, push a credential → **refused**, and `git ls-remote` shows
   the remote never moved
2. grant a bypass for that fingerprint → the **same push succeeds**
3. add a *second* credential → **refused again**: the bypass covered the one it
   named
4. the bypass is listed with its reason and marked used

## Related

- [Secret Scanning](SECRET_SCANNING.md) — the detectors and the findings list
- [Branch Governance](BRANCH_GOVERNANCE.md) — the other pre-receive control
- [Secrets Vault](SECRETS_VAULT.md) — where a credential should have gone instead
