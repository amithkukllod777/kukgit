/**
 * Connecting GitHub or Google to an account that already exists, and
 * disconnecting it again.
 *
 * This panel is the other half of a sentence the sign-in page has been saying
 * for a while. Somebody whose address already has a KukGit account, pressing
 * "Continue with Google", is sent back with:
 *
 *   > An account here already uses that email address. Sign in with your
 *   > password, then link this provider from account settings.
 *
 * There was no such thing in account settings. The instruction was correct
 * about what the server can do and impossible to follow — `/api/auth/identities`
 * and the unlink route both existed, and the only way to link while signed in
 * was to type `/api/auth/github/start` into the address bar. A message that
 * tells somebody to do something the product does not let them do is worse than
 * no message.
 *
 * ## Linking is a navigation, not a request
 *
 * "Connect" is a plain link. The whole flow is redirects — to the provider, to
 * a consent screen, back to a callback — and `fetch` would follow every one of
 * them invisibly and land nobody anywhere. `redirect_to` brings the person back
 * to this page; the server refuses anything that is not a `#/…` fragment, so it
 * cannot be turned into a way off this origin.
 *
 * Whether a start is a *link* or a *sign-in* is decided by the server from the
 * session at the moment the flow begins, never from anything in the callback
 * URL. That is the login-CSRF the state table exists to stop, and this file
 * cannot weaken it: it has no say in the matter.
 *
 * ## Removing the last way in
 *
 * An account created by a provider has no usable password — the column holds
 * `provider$github`, which no password can ever match — so disconnecting its
 * only provider would lock somebody out permanently. The server refuses that
 * with `IDENTITY_LAST_METHOD`, and this screen's job is to say so in a place
 * where it is useful rather than to guess at the rule and disable a button that
 * might have been fine.
 */

const PROVIDER_MARK = {
  // Inline, for the same reason the sign-in page's are: a page that fetches an
  // icon from a provider tells that provider who is looking at it.
  github: '<svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.4 7.4 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/></svg>',
  google: '<svg viewBox="0 0 18 18" width="18" height="18" aria-hidden="true"><path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62Z"/><path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.81.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18Z"/><path fill="#FBBC05" d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33Z"/><path fill="#EA4335" d="M9 3.58c1.32 0 2.5.46 3.44 1.35l2.58-2.58C13.46.9 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58Z"/></svg>',
};

function laEscape(value = '') {
  return String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

function laLabel(id) {
  return id === 'github' ? 'GitHub' : 'Google';
}

function laNotify(title, message, type = 'success') {
  const root = document.querySelector('#toast-root');
  if (!root) return;
  const element = document.createElement('div');
  element.className = `toast ${type}`;
  element.innerHTML = `<div>${type === 'error' ? '⚠' : '✓'}</div><div><b>${laEscape(title)}</b><span>${laEscape(message)}</span></div>`;
  root.append(element);
  setTimeout(() => element.remove(), 5200);
}

function onSettings() {
  const [pathPart] = location.hash.slice(1).split('?');
  return pathPart.split('/').filter(Boolean)[0] === 'settings';
}

/**
 * When it was linked, in words rather than a timestamp.
 *
 * Exported because the formatting is the only logic in this file worth testing
 * on its own, and because "just now" for something linked last month is the
 * kind of wrong that reads as the page being broken.
 */
export function linkedWhen(value, now = new Date()) {
  const at = Date.parse(value ?? '');
  if (!Number.isFinite(at)) return '';
  const days = Math.floor((now.getTime() - at) / 86400000);
  if (days < 0) return '';
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  return new Date(at).toISOString().slice(0, 10);
}

/**
 * One row, as a string.
 *
 * `email` is whatever the provider said about somebody's account, which is the
 * one value here that did not come from us — escaped, like everything on this
 * page, though a provider is not a likely attacker. The reason it is escaped is
 * that nobody rereads this function when a new provider is added.
 */
export function identityRowHtml(provider, identity) {
  const label = laLabel(provider);
  const mark = PROVIDER_MARK[provider] ?? '';
  if (!identity) {
    return `<div class="kg-identity">
      <div class="kg-identity-who">${mark}<div><b>${laEscape(label)}</b><span>Not connected</span></div></div>
      <a class="btn" href="/api/auth/${encodeURIComponent(provider)}/start?redirect_to=%23%2Fsettings" rel="nofollow">Connect</a>
    </div>`;
  }
  const who = identity.providerLogin || identity.email || '';
  const when = linkedWhen(identity.linkedAt);
  return `<div class="kg-identity">
    <div class="kg-identity-who">${mark}<div><b>${laEscape(label)}</b><span>${
      who ? laEscape(who) : 'Connected'}${when ? ` · linked ${laEscape(when)}` : ''}</span></div></div>
    <button class="btn" type="button" data-unlink="${laEscape(provider)}">Disconnect</button>
  </div>`;
}

export function panelHtml(providers, identities) {
  const byProvider = new Map(identities.map((identity) => [identity.provider, identity]));
  const rows = providers.map((provider) => identityRowHtml(provider.id, byProvider.get(provider.id) ?? null)).join('');
  return `<section class="card" id="kg-identities-panel"><div class="card-header"><div><h3>Linked accounts</h3><p>Sign in with GitHub or Google instead of typing your password.</p></div></div><div class="card-body">
    <div class="kg-identity-list">${rows}</div>
    <p class="field-hint" style="margin-top:14px">Connecting one does not change your password or your email address. If an account here already uses the same address as your provider account, connecting is how the two become one sign-in rather than two accounts.</p>
  </div></section>`;
}

function identityStyles() {
  if (document.querySelector('#kg-identity-styles')) return;
  const style = document.createElement('style');
  style.id = 'kg-identity-styles';
  style.textContent = `
    .kg-identity-list { display:grid; gap:10px; }
    .kg-identity { display:flex; align-items:center; justify-content:space-between; gap:14px; flex-wrap:wrap;
      border:1px solid var(--border); border-radius:12px; padding:13px 15px; }
    .kg-identity-who { display:flex; align-items:center; gap:12px; }
    .kg-identity-who b { display:block; font-size:14px; }
    .kg-identity-who span { display:block; color:var(--muted); font-size:12px; margin-top:2px; }
  `;
  document.head.append(style);
}

async function laRequest(path, options = {}) {
  const response = await fetch(path, { credentials: 'same-origin', ...options });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload?.error?.message || `Request failed (${response.status})`);
    error.code = payload?.error?.code;
    error.status = response.status;
    throw error;
  }
  return payload;
}

