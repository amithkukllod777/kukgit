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

## Limits

- 20,000 characters per comment.
- Comments are plain text, escaped on display. No Markdown rendering yet, and no
  attachments.
- Deleting an issue deletes its comments with it, by foreign key.

## What is not here yet

- **Reactions, mentions and notifications.** Replying to an issue notifies
  nobody today.
- **Markdown.** The body is shown as written, with line breaks preserved.
- **Editing history.** A comment says it was edited and when, not what it said
  before.
- **Comments on pull requests** — those are review threads, which are separate
  and already exist. See [REVIEW_THREADS.md](REVIEW_THREADS.md).
