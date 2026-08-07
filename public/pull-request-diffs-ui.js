const PR_DIFFS_API = '/api/pull-request-diffs';
const PR_THREADS_API = '/api/review-threads';
let diffMountKey = '';
let diffScheduled = false;
const diffState = {
  route: null,
  pullRequests: [],
  pullNumber: null,
  files: [],
  nextOffset: null,
  selectedPath: null,
  payload: null,
  mode: 'unified',
  whitespace: 'show',
  anchor: null,
};

function diffEscape(value = '') {
  return String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

function diffNotify(title, message, type = 'success') {
  const root = document.querySelector('#toast-root');
  if (!root) return;
  const element = document.createElement('div');
  element.className = `toast ${type}`;
  element.innerHTML = `<div>${type === 'error' ? '⚠' : '✓'}</div><div><b>${diffEscape(title)}</b><span>${diffEscape(message)}</span></div>`;
  root.append(element);
  setTimeout(() => element.remove(), 4600);
}

async function diffRequest(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
    body: options.body && typeof options.body !== 'string' ? JSON.stringify(options.body) : options.body,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload?.error?.message || `Request failed (${response.status})`);
    error.code = payload?.error?.code;
    throw error;
  }
  return payload;
}

function diffRoute() {
  const [path] = location.hash.slice(1).split('?');
  const segments = path.split('/').filter(Boolean).map(decodeURIComponent);
  if (segments[0] !== 'repo' || !segments[1] || !segments[2] || segments[3] !== 'pulls') return null;
  return { org: segments[1], repo: segments[2] };
}

