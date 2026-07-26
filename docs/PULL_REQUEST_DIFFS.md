# KukGit Pull Request Diffs and Inline Review Anchors

KukGit renders pull-request changes from Git's real merge base and permits inline review threads only on lines that exist in the current patch.

## Comparison model

For a pull request with base branch `main` and head branch `feature` KukGit resolves:

- current base tip SHA
- current head SHA
- `git merge-base <base-tip> <head>`

The displayed patch is generated from:

```text
<merge-base>..<head-sha>
```

This means commits added to the base branch after the feature branch was created do not appear as pull-request changes.

## File metadata

KukGit detects:

- added files
- modified files
- deleted files
- renamed files
- copied files
- type changes
- binary files

Each file summary includes:

- current path
- previous path for rename/copy operations
- additions
- deletions
- binary state
- Git status

Rename and copy detection use Git's native similarity detection.

## Files Changed interface

Open **Repository → Pull requests → Files changed**.

The browser interface provides:

- pull-request selector
- changed-file sidebar
- paginated file loading
- next/previous file navigation
- unified diff view
- side-by-side diff view
- show/ignore whitespace changes
- copy raw unified patch
- inline discussion display
- file-level review comments

File summaries are loaded separately from individual patches so large pull requests do not require every patch to be returned at once.

## Unified patch parsing

KukGit parses each hunk header:

```text
@@ -oldStart,oldCount +newStart,newCount @@
```

Every patch row records:

- row type: context, addition, deletion or metadata
- old-side line number when applicable
- new-side line number when applicable
- patch position
- line content

Parsed rows are sanitized against the old/new counts declared by the hunk header. This prevents trailing newline artifacts from becoming reviewable phantom lines.

## Inline review anchors

A line-level thread must target a line that appears in the current patch.

Supported sides:

- `left`: base-side line
- `right`: head-side line
- `file`: changed-file level

A comment cannot target:

- an arbitrary line elsewhere in the full file
- a line outside a diff hunk
- a non-existent line number
- the wrong side of an added or deleted file
- a binary-file line

Binary files support file-level comments only.

## Multi-line ranges

KukGit supports a same-side, same-hunk range.

In the browser:

1. Select the first line.
2. Shift-click the last line on the same side and hunk.
3. Submit the inline comment.

A valid range must:

- remain on one diff side
- remain inside one hunk
- have a start line not after the end line
- map continuously to actual side-specific patch lines

KukGit stores:

- end line and side
- optional start line and side
- merge-base SHA
- head SHA
- stable SHA-256 anchor key

## Outdated threads

A thread is current only while its stored head SHA matches the pull request's current head SHA.

When new commits are pushed:

- existing conversations remain visible
- their historical anchor remains intact
- they are marked outdated
- outdated unresolved threads do not block merge

This works with KukGit's existing optional policy requiring all active review threads to be resolved before merge.

## Whitespace handling

The default view shows all changes.

The **Ignore whitespace** control regenerates the selected patch with Git's whitespace-ignore behavior. A file that contains only whitespace changes may display no hunks under this mode.

Inline anchors are always validated against the normal current patch before storage. The display toggle does not create hidden or synthetic anchor positions.

## Safety limits

Browser review limits:

- maximum patch body: 2 MB per file
- maximum parsed patch lines: 20,000 per file
- maximum file summary set: 5,000 files
- file-summary page size: 50 by default, 100 maximum

When a patch exceeds the limit, KukGit returns file metadata but instructs the reviewer to inspect the file locally. Oversized patches cannot receive line-level browser threads.

## API

Read a pull-request diff summary:

```text
GET /api/pull-request-diffs/:org/:repo/pulls/:number
```

Query parameters:

- `offset`: file-list offset
- `limit`: page size, maximum 100
- `path`: load one changed-file patch
- `whitespace=ignore`: hide whitespace-only differences

Create a validated review thread:

```text
POST /api/review-threads/:org/:repo/pulls/:number/threads
```

Single-line example:

```json
{
  "path": "src/example.js",
  "side": "right",
  "lineNumber": 42,
  "body": "Please handle the failure case here."
}
```

Multi-line example:

```json
{
  "path": "src/example.js",
  "side": "right",
  "startSide": "right",
  "startLineNumber": 42,
  "lineNumber": 47,
  "body": "Could this block be extracted into a helper?"
}
```

File-level example:

```json
{
  "path": "assets/logo.png",
  "side": "file",
  "lineNumber": null,
  "body": "Please confirm the image license and source."
}
```

## Permissions and request protection

- Repository Read permission can view diff summaries and patches.
- Repository Write permission is required to create an inline review thread.
- Browser writes enforce same-origin protection.
- Repository lifecycle controls still apply; archived repositories reject review writes.
- Paths are validated as safe repository-relative paths before Git is invoked.
- Git is executed with argument arrays, not shell-interpolated commands.

## Local review fallback

For a patch that exceeds browser limits:

```bash
git fetch origin main feature
BASE=$(git merge-base origin/main origin/feature)
git diff "$BASE"..origin/feature -- path/to/file
```

Reviewers should return to KukGit for the final conversation, approval and merge-policy record.
