# KukGit Maintenance Windows

Taking the instance down on purpose, with a record of who decided to.

## What was missing

Maintenance mode already existed: a file switch that makes the instance
read-only. That was the gap. An instance could be taken down with nothing
recorded about who decided it, when it was supposed to end, or whether anybody
was told — and nothing to check afterwards against "it was only twenty minutes".

A window is that record, and it is now the only way in.

```text
POST /api/instance-admin/maintenance/windows               schedule
POST /api/instance-admin/maintenance/windows/:id/approve   a second operator agrees
POST /api/instance-admin/maintenance/windows/:id/start     maintenance mode on
POST /api/instance-admin/maintenance/windows/:id/end       maintenance mode off
POST /api/instance-admin/maintenance/windows/:id/cancel
GET  /api/instance-admin/maintenance/windows               all of it
GET  /api/maintenance/windows                              what any customer sees
```

## Notice is recorded, not enforced

A planned window is one announced at least 24 hours ahead. Anything shorter is
relabelled **expedited** and has to say why, in at least twenty characters.

Relabelled rather than refused, deliberately. A rule that said "no window inside
24 hours" would be worked around within a month by whoever has to fix something
tonight — a second switch, a direct edit, a deploy that happens to restart
everything — and the honest record would be the first thing lost. So the window
is allowed and the label tells the truth about it.

`noticeMinutes` is stored on every window, so "how often do we give people real
notice" is a question with an answer rather than an impression.

## Two operators

A window is scheduled by one operator and approved by **a different** one. It
cannot start without that.

Maintenance mode makes the instance read-only for every customer at once, which
is the largest blast radius any single operator action has here. The failure this
guards against is not malice; it is one tired person at 2am with the wrong window
open.

## An approved window is not a standing licence

A window may start at most 30 minutes before its planned start, and not at all
after its planned end. Without that, a window approved for next month is
permission to take the instance down today, with everybody's agreement on record
for something else entirely.

Two windows may not overlap. Two overlapping windows means two people believe
different things about when the instance is down.

## Ending one has to work during one

`POST /api/instance-admin/maintenance/windows/:id/end` is allowed through the
maintenance guard, which otherwise refuses every write.

Without that exception maintenance mode is a state the API can enter and not
leave — recoverable only by deleting a file on the box, which is exactly the sort
of step nobody wants to be looking up mid-incident.

## Planned against actual

```json
{ "plannedMinutes": 60, "actualMinutes": 184, "status": "completed" }
```

Both are recorded, and the end is audited with both. A window that was meant to
take twenty minutes and took three hours is the one worth going back and reading,
and it is the number that disappears if only the plan is written down.

## What customers see

`GET /api/maintenance/windows` returns **upcoming and in-progress** windows to
any signed-in user. Not the history — a customer wants to know whether their
release tonight is going to run into something.

A window nobody was told about is an outage with paperwork. Announcing is the
whole point of scheduling.

## Not done yet

- **Nothing starts or ends a window automatically.** An operator does both. That
  is deliberate for now: an instance that takes itself down on a timer will
  eventually do it during an incident.
- **No notification.** The window is visible on request; it should arrive by
  email to organization owners when scheduled and when it changes.
- **No per-tenant windows.** Every window here is instance-wide.

## Related

- [Status Page](STATUS_PAGE.md) — where a window is announced to anybody who
  cannot sign in
- [Operations Boundary](OPERATIONS_BOUNDARY.md) — severity levels and who is
  told what
- [Backups and Restore](BACKUPS_AND_RESTORE.md) — where the maintenance switch
  itself lives
- [Instance Admin Console](INSTANCE_ADMIN_CONSOLE.md) — the rest of the operator
  surface