function diffStyles() {
  if (document.querySelector('#kg-pr-diff-styles')) return;
  const style = document.createElement('style');
  style.id = 'kg-pr-diff-styles';
  style.textContent = `
    .kg-pr-diffs { margin-top:18px; overflow:hidden; }
    .kg-diff-toolbar { display:flex; flex-wrap:wrap; align-items:center; gap:8px; }
    .kg-diff-toolbar .select { min-width:180px; }
    .kg-diff-summary { display:flex; flex-wrap:wrap; gap:8px; margin-top:12px; }
    .kg-diff-layout { display:grid; grid-template-columns:280px minmax(0,1fr); min-height:420px; border-top:1px solid var(--border); }
    .kg-diff-files { border-right:1px solid var(--border); max-height:760px; overflow:auto; background:rgba(3,11,20,.32); }
    .kg-diff-file { width:100%; text-align:left; border:0; border-bottom:1px solid var(--border); background:transparent; color:inherit; padding:12px; cursor:pointer; }
    .kg-diff-file:hover, .kg-diff-file.active { background:rgba(21,152,255,.08); }
    .kg-diff-file strong { display:block; overflow-wrap:anywhere; font-size:12px; }
    .kg-diff-file-meta { display:flex; align-items:center; gap:7px; margin-top:5px; color:var(--muted); font-size:10px; }
    .kg-diff-file-load { padding:12px; }
    .kg-diff-main { min-width:0; overflow:auto; }
    .kg-diff-file-head { position:sticky; top:0; z-index:5; display:flex; justify-content:space-between; align-items:center; gap:12px; padding:12px 14px; border-bottom:1px solid var(--border); background:#07111f; }
    .kg-diff-file-head strong { overflow-wrap:anywhere; }
    .kg-diff-file-actions { display:flex; flex-wrap:wrap; gap:7px; }
    .kg-diff-hunk { border-bottom:1px solid var(--border); }
    .kg-diff-hunk-head { padding:8px 12px; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:11px; background:rgba(21,152,255,.08); color:#9bcfff; }
    .kg-diff-line { display:grid; grid-template-columns:28px 52px 28px 52px minmax(300px,1fr); min-height:25px; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:11px; line-height:1.55; }
    .kg-diff-line.add { background:rgba(61,220,151,.085); }
    .kg-diff-line.delete { background:rgba(255,91,118,.085); }
    .kg-diff-line.meta { color:var(--muted); font-style:italic; }
    .kg-diff-num { padding:3px 7px; text-align:right; color:var(--muted); user-select:none; border-right:1px solid rgba(255,255,255,.035); }
    .kg-diff-code { display:flex; gap:8px; white-space:pre; padding:3px 10px; overflow:auto; }
    .kg-diff-prefix { user-select:none; color:var(--muted); }
    .kg-diff-comment-button { border:0; background:transparent; color:transparent; cursor:pointer; padding:0; font-weight:800; }
    .kg-diff-line:hover .kg-diff-comment-button { color:#1598ff; background:rgba(21,152,255,.12); }
    .kg-diff-comment-button.selected { color:#fff; background:#1598ff; }
    .kg-diff-side-row { display:grid; grid-template-columns:minmax(360px,1fr) minmax(360px,1fr); border-bottom:1px solid rgba(255,255,255,.025); font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:11px; }
    .kg-diff-side-cell { display:grid; grid-template-columns:28px 52px minmax(280px,1fr); min-height:25px; border-right:1px solid var(--border); }
    .kg-diff-side-cell:last-child { border-right:0; }
    .kg-diff-side-cell.add { background:rgba(61,220,151,.085); }
    .kg-diff-side-cell.delete { background:rgba(255,91,118,.085); }
    .kg-diff-thread-inline { margin:7px 12px 10px; border:1px solid rgba(21,152,255,.28); border-radius:11px; overflow:hidden; background:rgba(5,17,30,.94); }
    .kg-diff-thread-head { display:flex; justify-content:space-between; gap:8px; padding:8px 10px; border-bottom:1px solid var(--border); font-size:10px; }
    .kg-diff-thread-comment { padding:9px 10px; border-top:1px solid var(--border); }
    .kg-diff-thread-comment:first-child { border-top:0; }
    .kg-diff-thread-comment b { font-size:11px; }
    .kg-diff-thread-comment span { color:var(--muted); font-size:9px; margin-left:7px; }
    .kg-diff-thread-comment p { margin:5px 0 0; white-space:pre-wrap; line-height:1.5; }
    .kg-diff-review-form { margin:10px 12px; padding:12px; border:1px solid rgba(247,201,72,.35); border-radius:12px; background:rgba(247,201,72,.05); }
    .kg-diff-review-form-head { display:flex; justify-content:space-between; gap:8px; margin-bottom:9px; }
    .kg-diff-review-actions { display:flex; gap:8px; justify-content:flex-end; margin-top:9px; }
    .kg-diff-empty { padding:40px 20px; text-align:center; color:var(--muted); }
    .kg-diff-file-level { margin:10px 12px; }
    @media (max-width:1000px) { .kg-diff-layout { grid-template-columns:1fr; } .kg-diff-files { border-right:0; border-bottom:1px solid var(--border); max-height:240px; } .kg-diff-side-row { grid-template-columns:1fr; } .kg-diff-side-cell { border-right:0; border-bottom:1px solid rgba(255,255,255,.04); } }
  `;
  document.head.append(style);
}

function statusLabel(file) {
  const labels = { added: 'A', deleted: 'D', modified: 'M', renamed: 'R', copied: 'C', 'type-changed': 'T', unmerged: 'U' };
  return labels[file.status] || file.change || 'M';
}

function fileButton(file) {
  return `<button class="kg-diff-file ${file.path === diffState.selectedPath ? 'active' : ''}" data-diff-file="${diffEscape(file.path)}"><strong><span class="badge ${file.status === 'deleted' ? 'critical' : file.status === 'added' ? 'public' : ''}">${statusLabel(file)}</span> ${diffEscape(file.path)}</strong><div class="kg-diff-file-meta">${file.previousPath ? `<span>from ${diffEscape(file.previousPath)}</span>` : ''}<span style="color:#3ddc97">+${file.additions}</span><span style="color:#ff5b76">-${file.deletions}</span>${file.binary ? '<span>binary</span>' : ''}</div></button>`;
}

