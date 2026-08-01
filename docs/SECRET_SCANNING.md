# KukGit Secret Scanning

Finding credentials that were committed, without ever storing one.

## What it does today

Every push is scanned — only the content that push introduced — and findings are
recorded against the repository. The push is **not** blocked.

That is a deliberate stopping point, not an oversight. Blocking a push is *push
protection*, and it needs a bypass, an audit trail for the bypass, and a policy
per repository. Shipping detection first means the credentials already in
repositories become visible now, which is the part that helps immediately.

## Never storing the secret

This is the constraint everything else is arranged around. A scanner's database
is a list of where the credentials are — a strictly better target than the
repository itself, because somebody has already done the searching.

So a finding holds:

- a **fingerprint**: `sha256("kukgit-secret-scan:" + value)` truncated to 16 hex
  characters. Enough to recognise the same credential in another file or another
  push — which is what makes "this is the one you already rotated" answerable —
  and not reversible. Truncated on purpose: a full digest of a short or
  low-entropy secret is brute-forceable.
- a **preview**: first four and last four characters, the middle replaced. A
  match of twelve characters or fewer is replaced entirely, because showing four
  of eight is showing half the secret.
- the file, the line and the commit.

The value itself never leaves the scanner. There is a test that serialises a
finding and asserts the credential does not appear in it, and the end-to-end
check greps the actual database rows for the real values.

## Detectors

| Detector | Severity | Verified by |
| --- | --- | --- |
| GitHub token | critical | CRC32 checksum in the token |
| KukGit personal access token | critical | prefix and length |
| KukGit runner token | critical | prefix and length |
| Stripe secret key | critical (`sk_test_` → low) | prefix and length |
| Private key material | critical | PEM header |
| AWS access key ID | high | prefix and length |
| Google API key | high | prefix and length |
| Slack token | high | prefix |
| Database URL with a password | high | shape |
| JSON Web Token | medium | shape |

**A checksum decides it where a format has one.** A GitHub token carries a CRC32
of its own payload in the last six characters, so "looks like a token" becomes
"is one". This matters more than adding detectors: a scanner that cries wolf is
one an author learns to ignore, and at that point it protects nobody.

`sk_test_` is reported at **low** rather than not at all. A test key is still a
credential; it just cannot move money.

KukGit scans for **its own** token formats. A host that scans for everybody
else's credentials and not its own would be an odd thing to ship.

## What is skipped, and said out loud

`node_modules`, `.git`, `dist`, `build` and `vendor` are skipped as vendored.
Files over 1 MiB are skipped as too large, files containing a NUL byte as binary,
and lines over 4000 characters are ignored within an otherwise scanned file — a
minified bundle is one enormous line and the file that matters is the source it
was built from.

Every skip is **returned in the result**. A scanner that quietly drops a file it
could not read lets somebody believe a clean result means a clean push.

An `.env.example` or a fixtures directory is **still reported**, marked
`likelyExample`. A credential committed to an example file is still committed;
marking it lets a policy warn instead of block, which is a decision for the
repository rather than for the scanner.

## Findings

```text
GET   /api/repos/:org/:repo/secret-scanning?status=open|all
PATCH /api/repos/:org/:repo/secret-scanning/findings/:id   {"status": "revoked", "note": "…"}
```

Reading needs repository **write**, not read. A finding names a file and a line
where a credential is, which is a map to it for anyone who can also read the
repository — and a private repository's read list is usually wider than the set
of people who should be handed that map.

Resolving needs **admin** and a same-origin request. The statuses are `revoked`
(rotated at the provider), `false_positive`, and `accepted`. The audit event
records the finding id and the outcome, never the preview.

**A resolved finding stays resolved.** The credential is still in history and
will be seen on every later push; re-opening it each time would mean a repository
whose history contains a rotated credential can never be clean, and a list that
can never be cleared is a list nobody reads.

Repeat sightings of the same credential in the same file merge into one row, so
the count is *credentials to rotate* rather than *times somebody pushed*.

`summary.blocking` counts critical and high only. A medium-severity JWT is worth
showing; it is not worth stopping a release for.

## Failure behaviour

Scanning runs **after** the push is accepted and acknowledged. A scanner failure
is logged and the push stands. Turning a scanner problem into a rejected push
would make the scanner the least reliable part of pushing code, and the first
outage would end with somebody disabling it.

## What is not done yet

- **Push protection.** Nothing is blocked. Needs a per-repository policy, a
  documented bypass and an audit record of every bypass — a bypass that is not
  recorded is a control that is not enforced.
- **History scanning.** Only new content is scanned. A credential committed
  before this shipped is found the next time the file containing it is touched,
  not before. A backfill command is the obvious next step.
- **Provider revocation.** Some providers accept a report of a leaked token and
  revoke it. That is a per-provider integration and an outbound network call
  KukGit does not currently make.
- **Entropy detection.** Deliberately absent. Generic high-entropy matching is
  where false positives come from, and the detectors above are the ones that can
  be verified rather than guessed at.

## A note on test fixtures

Every credential-shaped fixture in `test/secret-scanning.test.mjs` is assembled
at runtime rather than written as a literal.

The first attempt to push this feature was **blocked by GitHub's own push
protection**, which found the Stripe fixtures. It was right to — it cannot know
they are synthetic. A test file full of token literals trips every scanner in the
ecosystem, this one included, and becomes a nuisance for anyone who forks the
repository.

Worth knowing if you add a detector: assemble the sample, do not paste one.

## Related

- [Secrets Vault](SECRETS_VAULT.md) — where a credential *should* live
- [Branch Governance](BRANCH_GOVERNANCE.md) — where a blocking policy would sit
