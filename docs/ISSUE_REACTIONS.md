# Reactions

A reaction on an issue, or on any reply to one.

The point is that "I agree", "this happened to me too" and "thank you" stop
being comments. A tracker without reactions grows a layer of one-word replies
that push the actual discussion off the screen, and nobody reading a thread of
forty comments can tell whether it is forty people or one argument.

```
GET  /api/issue-reactions/:org/:repo/:number   # everything on the issue and its comments
POST /api/issue-reactions/:org/:repo/:number   # { reaction, commentId? } — toggles
```

One read covers the whole thread. Asking per comment would be one request per
reply on every render, which is the shape of every request storm this front end
has had.

## The set

`+1` `-1` `laugh` `hooray` `confused` `heart` `rocket` `eyes`

Fixed, and **stored by name rather than by character**. Two reasons, and both
matter:

- Free text would make this an unmoderated message channel on somebody else's
  issue. A "reaction" can be a sentence, and a slur is a sentence.
- `❤️` is two code points and `❤` is one. Storing what the keyboard sent means
  the same reaction from two keyboards is two rows, and one person appears to
  have reacted twice with the same thing.

Reacting again with the same thing takes it back. That is the only gesture the
interface offers, because an interface where the undo is somewhere else is an
interface where nobody undoes.

## Who can react

Read access is enough. A reader who cannot react writes "+1" as a comment
instead, which is worse for everybody.

**Except a KukGit support operator.** A support grant gives `read` on a
customer's repository, and the promise attached to that grant is that support
looks without touching — a reaction is a mark left in the customer's repository
with an operator's name on it. `GET` returns `canReact: false` so the screen
does not draw buttons that would answer 403.

An operator who is *also* a member of the organization reacts as a member. The
check asks whether anything other than the support grant is granting access, not
whether a grant exists.

A stranger gets 404 on a private repository, not 403 — the same rule as
everywhere else, because 403 confirms the repository exists and its name is in
the URL that produced the answer.

## Storage

```sql
issue_reactions(id, issue_id, comment_id, user_id, reaction, created_at)
```

`comment_id` is null when the reaction is on the issue itself. Both it and
`issue_id` are real foreign keys, so deleting a comment or an issue takes its
reactions with it.

Uniqueness is **two partial indexes**, not one `UNIQUE` across four columns:

```sql
UNIQUE(comment_id, user_id, reaction) WHERE comment_id IS NOT NULL
UNIQUE(issue_id,   user_id, reaction) WHERE comment_id IS NULL
```

SQLite treats every NULL as distinct, so a single constraint including
`comment_id` would never stop the same person reacting to the same *issue* with
the same thing twice. There is a test for exactly that.

## On screen

A row of chips under the issue body and under each comment, in the order the set
is declared — not by count, because ordering by count rearranges the buttons
under somebody's cursor as other people react.

Each chip shows the emoji and the number, is highlighted if it is yours, and
names up to eight of the people behind it in its tooltip. The count is exact;
the list is not, because an issue with four hundred thumbs does not need four
hundred names in every response.

Clicking repaints only the reaction rows. Re-rendering the whole thread for the
sake of a number going from two to three would throw away an open reply box and
whatever somebody had typed into it.

The new state comes back from the server rather than being guessed, so a
reaction the server refuses never appears to have worked.

## What is not here yet

- **No reactions on pull requests or review comments.** Those are review
  threads, which are a separate feature.
- **No notification.** Being reacted to tells you nothing; only a comment does.
  This is deliberate for now — a notification per thumb is the fastest way to
  make people mute the category.
- **No list of everybody who reacted.** Eight names and a count.