function threadMarkup(thread) {
  const range = thread.startLineNumber ? `${thread.startLineNumber}–${thread.lineNumber}` : thread.lineNumber || 'file';
  return `<article class="kg-diff-thread-inline"><div class="kg-diff-thread-head"><b>${diffEscape(thread.path)} · ${diffEscape(thread.side)} ${range}</b><span>${thread.outdated ? '<span class="badge">Outdated</span>' : thread.resolved ? '<span class="badge public">Resolved</span>' : '<span class="badge high">Open</span>'}</span></div><div>${thread.comments.map((comment) => `<div class="kg-diff-thread-comment"><b>${diffEscape(comment.authorName)}</b><span>${diffEscape(new Date(comment.createdAt).toLocaleString())}</span><p>${diffEscape(comment.body)}</p></div>`).join('')}</div></article>`;
}

function threadsFor(side, lineNumber) {
  return (diffState.payload?.threads || []).filter((thread) => thread.side === side && Number(thread.lineNumber) === Number(lineNumber));
}

function fileThreads() {
  return (diffState.payload?.threads || []).filter((thread) => thread.side === 'file');
}

function anchorSelected(hunkIndex, side, lineNumber) {
  const anchor = diffState.anchor;
  if (!anchor || anchor.hunkIndex !== hunkIndex || anchor.side !== side) return false;
  const start = Math.min(anchor.startLineNumber, anchor.lineNumber);
  const end = Math.max(anchor.startLineNumber, anchor.lineNumber);
  return lineNumber >= start && lineNumber <= end;
}

function commentButton(hunkIndex, side, lineNumber) {
  if (!lineNumber || !diffState.payload?.canComment) return '<span></span>';
  return `<button class="kg-diff-comment-button ${anchorSelected(hunkIndex, side, lineNumber) ? 'selected' : ''}" data-diff-anchor data-hunk="${hunkIndex}" data-side="${side}" data-line="${lineNumber}" title="Click for one line; Shift-click to extend range">＋</button>`;
}

function reviewFormMarkup() {
  const anchor = diffState.anchor;
  if (!anchor) return '';
  const range = anchor.startLineNumber === anchor.lineNumber ? `${anchor.side} line ${anchor.lineNumber}` : `${anchor.side} lines ${Math.min(anchor.startLineNumber, anchor.lineNumber)}–${Math.max(anchor.startLineNumber, anchor.lineNumber)}`;
  return `<form class="kg-diff-review-form" id="kg-diff-review-form"><div class="kg-diff-review-form-head"><b>Comment on ${diffEscape(range)}</b><button class="btn btn-ghost" type="button" id="kg-cancel-diff-review">Cancel</button></div><textarea class="textarea" name="body" rows="3" maxlength="20000" placeholder="Explain the code issue, question or suggestion" required></textarea><div class="kg-diff-review-actions"><button class="btn btn-primary" type="submit">Start inline thread</button></div></form>`;
}

function unifiedLineMarkup(line, hunkIndex) {
  if (line.type === 'meta') return `<div class="kg-diff-line meta"><span></span><span class="kg-diff-num"></span><span></span><span class="kg-diff-num"></span><code class="kg-diff-code">${diffEscape(line.content)}</code></div>`;
  const prefix = line.type === 'add' ? '+' : line.type === 'delete' ? '-' : ' ';
  const threads = [...threadsFor('left', line.oldLine), ...threadsFor('right', line.newLine)];
  const formHere = diffState.anchor && diffState.anchor.hunkIndex === hunkIndex && ((diffState.anchor.side === 'left' && line.oldLine === diffState.anchor.lineNumber) || (diffState.anchor.side === 'right' && line.newLine === diffState.anchor.lineNumber));
  return `<div class="kg-diff-line ${line.type}">${commentButton(hunkIndex, 'left', line.oldLine)}<span class="kg-diff-num">${line.oldLine || ''}</span>${commentButton(hunkIndex, 'right', line.newLine)}<span class="kg-diff-num">${line.newLine || ''}</span><code class="kg-diff-code"><span class="kg-diff-prefix">${prefix}</span>${diffEscape(line.content)}</code></div>${threads.map(threadMarkup).join('')}${formHere ? reviewFormMarkup() : ''}`;
}

