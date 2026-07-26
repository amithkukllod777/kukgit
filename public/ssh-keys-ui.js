const SSH_KEYS_API = '/api/ssh-keys';
let sshRenderKey = '';
let sshScheduled = false;

function sshEscape(value = '') {
  return String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

function sshNotify(title, message, type = 'success') {
  const root = document.querySelector('#toast-root');
  if (!root) return;
  const element = document.createElement('div');
  element.className = `toast ${type}`;
  element.innerHTML = `<div>${type === 'error' ? '⚠' : '✓'}</div><div><b>${sshEscape(title)}</b><span>${sshEscape(message)}</span></div>`;
  root.append(element);
  setTimeout(() => element.remove(), 4600);
}

async function sshRequest(path, options = {}) {
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

function sshRoute() {
  const [path] = location.hash.slice(1).split('?');
  const segments = path.split('/').filter(Boolean).map(decodeURIComponent);
  if (segments[0] === 'settings') return { type: 'user' };
  if (segments[0] === 'repo' && segments[1] && segments[2] && segments[3] === 'settings') {
    return { type: 'deploy', org: segments[1], repo: segments[2] };
  }
  return null;
}

function sshDate(value) {
  if (!value) return 'Never';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '—';
  return new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

async function sshCopy(value) {
  try { await navigator.clipboard.writeText(value); }
  catch {
    const textarea = document.createElement('textarea');
    textarea.value = value;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.append(textarea);
    textarea.select();
    document.execCommand('copy');
    textarea.remove();
  }
}

function sshStyles() {
  if (document.querySelector('#kg-ssh-key-styles')) return;
  const style = document.createElement('style');
  style.id = 'kg-ssh-key-styles';
  style.textContent = `
    .kg-ssh-keys { margin-top:18px; }
    .kg-ssh-grid { display:grid; grid-template-columns:minmax(300px,.75fr) minmax(0,1.25fr); gap:18px; }
    .kg-ssh-form { display:grid; gap:12px; }
    .kg-ssh-key-row { display:grid; grid-template-columns:minmax(180px,1fr) minmax(180px,.85fr) minmax(140px,.65fr) auto; gap:12px; align-items:center; padding:13px 0; border-top:1px solid var(--border); }
    .kg-ssh-key-row:first-child { border-top:0; }
    .kg-ssh-fingerprint { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:11px; overflow-wrap:anywhere; color:var(--muted); }
    .kg-ssh-clone { display:flex; gap:8px; align-items:center; padding:12px; border:1px solid var(--border); border-radius:12px; background:#06101c; margin-bottom:15px; }
    .kg-ssh-clone code { flex:1; overflow:auto; color:#fff; user-select:all; }
    .kg-ssh-empty { text-align:center; color:var(--muted); padding:26px 10px; }
    @media (max-width:900px) { .kg-ssh-grid { grid-template-columns:1fr; } .kg-ssh-key-row { grid-template-columns:1fr; } .kg-ssh-clone { align-items:stretch; flex-direction:column; } }
  `;
  document.head.append(style);
}

function keyRow(key, deploy = false) {
  const status = key.revokedAt ? 'Revoked' : 'Active';
  return `<div class="kg-ssh-key-row" data-key-id="${sshEscape(key.id)}">
    <div><b>${sshEscape(key.title)}</b><div class="muted" style="font-size:11px">${sshEscape(key.keyType)}${deploy ? ` · ${key.canWrite ? 'Read/write' : 'Read-only'}` : ''}</div></div>
    <div class="kg-ssh-fingerprint">${sshEscape(key.fingerprint)}</div>
    <div class="muted" style="font-size:11px"><span class="badge ${key.revokedAt ? 'critical' : 'public'}">${status}</span><br />Last used: ${sshDate(key.lastUsedAt)}<br />Added: ${sshDate(key.createdAt)}</div>
    <div>${!key.revokedAt ? `<button class="btn btn-ghost ${deploy ? 'kg-revoke-deploy-key' : 'kg-revoke-user-key'}">Revoke</button>` : ''}</div>
  </div>`;
}

function userPanel(data) {
  return `<section class="card kg-ssh-keys" id="kg-user-ssh-panel">
    <div class="card-header"><div><h2>SSH keys</h2><p>Authenticate Git clone, fetch and push without a password.</p></div><span class="badge public">${data.keys.filter((key) => !key.revokedAt).length} active</span></div>
    <div class="card-body"><div class="kg-ssh-grid"><form class="kg-ssh-form" id="kg-user-ssh-form"><div class="field"><label>Key title</label><input class="input" name="title" maxlength="100" placeholder="Founder laptop" required /></div><div class="field"><label>Public key</label><textarea class="textarea" name="publicKey" rows="5" maxlength="20000" placeholder="ssh-ed25519 AAAA..." required></textarea></div><button class="btn btn-primary" type="submit">Add SSH key</button><div class="login-demo"><b>Supported:</b> Ed25519, ECDSA and RSA 2048-bit or stronger. Private keys never leave your device.</div></form><div id="kg-user-ssh-list">${data.keys.length ? data.keys.map((key) => keyRow(key)).join('') : '<div class="kg-ssh-empty">No SSH keys added yet.</div>'}</div></div></div>
  </section>`;
}

function deployPanel(data) {
  return `<section class="card kg-ssh-keys" id="kg-deploy-ssh-panel">
    <div class="card-header"><div><h2>Deploy keys and SSH clone</h2><p>Repository-scoped machine credentials for build and deployment systems.</p></div><span class="badge public">${data.keys.filter((key) => !key.revokedAt).length} active</span></div>
    <div class="card-body"><div class="kg-ssh-clone"><code id="kg-ssh-clone-url">${sshEscape(data.sshCloneUrl)}</code><button class="btn" id="kg-copy-ssh-clone">Copy SSH URL</button></div><div class="kg-ssh-grid"><form class="kg-ssh-form" id="kg-deploy-key-form"><div class="field"><label>Deploy key title</label><input class="input" name="title" maxlength="100" placeholder="Production deploy runner" required /></div><div class="field"><label>Public key</label><textarea class="textarea" name="publicKey" rows="5" maxlength="20000" placeholder="ssh-ed25519 AAAA..." required></textarea></div><label class="kg-hook-event"><input type="checkbox" name="canWrite" /> Allow Git push (read/write)</label><button class="btn btn-primary" type="submit">Add deploy key</button><div class="login-demo">A deploy key is permanently scoped to this repository. Use read-only unless the automation must push commits or tags.</div></form><div id="kg-deploy-key-list">${data.keys.length ? data.keys.map((key) => keyRow(key, true)).join('') : '<div class="kg-ssh-empty">No deploy keys configured.</div>'}</div></div></div>
  </section>`;
}

function bindUserPanel(data) {
  const form = document.querySelector('#kg-user-ssh-form');
  form?.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      await sshRequest(SSH_KEYS_API, { method: 'POST', body: Object.fromEntries(new FormData(form)) });
      sshNotify('SSH key added', 'Git-over-SSH can now authenticate with the matching private key.');
      await mountSshKeys(true);
    } catch (error) { sshNotify('Key rejected', error.message, 'error'); button.disabled = false; }
  });
  document.querySelectorAll('.kg-revoke-user-key').forEach((button) => button.addEventListener('click', async () => {
    const row = button.closest('[data-key-id]');
    if (!window.confirm('Revoke this SSH key? Active SSH sessions are unaffected, but new authentication will fail.')) return;
    button.disabled = true;
    try {
      await sshRequest(`${SSH_KEYS_API}/${encodeURIComponent(row.dataset.keyId)}`, { method: 'DELETE' });
      sshNotify('SSH key revoked', 'The key can no longer authenticate new Git sessions.');
      await mountSshKeys(true);
    } catch (error) { sshNotify('Revocation failed', error.message, 'error'); button.disabled = false; }
  }));
}

