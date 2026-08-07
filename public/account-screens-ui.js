/**
 * The three screens somebody reaches from an email, plus the link that starts
 * one.
 *
 *   #/verify-email?token=…    confirming an address
 *   #/reset-password?token=…  choosing a new password
 *   #/forgot-password         asking for the link
 *
 * All three are reached **without being signed in** — that is the whole point
 * of them — so they take over the page rather than living inside the app shell.
 * Somebody who has forgotten their password cannot sign in to ask for a reset,
 * and somebody clicking a link out of their inbox has no session yet.
 *
 * ## The token is in the fragment, and it stays there
 *
 * `…/#/reset-password?token=abc` puts the token after the `#`, which means it
 * is never sent to a server, never lands in an access log, and never travels in
 * a `Referer` header. That is why the links are built that way, and it is why
 * this file does not put the token into any request URL either — it goes in the
 * body of a POST.
 *
 * It is still in the address bar and in browser history, so the moment it has
 * been spent the fragment is rewritten without it. A one-time token left in the
 * URL is a one-time token somebody finds on a shared machine and, more
 * practically, one the person themselves re-triggers by pressing Back — landing
 * on "this link has already been used" for a link that just worked.
 *
 * ## Saying the same thing either way
 *
 * The reset request screen shows one message whether or not the address has an
 * account. The server already answers that way — for a Git host, "is this
 * address registered" is "does this company keep its code here" — and a screen
 * that helpfully said "no account found" would give away exactly what the
 * server refused to.
 */

const ROUTES = new Set(['verify-email', 'reset-password', 'forgot-password']);

/**
 * Which screen is currently on the page, as `name:token`.
 *
 * The application re-renders `#app` on every hash change and the observer fires
 * on this file's own writes, so without a key each render would start the work
 * again — and for a one-time token, the second attempt reports it as already
 * used.
 */
let rendered = '';

function accEscape(value = '') {
  return String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

/**
 * Which screen the fragment asks for, and the token if it carries one.
 *
 * Returns nothing for any other route, so this file leaves the rest of the
 * application alone.
 */
export function accountRoute(hash = location.hash) {
  const [pathPart, queryPart] = String(hash).replace(/^#/, '').split('?');
  const name = pathPart.split('/').filter(Boolean)[0];
  if (!ROUTES.has(name)) return null;
  const token = queryPart ? new URLSearchParams(queryPart).get('token') : null;
  return { name, token: token || null };
}

/**
 * Takes the token out of the address bar once it has been used.
 *
 * `replaceState` rather than assigning to `location.hash`, so pressing Back
 * does not walk into the spent link and report a failure for something that
 * worked.
 *
 * It also claims the address it is moving to. Changing the fragment changes
 * what `accountRoute` returns, and the observer is about to fire on the write
 * that put the result on screen — so without this the finished screen is
 * immediately replaced by the "this page needs a link" one, a second after the
 * link worked. Found by a test, and it happens in a real browser too.
 */
export function forgetToken(name) {
  rendered = `${name}:`;
  try { history.replaceState(null, '', `#/${name}`); }
  catch { /* No history API — the token stays visible, which is not worth breaking the screen over. */ }
}

async function post(path, body) {
  const response = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload?.error?.message || `Request failed (${response.status})`);
    error.code = payload?.error?.code || 'REQUEST_FAILED';
    error.status = response.status;
    throw error;
  }
  return payload;
}

function accountStyles() {
  if (document.querySelector('#kg-account-styles')) return;
  const style = document.createElement('style');
  style.id = 'kg-account-styles';
  style.textContent = `
    .kg-account { min-height:100vh; display:flex; align-items:center; justify-content:center; padding:32px 20px; }
    .kg-account-card { width:100%; max-width:440px; display:grid; gap:14px; padding:28px; border:1px solid var(--border); border-radius:16px; }
    .kg-account-card h2 { margin:0; }
    .kg-account-card p { margin:0; line-height:1.55; }
    .kg-account-note { font-size:13px; color:var(--muted); line-height:1.55; }
    .kg-account-bad { border:1px solid #d9534f66; background:#d9534f14; border-radius:10px; padding:11px 13px; font-size:13px; line-height:1.5; }
    .kg-account-good { border:1px solid #3aa06655; background:#3aa06614; border-radius:10px; padding:11px 13px; font-size:13px; line-height:1.5; }
    .kg-account-links { display:flex; justify-content:center; margin-top:2px; }
    .kg-account-links a { font-size:13px; }
  `;
  document.head.append(style);
}

function card(inner) {
  return `<main class="kg-account"><section class="card kg-account-card" id="kg-account-card">${inner}</section></main>`;
}

function backLink(text = 'Back to sign in') {
  return `<div class="kg-account-links"><a href="#/">${accEscape(text)}</a></div>`;
}

/* ------------------------------------------------------------ verify email */

async function renderVerifyEmail(root, token) {
  if (!token) {
    root.innerHTML = card(`<h2>Nothing to confirm</h2>
      <p>This page needs the link from the email we sent you. Open that link, or sign in and ask for another.</p>
      ${backLink()}`);
    return;
  }
  root.innerHTML = card('<h2>Confirming your address…</h2><p class="kg-account-note">One moment.</p>');
  try {
    const result = await post('/api/account/verify-email/confirm', { token });
    forgetToken('verify-email');
    root.innerHTML = card(`<h2>Address confirmed</h2>
      <div class="kg-account-good">${accEscape(result.email || 'Your address')} is now verified.</div>
      <p class="kg-account-note">You can sign in, and you can now be added to organizations by email.</p>
      ${backLink('Continue to sign in')}`);
  } catch (error) {
    forgetToken('verify-email');
    root.innerHTML = card(`<h2>That link did not work</h2>
      <div class="kg-account-bad">${accEscape(error.message)}</div>
      <p class="kg-account-note">Links work once and expire after 24 hours. Sign in and ask for a new one.</p>
      ${backLink()}`);
  }
}