function pairSideRows(lines) {
  const rows = [];
  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    if (line.type === 'context') { rows.push({ left: line, right: line }); index += 1; continue; }
    if (line.type === 'meta') { rows.push({ meta: line }); index += 1; continue; }
    const deletes = [];
    const adds = [];
    while (index < lines.length && lines[index].type === 'delete') deletes.push(lines[index++]);
    while (index < lines.length && lines[index].type === 'add') adds.push(lines[index++]);
    if (!deletes.length && !adds.length) { rows.push({ left: line.type === 'delete' ? line : null, right: line.type === 'add' ? line : null }); index += 1; continue; }
    for (let row = 0; row < Math.max(deletes.length, adds.length); row += 1) rows.push({ left: deletes[row] || null, right: adds[row] || null });
  }
  return rows;
}

function sideCell(line, side, hunkIndex) {
  if (!line) return '<div class="kg-diff-side-cell"><span></span><span class="kg-diff-num"></span><code class="kg-diff-code"></code></div>';
  const lineNumber = side === 'left' ? line.oldLine : line.newLine;
  const type = side === 'left' && line.type === 'delete' ? 'delete' : side === 'right' && line.type === 'add' ? 'add' : 'context';
  return `<div class="kg-diff-side-cell ${type}">${commentButton(hunkIndex, side, lineNumber)}<span class="kg-diff-num">${lineNumber || ''}</span><code class="kg-diff-code">${diffEscape(line.content)}</code></div>`;
}

function sideRowMarkup(row, hunkIndex) {
  if (row.meta) return `<div class="kg-diff-hunk-head">${diffEscape(row.meta.content)}</div>`;
  const leftThreads = row.left ? threadsFor('left', row.left.oldLine) : [];
  const rightThreads = row.right ? threadsFor('right', row.right.newLine) : [];
  const formHere = diffState.anchor && diffState.anchor.hunkIndex === hunkIndex && ((diffState.anchor.side === 'left' && row.left?.oldLine === diffState.anchor.lineNumber) || (diffState.anchor.side === 'right' && row.right?.newLine === diffState.anchor.lineNumber));
  return `<div class="kg-diff-side-row">${sideCell(row.left, 'left', hunkIndex)}${sideCell(row.right, 'right', hunkIndex)}</div>${[...leftThreads, ...rightThreads].map(threadMarkup).join('')}${formHere ? reviewFormMarkup() : ''}`;
}

function patchMarkup(selected) {
  if (!selected) return '<div class="kg-diff-empty">Select a changed file to load its patch.</div>';
  if (selected.binary) return '<div class="kg-diff-empty">Binary file changed. Use a file-level review thread for this file.</div>';
  if (selected.tooLarge) return '<div class="kg-diff-empty">This file diff exceeds the 2 MB / 20,000-line browser review limit. Review it locally.</div>';
  if (!selected.hunks.length) return '<div class="kg-diff-empty">No visible patch lines under the current whitespace setting.</div>';
  return `${fileThreads().map(threadMarkup).join('')}${selected.hunks.map((hunk, index) => `<section class="kg-diff-hunk"><div class="kg-diff-hunk-head">${diffEscape(hunk.header)}</div>${diffState.mode === 'unified' ? hunk.lines.map((line) => unifiedLineMarkup(line, index)).join('') : pairSideRows(hunk.lines).map((row) => sideRowMarkup(row, index)).join('')}</section>`).join('')}`;
}

