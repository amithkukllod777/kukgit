/**
 * The one markdown renderer, shared by every screen that shows prose.
 *
 * KukGit had a nine-line renderer inside `app.js` that handled headings, bold,
 * inline code and lists, and that was the whole of it — so an issue body, a
 * comment and a README each rendered a slightly different subset of markdown
 * depending on which screen you were on, and a link was never a link anywhere.
 *
 * This is a small block-and-inline parser rather than a pile of regular
 * expressions applied to the whole document at once. That matters for one
 * reason above all the others: **the escaping has to happen before any markup
 * is inserted, and nothing must ever put user text inside an attribute without
 * deciding first whether it belongs there.**
 *
 * Three decisions that are security, not formatting:
 *
 * **No raw HTML survives.** `<b>bold</b>` in a comment renders as the literal
 * characters. A tracker where a comment can inject markup is a tracker where a
 * comment can draw a fake sign-in box, and everyone with read access can write
 * comments.
 *
 * **A link's scheme is checked against a list of what is allowed, not against a
 * list of what is banned.** `javascript:`, `data:` and `vbscript:` are the ones
 * everybody remembers; the reason to allow-list instead is the ones nobody
 * does. A URL that fails the check renders as plain text, visible, so nothing
 * is silently swallowed.
 *
 * **A remote image is not loaded.** `![](http://someone-elses-host/x.png)` in a
 * comment turns every person who opens that issue into a row in somebody else's
 * access log, complete with IP address and the time they read it — without
 * clicking anything. It renders as a link instead, which requires a decision
 * from the reader. Images served from this instance are shown normally.
 */

const MAX_INPUT = 200_000;

// What may appear in an `href`. Anything else is not a link.
//
// Allow-listed rather than blocked: `javascript:` and `data:` are the two
// everybody thinks of, and the list of the rest is not knowable.
const SAFE_HREF = /^(?:https?:\/\/|mailto:[^\s@]+@|\/|#|\.{1,2}\/)/i;

// An image is only rendered if it comes from here. Everything else becomes a
// link the reader has to choose to follow.
const LOCAL_IMAGE = /^(?:\/(?!\/)|\.{1,2}\/)/;

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, (char) => ESCAPES[char]);
}

export function safeHref(url = '') {
  // The text arrives already HTML-escaped, so `&` is `&amp;` and a quote can no
  // longer close the attribute. What is left to decide is the scheme.
  const trimmed = String(url).trim();
  if (!trimmed || /[\u0000-\u0020\u007F]/.test(trimmed)) return null;
  return SAFE_HREF.test(trimmed) ? trimmed : null;
}

function isExternal(href) {
  return /^https?:\/\//i.test(href);
}

function anchor(href, label) {
  // `nofollow` because a public host with open issues is a link farm otherwise,
  // and `noopener` because a target that can reach back into `window.opener`
  // can navigate the page it came from.
  const attributes = isExternal(href)
    ? ' target="_blank" rel="noopener noreferrer nofollow"'
    : '';
  return `<a href="${href}"${attributes}>${label}</a>`;
}

/**
 * Inline markup, run over one already-escaped line.
 *
 * Code spans are lifted out first and put back last. Without that, a link or an
 * asterisk inside backticks would be turned into markup — and the whole point
 * of writing `` `**not bold**` `` is to show the characters.
 */
