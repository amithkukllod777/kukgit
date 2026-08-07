# Replying to an issue

KukGit has had issues since the beginning and, until now, no way to answer one.
A tracker where nobody can reply is a list of complaints — and it is why
importing issues from another host would have thrown away the part people
actually wanted to keep, because there was nowhere to put the conversation.

Open an issue from the repository's Issues tab. The thread is at
`#/repo/:org/:repo/issues?issue=:number`.

```
GET    /api/issue-comments/:org/:repo/:number              # the issue and its replies
POST   /api/issue-comments/:org/:repo/:number              # reply
PATCH  /api/issue-comments/:org/:repo/:number/:commentId   # edit your own
DELETE /api/issue-comments/:org/:repo/:number/:commentId   # remove
```

## Who can do what

| | Read the thread | Reply | Edit a comment | Delete a comment |
| --- | --- | --- | --- | --- |
| Viewer / read | yes | no | no | no |
| Developer / write | yes | yes | **own only** | own only |
| Maintainer and above | yes | yes | **own only** | anyone's |

**Only the author may edit, including maintainers editing somebody else.** A
maintainer can remove a comment — that is moderation. Putting different words in
somebody's mouth is not a power any role should have, and a thread where a reply
can be silently rewritten after somebody acted on it is a thread nobody can rely
on. An edited comment shows that it was edited, and when.

Deleting somebody else's comment writes an audit event recording who did it and
that it was not their own.

## Imported comments

A comment carried in from another host records **two** things: the KukGit
account that ran the import owns the row, and the original author's name is kept
as text. The screen shows the original name and marks the comment as imported.

Nothing creates a KukGit user for a GitHub login. That would invent a person who
can be @-mentioned, assigned work and granted access — and who cannot sign in to
object. It is the same rule tenant import already follows: a member with no
account here is reported, never invented.

An imported comment also keeps the time it was written. A thread where every
reply is dated the day of the migration is a thread whose order means nothing.

## Markdown

Bodies are Markdown, rendered by `public/markdown.js` — the same renderer the
README uses, so a comment and a repository's documentation look the same. See
[MARKDOWN.md](MARKDOWN.md) for what is supported and, more importantly, for the
three rules that are security rather than formatting: no raw HTML survives, link
schemes are allow-listed, and a remote image is never fetched.

`#42` in a comment links to issue 42 in the same repository.

## Notifications

Adding a comment notifies:

- whoever opened the issue,
- whoever it is assigned to,
- and everybody who has already replied.

Not everybody with write access. A tracker produces far more of these than pull
requests do, and a product whose first week is a hundred notifications about
issues nobody opened is a product where the bell gets muted — taking the ones
that mattered with it.

Two things the rule deliberately excludes:

- **An imported comment does not make anybody a participant.** The account that
  ran an import owns every row it carried across, so counting those would
  subscribe one person to five hundred conversations on the strength of pressing
  a button once.
- **Somebody who has lost access is not told.** Access is re-checked per
  recipient at the moment of sending, because the title of a private issue is
  private and a participant from last month may have been removed since.

They arrive in the bell by default and not by email. Turn email on per person
under the `issue` category in notification settings.

A notification that fails does not lose the comment: the failure is logged with
the request id and the writer still gets a 201, because from their side the
thing they did worked.

### The schema change this needed

`issue` was the first notification category added after those tables existed,
and SQLite has no `ALTER TABLE … DROP CONSTRAINT`. The three tables carrying a
`CHECK(category IN …)` are rebuilt when the list in `NOTIFICATION_CATEGORIES`
changes, and the constraint is generated from that constant so the next category
costs nothing.

The dangerous part is the rename. **Renaming a table rewrites the `REFERENCES`
clause of every table that points at it**, whatever `legacy_alter_table` says,
so after `email_outbox` is renamed aside, `email_delivery_attempts` points at
the temporary name and dropping it cascades every delivery attempt away. The
migration rebuilds the dependant table too, before the old parent is dropped.

**Rollback:** deploy the previous release. A shorter category list rebuilds the
tables in the other direction. Narrowing is refused — loudly, at startup — while
rows still use the category being removed, because the alternative is deleting
somebody's notifications to make a schema fit.

## Reactions

See [ISSUE_REACTIONS.md](ISSUE_REACTIONS.md).

## Limits

- 20,000 characters per comment.
- Deleting an issue deletes its comments, and their reactions, with it.

## What is not here yet

- **Mentions.** `@somebody` is text; it does not notify them.
- **Attachments.** There is no upload path, so an image has to be hosted
  somewhere and linked — and a remote image renders as a link, not as an image.
- **Editing history.** A comment says it was edited and when, not what it said
  before.
- **Comments on pull requests** — those are review threads, which are separate
  and already exist. See [REVIEW_THREADS.md](REVIEW_THREADS.md).