/**
 * What this instance offers, asked once per page load.
 *
 * The provider list is a deployment fact. The identities are not — they change
 * when somebody presses a button on this very panel — so they are read fresh
 * every mount, and only the list is cached.
 */
let offering = null;
async function offeredProviders() {
  if (!offering) {
    offering = laRequest('/api/auth/providers')
      .then((payload) => (Array.isArray(payload.providers) ? payload.providers : []))
      // 404 on an instance where Kuklabs Account owns the sessions. No panel,
      // no error: there is nothing to link here.
      .catch(() => []);
  }
  return offering;
}

function bind(panel) {
  for (const button of panel.querySelectorAll('[data-unlink]')) {
    button.addEventListener('click', async () => {
      const provider = button.dataset.unlink;
      button.disabled = true;
      try {
        await laRequest(`/api/auth/identities/${encodeURIComponent(provider)}`, { method: 'DELETE' });
        laNotify('Disconnected', `${laLabel(provider)} can no longer sign in to this account.`);
        // Redrawn from the server rather than patched in place, so what is on
        // screen is what is stored — including the case where the row was
        // already gone in another tab.
        mounted = false;
        panel.remove();
        scheduleIdentityPanel();
      } catch (error) {
        // Usually the last-way-in refusal, which is the one message on this
        // panel somebody genuinely needs to read.
        laNotify('Not disconnected', error.message, 'error');
        button.disabled = false;
      }
    });
  }
}

/**
 * That a mount is under way, which is not the same as "the panel is on screen".
 *
 * There are two awaits between deciding to render and rendering, and a
 * navigation during them starts a second mount that also sees no panel.
 */
let mounted = false;

async function mountIdentityPanel() {
  if (!onSettings()) { mounted = false; return; }
  if (mounted || document.querySelector('#kg-identities-panel')) return;
  const content = document.querySelector('.app-shell .content') ?? document.querySelector('#app .content') ?? document.querySelector('#app');
  if (!content) return;
  mounted = true;

  const providers = await offeredProviders();
  if (!providers.length) { mounted = false; return; }

  let identities = [];
  try {
    identities = (await laRequest('/api/auth/identities')).identities ?? [];
  } catch {
    // Signed out, or the route is absent. Either way there is nothing useful
    // to draw and nothing worth saying about it on a settings page.
    mounted = false;
    return;
  }

  // Asked again after the awaits: the application may have redrawn or the
  // person may have navigated while those two requests were in flight, and
  // writing into an element nobody is looking at is how a panel appears twice.
  if (!onSettings() || document.querySelector('#kg-identities-panel')) { mounted = false; return; }

  identityStyles();
  content.insertAdjacentHTML('beforeend', panelHtml(providers, identities));
  bind(document.querySelector('#kg-identities-panel'));
}

let scheduled = false;
function scheduleIdentityPanel() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => requestAnimationFrame(async () => {
    scheduled = false;
    await mountIdentityPanel();
  }));
}

if (typeof document !== 'undefined' && document.querySelector('#app')) {
  window.addEventListener('hashchange', scheduleIdentityPanel);
  new MutationObserver(scheduleIdentityPanel).observe(document.querySelector('#app'), { childList: true, subtree: true });
  scheduleIdentityPanel();
}
