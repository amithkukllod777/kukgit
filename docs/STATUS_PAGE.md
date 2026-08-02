# KukGit Status Page

What a customer can see when they cannot sign in.

## Why it is unauthenticated

```text
GET /status        the page
GET /api/status    the same thing as JSON
```

Neither needs a session. A status page behind a login is useless in the one case
it exists for: somebody who cannot get in. That is also why it survives
maintenance mode — the guard refuses writes and lets these through.

Nothing on it is private. Incident titles and updates are prose an operator typed
for the public, and maintenance summaries are the same.

## Nothing is generated from the database

Every word on the page was written by a person for the public. No tenant names,
no repository names, no request ids, no error strings copied out of a log.

A status page that assembles itself from internal state is one bad template away
from telling the internet which customer was affected — and the pressure to make
it "more informative" during an incident is exactly when that change gets made.
The only derived thing is the banner, and it is derived from counts.

## The banner is derived, never set

| | |
| --- | --- |
| an open **SEV1** | Major outage |
| any other open incident | Degraded performance |
| a window in progress | Scheduled maintenance |
| nothing open | All systems operational |

Derived rather than a field somebody sets, because a page reading "all systems
operational" above an open SEV1 is worse than no page at all — and that is what
happens when the banner is a separate thing somebody has to remember to change.

A SEV1 outranks maintenance. If both are true, the outage is the thing the reader
needs.

## The timeline is appended to, never rewritten

```text
POST /api/instance-admin/status/incidents               open one
POST /api/instance-admin/status/incidents/:id/updates   add to it
```

States are `investigating`, `identified`, `monitoring`, `resolved`. Nothing edits
or deletes an update. Correcting something means posting the correction, which is
what anybody reading later actually needs: the sequence of what was believed and
when, **including the part that was wrong**.

An incident and its first update are written together, in one transaction. An
incident whose first update was refused is still an incident — published, with an
empty timeline, saying nothing about what is wrong. There is no state in which
one exists without the other.

Instance administrator only, like every other operator route.

## The page is one file

No stylesheet, no script, no font, no image, no external request of any kind. A
status page that needs the asset pipeline of the thing it reports on goes down
with it, and it is read at exactly the moment when the least should have to work.

There is a test that asserts the rendered HTML contains no `<script>`, no `<link>`
and no absolute URL.

Operator prose is escaped on the way out. It comes from a trusted person, but a
pasted error message containing markup should not become markup on a public page.

## The limitation, said on the page itself

**This page is served by the instance it describes, so it cannot report a total
outage.** That sentence is in the footer, not only in this document.

```bash
npm run status                      # what the page says right now
npm run status -- --snapshot DIR    # write status.json and index.html
```

The snapshot is two ordinary files with no server behind them. Push them to
object storage or a CDN on a schedule and that copy keeps answering when the
instance does not, which is where a status page belongs. KukGit does not do the
pushing — that is one line of an operator's cron and it depends on where they
host.

## Not done yet

- **Nothing publishes the snapshot.** The files are written; getting them
  somewhere else is manual.
- **No subscriptions.** A customer has to look. Email or webhook notification on
  a new incident is the obvious next thing.
- **No component breakdown.** One overall state, not "Git operational, CI
  degraded". Worth adding once there is more than one thing to say.
- **No automatic incident from monitoring.** Every incident here is opened by a
  person, which is deliberate: an automatically published incident is an
  automatically published claim.

## Related

- [Maintenance Windows](MAINTENANCE_WINDOWS.md) — where the maintenance entries
  come from
- [Operations Boundary](OPERATIONS_BOUNDARY.md) — severity levels and who is
  told what, on what deadline
- [Operations Health](OPERATIONS_BOUNDARY.md) — the internal signals, which are
  not this
