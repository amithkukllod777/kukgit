const authKitUiState = {
  status: null,
  mode: 'login',
  identifier: '',
  busy: false,
};

function authEscape(value = '') {
  return String(value).replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[character]);
}

async function authRequest(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
    body: options.body && typeof options.body !== 'string' ? JSON.stringify(options.body) : options.body,
  });
  const payload = response.status === 204 ? {} : await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload?.error?.message || payload?.message || `Request failed (${response.status})`);
    error.status = response.status;
    error.code = payload?.error?.code;
    error.flowStatus = payload?.status;
    error.identifier = payload?.identifier;
    throw error;
  }
  return payload;
}

function authToast(title, message, type = 'success') {
  const root = document.querySelector('#toast-root');
  if (!root) return;
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<div>${type === 'error' ? '⚠' : '✓'}</div><div><b>${authEscape(title)}</b><span>${authEscape(message)}</span></div>`;
  root.append(toast);
  setTimeout(() => toast.remove(), 4600);
}

function injectAuthKitStyles() {
  if (document.querySelector('#kg-authkit-styles')) return;
  const style = document.createElement('style');
  style.id = 'kg-authkit-styles';
  style.textContent = `
    .kg-authkit-brand { display:flex; align-items:center; gap:10px; margin-bottom:8px; }
    .kg-authkit-brand img { width:34px; height:34px; border-radius:10px; }
    .kg-authkit-brand div { display:grid; gap:1px; }
    .kg-authkit-brand b { font-size:17px; }
    .kg-authkit-brand span { color:var(--muted); font-size:11px; }
    .kg-authkit-tabs { display:grid; grid-template-columns:1fr 1fr; gap:6px; padding:5px; border:1px solid var(--border); border-radius:12px; margin:18px 0; background:rgba(255,255,255,.018); }
    .kg-authkit-tab { border:0; border-radius:9px; padding:9px 12px; background:transparent; color:var(--muted); font:inherit; font-weight:600; cursor:pointer; }
    .kg-authkit-tab.active { background:rgba(21,152,255,.16); color:var(--text); }
    .kg-authkit-actions { display:grid; gap:10px; margin-top:14px; }
    .kg-authkit-divider { display:flex; align-items:center; gap:10px; color:var(--muted); font-size:11px; margin:14px 0; }
    .kg-authkit-divider::before,.kg-authkit-divider::after { content:''; height:1px; flex:1; background:var(--border); }
    .kg-authkit-powered { text-align:center; color:var(--muted); font-size:11px; margin-top:16px; }
    .kg-authkit-security { margin-top:13px; padding:11px 12px; border:1px solid var(--border); border-radius:11px; color:var(--muted); font-size:11px; line-height:1.55; }
    .kg-authkit-code { letter-spacing:.28em; text-align:center; font-size:19px; font-weight:700; }
  `;
  document.head.append(style);
}

function loginMarkup() {
  const signup = authKitUiState.mode === 'signup';
  return `
    <div class="kg-authkit-brand">
      <img src="/assets/kuklabs-k.png" alt="KukGit" />
      <div><b>One Kuklabs Account</b><span>Use the same identity across every Kuklabs product</span></div>
    </div>
    <h2>${signup ? 'Create your Kuklabs Account' : 'Welcome to KukGit'}</h2>
    <p>${signup ? 'Create one verified account for KukGit and the Kuklabs ecosystem.' : 'Sign in with your shared Kuklabs Account.'}</p>
    <div class="kg-authkit-tabs" role="tablist">
      <button class="kg-authkit-tab ${signup ? '' : 'active'}" type="button" data-auth-mode="login">Sign in</button>
      <button class="kg-authkit-tab ${signup ? 'active' : ''}" type="button" data-auth-mode="signup">Sign up</button>
    </div>
    <form id="kg-authkit-form">
      ${signup ? '<div class="field"><label>Full name</label><input class="input" name="fullName" autocomplete="name" minlength="2" required /></div>' : ''}
      <div class="field"><label>Email address or mobile number</label><input class="input" name="identifier" autocomplete="username" type="text" required /></div>
      <div class="field"><label>Password</label><input class="input" name="password" autocomplete="${signup ? 'new-password' : 'current-password'}" type="password" minlength="6" required /></div>
      <div class="kg-authkit-actions"><button class="btn btn-primary btn-block" type="submit">${signup ? 'Create Kuklabs Account' : 'Sign in to KukGit'} <span>→</span></button></div>
    </form>
    ${authKitUiState.status?.google?.enabled ? `
      <div class="kg-authkit-divider">or</div>
      <button class="btn btn-block" type="button" id="kg-authkit-google">Continue with Google</button>
    ` : ''}
    <div class="kg-authkit-security">KukGit never stores or verifies your production password. Authentication, OTP, Google linking, refresh-token rotation and device sessions are managed by central Kuklabs AuthKit.</div>
    <div class="kg-authkit-powered">Powered by Kuklabs</div>
  `;
}

function otpMarkup() {
  return `
    <div class="kg-authkit-brand"><img src="/assets/kuklabs-k.png" alt="KukGit" /><div><b>Verify your account</b><span>One Kuklabs Account</span></div></div>
    <h2>Enter the 6-digit code</h2>
    <p>We sent a verification code for <b>${authEscape(authKitUiState.identifier)}</b>.</p>
    <form id="kg-authkit-otp-form">
      <div class="field"><label>Verification code</label><input class="input kg-authkit-code" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required /></div>
      <div class="kg-authkit-actions"><button class="btn btn-primary btn-block" type="submit">Verify and continue</button><button class="btn btn-block" type="button" id="kg-authkit-resend">Send a new code</button><button class="btn btn-ghost btn-block" type="button" id="kg-authkit-back">Back to sign in</button></div>
    </form>
    <div class="kg-authkit-powered">Powered by Kuklabs</div>
  `;
}

function unavailableMarkup(message) {
  return `
    <div class="kg-authkit-brand"><img src="/assets/kuklabs-k.png" alt="KukGit" /><div><b>One Kuklabs Account</b><span>Identity service</span></div></div>
    <h2>Sign-in service unavailable</h2>
    <p>${authEscape(message)}</p>
    <button class="btn btn-primary btn-block" type="button" id="kg-authkit-retry">Try again</button>
    <div class="kg-authkit-powered">Powered by Kuklabs</div>
  `;
}

async function completeGoogleSignIn() {
  const provider = window.KuklabsGoogleIdentity;
  if (!provider || typeof provider.getIdToken !== 'function') {
    throw new Error('The shared Kuklabs Google web adapter is not loaded on this deployment.');
  }
  const idToken = await provider.getIdToken({ productId: 'kukgit' });
  await authRequest('/api/auth/google', { method: 'POST', body: { id_token: idToken } });
  location.reload();
}

function bindAuthKitCard(card) {
  card.querySelectorAll('[data-auth-mode]').forEach((button) => button.addEventListener('click', () => {
    authKitUiState.mode = button.dataset.authMode;
    renderAuthKitCard(card);
  }));

  card.querySelector('#kg-authkit-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.reportValidity() || authKitUiState.busy) return;
    const button = form.querySelector('button[type="submit"]');
    const values = Object.fromEntries(new FormData(form));
    authKitUiState.busy = true;
    button.disabled = true;
    try {
      authKitUiState.identifier = String(values.identifier || '').trim();
      const path = authKitUiState.mode === 'signup' ? '/api/auth/signup' : '/api/auth/login';
      await authRequest(path, {
        method: 'POST',
        body: {
          identifier: authKitUiState.identifier,
          password: values.password,
          full_name: values.fullName,
        },
      });
      location.reload();
    } catch (error) {
      if (error.code === 'OTP_REQUIRED' || error.flowStatus === 'otp_required') {
        authKitUiState.identifier = error.identifier || authKitUiState.identifier;
        authKitUiState.mode = 'otp';
        renderAuthKitCard(card);
      } else {
        authToast('Unable to continue', error.message, 'error');
        button.disabled = false;
      }
    } finally {
      authKitUiState.busy = false;
    }
  });

  card.querySelector('#kg-authkit-otp-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.reportValidity() || authKitUiState.busy) return;
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    authKitUiState.busy = true;
    try {
      const values = Object.fromEntries(new FormData(form));
      await authRequest('/api/auth/otp/verify', {
        method: 'POST',
        body: { identifier: authKitUiState.identifier, code: values.code },
      });
      location.reload();
    } catch (error) {
      authToast('Verification failed', error.message, 'error');
      button.disabled = false;
    } finally {
      authKitUiState.busy = false;
    }
  });

  card.querySelector('#kg-authkit-resend')?.addEventListener('click', async (event) => {
    event.currentTarget.disabled = true;
    try {
      await authRequest('/api/auth/otp/request', {
        method: 'POST',
        body: { identifier: authKitUiState.identifier },
      });
      authToast('Code sent', 'A fresh verification code has been requested.');
    } catch (error) {
      authToast('Unable to send code', error.message, 'error');
    } finally {
      event.currentTarget.disabled = false;
    }
  });

  card.querySelector('#kg-authkit-back')?.addEventListener('click', () => {
    authKitUiState.mode = 'login';
    renderAuthKitCard(card);
  });

  card.querySelector('#kg-authkit-google')?.addEventListener('click', async (event) => {
    event.currentTarget.disabled = true;
    try { await completeGoogleSignIn(); }
    catch (error) { authToast('Google sign-in unavailable', error.message, 'error'); event.currentTarget.disabled = false; }
  });

  card.querySelector('#kg-authkit-retry')?.addEventListener('click', () => {
    authKitUiState.status = null;
    mountAuthKitUi(true);
  });
}

function renderAuthKitCard(card, error = null) {
  card.dataset.authkit = 'true';
  card.innerHTML = error ? unavailableMarkup(error.message) : authKitUiState.mode === 'otp' ? otpMarkup() : loginMarkup();
  bindAuthKitCard(card);
  if (!error) card.querySelector('input')?.focus();
}

let statusPromise = null;
function getAuthStatus(force = false) {
  if (force) statusPromise = null;
  statusPromise ||= authRequest('/api/auth/status');
  return statusPromise;
}

async function mountAuthKitUi(force = false) {
  const card = document.querySelector('.login-card');
  if (!card || (card.dataset.authkit === 'true' && !force)) return;
  injectAuthKitStyles();
  try {
    authKitUiState.status = await getAuthStatus(force);
    if (authKitUiState.status?.mode !== 'authkit') return;
    renderAuthKitCard(card);
  } catch (error) {
    renderAuthKitCard(card, error);
  }
}

new MutationObserver(() => mountAuthKitUi()).observe(document.querySelector('#app'), { childList: true, subtree: true });
mountAuthKitUi();
