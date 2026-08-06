const THREAD_API = '/api/issue-comments';
let threadRenderKey = '';
let threadRefusedKey = '';
let threadScheduled = false;

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
    .kg-thread-body { white-space:pre-wrap; word-break:break-word; line-height:1.6; }
    .kg-thread-controls { display:flex; gap:7px; margin-left:auto; }
    .kg-thread-empty { padding:18px 8px; text-align:center; color:var(--muted); }
    .kg-thread-compose { margin-top:16px; }
  `;
  document.head.append(style);
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
    <div class="kg-thread-body">${threadEscape(comment.body)}</div>
  </article>`;
}

function threadMarkup(payload, route) {
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
      ${issue.body ? `<div class="kg-thread-comment"><div class="kg-thread-body">${threadEscape(issue.body)}</div></div>` : ''}
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

function bindThread(canComment) {
  bindComments(canComment);
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
    document.querySelector('#kg-thread-panel')?.remove();
    content.insertAdjacentHTML('beforeend', threadMarkup(payload, route));
    bindThread(payload.canComment);
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