function panelMarkup(summary, selectedPayload) {
  const selected = selectedPayload?.selectedFile || null;
  const selectedFile = selected?.file || null;
  return `<section class="card kg-pr-diffs" id="kg-pr-diffs-panel"><div class="card-header"><div><h2>Files changed</h2><p>Git-native merge-base diff with inline patch conversations.</p></div><div class="kg-diff-toolbar"><select class="select" id="kg-diff-pr-select">${diffState.pullRequests.map((pull) => `<option value="${pull.number}" ${Number(pull.number) === Number(diffState.pullNumber) ? 'selected' : ''}>#${pull.number} ${diffEscape(pull.title)}</option>`).join('')}</select><button class="btn ${diffState.mode === 'unified' ? 'btn-primary' : ''}" id="kg-diff-unified">Unified</button><button class="btn ${diffState.mode === 'side' ? 'btn-primary' : ''}" id="kg-diff-side">Side-by-side</button><button class="btn" id="kg-diff-whitespace">${diffState.whitespace === 'ignore' ? 'Show whitespace changes' : 'Ignore whitespace'}</button></div></div><div class="card-body"><div class="kg-diff-summary"><span class="badge">${summary.totals.files} files</span><span class="badge public">+${summary.totals.additions}</span><span class="badge critical">-${summary.totals.deletions}</span><span class="badge">Merge base ${diffEscape(summary.refs.mergeBase.slice(0, 7))}</span>${summary.totals.truncated ? '<span class="badge high">File list truncated</span>' : ''}</div></div><div class="kg-diff-layout"><aside class="kg-diff-files" id="kg-diff-file-list">${diffState.files.map(fileButton).join('')}${diffState.nextOffset !== null ? '<div class="kg-diff-file-load"><button class="btn btn-block" id="kg-diff-load-more">Load more files</button></div>' : ''}</aside><main class="kg-diff-main"><div class="kg-diff-file-head"><div><strong>${selectedFile ? diffEscape(selectedFile.path) : 'Select a file'}</strong>${selectedFile?.previousPath ? `<div class="muted" style="font-size:10px">Renamed from ${diffEscape(selectedFile.previousPath)}</div>` : ''}</div><div class="kg-diff-file-actions">${selectedFile && selectedPayload.canComment ? '<button class="btn" id="kg-file-review">Comment on file</button>' : ''}${selected?.rawPatch ? '<button class="btn" id="kg-copy-patch">Copy patch</button>' : ''}<button class="btn" id="kg-prev-diff-file">←</button><button class="btn" id="kg-next-diff-file">→</button></div></div><div id="kg-diff-patch">${patchMarkup(selected)}</div></main></div></section>`;
}

async function loadSummary(route, pullNumber, offset = 0) {
  return diffRequest(`${PR_DIFFS_API}/${encodeURIComponent(route.org)}/${encodeURIComponent(route.repo)}/pulls/${pullNumber}?offset=${offset}&limit=50`);
}

async function loadSelected(route, pullNumber, filePath) {
  return diffRequest(`${PR_DIFFS_API}/${encodeURIComponent(route.org)}/${encodeURIComponent(route.repo)}/pulls/${pullNumber}?path=${encodeURIComponent(filePath)}&whitespace=${diffState.whitespace}`);
}

function resetAnchor() {
  diffState.anchor = null;
}

/**
 * `reuseSelected` is for a change that is only about how the patch is drawn.
 *
 * Unified and side-by-side are the same bytes arranged differently, so
 * re-fetching the file to switch between them is a round trip per click on a
 * patch that may be a megabyte. Whitespace is not this: it changes what the
 * server computes, so that path still reloads.
 */