function bindDeployPanel(data, route) {
  document.querySelector('#kg-copy-ssh-clone')?.addEventListener('click', async () => {
    await sshCopy(data.sshCloneUrl);
    sshNotify('SSH clone URL copied', 'Use it with git clone or as a remote URL.');
  });
  const form = document.querySelector('#kg-deploy-key-form');
  form?.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    const values = new FormData(form);
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      await sshRequest(`${SSH_KEYS_API}/${encodeURIComponent(route.org)}/${encodeURIComponent(route.repo)}/deploy-keys`, {
        method: 'POST',
        body: { title: values.get('title'), publicKey: values.get('publicKey'), canWrite: values.get('canWrite') === 'on' },
      });
      sshNotify('Deploy key added', 'The repository can now authenticate with this machine key.');
      await mountSshKeys(true);
    } catch (error) { sshNotify('Deploy key rejected', error.message, 'error'); button.disabled = false; }
  });
  document.querySelectorAll('.kg-revoke-deploy-key').forEach((button) => button.addEventListener('click', async () => {
    const row = button.closest('[data-key-id]');
    if (!window.confirm('Revoke this deploy key?')) return;
    button.disabled = true;
    try {
      await sshRequest(`${SSH_KEYS_API}/${encodeURIComponent(route.org)}/${encodeURIComponent(route.repo)}/deploy-keys/${encodeURIComponent(row.dataset.keyId)}`, { method: 'DELETE' });
      sshNotify('Deploy key revoked', 'The machine key no longer authorizes this repository.');
      await mountSshKeys(true);
    } catch (error) { sshNotify('Revocation failed', error.message, 'error'); button.disabled = false; }
  }));
}

async function mountSshKeys(force = false) {
  const route = sshRoute();
  if (!route) return;
  const content = document.querySelector('.content');
  if (!content) return;
  const key = `${route.type}/${route.org || ''}/${route.repo || ''}/${location.hash}`;
  const selector = route.type === 'user' ? '#kg-user-ssh-panel' : '#kg-deploy-ssh-panel';
  if (!force && sshRenderKey === key && document.querySelector(selector)) return;
  sshRenderKey = key;
  sshStyles();
  try {
    if (route.type === 'user') {
      const data = await sshRequest(SSH_KEYS_API);
      document.querySelector('#kg-user-ssh-panel')?.remove();
      content.insertAdjacentHTML('beforeend', userPanel(data));
      bindUserPanel(data);
    } else {
      const data = await sshRequest(`${SSH_KEYS_API}/${encodeURIComponent(route.org)}/${encodeURIComponent(route.repo)}/deploy-keys`);
      document.querySelector('#kg-deploy-ssh-panel')?.remove();
      content.insertAdjacentHTML('beforeend', deployPanel(data));
      bindDeployPanel(data, route);
    }
  } catch (error) {
    if (!document.querySelector(selector)) content.insertAdjacentHTML('beforeend', `<section class="card kg-ssh-keys" id="${selector.slice(1)}"><div class="card-body kg-ssh-empty">${sshEscape(error.message)}</div></section>`);
  }
}

function scheduleSshKeys() {
  if (sshScheduled) return;
  sshScheduled = true;
  requestAnimationFrame(() => requestAnimationFrame(async () => {
    sshScheduled = false;
    await mountSshKeys();
  }));
}

window.addEventListener('hashchange', scheduleSshKeys);
new MutationObserver(scheduleSshKeys).observe(document.querySelector('#app'), { childList: true, subtree: true });
scheduleSshKeys();
