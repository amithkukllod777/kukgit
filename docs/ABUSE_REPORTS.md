# KukGit Abuse Reports

Somebody is hosting malware here. What happens next.

## Reporting needs no account

```text
POST /api/abuse/reports
{"org": "acme", "repo": "app", "category": "phishing", "detail": "…", "email": "optional"}
```

The person who finds a phishing page hosted on your platform is usually not your
customer. A form only customers can reach is a form that never sees the reports
that matter most.

That immediately means the form itself is abusable, so it has its own rate-limit
surface — **10 per minute**, not the 600 the general API gets. A flood of reports
against one repository is itself a way to attack it.

## It never says whether the target exists

The answer is the same for a real repository, a private one and a name nobody has
ever used:

```json
{"received": true, "caseId": "abc_…"}
```

Otherwise the form is an existence oracle for every private repository on the
instance, usable by anybody with no account. A report naming something
unresolvable is filed as `unknown` and looked at by a person — which is also the
right answer for a real report with a typo, or one about something deleted an
hour ago.

## A report is evidence, not a verdict

**Nothing is disabled by reporting it.** An automatic takedown on report is a
weapon anybody can point at any repository, and it would be used that way within
a week. There is a test that files twenty reports and asserts the repository is
still fully accessible.

Reports about the same target and category collapse into **one case**. Five
hundred reports about one repository is one thing to look at, not five hundred —
and the count is itself a signal.

The case shows `reportCount` and `distinctReporters` separately, so "six reports"
and "six reports from one place" do not read the same.

## The reporter is a fingerprint

A report stores `sha256("kukgit-abuse:" + address)` truncated to 16 characters —
enough to see that fifty reports came from one place, not enough to be a record
of who reported what. An abuse queue full of raw addresses is a list of people
who reported things, which is a list worth stealing.

A contact address is **optional**. When given it is kept for the operator and is
never part of anything the reported party would see.

## Deciding

```text
GET  /api/instance-admin/abuse/cases?status=open|all
POST /api/instance-admin/abuse/cases/:id/resolve   {"action": "…", "resolution": "…"}
```

`dismiss`, `warn`, `disable`, `escalate`. **Every outcome needs a written reason,
including a dismissal** — "we looked and it was fine" is the sentence somebody
needs when the same repository is reported again next month.

A resolved case stays resolved. Changing your mind means a new case, because an
outcome that can be edited is not a record of what was decided.

## Disabled, not deleted

`disable` sets one column on the repository. The bytes are untouched, the row is
untouched, and putting it back is one statement:

```text
GET  /api/instance-admin/abuse/disabled
POST /api/instance-admin/abuse/disabled/:org/:repo/reinstate   {"reason": "…"}
```

The alternative to a reversible disable is either doing nothing about hosted
malware or deleting somebody's work on the strength of a report form.

While disabled, **nobody** reads it — including its owners. That is harsh on a
false positive and deliberate on a true one, and it is why reinstating is cheap
and why the reason is recorded on both ends.

### Where the check lives, and why it took a live test to get right

The obvious place is the permission resolver, and that is where it started. It
was wrong, and cloning the repository proved it:

**A public repository is served over Git with no authorization at all.** No
credential, no permission resolution, nothing for a check inside the resolver to
run against. Hosted malware is public on purpose — anonymous download is the
entire point of it — so the one case the control exists for was the one case it
missed.

The check now sits at the transport entry point, before the auth branch, in both
Git HTTP and Git LFS. SSH resolves a permission and is covered by the resolver.
Three transports, and the test that caught it was a real `git clone` rather than
a unit test of the function that was already passing.

## The owner is told

A disable or a warning notifies every **owner and admin** of the organization,
with the operator's written reason **verbatim**. A message that says only "policy
violation" leaves somebody unable to fix anything, and they are the only person
who can.

A repository that stops working with no message is indistinguishable from an
outage, and the first thing its owner does is open a support ticket asking why
the platform is broken.

Members also get the reason from the API rather than a bare 403:

```text
403 REPOSITORY_DISABLED
This repository is disabled pending an abuse review. Confirmed phishing page …
```

A stranger gets the same 404 they would get for a private repository. "Disabled
for abuse" is not a fact to hand to somebody passing by.

Delivery failures are swallowed — an operator who disabled hosted malware has
done the important part, and not being able to send an email is a worse day, not
a reason to leave it running. How many owners were actually reached is written
into the audit event, so telling nobody at all is visible rather than silent.

## Appealing

```text
POST /api/abuse/appeals                                  {"org": "…", "repo": "…", "body": "…"}
GET  /api/instance-admin/abuse/appeals?status=open|all
POST /api/instance-admin/abuse/appeals/:id/answer        {"answer": "…"}
```

Deliberately **not** under `/api/repos/:org/:repo/…`. Those routes resolve
repository access, which is exactly what a disable takes away — so the one route
somebody needs when their repository is disabled would have been the one refusing
them. Authorization is on the organization, which a disable does not touch.

One open appeal at a time. Filing ten does not make anybody read it faster, and
it turns the appeal route into the flooding problem the report route already has.

Two ways it ends, and both notify the owner:

- **Reinstating answers it.** Waiting for a reply to a question already decided
  in your favour is the worst outcome available here.
- **Answering without reinstating.** The decision stands, and here is why. An
  appeal process with no way to say no says nothing at all, and the person waits
  forever.

## What this is not

- **Not a DMCA process.** Copyright is a category here so a report can be filed
  and routed; counter-notice, jurisdiction and the rest are legal process this
  does not implement.
- **Not automated detection.** Nothing scans for malware. See
  [Secret Scanning](SECRET_SCANNING.md) for the one thing that is scanned.

## Not done yet

- **Email.** Notifications are raised in the `security` category, which defaults
  to email on — but a disabled repository's owner may not be reachable by email
  at all, and nothing here retries or escalates.
- **Organization-level disable.** Only repositories can be disabled today.
- **Reporter feedback.** A reporter who left an address hears nothing back.

## Related

- [Operations Boundary](OPERATIONS_BOUNDARY.md) — severity and escalation
- [Instance Admin Console](INSTANCE_ADMIN_CONSOLE.md) — the rest of the operator
  surface
- [Repository Access](REPOSITORY_ACCESS.md) — the resolver a disable overrides