async function renderDiffPanel(forceSummary = false, reuseSelected = false) {
  const route = diffState.route;
  if (!route || !diffState.pullNumber) return;
  let summary;
  if (forceSummary || !diffState.payload) {
    summary = await loadSummary(route, diffState.pullNumber, 0);
    diffState.files = summary.files;
    diffState.nextOffset = summary.nextOffset;
    if (!diffState.selectedPath || !diffState.files.some((file) => file.path === diffState.selectedPath)) diffState.selectedPath = diffState.files[0]?.path || null;
  } else {
    summary = diffState.payload.summary || await loadSummary(route, diffState.pullNumber, 0);
  }
  let selectedPayload = reuseSelected && diffState.payload?.selectedFile ? diffState.payload : null;
  if (!selectedPayload && diffState.selectedPath) selectedPayload = await loadSelected(route, diffState.pullNumber, diffState.selectedPath);
  diffState.payload = { ...(selectedPayload || summary), summary };
  const content = document.querySelector('.content');
  document.querySelector('#kg-pr-diffs-panel')?.remove();
  const after = document.querySelector('#kg-review-threads-panel');
  if (after) after.insertAdjacentHTML('afterend', panelMarkup(summary, selectedPayload));
  else content.insertAdjacentHTML('beforeend', panelMarkup(summary, selectedPayload));
  bindDiffPanel(summary, selectedPayload);
}

function setAnchor(event) {
  const button = event.currentTarget;
  const next = { hunkIndex: Number(button.dataset.hunk), side: button.dataset.side, lineNumber: Number(button.dataset.line), startLineNumber: Number(button.dataset.line) };
  if (event.shiftKey && diffState.anchor && diffState.anchor.hunkIndex === next.hunkIndex && diffState.anchor.side === next.side) next.startLineNumber = diffState.anchor.startLineNumber;
  diffState.anchor = next;
  renderDiffPanel(false).catch((error) => diffNotify('Diff render failed', error.message, 'error'));
}

function bindReviewForm() {
  document.querySelector('#kg-cancel-diff-review')?.addEventListener('click', () => {
    resetAnchor();
    renderDiffPanel(false).catch(() => {});
  });
  document.querySelector('#kg-diff-review-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      const anchor = diffState.anchor;
      const start = Math.min(anchor.startLineNumber, anchor.lineNumber);
      const end = Math.max(anchor.startLineNumber, anchor.lineNumber);
      await diffRequest(`${PR_THREADS_API}/${encodeURIComponent(diffState.route.org)}/${encodeURIComponent(diffState.route.repo)}/pulls/${diffState.pullNumber}/threads`, {
        method: 'POST',
        body: {
          path: diffState.selectedPath,
          side: anchor.side,
          lineNumber: end,
          startSide: anchor.side,
          startLineNumber: start === end ? null : start,
          body: new FormData(form).get('body'),
        },
      });
      diffNotify('Inline review thread created', 'The comment is anchored to the current pull-request patch.');
      resetAnchor();
      await renderDiffPanel(false);
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    } catch (error) {
      diffNotify('Review comment rejected', error.message, 'error');
      button.disabled = false;
    }
  });
}

