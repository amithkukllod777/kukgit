# Markdown

One renderer, `public/markdown.js`, shared by every screen that shows prose: a
repository's README, an issue body, and every comment in a thread.

There used to be nine lines of regular expressions inside `app.js` that knew
about headings, bold, inline code and lists. That meant a README and a comment
rendered a slightly different subset of Markdown depending on which screen you
were on, and a link was never a link anywhere.

```js
import { renderMarkdown } from './markdown.js';

renderMarkdown(text);
renderMarkdown(text, { issueHref: (number) => `#/repo/kuklabs/kukgit/issues?issue=${number}` });
```

It is a pure function of a string, so it is tested directly rather than through
a page — see `test/markdown.test.mjs`.

## The three rules that are security, not formatting

The output goes into `innerHTML` on screens where anybody with read access can
write the input. Everything below follows from that.

### No raw HTML survives

`<b>bold</b>` in a comment renders as the literal characters. The escaping
happens before any markup is inserted, never after.

A tracker where a comment can inject markup is a tracker where a comment can
draw a fake sign-in box.

### A link's scheme is allow-listed

Allowed: `https://`, `http://`, `mailto:`, and anything starting `/`, `#`, `./`
or `../`. Everything else — `javascript:`, `data:`, `vbscript:`, `file:`,
`about:` — is **not a link**. The list is an allow-list rather than a block-list
because the schemes worth blocking are the ones nobody has thought of yet.

A URL that fails the check renders as the characters that were typed, visible.
A silently swallowed link is a reader who thinks the comment said nothing.

External links carry `rel="noopener noreferrer nofollow"` and open in a new tab.
`noopener` because a page opened this way can otherwise navigate the page it
came from; `nofollow` because a public host with open issues is a link farm.

### A remote image is not fetched

`![](https://someone-elses-host/pixel.png)` in a comment would put every person
who opens that issue into somebody else's access log — IP address, time, no
click required. It renders as a link with `(image, not loaded)` next to it, so
following it is a decision.

Images served from this instance (`/uploads/x.png`, `./x.png`) render normally.
A protocol-relative URL (`//host/x.png`) counts as remote, because it is.

## What is supported

| | |
|---|---|
| Headings | `# ` through `###### ` |
| Emphasis | `**bold**`, `*italic*`, `~~strikethrough~~` |
| Code | `` `inline` `` and ```` ```lang ```` fenced blocks |
| Lists | `-`/`*`/`+`, `1.`/`1)` |
| Tasks | `- [ ]` and `- [x]`, rendered as **disabled** checkboxes |
| Quotes | `> ` |
| Rules | `---`, `***`, `___` |
| Links | `[text](url)`, and bare `https://…` autolinked |
| Images | `![alt](url)`, local only |
| Issues | `#42`, when the screen provides `issueHref` |

A task checkbox is disabled on purpose. This renders a comment somebody else
wrote; a box that looked clickable and silently saved nothing would be worse
than no box.

An unterminated fence runs to the end of the document rather than falling back
to prose — somebody opened it and forgot to close it, and reverting to
paragraphs would render their pasted stack trace as a wall of accidental
emphasis.

## What is not supported

- Tables.
- Footnotes, definition lists, and the rest of the extended syntaxes.
- Reference-style links (`[text][ref]`).
- Nested lists — a nested bullet renders as a flat one.
- Syntax highlighting. A fence gets `class="language-…"` and nothing colours it.
- `@mentions`. They are text and notify nobody.

## Bounds

- 200,000 characters. Beyond that the input is cut, so a pasted log file cannot
  make the parser the slowest thing on the page.
- Control characters are stripped before parsing. The code-span placeholders are
  NUL-delimited indexes, and text containing one could otherwise name a span
  that was never lifted out.
- Every inline pattern is bounded to a single line and forbids its own delimiter
  inside itself, which is what keeps matching linear rather than exponential.
