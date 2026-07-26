const TOKEN_API = '/api/settings/tokens';
let renderSequence = 0;

function escapeHtml(value = '') {
  return String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

function notify(title, message, type = 'success') {
  const root = document.querySelector('#toast-root');
  if (!root) return;
  const element = document.createElement('div');
  element.className = `toast ${type}`;
  element.innerHTML = `<div>${type === 'error' ? '⚠' : '✓'}</div><div><b>${escapeHtml(title)}</b><span>${escapeHtml(message)}</span></div>`;
  root.append(element);
  setTimeout(() => element.remove(), 4600);
}

async function request(path = TOKEN_API, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
    body: options.body && typeof options.body !== 'string' ? JSON.stringify(options.body) : options.body,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.error?.message || `Request failed (${response.status})`);
  return payload;
}

function formatDate(value) {
  if (!value) return 'Never';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '—';
  return new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function statusFor(token) {
  if (token.revokedAt) return { label: 'Revoked', className: 'danger' };
  if (token.expiresAt && new Date(token.expiresAt).getTime() <= Date.now()) return { label: 'Expired', className: 'danger' };
  return { label: 'Active', className: 'public' };
}

async function copyText(value) {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    const input = document.createElement('textarea');
    input.value = value;
    input.style.position = 'fixed';
    input.style.opacity = '0';
    document.body.append(input);
    input.select();
    document.execCommand('copy');
    input.remove();
  }
}

function injectStyles() {
  if (document.querySelector('#kg-token-styles')) return;
  const style = document.createElement('style');
  style.id = 'kg-token-styles';
  style.textContent = `
    .kg-token-panel { margin-top: 18px; }
    .kg-token-layout { display:grid; grid-template-columns:minmax(260px,.8fr) minmax(420px,1.4fr); gap:18px; }
    .kg-token-form { display:grid; gap:14px; }
    .kg-scope-grid { display:grid; gap:9px; }
    .kg-scope-option { display:flex; gap:10px; align-items:flex-start; padding:11px 12px; border:1px solid var(--border); border-radius:12px; background:rgba(255,255,255,.025); }
    .kg-scope-option input { margin-top:3px; }
    .kg-scope-option b { display:block; font-size:13px; }
    .kg-scope-option span { display:block; color:var(--muted); font-size:11px; margin-top:2px; line-height:1.45; }
    .kg-token-secret { border:1px solid rgba(247,201,72,.35); background:rgba(247,201,72,.08); border-radius:14px; padding:14px; margin-bottom:14px; }
    .kg-token-secret code { display:block; margin:10px 0; padding:12px; border-radius:10px; background:#06101c; overflow:auto; color:#fff; user-select:all; }
    .kg-token-row { display:grid; grid-template-columns:minmax(180px,1.2fr) minmax(140px,.8fr) minmax(120px,.7fr) auto; gap:12px; align-items:center; padding:14px 0; border-top:1px solid var(--border); }
    .kg-token-row:first-child { border-top:0; }
    .kg-token-name b { display:block; }
    .kg-token-name span, .kg-token-meta { color:var(--muted); font-size:11px; line-height:1.55; }
    .kg-token-scopes { display:flex; flex-wrap:wrap; gap:5px; }
    .kg-token-empty { padding:28px 10px; text-align:center; color:var(--muted); }
    @media (max-width:900px) { .kg-token-layout { grid-template-columns:1fr; } .kg-token-row { grid-template-columns:1fr; } }
  `;
  document.head.append(style);
}

function panelMarkup() {
  return `
    <section class="card kg-token-panel" id="kg-token-panel">
      <div class="card-header">
        <div><h2>Personal access tokens</h2><p>Create scoped credentials for Git clone, fetch and push. Full token values are shown only once.</p></div>
        <span class="badge public">Phase 1 security</span>
      </div>
      <div class="card-body">
        <div class="kg-token-layout">
          <form class="kg-token-form" id="kg-token-form">
            <div class="field"><label>Token name</label><input class="input" name="name" maxlength="80" placeholder="Developer laptop" required /></div>
            <div class="field"><label>Expiry</label><select class="select" name="expiresInDays"><option value="7">7 days</option><option value="30">30 days</option><option value="90" selected>90 days</option><option value="180">180 days</option><option value="365">365 days</option></select></div>
            <div class="field"><label>Scopes</label><div class="kg-scope-grid">
              <label class="kg-scope-option"><input type="checkbox" name="scope" value="repo:read" checked /><span><b>Repository read</b><span>Clone and fetch repositories you can access.</span></span></label>
              <label class="kg-scope-option"><input type="checkbox" name="scope" value="repo:write" /><span><b>Repository write</b><span>Push branches and updates. Write scope also includes read access.</span></span></label>
            </div></div>
            <button class="btn btn-primary" type="submit" id="kg-token-create">Create personal access token</button>
          </form>
          <div>
            <div id="kg-token-secret"></div>
            <div id="kg-token-list"><div class="kg-token-empty">Loading tokens…</div></div>
          </div>
        </div>
      </div>
    </section>`;
}

