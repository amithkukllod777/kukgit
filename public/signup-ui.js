const SIGNUP_ROUTE = 'signup';
const ACCEPTED_MESSAGE = 'Check your inbox — if that address can be used, a link to finish setting up is on its way.';

let rendered = false;
let scheduled = false;

function signupEscape(value = '') {
  return String(value).replace(/[&<>'"]/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[char]);
}

export function isSignupRoute(hash = location.hash) {
  const [path] = String(hash).replace(/^#/, '').split('?');
  return path.split('/').filter(Boolean)[0] === SIGNUP_ROUTE;
}

async function postSignup(body) {
  const response = await fetch('/api/account/signup', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload?.error?.message || `Request failed (${response.status})`);
    error.code = payload?.error?.code || 'SIGNUP_FAILED';
    error.status = response.status;
    throw error;
  }
  return payload;
}

function signupStyles() {
  if (document.querySelector('#kg-signup-styles')) return;
  const style = document.createElement('style');
  style.id = 'kg-signup-styles';
  style.textContent = `
    .kg-signup { min-height:100vh; display:flex; align-items:center; justify-content:center; padding:32px 20px; }
    .kg-signup-card { width:100%; max-width:460px; display:grid; gap:14px; padding:28px; border:1px solid var(--border); border-radius:16px; }
    .kg-signup-card h2 { margin:0; }
    .kg-signup-card p { margin:0; line-height:1.55; }
    .kg-signup-note { font-size:13px; color:var(--muted); line-height:1.55; }
    .kg-signup-error { border:1px solid #d9534f66; background:#d9534f14; border-radius:10px; padding:11px 13px; font-size:13px; line-height:1.5; }
    .kg-signup-good { border:1px solid #3aa06655; background:#3aa06614; border-radius:10px; padding:11px 13px; font-size:13px; line-height:1.5; }
    .kg-signup-links { display:flex; justify-content:center; gap:14px; flex-wrap:wrap; margin-top:2px; }
    .kg-signup-links a { font-size:13px; }
  `;
  document.head.append(style);
}

function card(inner) {
  return `<main class="kg-signup"><section class="card kg-signup-card" id="kg-signup-card">${inner}</section></main>`;
}

function signInLink(text = 'Back to sign in') {
  return `<div class="kg-signup-links"><a href="#/">${signupEscape(text)}</a></div>`;
}

function renderAccepted(root) {
  root.innerHTML = card(`
    <h2>Check your inbox</h2>
    <div class="kg-signup-good">${signupEscape(ACCEPTED_MESSAGE)}</div>
    <p class="kg-signup-note">The verification link is the step that activates a new self-service account. Signing up never signs this browser in.</p>
    ${signInLink('Continue to sign in')}
  `);
}

function renderUnavailable(root) {
  root.innerHTML = card(`
    <h2>Signup is not available here</h2>
    <p>This KukGit instance is not currently offering self-service email signup.</p>
    <p class="kg-signup-note">Use an available provider sign-in, an invitation, or ask the instance administrator how accounts are created.</p>
    ${signInLink()}
  `);
}

function renderSignup(root) {
  root.innerHTML = card(`
    <h2>Create your KukGit account</h2>
    <p class="kg-signup-note">Use an email address you can verify. Creating the account does not sign you in.</p>
    <form id="kg-signup-form" style="display:grid;gap:12px">
      <div class="field"><label>Display name</label><input class="input" name="displayName" autocomplete="name" maxlength="191" /></div>
      <div class="field"><label>Email address</label><input class="input" name="email" type="email" autocomplete="email" required /></div>
      <div class="field"><label>Password</label><input class="input" name="password" type="password" autocomplete="new-password" minlength="10" required /></div>
      <div class="field"><label>Type it again</label><input class="input" name="confirm" type="password" autocomplete="new-password" minlength="10" required /></div>
      <div id="kg-signup-error" class="kg-signup-error" hidden></div>
      <button class="btn btn-primary btn-block" type="submit">Create account <span>→</span></button>
    </form>
    <p class="kg-signup-note">For privacy, this page gives the same success message whether an address is new or already belongs to an account.</p>
    ${signInLink()}
  `);

  const form = root.querySelector('#kg-signup-form');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;

    const data = new FormData(form);
    const password = String(data.get('password') || '');
    const confirm = String(data.get('confirm') || '');
    const errorBox = root.querySelector('#kg-signup-error');
    const button = form.querySelector('button[type="submit"]');
    errorBox.hidden = true;

    if (password !== confirm) {
      errorBox.textContent = 'Those two passwords do not match.';
      errorBox.hidden = false;
      return;
    }

    button.disabled = true;
    button.textContent = 'Creating…';
    try {
      await postSignup({
        displayName: data.get('displayName'),
        email: data.get('email'),
        password,
      });
      // Deliberately ignore the response body. The browser owns one generic
      // accepted state, so a future server change cannot accidentally turn this
      // page into an account-enumeration oracle.
      renderAccepted(root);
    } catch (error) {
      if (error.status === 404 || error.code === 'NOT_FOUND') {
        renderUnavailable(root);
        return;
      }
      // Keep the form itself in place. Safe text fields and the browser-owned
      // password inputs remain exactly where the person typed them; no password
      // is copied into markup, URL, module state or logs.
      errorBox.textContent = error.message;
      errorBox.hidden = false;
      button.disabled = false;
      button.innerHTML = 'Create account <span>→</span>';
    }
  });
}

function addSignupLink() {
  const form = document.querySelector('#login-form');
  if (!form || form.dataset.kgSignup === 'done') return;
  form.dataset.kgSignup = 'done';
  form.insertAdjacentHTML(
    'beforeend',
    '<div class="kg-signup-links"><span class="kg-signup-note">New to KukGit?</span><a href="#/signup">Create an account</a></div>',
  );
}

export function mountSignupUi() {
  const root = document.querySelector('#app');
  if (!root) return;
  signupStyles();

  if (!isSignupRoute()) {
    rendered = false;
    addSignupLink();
    return;
  }

  // A signed-in shell wins. A signup form over a dashboard would be a route
  // takeover, not account onboarding. On an unauthenticated direct visit,
  // app.js briefly draws the sign-in form and the observer below restores this
  // screen after that render lands.
  if (document.querySelector('.app-shell')) return;
  if (rendered && document.querySelector('#kg-signup-card')) return;
  rendered = true;
  renderSignup(root);
}

function scheduleSignupUi() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    scheduled = false;
    mountSignupUi();
  }));
}

if (typeof document !== 'undefined' && document.querySelector('#app')) {
  window.addEventListener('hashchange', scheduleSignupUi);
  new MutationObserver(scheduleSignupUi).observe(document.querySelector('#app'), { childList: true, subtree: true });
  scheduleSignupUi();
}
