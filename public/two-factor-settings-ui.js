/**
 * Turning a second factor on, and off, from account settings.
 *
 * The panel exists because the alternative is worse than not having 2FA: the
 * API is live, so without a screen the only way to enable it is a hand-written
 * request — and somebody who does that has no recovery codes on screen and no
 * way to turn it off again.
 *
 * Three things this screen has to get right, and they are all about the person
 * rather than the protocol:
 *
 * **The recovery codes are shown before it is switched on, and only once.** The
 * server issues them at the start of enrolment for exactly this reason. This
 * screen keeps them on the page until the person says they have written them
 * down, and it says plainly that they will not be shown again.
 *
 * **A code is asked for before it is enabled.** That is the server's rule, and
 * the screen exists to make it obvious why: it is proof that the app scanned
 * the right secret and that the phone's clock agrees.
 *
 * **Turning it off asks for a code too**, and says that a recovery code works —
 * because the person doing it is often the person whose phone is gone, and that
 * is the one moment they must not be stuck.
 *
 * There is no QR code. Drawing one needs an encoder this build does not have
 * and will not load from anywhere else, so the setup key is shown for manual
 * entry, which every authenticator app supports.
 */

function tfEscape(value = '') {
  return String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

function tfNotify(title, message, type = 'success') {
  const root = document.querySelector('#toast-root');
  if (!root) return;
  const element = document.createElement('div');
  element.className = `toast ${type}`;
  element.innerHTML = `<div>${type === 'error' ? '⚠' : '✓'}</div><div><b>${tfEscape(title)}</b><span>${tfEscape(message)}</span></div>`;
  root.append(element);
  setTimeout(() => element.remove(), 5200);
}

function onSettings() {
  const [pathPart] = location.hash.slice(1).split('?');
  return pathPart.split('/').filter(Boolean)[0] === 'settings';
}

async function tfRequest(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
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
 * The setup key, in groups of four.
 *
 * A thirty-two character string typed off a screen in one run is a string
 * somebody mistypes. The spaces are ignored by the server, which strips them
 * before decoding.
 */
export function groupSecret(secret) {
  return String(secret).replace(/(.{4})/g, '$1 ').trim();
}

export function statusPanelHtml(status) {
  // A number, not whatever arrived. It is interpolated into the page, and
  // coercing it is both the escaping and the answer to "what if it is
  // missing" — `Number(undefined)` is NaN, which renders as text rather than
  // as somebody else's markup.
  const remaining = Number(status.recoveryCodesRemaining) || 0;
  const body = status.enabled
    ? `<p class="muted" style="margin:0 0 12px">Two-factor authentication is on. Signing in asks for a code from your authenticator app.</p>
       <div class="login-demo" style="margin-bottom:12px">${remaining} recovery ${
         remaining === 1 ? 'code' : 'codes'} left.${
         remaining <= 2 ? ' <b>Generate a new set — running out means losing the way back if your phone goes.</b>' : ''}</div>
       <form id="kg-2fa-manage" style="display:grid;gap:12px">
         <div class="field"><label>Code from your app, or a recovery code</label><input class="input" name="code" autocomplete="one-time-code" required /></div>
         <div style="display:flex;gap:10px;flex-wrap:wrap">
           <button class="btn" type="submit" name="action" value="codes" id="kg-2fa-new-codes">New recovery codes</button>
           <button class="btn" type="button" id="kg-2fa-disable">Turn it off</button>
         </div>
       </form>`
    : `<p class="muted" style="margin:0 0 12px">A code from your phone, on top of your password. Recovery codes are handed to you before it is switched on, so a lost phone does not mean a lost account.</p>
       <form id="kg-2fa-start" style="display:grid;gap:12px">
         <div class="field"><label>Confirm your password</label><input class="input" name="password" type="password" autocomplete="current-password" /></div>
         <button class="btn btn-primary" type="submit">Set up two-factor authentication</button>
       </form>`;
  return `<section class="card" id="kg-2fa-panel"><div class="card-header"><div><h3>Two-factor authentication</h3></div></div><div class="card-body">${body}</div></section>`;
}

export function enrolmentHtml(started) {
  return `<section class="card" id="kg-2fa-panel"><div class="card-header"><div><h3>Two-factor authentication</h3></div></div><div class="card-body">
    <p class="muted" style="margin:0 0 12px"><b>1.</b> Add this key to your authenticator app — choose "enter a setup key" rather than scanning.</p>
    <div class="field"><label>Setup key</label><input class="input" value="${tfEscape(groupSecret(started.secret))}" readonly onclick="this.select()" /></div>
    <p class="muted" style="margin:12px 0"><b>2.</b> Write these recovery codes down and keep them somewhere that is not your phone. <b>They are shown once and never again.</b> Each works one time, and they are what gets you back in if your phone is lost.</p>
    <div class="login-demo" style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;line-height:1.9;letter-spacing:.04em">${
      started.recoveryCodes.map((code) => tfEscape(code)).join('<br />')}</div>
    <form id="kg-2fa-confirm" style="display:grid;gap:12px;margin-top:14px">
      <p class="muted" style="margin:0"><b>3.</b> Enter the code your app is showing now. Nothing is switched on until this works — which is how a wrong clock or a mis-typed key gets caught here rather than at your next sign-in.</p>
      <div class="field"><label>Six-digit code</label><input class="input" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required /></div>
      <div style="display:flex;gap:10px;flex-wrap:wrap">
        <button class="btn btn-primary" type="submit">I have saved my codes — turn it on</button>
        <button class="btn" type="button" id="kg-2fa-cancel">Cancel</button>
      </div>
    </form>
  </div></section>`;
}

/**
 * That a mount is already under way.
 *
 * Not the same as "the panel is on the page": there is an await between asking
 * the server and inserting anything, and a navigation during it starts a second
 * mount that also sees no panel.
 *
 * No test kills this line — the harness answers instantly, so the two rounds
 * cannot be made to overlap. What the tests hold is that one round makes one
 * panel.
 */
let mounted = false;
let offering = null;

/** Whether this instance has KukGit's own accounts at all. */
async function offered() {
  // Once per page load. The answer is decided by the instance's auth mode at
  // deploy time, and the observer here fires on every write anywhere in the
  // application.
  if (offering !== null) return offering;
  try {
    const response = await fetch('/api/account/two-factor', { credentials: 'same-origin' });
    offering = response.ok;
    if (response.ok) offering = await response.json();
  } catch { offering = false; }
  return offering;
}

function bindStatus(panel) {
  panel.querySelector('#kg-2fa-start')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = event.currentTarget.querySelector('button');
    button.disabled = true;
    try {
      const started = await tfRequest('/api/account/two-factor/start', {
        method: 'POST',
        body: { password: new FormData(event.currentTarget).get('password') },
      });
      replacePanel(enrolmentHtml(started), bindEnrolment);
    } catch (error) {
      tfNotify('Could not start', error.message, 'error');
      button.disabled = false;
    }
  });

  const codeOf = () => String(panel.querySelector('#kg-2fa-manage [name="code"]')?.value ?? '').trim();

  panel.querySelector('#kg-2fa-manage')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      const fresh = await tfRequest('/api/account/two-factor/recovery-codes', { method: 'POST', body: { code: codeOf() } });
      replacePanel(`<section class="card" id="kg-2fa-panel"><div class="card-header"><div><h3>New recovery codes</h3></div></div><div class="card-body">
        <p class="muted" style="margin:0 0 12px">The old set no longer works. Write these down — shown once.</p>
        <div class="login-demo" style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;line-height:1.9;letter-spacing:.04em">${
          fresh.recoveryCodes.map((code) => tfEscape(code)).join('<br />')}</div>
        <div style="margin-top:14px"><button class="btn" type="button" id="kg-2fa-done">I have saved them</button></div>
      </div></section>`, (next) => {
        next.querySelector('#kg-2fa-done').addEventListener('click', () => { mounted = false; next.remove(); });
      });
    } catch (error) {
      tfNotify('Not regenerated', error.message, 'error');
    }
  });

  panel.querySelector('#kg-2fa-disable')?.addEventListener('click', async () => {
    try {
      await tfRequest('/api/account/two-factor/disable', { method: 'POST', body: { code: codeOf() } });
      offering = null;
      mounted = false;
      panel.remove();
      tfNotify('Turned off', 'Signing in no longer asks for a code.');
    } catch (error) {
      // Usually a wrong or reused code. Saying so beats a silent no-op.
      tfNotify('Not turned off', error.message, 'error');
    }
  });
}