function bindDiffPanel(summary, selectedPayload) {
  document.querySelector('#kg-diff-pr-select')?.addEventListener('change', async (event) => {
    diffState.pullNumber = Number(event.target.value);
    diffState.selectedPath = null;
    diffState.payload = null;
    resetAnchor();
    await renderDiffPanel(true);
  });
  document.querySelector('#kg-diff-unified')?.addEventListener('click', () => { diffState.mode = 'unified'; renderDiffPanel(false, true).catch(() => {}); });
  document.querySelector('#kg-diff-side')?.addEventListener('click', () => { diffState.mode = 'side'; renderDiffPanel(false, true).catch(() => {}); });
  document.querySelector('#kg-diff-whitespace')?.addEventListener('click', () => { diffState.whitespace = diffState.whitespace === 'ignore' ? 'show' : 'ignore'; resetAnchor(); renderDiffPanel(false).catch(() => {}); });
  document.querySelectorAll('[data-diff-file]').forEach((button) => button.addEventListener('click', async () => {
    diffState.selectedPath = button.dataset.diffFile;
    resetAnchor();
    await renderDiffPanel(false);
  }));
  document.querySelector('#kg-diff-load-more')?.addEventListener('click', async (event) => {
    event.currentTarget.disabled = true;
    const page = await loadSummary(diffState.route, diffState.pullNumber, diffState.nextOffset);
    diffState.files.push(...page.files.filter((file) => !diffState.files.some((item) => item.path === file.path)));
    diffState.nextOffset = page.nextOffset;
    await renderDiffPanel(false);
  });
  document.querySelectorAll('[data-diff-anchor]').forEach((button) => button.addEventListener('click', setAnchor));
  document.querySelector('#kg-file-review')?.addEventListener('click', async () => {
    const body = window.prompt(`Comment on file ${diffState.selectedPath}`);
    if (!body?.trim()) return;
    try {
      await diffRequest(`${PR_THREADS_API}/${encodeURIComponent(diffState.route.org)}/${encodeURIComponent(diffState.route.repo)}/pulls/${diffState.pullNumber}/threads`, { method: 'POST', body: { path: diffState.selectedPath, side: 'file', lineNumber: null, body } });
      diffNotify('File review thread created', 'The comment is attached to the changed file.');
      await renderDiffPanel(false);
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    } catch (error) { diffNotify('Review comment rejected', error.message, 'error'); }
  });
  document.querySelector('#kg-copy-patch')?.addEventListener('click', async () => {
    await navigator.clipboard.writeText(selectedPayload.selectedFile.rawPatch);
    diffNotify('Patch copied', 'The selected unified patch is on your clipboard.');
  });
  const currentIndex = diffState.files.findIndex((file) => file.path === diffState.selectedPath);
  document.querySelector('#kg-prev-diff-file')?.addEventListener('click', async () => {
    if (currentIndex <= 0) return;
    diffState.selectedPath = diffState.files[currentIndex - 1].path;
    resetAnchor();
    await renderDiffPanel(false);
  });
  document.querySelector('#kg-next-diff-file')?.addEventListener('click', async () => {
    if (currentIndex < 0 || currentIndex >= diffState.files.length - 1) return;
    diffState.selectedPath = diffState.files[currentIndex + 1].path;
    resetAnchor();
    await renderDiffPanel(false);
  });
  bindReviewForm();
}

async function mountPullRequestDiffs(force = false) {
  const route = diffRoute();
  if (!route) return;
  const content = document.querySelector('.content');
  if (!content) return;
  const key = `${route.org}/${route.repo}/${location.hash}`;
  if (!force && diffMountKey === key && document.querySelector('#kg-pr-diffs-panel')) return;
  diffMountKey = key;
  diffStyles();
  diffState.route = route;
  try {
    const governance = await diffRequest(`/api/governance/${encodeURIComponent(route.org)}/${encodeURIComponent(route.repo)}`);
    diffState.pullRequests = governance.pullRequests.filter((pull) => pull.status === 'open');
    if (!diffState.pullRequests.length) {
      document.querySelector('#kg-pr-diffs-panel')?.remove();
      content.insertAdjacentHTML('beforeend', '<section class="card kg-pr-diffs" id="kg-pr-diffs-panel"><div class="kg-diff-empty">Open a pull request to review a Git patch.</div></section>');
      return;
    }
    if (!diffState.pullNumber || !diffState.pullRequests.some((pull) => Number(pull.number) === Number(diffState.pullNumber))) diffState.pullNumber = diffState.pullRequests[0].number;
    await renderDiffPanel(true);
  } catch (error) {
    if (!document.querySelector('#kg-pr-diffs-panel')) content.insertAdjacentHTML('beforeend', `<section class="card kg-pr-diffs" id="kg-pr-diffs-panel"><div class="kg-diff-empty">${diffEscape(error.message)}</div></section>`);
  }
}

function schedulePullRequestDiffs() {
  if (diffScheduled) return;
  diffScheduled = true;
  requestAnimationFrame(() => requestAnimationFrame(async () => {
    diffScheduled = false;
    await mountPullRequestDiffs();
  }));
}

window.addEventListener('hashchange', schedulePullRequestDiffs);
new MutationObserver(schedulePullRequestDiffs).observe(document.querySelector('#app'), { childList: true, subtree: true });
schedulePullRequestDiffs();
