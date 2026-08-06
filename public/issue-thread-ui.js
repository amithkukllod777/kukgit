import { renderMarkdown } from './markdown.js';

const THREAD_API = '/api/issue-comments';
const TAXONOMY_API = '/api/issue-taxonomy';
const REACTIONS_API = '/api/issue-reactions';
let threadRenderKey = '';
let threadRefusedKey = '';
let threadScheduled = false;
let threadReactions = null;

function threadEscape(value = '') {
  return String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

function threadDate(value) {
  if (!value) return '';
  const date = new Date(String(value).includes('T') ? value : `${String(value).replace(' ', 'T')}Z`);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' }).format(date)
    : '';
}

function threadNotify(title, message, type = 'success') {
  const root = document.querySelector('#toast-root');
  if (!root) return;
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<div>${type === 'error' ? '⚠' : '✓'}</div><div><b>${threadEscape(title)}</b><span>${threadEscape(message)}</span></div>`;
  root.append(toast);
  setTimeout(() => toast.remove(), 4600);
}

async function threadRequest(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
    body: options.body && typeof options.body !== 'string' ? JSON.stringify(options.body) : options.body,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload?.error?.message || `Request failed (${response.status})`);
    error.status = response.status;
    error.code = payload?.error?.code;
    throw error;
  }
  return payload;
}

function threadRoute() {
  const [path, query] = location.hash.slice(1).split('?');
  const segments = path.split('/').filter(Boolean).map(decodeURIComponent);
  if (segments[0] !== 'repo' || segments[3] !== 'issues' || !segments[1] || !segments[2]) return null;
  const number = new URLSearchParams(query || '').get('issue');
  // No `?issue=` is the list, which app.js renders. This module is only ever
  // the thread underneath one issue.
  if (!number || !/^\d+$/.test(number)) return null;
  return { org: segments[1], repo: segments[2], number };
}

function threadStyles() {
  if (document.querySelector('#kg-thread-styles')) return;
  const style = document.createElement('style');
  style.id = 'kg-thread-styles';
  style.textContent = `
    .kg-thread-comment { border:1px solid var(--border); border-radius:12px; padding:14px; margin-top:12px; background:rgba(255,255,255,.018); }
    .kg-thread-head { display:flex; gap:9px; align-items:center; flex-wrap:wrap; margin-bottom:8px; }
    .kg-thread-head b { font-size:13px; }
    .kg-thread-head span { color:var(--muted); font-size:11px; }
    .kg-thread-body { word-break:break-word; line-height:1.6; }
    .kg-thread-body > *:first-child { margin-top:0; }
    .kg-thread-body > *:last-child { margin-bottom:0; }
    .kg-thread-body p { margin:0 0 10px; }
    .kg-thread-body h1, .kg-thread-body h2, .kg-thread-body h3,
    .kg-thread-body h4, .kg-thread-body h5, .kg-thread-body h6 { margin:16px 0 8px; line-height:1.3; }
    .kg-thread-body h1 { font-size:19px; } .kg-thread-body h2 { font-size:17px; }
    .kg-thread-body h3 { font-size:15px; } .kg-thread-body h4, .kg-thread-body h5, .kg-thread-body h6 { font-size:13px; }
    .kg-thread-body ul, .kg-thread-body ol { margin:0 0 10px; padding-left:22px; }
    .kg-thread-body li { margin:3px 0; }
    .kg-thread-body code { background:rgba(255,255,255,.07); border-radius:5px; padding:1px 5px; font-size:12px; }
    .kg-thread-body pre { background:rgba(0,0,0,.32); border:1px solid var(--border); border-radius:9px; padding:11px 13px; overflow-x:auto; margin:0 0 10px; }
    .kg-thread-body pre code { background:none; padding:0; font-size:12px; line-height:1.5; }
    .kg-thread-body blockquote { margin:0 0 10px; padding:2px 0 2px 12px; border-left:3px solid var(--border); color:var(--muted); }
    .kg-thread-body hr { border:0; border-top:1px solid var(--border); margin:14px 0; }
    .kg-thread-body img { max-width:100%; border-radius:8px; }
    .kg-thread-body table { border-collapse:collapse; }
    .kg-thread-body input[type=checkbox] { margin-right:4px; vertical-align:middle; }
    .kg-md-note { color:var(--muted); font-size:11px; }
    .kg-rxn-row { display:flex; gap:6px; flex-wrap:wrap; align-items:center; margin-top:10px; }
    .kg-rxn { display:inline-flex; align-items:center; gap:5px; border:1px solid var(--border); background:rgba(255,255,255,.03); border-radius:99px; padding:2px 10px; font-size:12px; cursor:pointer; line-height:1.7; }
    .kg-rxn[disabled] { cursor:default; opacity:.75; }
    .kg-rxn.mine { border-color:rgba(120,170,255,.55); background:rgba(120,170,255,.14); }
    .kg-rxn-add { color:var(--muted); font-size:13px; padding:2px 9px; }
    .kg-rxn-picker { display:flex; gap:4px; flex-wrap:wrap; }
    .kg-rxn-picker button { border:1px solid var(--border); background:none; border-radius:8px; padding:2px 7px; cursor:pointer; font-size:14px; }
    .kg-thread-controls { display:flex; gap:7px; margin-left:auto; }
    .kg-thread-empty { padding:18px 8px; text-align:center; color:var(--muted); }
    .kg-thread-compose { margin-top:16px; }
    .kg-thread-side { display:flex; gap:9px; flex-wrap:wrap; align-items:center; padding:11px 0; border-bottom:1px solid var(--border); margin-bottom:6px; }
    .kg-thread-label { display:inline-flex; align-items:center; gap:5px; border-radius:99px; padding:3px 10px; font-size:11px; font-weight:600; border:1px solid rgba(255,255,255,.14); }
    .kg-thread-side .muted { font-size:11px; }
    .kg-thread-side select { max-width:190px; }
  `;
  document.head.append(style);
}

/**
 * Markdown, rendered with this repository's issue numbers turned into links.
 *
 * `#42` in a comment means issue 42 in *this* repository, so the renderer is
 * given a way to build that address rather than guessing one. On a screen with
 * no repository — a README on another route — it is not given one, and `#42`
 * stays text rather than becoming a link to somewhere it does not mean.
 */
function threadBody(text) {
  const route = threadContext?.route;
  return renderMarkdown(text, route
    ? { issueHref: (number) => `#/repo/${encodeURIComponent(route.org)}/${encodeURIComponent(route.repo)}/issues?issue=${number}` }
    : {});
}

/**
 * The row of reactions under a comment or under the issue itself.
 *
 * `subject` is the comment id, or empty for the issue. It goes into a data
 * attribute and comes back out on click, so the click handler never has to
 * know how the thread is laid out.
 *
 * When nobody has reacted and the reader cannot react either, this renders
 * nothing at all rather than an empty row — a control that does nothing is
 * worse than no control.
 */
function reactionRow(subject = '') {
  const inner = reactionChips(subject);
  return inner === null ? '' : `<div class="kg-rxn-row" data-rxn-row="${threadEscape(subject)}">${inner}</div>`;
}

/**
 * What goes inside the row. Separate from the row itself so that repainting
 * after a click replaces the contents rather than the element — the shim and
 * the browser agree on `innerHTML`, and replacing an element from under a
 * listener that is mid-click is a different kind of problem.
 *
 * `null` means there is nothing to draw at all.
 */
function reactionChips(subject = '') {
  if (!threadReactions) return null;
  const summary = (subject ? threadReactions.comments?.[subject] : threadReactions.issue) ?? [];
  const canReact = Boolean(threadReactions.canReact);
  if (!summary.length && !canReact) return null;
  const emoji = new Map((threadReactions.available ?? []).map((entry) => [entry.name, entry]));
  const chips = summary.map((entry) => {
    const known = emoji.get(entry.reaction);
    // The names are what the count means. A tooltip is the only place they fit
    // without the row of chips becoming a paragraph.
    const title = `${entry.names.join(', ')}${entry.count > entry.names.length ? ` and ${entry.count - entry.names.length} more` : ''}`;
    return `<button class="kg-rxn${entry.mine ? ' mine' : ''}" data-rxn="${threadEscape(entry.reaction)}" data-rxn-subject="${threadEscape(subject)}" title="${threadEscape(title)}"${canReact ? '' : ' disabled'}>${threadEscape(known?.emoji ?? '?')} ${entry.count}</button>`;
  }).join('');
  const add = canReact
    ? `<button class="kg-rxn kg-rxn-add" data-rxn-open="${threadEscape(subject)}" title="Add a reaction">☺+</button>`
    : '';
  return `${chips}${add}`;
}

function commentMarkup(comment, canComment) {
  const mine = Boolean(comment.authorId) && canComment;
  return `<article class="kg-thread-comment" data-comment="${threadEscape(comment.id)}">
    <div class="kg-thread-head">
      <b>${threadEscape(comment.authorName)}</b>
      ${comment.imported ? `<span class="badge">imported from ${threadEscape(comment.importedFrom || 'another host')}</span>` : ''}
      <span>${threadEscape(threadDate(comment.createdAt))}</span>
      ${comment.editedAt ? `<span>· edited ${threadEscape(threadDate(comment.editedAt))}</span>` : ''}
      ${mine ? '<div class="kg-thread-controls"><button class="btn btn-ghost kg-thread-edit">Edit</button><button class="btn btn-ghost kg-thread-delete">Delete</button></div>' : ''}
    </div>
    <div class="kg-thread-body">${threadBody(comment.body)}</div>
    ${reactionRow(comment.id)}
  </article>`;
}

/**
 * Readable on the colour the label was given.
 *
 * A hex colour from another host is whatever somebody picked there, and a
 * light-on-light or dark-on-dark label is a label nobody can read. The
 * coefficients are the standard luminance weights.
 */
function readableOn(hex) {
  const value = String(hex || '888888').padEnd(6, '8').slice(0, 6);
  const [r, g, b] = [0, 2, 4].map((offset) => parseInt(value.slice(offset, offset + 2), 16) || 0);
  return (0.299 * r + 0.587 * g + 0.114 * b) > 150 ? '#0b1220' : '#ffffff';
}

function labelChip(label) {
  return `<span class="kg-thread-label" style="background:#${threadEscape(label.colour)};color:${readableOn(label.colour)}">${threadEscape(label.name)}</span>`;
}

function taxonomyMarkup(payload, taxonomy) {
  if (!taxonomy) return '';
  const labels = payload.issue.labels ?? [];
  const assignee = payload.issue.assigneeName || payload.issue.importedAssignee;
  return `<div class="kg-thread-side" id="kg-thread-side">
    ${labels.length ? labels.map(labelChip).join('') : '<span class="muted">No labels</span>'}
    ${payload.issue.milestoneTitle ? `<span class="badge">◷ ${threadEscape(payload.issue.milestoneTitle)}</span>` : ''}
    ${assignee ? `<span class="muted">Assigned to ${threadEscape(assignee)}${payload.issue.assigneeName ? '' : ' (imported)'}</span>` : '<span class="muted">Unassigned</span>'}
    ${taxonomy.canManage ? '<button class="btn btn-ghost" id="kg-thread-edit-side" style="margin-left:auto">Edit</button>' : ''}
  </div>`;
}

function taxonomyEditor(payload, taxonomy) {
  const chosen = new Set((payload.issue.labels ?? []).map((label) => label.id));
  return `<div class="kg-thread-side" id="kg-thread-side">
    <div style="display:grid;gap:9px;width:100%">
      <div>${taxonomy.labels.length
        ? taxonomy.labels.map((label) => `<label class="kg-thread-label" style="background:#${threadEscape(label.colour)};color:${readableOn(label.colour)}"><input type="checkbox" name="label" value="${threadEscape(label.id)}"${chosen.has(label.id) ? ' checked' : ''} /> ${threadEscape(label.name)}</label>`).join(' ')
        : '<span class="muted">This repository has no labels yet.</span>'}</div>
      <div style="display:flex;gap:9px;flex-wrap:wrap;align-items:center">
        <select class="select" id="kg-thread-milestone"><option value="">No milestone</option>${taxonomy.milestones.map((milestone) => `<option value="${threadEscape(milestone.id)}"${payload.issue.milestoneId === milestone.id ? ' selected' : ''}>${threadEscape(milestone.title)}</option>`).join('')}</select>
        <select class="select" id="kg-thread-assignee"><option value="">Unassigned</option>${taxonomy.assignable.map((person) => `<option value="${threadEscape(person.id)}"${payload.issue.assigneeId === person.id ? ' selected' : ''}>${threadEscape(person.name)}</option>`).join('')}</select>
        <button class="btn btn-primary" id="kg-thread-save-side">Save</button>
        <button class="btn" id="kg-thread-cancel-side">Cancel</button>
      </div>
    </div>
  </div>`;
}

function threadMarkup(payload, route, taxonomy) {
  const { issue, comments, canComment } = payload;
  return `<section class="card kg-thread-panel" id="kg-thread-panel">
    <div class="card-header">
      <div><h2>#${issue.number} ${threadEscape(issue.title)}</h2><p>Opened by ${threadEscape(issue.authorName)} · ${threadEscape(threadDate(issue.createdAt))}</p></div>
      <div style="display:flex;gap:8px;align-items:center">
        <span class="badge ${threadEscape(issue.status)}">${threadEscape(issue.status)}</span>
        <a class="btn btn-ghost" href="#/repo/${encodeURIComponent(route.org)}/${encodeURIComponent(route.repo)}/issues">Back to issues</a>
      </div>
    </div>
    <div class="card-body">
      <div id="kg-thread-side-wrap">${taxonomyMarkup(payload, taxonomy)}</div>
      <div class="kg-thread-comment">${issue.body ? `<div class="kg-thread-body">${threadBody(issue.body)}</div>` : ''}${reactionRow('')}</div>
      <div id="kg-thread-comments">
        ${comments.length ? comments.map((comment) => commentMarkup(comment, canComment)).join('') : '<div class="kg-thread-empty">No replies yet.</div>'}
      </div>
      ${canComment ? `<form class="kg-thread-compose" id="kg-thread-form">
        <div class="field"><label>Reply</label><textarea class="textarea" name="body" placeholder="Add context, a decision, or what you tried" required></textarea></div>
        <button type="button" class="btn btn-primary" id="kg-thread-submit">Comment</button>
      </form>` : '<div class="kg-thread-empty">You have read access to this repository, so you can follow the discussion but not reply.</div>'}
    </div>
  </section>`;
}

function renderComments(comments, canComment) {
  const list = document.querySelector('#kg-thread-comments');
  if (!list) return;
  list.innerHTML = comments.length ? comments.map((comment) => commentMarkup(comment, canComment)).join('') : '<div class="kg-thread-empty">No replies yet.</div>';
  bindComments(canComment);
  bindReactions();
}

let threadContext = null;

function commentPath(commentId = '') {
  const { org, repo, number } = threadContext.route;
  const base = `${THREAD_API}/${encodeURIComponent(org)}/${encodeURIComponent(repo)}/${encodeURIComponent(number)}`;
  return commentId ? `${base}/${encodeURIComponent(commentId)}` : base;
}

function bindComments(canComment) {
  document.querySelectorAll('.kg-thread-delete').forEach((button) => button.addEventListener('click', async () => {
    const id = button.closest('[data-comment]').dataset.comment;
    // A deleted comment is gone, and whoever replied to it is now answering
    // nothing.
    if (!window.confirm('Delete this comment? It cannot be brought back.')) return;
    button.disabled = true;
    try {
      const payload = await threadRequest(commentPath(id), { method: 'DELETE' });
      renderComments(payload.comments, canComment);
    } catch (error) {
      threadNotify('Could not delete the comment', error.message, 'error');
      button.disabled = false;
    }
  }));

  document.querySelectorAll('.kg-thread-edit').forEach((button) => button.addEventListener('click', () => {
    const article = button.closest('[data-comment]');
    const body = article.querySelector('.kg-thread-body');
    if (article.querySelector('.kg-thread-editor')) return;
    const original = body.textContent;
    body.innerHTML = `<textarea class="textarea kg-thread-editor">${threadEscape(original)}</textarea>
      <div style="display:flex;gap:7px;margin-top:8px"><button class="btn btn-primary kg-thread-save">Save</button><button class="btn kg-thread-cancel">Cancel</button></div>`;
    article.querySelector('.kg-thread-cancel').addEventListener('click', () => { body.textContent = original; });
    article.querySelector('.kg-thread-save').addEventListener('click', async (event) => {
      const save = event.currentTarget;
      save.disabled = true;
      try {
        const payload = await threadRequest(commentPath(article.dataset.comment), {
          method: 'PATCH',
          body: { body: article.querySelector('.kg-thread-editor').value },
        });
        renderComments(payload.comments, canComment);
      } catch (error) {
        threadNotify('Could not save the edit', error.message, 'error');
        save.disabled = false;
      }
    });
  }));
}

function reactionsPath() {
  const { org, repo, number } = threadContext.route;
  return `${REACTIONS_API}/${encodeURIComponent(org)}/${encodeURIComponent(repo)}/${encodeURIComponent(number)}`;
}

/**
 * Repaints the reaction rows without touching anything else on the screen.
 *
 * Re-rendering the whole thread after a click would throw away an open reply
 * box and whatever somebody had typed into it, for the sake of a number going
 * from two to three.
 */
function repaintReactions() {
  for (const row of document.querySelectorAll('[data-rxn-row]')) {
    row.innerHTML = reactionChips(row.dataset.rxnRow) ?? '';
  }
  bindReactions();
}

async function sendReaction(subject, reaction) {
  try {
    threadReactions = await threadRequest(reactionsPath(), {
      method: 'POST',
      body: { reaction, commentId: subject || null },
    });
    repaintReactions();
  } catch (error) {
    threadNotify('Could not react', error.message, 'error');
  }
}

function bindReactions() {
  for (const button of document.querySelectorAll('[data-rxn]')) {
    button.addEventListener('click', () => sendReaction(button.dataset.rxnSubject, button.dataset.rxn));
  }
  for (const opener of document.querySelectorAll('[data-rxn-open]')) {
    opener.addEventListener('click', () => {
      const subject = opener.dataset.rxnOpen;
      const row = opener.closest('[data-rxn-row]');
      if (row.querySelector('.kg-rxn-picker')) { repaintReactions(); return; }
      // The whole set, so the choice is a choice and not a text box. Free text
      // here would be an unmoderated message channel on somebody else's issue.
      const picker = document.createElement('span');
      picker.className = 'kg-rxn-picker';
      picker.innerHTML = (threadReactions.available ?? [])
        .map((entry) => `<button data-rxn-pick="${threadEscape(entry.name)}" title="${threadEscape(entry.label)}">${threadEscape(entry.emoji)}</button>`)
        .join('');
      row.append(picker);
      for (const choice of picker.querySelectorAll('[data-rxn-pick]')) {
        choice.addEventListener('click', () => sendReaction(subject, choice.dataset.rxnPick));
      }
    });
  }
}

function bindTaxonomy(payload, taxonomy) {
  if (!taxonomy?.canManage) return;
  document.querySelector('#kg-thread-edit-side')?.addEventListener('click', () => {
    document.querySelector('#kg-thread-side-wrap').innerHTML = taxonomyEditor(payload, taxonomy);
    document.querySelector('#kg-thread-cancel-side').addEventListener('click', () => {
      document.querySelector('#kg-thread-side-wrap').innerHTML = taxonomyMarkup(payload, taxonomy);
      bindTaxonomy(payload, taxonomy);
    });
    document.querySelector('#kg-thread-save-side').addEventListener('click', async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      const { org, repo, number } = threadContext.route;
      try {
        await threadRequest(`${TAXONOMY_API}/${encodeURIComponent(org)}/${encodeURIComponent(repo)}/issues/${encodeURIComponent(number)}`, {
          method: 'PATCH',
          body: {
            labelIds: [...document.querySelectorAll('input[name="label"]:checked')].map((input) => input.value),
            milestoneId: document.querySelector('#kg-thread-milestone').value || null,
            assigneeId: document.querySelector('#kg-thread-assignee').value || null,
          },
        });
        // Re-read rather than guess: the server decides what the issue now
        // looks like, and an assignment it refuses must not appear to have
        // worked.
        await mountThread(true);
      } catch (error) {
        threadNotify('Could not save', error.message, 'error');
        button.disabled = false;
      }
    });
  });
}

function bindThread(canComment, payload, taxonomy) {
  bindComments(canComment);
  bindReactions();
  bindTaxonomy(payload, taxonomy);
  document.querySelector('#kg-thread-submit')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const textarea = document.querySelector('#kg-thread-form [name="body"]');
    if (!textarea.value.trim()) { threadNotify('Nothing to post', 'Write something before commenting.', 'error'); return; }
    button.disabled = true;
    button.textContent = 'Posting…';
    try {
      const payload = await threadRequest(commentPath(), { method: 'POST', body: { body: textarea.value } });
      textarea.value = '';
      renderComments(payload.comments, canComment);
    } catch (error) {
      threadNotify('Could not post the comment', error.message, 'error');
    } finally {
      button.disabled = false;
      button.textContent = 'Comment';
    }
  });
}

