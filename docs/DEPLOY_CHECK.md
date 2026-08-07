# KukGit Deploy Check

One command that says whether a box is ready, and what to do about it if not.

```bash
npm run deploy:check
npm run deploy:check -- --json
```

Run it **on the server, with the environment KukGit will start with**:

```bash
env $(cat /etc/kukgit.env | xargs) npm run deploy:check
```

It exits non-zero if anything failed, so it can gate a deploy.

## Why this exists

The deployment documentation is correct and long. A checklist a person reads is
a checklist a person skips — and every item on it is something that fails
quietly: a feature that stays off, a key that is missing until the first request
that needs it, a directory that works perfectly until the deploy that deletes it.

So the checklist runs.

## Warnings do not fail

Failures block; warnings do not. Most warnings are the correct choice for an
internal trial and the wrong one for real users — no off-instance backup
destination or incomplete operational settings. A check that blocks on both
stops being read, and then it stops being run.

## What it checks

| | |
| --- | --- |
| Node and git | versions, because `node:sqlite` needs 22.5+ and everything shells out to git |
| Base URL | set, absolute, and HTTPS in production |
| Auth mode | `local` or `authkit`; local production also requires working email delivery |
| Founder password | set and not the published default, in local mode |
| Development Git token | see below |
| The five keys | set, long enough, and **different from each other** |
| Data directory | writable, not world-accessible, **outside the source checkout** |
| Disk | free space where the data lives |
| Backups | configured, and not on the volume they protect |
| Rate limiting | on, and proxy trust consistent |
| Port | actually free |

### The three that matter most

**Keys reused for more than one purpose.** The instructions say generate each one
separately. The way that goes wrong is somebody running the generator once and
pasting the result five times — every key long, every key random, and one
compromise opening all of them. In an environment file it looks entirely
correct, and nothing else checks it. This does, by fingerprint.

**A data directory inside the source checkout.** Convenient, works perfectly, and
then the first deploy that checks out cleanly takes every repository, every LFS
object and the database together. It is the mistake that loses everything, and
it is one line to prevent.

**The development Git token.** It grants **admin on every repository**, and its
default value is published in this repository. Production refuses it outright —
but an internal trial is exactly where somebody runs without `NODE_ENV` set. So
outside production, the default value is a **failure**, not a warning.

## What it does not check

- **That the selected identity provider works end to end.** In AuthKit mode the
  URL and key are validated but the service is not called. In local mode the
  check can see that email is configured, not that a message reaches an inbox.
- **That TLS terminates correctly.** It checks the base URL says `https`, not
  that a certificate exists and is valid.
- **That the reverse proxy passes what it should.** `KUKGIT_TRUST_PROXY` is
  checked for consistency, not correctness — trusting a header no proxy sets is
  how a rate limiter is bypassed.
- **Anything about the data.** Run `npm run doctor` for that.

Each of these needs a live network, a real certificate authority or credentials.
Saying so is more useful than a check that half-does it.

## Then what

```bash
npm run deploy:check   # ready?
npm run seed           # founder account and a demo repository
npm start
```

Then push a repository, clone it back, and run `npm run doctor`. See
[DEPLOYMENT.md](DEPLOYMENT.md) for the host, the proxy and the SSH endpoint, and
[GETTING_TO_PRODUCTION.md](GETTING_TO_PRODUCTION.md) for the order of work.

## Related

- [Deployment](DEPLOYMENT.md) — the full configuration reference
- [Getting to Production](GETTING_TO_PRODUCTION.md) — what only an operator can
  supply, and in what order
- [Recovery Rehearsal](RECOVERY_REHEARSAL.md) — proving a restore works before
  needing one