/* ---------------------------------------------------------- forgot password */

function renderForgotPassword(root) {
  root.innerHTML = card(`<h2>Reset your password</h2>
    <p class="kg-account-note">Tell us the address on your account and we will send a link.</p>
    <form id="kg-forgot-form" class="kg-account-card" style="padding:0;border:0;gap:12px">
      <div class="field"><label>Email address</label><input class="input" name="email" type="email" autocomplete="username" required /></div>
      <button class="btn btn-primary btn-block" type="submit">Send the link</button>
    </form>
    ${backLink()}`);

  root.querySelector('#kg-forgot-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector('button');
    button.disabled = true;
    button.textContent = 'Sending…';
    const email = new FormData(form).get('email');
    try { await post('/api/account/password-reset/request', { email }); }
    catch { /* Deliberately ignored — see below. */ }
    // The same screen either way, including when the request itself failed.
    // Branching here would answer the question the server refused to answer:
    // whether that address has an account.
    root.innerHTML = card(`<h2>Check your inbox</h2>
      <div class="kg-account-good">If that address has a KukGit account, a reset link is on its way.</div>
      <p class="kg-account-note">The link works once and expires in one hour. It can take a minute to arrive; check spam before asking for another.</p>
      ${backLink()}`);
  });
}

/* ---------------------------------------------------------- reset password */

function renderResetPassword(root, token) {
  if (!token) {
    root.innerHTML = card(`<h2>This page needs a link</h2>
      <p>Open the link from the reset email, or ask for a new one.</p>
      <div class="kg-account-links"><a href="#/forgot-password">Ask for a reset link</a></div>
      ${backLink()}`);
    return;
  }
  root.innerHTML = card(`<h2>Choose a new password</h2>
    <form id="kg-reset-form" class="kg-account-card" style="padding:0;border:0;gap:12px">
      <div class="field"><label>New password</label><input class="input" name="password" type="password" autocomplete="new-password" required /></div>
      <div class="field"><label>Type it again</label><input class="input" name="confirm" type="password" autocomplete="new-password" required /></div>
      <div id="kg-reset-error" class="kg-account-bad" hidden></div>
      <p class="kg-account-note">Changing the password signs out every device that is currently signed in, including this one.</p>
      <button class="btn btn-primary btn-block" type="submit">Change my password</button>
    </form>
    ${backLink()}`);

  const form = root.querySelector('#kg-reset-form');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const box = root.querySelector('#kg-reset-error');
    const fail = (message) => {
      box.textContent = message;
      box.hidden = false;
    };
    box.hidden = true;

    // Checked here as well as on the server, because a mistyped password that
    // is only caught after the token is spent leaves somebody locked out with a
    // link that no longer works.
    if (data.get('password') !== data.get('confirm')) return fail('Those two do not match.');

    const button = form.querySelector('button');
    button.disabled = true;
    button.textContent = 'Changing…';
    try {
      const result = await post('/api/account/password-reset/complete', { token: form.dataset.token, password: data.get('password') });
      forgetToken('reset-password');
      root.innerHTML = card(`<h2>Password changed</h2>
        <div class="kg-account-good">${accEscape(result.message || 'Your password has been changed.')}</div>
        <p class="kg-account-note">${result.sessionsEnded
          ? `${accEscape(String(result.sessionsEnded))} signed-in ${result.sessionsEnded === 1 ? 'device was' : 'devices were'} signed out.`
          : 'Nothing else was signed in.'}</p>
        ${backLink('Sign in with the new password')}`);
    } catch (error) {
      // The token is *not* forgotten here. A password the rules refuse is
      // rejected before anything is spent, so the link still works and the
      // person should get to try again on this same screen.
      fail(error.message);
      button.disabled = false;
      button.textContent = 'Change my password';
    }
  });
  // Held on the element rather than in a closure variable, so a re-render that
  // rebinds the form cannot end up submitting a token from a previous one.
  form.dataset.token = token;
}

/* ------------------------------------------------- the link on the sign-in */

function addForgotLink() {
  const form = document.querySelector('#login-form');
  if (!form || form.dataset.kgForgot === 'done') return;
  form.dataset.kgForgot = 'done';
  form.insertAdjacentHTML('beforeend', '<div class="kg-account-links"><a href="#/forgot-password">Forgot your password?</a></div>');
}

/* ------------------------------------------------------------------ mount */

export async function mountAccountScreen() {
  const route = accountRoute();
  const root = document.querySelector('#app');
  if (!root) return;
  if (!route) {
    rendered = '';
    accountStyles();
    addForgotLink();
    return;
  }
  accountStyles();
  const key = `${route.name}:${route.token ?? ''}`;
  if (rendered === key) return;
  rendered = key;

  if (route.name === 'verify-email') return renderVerifyEmail(root, route.token);
  if (route.name === 'reset-password') return renderResetPassword(root, route.token);
  return renderForgotPassword(root);
}

let scheduled = false;
function scheduleAccountScreen() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => requestAnimationFrame(async () => {
    scheduled = false;
    await mountAccountScreen();
  }));
}

if (typeof document !== 'undefined' && document.querySelector('#app')) {
  window.addEventListener('hashchange', scheduleAccountScreen);
  new MutationObserver(scheduleAccountScreen).observe(document.querySelector('#app'), { childList: true, subtree: true });
  scheduleAccountScreen();
}
