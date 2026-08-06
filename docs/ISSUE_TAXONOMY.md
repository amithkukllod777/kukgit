# Labels, milestones and assignees

Every tracker anybody migrates from has these, and KukGit had none of them — so
an import either dropped them or had to say it dropped them, which is what it
was doing. This is where they go.

```
GET    /api/issue-taxonomy/:org/:repo                       # labels, milestones, who can be assigned
POST   /api/issue-taxonomy/:org/:repo/labels                # create a label
DELETE /api/issue-taxonomy/:org/:repo/labels/:labelId       # remove one
POST   /api/issue-taxonomy/:org/:repo/milestones            # create a milestone
PATCH  /api/issue-taxonomy/:org/:repo/issues/:number        # set labels, milestone, assignee
```

On an issue thread the strip above the conversation shows them, with an **Edit**
button for anybody with write access.

## Labels belong to a repository

`bug` on one repository and `bug` on another are two labels that happen to share
a word. Merging them by name would let one team's rename change another team's
tracker.

That matters more than it sounds, because label ids come from the caller. A
label id from another repository is refused rather than attached, both when
setting an issue's labels and when deleting a label through a repository's own
path. Both are tested, and both fail their test when the check is removed.

**Deleting a label needs `maintain`; creating one needs `write`.** Deleting takes
the label off every issue that carried it, which is not the same weight of
decision as adding one. The issues themselves are untouched — an issue is not a
label's dependant.

A label's colour is stored as six hex digits. Text on the chip is chosen from the
colour's luminance, because a hex value from another host is whatever somebody
picked there and white on white is a label nobody can read.

## Milestones

Created once per title within a repository. Deleting one clears it from its
issues and deletes none of them: a milestone being cancelled is not a reason to
lose the work that was planned for it.

## Assignees

**An assignee must be somebody who can see the repository.** Assigning work to a
person with no access produces an issue nobody can open and a name on a screen
that means nothing. The screen only offers people who are already members, and
the server checks again rather than trusting the list it sent.

**An imported assignee is recorded as text.** GitHub gives a login, not an email,
so there is nothing to match a KukGit account against. Creating one would invent
somebody who can be @-mentioned, assigned work and granted access, and who cannot
sign in to object — the same rule the rest of import follows. The name is shown
and marked imported.

## Import

A bulk import from GitHub brings labels, milestones and assignee names with the
issues. Labels are created once per name rather than once per use — a label
arrives attached to every issue that carries it, not as a list — and the same
holds for milestones. The progress line reports how many of each arrived.

## What is not here yet

- **Filtering the issue list** by label, milestone or assignee.
- **A milestone page** with its own progress and burndown; milestones are
  currently set and displayed but have no screen of their own.
- **Editing a label** after creation — it can be created and deleted, not
  renamed or recoloured.
- **Multiple assignees.** One per issue.