function renderTokenList(tokens) {
  const root = document.querySelector('#kg-token-list');
  if (!root) return;
  if (!tokens.length) {
    root.innerHTML = '<div class="kg-token-empty"><b>No personal access tokens yet.</b><br />Create one to authenticate Git operations without using your account password.</div>';
    return;
  }
  root.innerHTML = tokens.map((token) => {
    const status = statusFor(token);
    const active = status.label === 'Active';
    return `<div class="kg-token-row">
      <div class="kg-token-name"><b>${escapeHtml(token.name)}</b><span>${escapeHtml(token.tokenPrefix)}… · Created ${formatDate(token.createdAt)}</span></div>
      <div class="kg-token-scopes">${token.scopes.map((scope) => `<span class="badge">${escapeHtml(scope)}</span>`).join('')}</div>
      <div class="kg-token-meta"><span class="badge ${status.className}">${status.label}</span><br />Expires: ${formatDate(token.expiresAt)}<br />Last used: ${formatDate(token.lastUsedAt)}</div>
      <div>${active ? `<button class="btn btn-ghost kg-token-revoke" data-token-id="${escapeHtml(token.id)}" data-token-name="${escapeHtml(token.name)}">Revoke</button>` : ''}</div>
    </div>`;
  }).join('');

  root.querySelectorAll('.kg-token-revoke').forEach((button) => button.addEventListener('click', async () => {
    const confirmed = window.confirm(`Revoke “${button.dataset.tokenName}”? Git clients using it will stop working immediately.`);
    if (!confirmed) return;
    button.disabled = true;
    try {
      await request(`${TOKEN_API}/${encodeURIComponent(button.dataset.tokenId)}`, { method: 'DELETE' });
      notify('Token revoked', `${button.dataset.tokenName} can no longer authenticate Git operations.`);
      await loadTokens();
    } catch (error) {
      notify('Revocation failed', error.message, 'error');
      button.disabled = false;
    }
  }));
}

async function loadTokens() {
  const root = document.querySelector('#kg-token-list');
  if (!root) return;
  try {
    const payload = await request();
    renderTokenList(payload.tokens || []);
  } catch (error) {
    root.innerHTML = `<div class="kg-token-empty">${escapeHtml(error.message)}</div>`;
  }
}

function bindForm() {
  const form = document.querySelector('#kg-token-form');
  if (!form) return;
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    const scopes = [...form.querySelectorAll('[name="scope"]:checked')].map((input) => input.value);
    if (!scopes.length) {
      notify('Select a scope', 'Choose repository read or repository write access.', 'error');
      return;
    }
    const button = document.querySelector('#kg-token-create');
    button.disabled = true;
    button.textContent = 'Creating secure token…';
    try {
      const data = new FormData(form);
      const payload = await request(TOKEN_API, {
        method: 'POST',
        body: { name: data.get('name'), expiresInDays: Number(data.get('expiresInDays')), scopes },
      });
      const created = payload.token;
      const secretRoot = document.querySelector('#kg-token-secret');
      secretRoot.innerHTML = `<div class="kg-token-secret"><b>Copy your new token now</b><p class="muted">KukGit stores only a hash and cannot reveal this value again.</p><code id="kg-token-value">${escapeHtml(created.token)}</code><button class="btn btn-primary" id="kg-token-copy">Copy token</button></div>`;
      document.querySelector('#kg-token-copy').addEventListener('click', async () => {
        await copyText(created.token);
        notify('Token copied', 'The personal access token is in your clipboard.');
      });
      form.reset();
      form.querySelector('[value="repo:read"]').checked = true;
      form.querySelector('[name="expiresInDays"]').value = '90';
      notify('Token created', 'Copy it now and store it in a secure password manager.');
      await loadTokens();
    } catch (error) {
      notify('Token creation failed', error.message, 'error');
    } finally {
      button.disabled = false;
      button.textContent = 'Create personal access token';
    }
  });
}

async function mountTokenPanel() {
  if (location.hash.split('?')[0] !== '#/settings') return;
  const content = document.querySelector('.content');
  if (!content || document.querySelector('#kg-token-panel')) return;
  const sequence = ++renderSequence;
  injectStyles();
  content.insertAdjacentHTML('beforeend', panelMarkup());
  bindForm();
  await loadTokens();
  if (sequence !== renderSequence || location.hash.split('?')[0] !== '#/settings') document.querySelector('#kg-token-panel')?.remove();
}

function scheduleMount() {
  requestAnimationFrame(() => requestAnimationFrame(mountTokenPanel));
}

window.addEventListener('hashchange', scheduleMount);
new MutationObserver(scheduleMount).observe(document.querySelector('#app'), { childList: true, subtree: true });
scheduleMount();