function renderInline(escaped, options) {
  const spans = [];
  let text = escaped.replace(/`([^`\n]+)`/g, (_, code) => {
    spans.push(`<code>${code}</code>`);
    return `\u0000${spans.length - 1}\u0000`;
  });

  // An attribute is not element content: a code span restored inside one would
  // put `<code>` where it means nothing, so in that position it goes back as
  // the characters the author typed.
  const plain = (value) => value.replace(/\u0000(\d+)\u0000/g, (_, index) => spans[Number(index)].replace(/<\/?code>/g, ''));

  // Images before links: the syntax differs by one leading `!`, and a link
  // pattern applied first would eat the image and leave the `!` behind.
  text = text.replace(/!\[([^\]\n]*)\]\(([^)\s]+)\)/g, (whole, alt, url) => {
    const href = safeHref(url);
    if (!href) return whole;
    if (LOCAL_IMAGE.test(href)) return `<img src="${plain(href)}" alt="${plain(alt)}" loading="lazy">`;
    // Somebody else's host. Rendering it would report every reader to them.
    return `${anchor(href, alt || href)} <span class="kg-md-note">(image, not loaded)</span>`;
  });

  text = text.replace(/\[([^\]\n]*)\]\(([^)\s]+)\)/g, (whole, label, url) => {
    const href = safeHref(url);
    // Not a link, and not thrown away either — the reader sees exactly what was
    // written and can judge it.
    return href ? anchor(href, label || href) : whole;
  });

  // A bare URL somebody pasted. Bounded so the trailing punctuation of a
  // sentence does not end up inside the link.
  text = text.replace(/(^|[\s(])(https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)])/g, (_, before, url) => `${before}${anchor(url, url)}`);

  if (options.issueHref) {
    text = text.replace(/(^|[\s(])#(\d{1,9})\b/g, (whole, before, number) => {
      const href = safeHref(options.issueHref(Number(number)));
      return href ? `${before}${anchor(href, `#${number}`)}` : whole;
    });
  }

  text = text.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/(^|[^*\w])\*([^*\n]+)\*(?![*\w])/g, '$1<em>$2</em>');
  text = text.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');

  return text.replace(/\u0000(\d+)\u0000/g, (_, index) => spans[Number(index)]);
}

function listItemBody(raw, options) {
  // `- [ ] thing` is a task, and the box is disabled: this renders a comment
  // somebody else wrote, and a checkbox that looked clickable but changed
  // nothing would be worse than no checkbox.
  const task = raw.match(/^\[([ xX])\]\s+(.*)$/);
  if (!task) return renderInline(escapeHtml(raw), options);
  const checked = task[1].toLowerCase() === 'x' ? ' checked' : '';
  return `<input type="checkbox" disabled${checked}> ${renderInline(escapeHtml(task[2]), options)}`;
}

/**
 * @param {string} text markdown as the author typed it
 * @param {{issueHref?: (number: number) => string}} [options]
 * @returns {string} HTML safe to assign to innerHTML
 */
export function renderMarkdown(text = '', options = {}) {
  // Two ceilings. The length is so a pasted log file cannot make the parser the
  // slowest thing on the page; the control-character strip is because the code
  // span placeholders use NUL, and text that contained one could otherwise
  // address a span that was never lifted out.
  const source = String(text ?? '').slice(0, MAX_INPUT).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
  const lines = source.replace(/\r\n?/g, '\n').split('\n');

  const out = [];
  let paragraph = [];
  let list = null;

  const flushParagraph = () => {
    if (!paragraph.length) return;
    out.push(`<p>${paragraph.map((line) => renderInline(escapeHtml(line), options)).join('<br>')}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (!list) return;
    out.push(`<${list.tag}>${list.items.map((item) => `<li>${item}</li>`).join('')}</${list.tag}>`);
    list = null;
  };
  const flush = () => { flushParagraph(); flushList(); };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];

    const fence = line.match(/^\s*```\s*([A-Za-z0-9_+-]{0,20})\s*$/);
    if (fence) {
      flush();
      const body = [];
      index += 1;
      // An unterminated fence runs to the end of the document rather than
      // falling back to prose, which is what the author meant when they opened
      // it and forgot to close it.
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) {
        body.push(lines[index]);
        index += 1;
      }
      const language = fence[1] ? ` class="language-${escapeHtml(fence[1])}"` : '';
      out.push(`<pre><code${language}>${escapeHtml(body.join('\n'))}</code></pre>`);
      continue;
    }

    if (!line.trim()) { flush(); continue; }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flush();
      const level = heading[1].length;
      out.push(`<h${level}>${renderInline(escapeHtml(heading[2].trim()), options)}</h${level}>`);
      continue;
    }

    if (/^\s*(?:---+|\*\*\*+|___+)\s*$/.test(line)) { flush(); out.push('<hr>'); continue; }

    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      flush();
      out.push(`<blockquote>${renderInline(escapeHtml(quote[1]), options)}</blockquote>`);
      continue;
    }

    const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
    const numbered = line.match(/^\s*\d{1,9}[.)]\s+(.*)$/);
    if (bullet || numbered) {
      flushParagraph();
      const tag = bullet ? 'ul' : 'ol';
      if (list && list.tag !== tag) flushList();
      if (!list) list = { tag, items: [] };
      list.items.push(listItemBody((bullet || numbered)[1], options));
      continue;
    }

    flushList();
    paragraph.push(line);
  }

  flush();
  return out.join('');
}
