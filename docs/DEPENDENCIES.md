# Dependencies, licences and the bill of materials

```bash
npm run deps    # the licence gate — runs in CI
npm run sbom    # CycloneDX to stdout, or --out sbom.json
```

## Two questions, asked by different people

Engineering asks *"is this licence compatible with a commercial product"* once,
when a dependency is added. A customer's procurement team asks *"give us a bill
of materials"* months later, in a format their scanner reads.

Both are answered from `package-lock.json`, because that is the file that
decides what actually gets installed. `package.json` says what we asked for; the
lockfile says what arrives.

## What KukGit ships

```
14 packages ship with KukGit.
    2 × ISC
   12 × MIT
```

All of it is `pg` and its tree. The web UI has no dependencies, the server has
no framework, and the test runner is Node's own. That is a deliberate position
and this is the check that keeps it honest.

## The licence gate

Permissive only:

```
0BSD  Apache-2.0  BSD-2-Clause  BSD-3-Clause  CC0-1.0  ISC  MIT  Unlicense
```

**The absences are the point.** GPL, LGPL, AGPL and SSPL are not on the list,
because KukGit is sold and will be self-hosted by customers, and a copyleft
dependency in that position is a legal question that has to be answered by a
person before the dependency is added — not discovered by a customer's scanner
afterwards.

Adding to the list is a business decision, so it is a code change with a
reviewer rather than a configuration file somebody can edit quietly.

**A package that declares no licence is refused, not passed over.** Its terms
are ones nobody has read, which is the same risk as shipping GPL.

### SPDX expressions

`(MIT OR GPL-3.0)` is allowed — we may take the MIT side. `MIT AND GPL-3.0` is
not, because we would have to satisfy both.

`AND` binds tighter than `OR`, so `MIT OR GPL-3.0 AND GPL-3.0` is
`MIT OR (GPL AND GPL)` and is allowed. Splitting on `AND` first reads it as
`(MIT OR GPL) AND GPL` and refuses a package we may ship. Brackets are honoured
rather than stripped.

`Apache-2.0 WITH LLVM-exception` is still Apache-2.0 — an exception narrows what
a licence requires, it does not turn one licence into another.

### Declared, not verified

The `license` field is what the publisher typed. **Nothing here reads a LICENSE
file or checks that the declaration is true.** A report that implied otherwise
would be worse than no report, so the tool says so every time it passes.

## Lockfile drift

The gate also refuses when `package.json` and the lockfile disagree — a
dependency in one and not the other, or a version mismatch on the root package.

Without that, a dependency can be added and the licence audit still passes,
against a tree nobody approved.

## The bill of materials

CycloneDX 1.5, because that is what procurement scanners read.

**Deterministic on purpose.** No timestamp, and a serial number derived from the
component list rather than randomly generated — so two runs of the same tree
produce byte-identical output, and a diff between two releases is a diff of what
changed rather than of when it ran. Pass a timestamp explicitly when one is
wanted for a release artifact.

Every component carries a `purl`, a version, and the `integrity` hash from the
lockfile converted to a CycloneDX `SHA-512`. The same package at two versions
appears twice, because both are shipped and both have a licence.

## What this does not do

- **No vulnerability scanning.** `npm audit` exists and is not wired into
  anything here. This answers "may we ship it", not "is it safe today".
- **Nothing verifies the declared licence.** See above.
- **No transitive licence obligations.** Attribution files, NOTICE requirements
  and the text a customer must be given are not generated.
- **Nothing checks the Git side.** Vendored code, container base images and the
  Chromium used for browser verification are outside `package-lock.json` and
  outside this.
- **No signing.** The SBOM is not signed, so it proves what this repository
  believes and nothing about who produced it.

## Related

- [SECRET_SCANNING.md](SECRET_SCANNING.md) — credentials in the repository
- [ARCHITECTURE.md](ARCHITECTURE.md) — why the dependency count is what it is