function bindEnrolment(panel) {
  panel.querySelector('#kg-2fa-cancel').addEventListener('click', () => {
    // The enrolment row is left behind on the server, unconfirmed and therefore
    // inert; starting again replaces it. Nothing is on, so nothing is lost.
    offering = null;
    mounted = false;
    panel.remove();
  });

  panel.querySelector('#kg-2fa-confirm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = event.currentTarget.querySelector('button');
    button.disabled = true;
    try {
      await tfRequest('/api/account/two-factor/confirm', {
        method: 'POST',
        body: { code: new FormData(event.currentTarget).get('code') },
      });
      offering = null;
      mounted = false;
      panel.remove();
      tfNotify('Two-factor authentication is on', 'Signing in will ask for a code from now on.');
    } catch (error) {
      tfNotify('That code was not right', error.message, 'error');
      button.disabled = false;
    }
  });
}

function replacePanel(html, bind) {
  const existing = document.querySelector('#kg-2fa-panel');
  if (!existing) return;
  existing.insertAdjacentHTML('afterend', html);
  existing.remove();
  const next = document.querySelector('#kg-2fa-panel');
  if (next) bind(next);
}

async function mountTwoFactorPanel() {
  if (!onSettings()) { mounted = false; return; }
  if (mounted || document.querySelector('#kg-2fa-panel')) return;
  const content = document.querySelector('.app-shell .content') ?? document.querySelector('#app .content') ?? document.querySelector('#app');
  if (!content) return;
  mounted = true;

  const status = await offered();
  // Absent, not disabled, where Kuklabs Account owns the passwords: a second
  // factor on top of a password KukGit does not hold is not a second factor.
  if (!status) { mounted = false; return; }
  if (!onSettings() || document.querySelector('#kg-2fa-panel')) { mounted = false; return; }

  content.insertAdjacentHTML('beforeend', statusPanelHtml(status));
  bindStatus(document.querySelector('#kg-2fa-panel'));
}

let scheduled = false;
function scheduleTwoFactorPanel() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => requestAnimationFrame(async () => {
    scheduled = false;
    await mountTwoFactorPanel();
  }));
}

if (typeof document !== 'undefined' && document.querySelector('#app')) {
  window.addEventListener('hashchange', scheduleTwoFactorPanel);
  new MutationObserver(scheduleTwoFactorPanel).observe(document.querySelector('#app'), { childList: true, subtree: true });
  scheduleTwoFactorPanel();
}