async function mountThread(force = false) {
  threadScheduled = false;
  const route = threadRoute();
  if (!route) return;
  const content = document.querySelector('.content');
  if (!content) return;
  const key = `${route.org}/${route.repo}#${route.number}`;
  if (!force && threadRenderKey === key && document.querySelector('#kg-thread-panel')) return;
  // A refused load renders no panel, so the guard above can never be satisfied
  // by one. Without remembering the refusal this asks again on every DOM
  // change — a request per keystroke, for an issue the visitor cannot read.
  if (!force && threadRefusedKey === key) return;
  threadRenderKey = key;
  threadContext = { route };
  threadStyles();
  try {
    const payload = await threadRequest(commentPath());
    // A repository whose taxonomy cannot be read is not a reason to hide the
    // conversation, so this failure is absorbed rather than raised.
    const taxonomy = await threadRequest(`${TAXONOMY_API}/${encodeURIComponent(route.org)}/${encodeURIComponent(route.repo)}`).catch(() => null);
    // Same reasoning: a thread that cannot load its reactions is still a
    // thread. `null` makes every reaction row render as nothing.
    threadReactions = await threadRequest(reactionsPath()).catch(() => null);
    document.querySelector('#kg-thread-panel')?.remove();
    content.insertAdjacentHTML('beforeend', threadMarkup(payload, route, taxonomy));
    bindThread(payload.canComment, payload, taxonomy);
  } catch (error) {
    if ([401, 403, 404].includes(error.status)) { threadRefusedKey = key; return; }
    if (!document.querySelector('#kg-thread-panel')) {
      content.insertAdjacentHTML('beforeend', `<section class="card kg-thread-panel" id="kg-thread-panel"><div class="card-body kg-thread-empty">${threadEscape(error.message)}</div></section>`);
    }
  }
}

function scheduleThreadMount() {
  if (threadScheduled) return;
  threadScheduled = true;
  requestAnimationFrame(() => requestAnimationFrame(() => mountThread()));
}

window.addEventListener('hashchange', scheduleThreadMount);
new MutationObserver(scheduleThreadMount).observe(document.querySelector('#app'), { childList: true, subtree: true });
scheduleThreadMount();
