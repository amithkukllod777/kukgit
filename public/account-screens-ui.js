/**
 * The screens somebody reaches without an account, or from an email.
 *
 *   #/signup                  making one
 *   #/verify-email?token=…    confirming an address
 *   #/reset-password?token=…  choosing a new password
 *   #/forgot-password         asking for the link
 *
 * All of them are reached **without being signed in** — that is the whole point
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
 *
 * The signup screen has the same rule and it is easier to get wrong there,
 * because the obvious thing for a signup form to say is "that address is
 * already taken". It does not say it. It says the same sentence as a brand new
 * address gets, and the person who really owns the address is told by email.
 */

import { signedOutPage } from './brand-hero.js';

const ROUTES = new Set(['signup', 'verify-email', 'reset-password', 'forgot-password']);

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
  // Only what the sign-in card does not already provide. The frame, the panel
  // and the card itself are `.login-page` / `.login-panel` / `.login-card` from
  // the main style sheet, so these screens inherit the sign-in page's
  // proportions, its responsive breakpoints and any future change to them
  // rather than carrying a second, slowly diverging copy.
  style.textContent = `
    /* The gap owns the spacing, so every child sits the same distance apart
       whether it is a field, an error box or the button. \`.field\` brings its
       own bottom margin from the main sheet, which would add to it. */
    .kg-account-form { display:grid; gap:16px; margin-top:4px; }
    .kg-account-form .field { margin-bottom:0; }
    .kg-account-top { display:flex; align-items:baseline; justify-content:flex-end; gap:8px; margin:-6px 0 18px; font-size:13px; color:var(--muted); }
    .kg-account-top a { font-size:13px; }
    .kg-account-note { font-size:13px; color:var(--muted); line-height:1.55; margin:0; }
    .kg-account-bad { border:1px solid #d9534f66; background:#d9534f14; border-radius:10px; padding:11px 13px; font-size:13px; line-height:1.5; }
    .kg-account-good { border:1px solid #3aa06655; background:#3aa06614; border-radius:10px; padding:11px 13px; font-size:13px; line-height:1.5; }
    .kg-account-links { display:flex; justify-content:center; gap:10px; margin-top:18px; flex-wrap:wrap; }
    .kg-account-links a { font-size:13px; }
    .kg-account-links span { font-size:13px; color:var(--muted); }
  `;
  document.head.append(style);
}

function card(inner) {
  return signedOutPage(`<section class="login-card kg-account-card" id="kg-account-card">${inner}</section>`);
}

function backLink(text = 'Back to sign in') {
  return `<div class="kg-account-links"><a href="#/">${accEscape(text)}</a></div>`;
}

/* ------------------------------------------------------------------ signup */

/**
 * The shortest password the server will hash, repeated here.
 *
 * Not a second policy — the same one, said before the person has waited for a
 * round trip. The server is still the one that decides; if these two ever
 * disagree the server wins and the message it sends is what goes on screen.
 */
const MIN_PASSWORD = 10;

/**
 * The longest name the server stores, repeated here for the same reason.
 *
 * A name is asked for rather than offered as optional. It is what everybody
 * else in an organization sees next to a commit, a review and a pull request,
 * and defaulting it to the part of an address before the `@` means a repository
 * page full of `a.kukllod`, `devops2`, `info`. Somebody who does not want to
 * give a real one can type anything; what they cannot do is skip the question
 * and have the address answer it for them.
 */
const MAX_NAME = 191;

/**
 * The mark beside a label that has to be filled in.
 *
 * Every field on this form is required, which is an argument for marking none
 * of them — but the form is the first thing an outside developer sees of
 * KukGit, and "which of these can I skip" is a question worth answering before
 * it is asked rather than with a red box afterwards.
 */
const REQUIRED = '<span class="field-required" aria-hidden="true">*</span>';

/**
 * Whether this instance offers signup at all, asked once per page load.
 *
 * The answer is a deployment fact — local accounts, and a way to send the
 * verification email — so it cannot change while somebody is looking at the
 * page. Cached as the promise rather than the value, because the observer on
 * `#app` fires on every write anywhere in the application and an uncached check
 * here is a request per redraw.
 */
let signupOffering = null;
function signupOffered() {
  if (!signupOffering) {
    signupOffering = fetch('/api/account/signup', { credentials: 'same-origin' })
      // 404 is the honest answer where signup is not offered: no link, no
      // error on screen, nothing wrong.
      .then((response) => response.ok)
      .catch(() => false);
  }
  return signupOffering;
}

function signupAcceptedCard(message) {
  return card(`<h2>Check your inbox</h2>
    <div class="kg-account-good">${accEscape(message || 'If that address can be used, a link to finish setting up is on its way.')}</div>
    <p class="kg-account-note">The link proves the address is yours. Until it is opened you can sign in and look around, but not create an organization or a repository.</p>
    ${backLink()}`);
}

function renderSignup(root) {
  root.innerHTML = card(`<div class="kg-account-top"><span>Already have an account?</span><a href="#/">Sign in →</a></div>
    <h2>Create your KukGit account</h2>
    <p>Free while KukGit is in private alpha. Hosting for your own repositories, and for the organizations you are invited to.</p>
    <div id="kg-oauth-slot"></div>
    <form id="kg-signup-form" class="kg-account-form">
      <div class="field">
        <label>Your name${REQUIRED}</label>
        <input class="input" name="displayName" autocomplete="name" maxlength="${MAX_NAME}" required />
        <span class="field-hint">Shown next to your commits, reviews and pull requests. It does not have to be your legal name.</span>
      </div>
      <div class="field">
        <label>Email address${REQUIRED}</label>
        <input class="input" name="email" type="email" autocomplete="username" required />
        <span class="field-hint">We send a link here to confirm the address. Nothing else until you ask for it.</span>
      </div>
      <div class="field">
        <label>Password${REQUIRED}</label>
        <input class="input" name="password" type="password" autocomplete="new-password" minlength="${MIN_PASSWORD}" required />
        <span class="field-hint">At least ${MIN_PASSWORD} characters. Longer beats complicated — a phrase you can remember is stronger than a short word with symbols in it.</span>
      </div>
      <div class="field">
        <label>Type it again${REQUIRED}</label>
        <input class="input" name="confirm" type="password" autocomplete="new-password" minlength="${MIN_PASSWORD}" required />
      </div>
      <div id="kg-signup-error" class="kg-account-bad" hidden></div>
      <button class="btn btn-primary btn-block" type="submit">Create my account <span>→</span></button>
      <p class="kg-account-note">Creating an account does not sign you in — the link in the email does that.</p>
    </form>`);

  // Asked after the form is on screen rather than before it. The render stays
  // synchronous on purpose: this module runs before the application has
  // finished asking who is signed in, and a screen that waits for a round trip
  // before drawing anything is a screen the sign-in page renders over. That is
  // exactly how the forgot-password screen went missing on the live instance.
  signupOffered().then((available) => {
    if (available) return;
    // Still here, and still this screen. A slow answer that lands after
    // somebody has navigated away must not put a card on top of where they
    // went.
    if (accountRoute()?.name !== 'signup') return;
    const current = document.querySelector('#app');
    if (!current || !current.querySelector('#kg-signup-form')) return;
    current.innerHTML = card(`<h2>Accounts here are by invitation</h2>
      <p>This instance does not take open signups. Ask somebody in the organization to invite you, and the invitation arrives by email.</p>
      ${backLink()}`);
  });

  const form = root.querySelector('#kg-signup-form');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const box = root.querySelector('#kg-signup-error');
    const button = form.querySelector('button');
    const fail = (message) => {
      box.textContent = message;
      box.hidden = false;
      button.disabled = false;
      button.innerHTML = 'Create my account <span>→</span>';
    };
    box.hidden = true;

    // Checked here as well as by the `required` attribute, because that
    // attribute is enforced by the browser and this handler is what a test can
    // drive. A check only the browser makes is a check no test holds.
    const displayName = String(data.get('displayName') ?? '').trim();
    if (!displayName) return fail('Tell us what to call you.');
    if (displayName.length > MAX_NAME) return fail(`That name is longer than ${MAX_NAME} characters.`);

    const password = String(data.get('password') ?? '');
    // Both checked here as well as on the server. A mistyped password is worth
    // catching before an account exists with it, because the way to fix it
    // afterwards is a password reset on an address that is not yet confirmed.
    if (password !== String(data.get('confirm') ?? '')) return fail('Those two do not match.');
    if (password.length < MIN_PASSWORD) return fail(`Password must be at least ${MIN_PASSWORD} characters.`);

    button.disabled = true;
    button.textContent = 'Creating…';
    try {
      const result = await post('/api/account/signup', {
        email: data.get('email'),
        password,
        displayName,
      });
      root.innerHTML = signupAcceptedCard(result.message);
    } catch (error) {
      // The one failure that is not about what was typed: the route is not
      // there. Saying "not found" would read as a broken site rather than as a
      // deliberate policy.
      if (error.status === 404) {
        root.innerHTML = card(`<h2>Accounts here are by invitation</h2>
          <p>This instance does not take open signups. Ask somebody in the organization to invite you.</p>
          ${backLink()}`);
        return;
      }
      // Everything else is the server's own message — a malformed address, a
      // password it refuses. Never a hint about whether the address is already
      // registered: it does not send one, because it does not check before it
      // has hashed the password.
      fail(error.message);
    }
  });
}

/* ------------------------------------------------------------ verify email */

/**
 * One attempt per token, and the *result* of it.
 *
 * Not a set of tokens already tried. That was the first version and it turned
 * a link that had just worked into "already used" the moment anything redrew
 * the page — the token really had been spent, by us, a tick earlier.
 *
 * What is kept is the promise of the finished screen. A remount joins the same
 * attempt instead of starting another, and renders whatever it produced.
 */
const attempts = new Map();

/**
 * What this page's one attempt ended up showing.
 *
 * The token leaves the address bar as soon as it is spent, so a remount arrives
 * with no token at all — and "no token" reads as "you have not opened a link",
 * which replaced a confirmed address with "nothing to confirm" a moment after
 * confirming it. The route remembers its own outcome instead.
 */
let verifyOutcome = null;

async function confirmToken(token) {
  try {
    const result = await post('/api/account/verify-email/confirm', { token });
    return card(`<h2>Address confirmed</h2>
      <div class="kg-account-good">${accEscape(result.email || 'Your address')} is now verified.</div>
      <p class="kg-account-note">You can sign in, and you can now be added to organizations by email.</p>
      ${backLink('Continue to sign in')}`);
  } catch (error) {
    return card(`<h2>That link did not work</h2>
      <div class="kg-account-bad">${accEscape(error.message)}</div>
      <p class="kg-account-note">Links work once and expire after 24 hours. Sign in and ask for a new one.</p>
      ${backLink()}`);
  }
}

async function renderVerifyEmail(root, token) {
  if (!token) {
    if (verifyOutcome) {
      root.innerHTML = verifyOutcome;
      return;
    }
    root.innerHTML = card(`<h2>Nothing to confirm</h2>
      <p>This page needs the link from the email we sent you. Open that link, or sign in and ask for another.</p>
      ${backLink()}`);
    return;
  }
  // No test kills this line, because the token normally leaves the address bar
  // the moment it is spent and a remount never sees it again. It is here for
  // the case where it does not: `forgetToken` swallows a missing history API,
  // and on a browser without one the token stays in the URL and every remount
  // would spend it again.
  if (!attempts.has(token)) attempts.set(token, confirmToken(token));
  root.innerHTML = card('<h2>Confirming your address…</h2><p class="kg-account-note">One moment.</p>');
  const html = await attempts.get(token);
  // Everything after the answer is conditional on still being on this screen.
  // `forgetToken` rewrites the address, and doing that for somebody who has
  // navigated away drags them back to a page they left — which then makes the
  // result land on top of wherever they went. One check, because the two
  // failures are the same failure.
  if (accountRoute()?.name !== 'verify-email') return;
  verifyOutcome = html;
  forgetToken('verify-email');
  // Asked again after the await: the application may have redrawn `#app` while
  // this was in flight, and writing into an element nobody is looking at is how
  // a result appears to vanish.
  const current = document.querySelector('#app');
  if (current) current.innerHTML = html;
}

/* ---------------------------------------------------------- forgot password */

function renderForgotPassword(root) {
  root.innerHTML = card(`<h2>Reset your password</h2>
    <p class="kg-account-note">Tell us the address on your account and we will send a link.</p>
    <form id="kg-forgot-form" class="kg-account-form">
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
    <form id="kg-reset-form" class="kg-account-form">
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

/**
 * "Forgot password?", beside the password box rather than under the card.
 *
 * The moment somebody realises they cannot remember it is the moment they are
 * looking at that field, and a link at the foot of the card is a link they have
 * to go looking for. `app.js` leaves a slot in the label row for it.
 *
 * The fallback still appends to the end of the form. This module has to keep
 * working against a sign-in card it does not own, and a missing slot should
 * cost the link its position, not its existence.
 */
function addForgotLink() {
  const form = document.querySelector('#login-form');
  if (!form || form.dataset.kgForgot === 'done') return;
  form.dataset.kgForgot = 'done';
  const slot = form.querySelector('#kg-forgot-slot');
  if (slot) slot.innerHTML = '<a href="#/forgot-password">Forgot password?</a>';
  else form.insertAdjacentHTML('beforeend', '<div class="kg-account-links"><a href="#/forgot-password">Forgot password?</a></div>');
}

/**
 * "Create an account", but only where there is one to create.
 *
 * Gated on the server's answer rather than shown always, because a link to a
 * form that collects a password and then says the route does not exist is worse
 * than no link. On an invitation-only instance nothing appears and nothing is
 * said, which is the truth: there is no signup here.
 *
 * The flag goes on the form before the await, so the observer firing on the
 * application's own redraws cannot start a second check — that is how a page
 * ends up asking the same question forty times in two seconds.
 */
async function addSignupLink() {
  const form = document.querySelector('#login-form');
  if (!form || form.dataset.kgSignup === 'done') return;
  form.dataset.kgSignup = 'done';
  if (!(await signupOffered())) return;
  // The application re-renders on navigation and may have done so while the
  // answer was in flight. Appending to a form that is no longer on screen puts
  // the link nowhere.
  //
  // No test kills this line: without it the link goes onto a detached form and
  // the fresh one — which has no flag — asks again from the cache and gets its
  // own, so the page ends up the same either way. It is here because "write
  // into the element you looked up before the await" is the shape of a bug this
  // file has already had twice.
  if (document.querySelector('#login-form') !== form) return;
  // Its own line at the foot of the card, and a sentence rather than a bare
  // link. "Create an account" sitting next to "Forgot password?" read as two
  // items on a menu; this reads as the answer to a question somebody arriving
  // without an account is actually asking.
  form.insertAdjacentHTML('beforeend', '<div class="kg-account-links"><span>New to KukGit?</span><a href="#/signup">Create an account</a></div>');
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
    // Not awaited. The forgot-password link is on the page either way, and a
    // sign-in form that waits for this one before it has any links is a form
    // somebody sees without a way to reset their password.
    addSignupLink();
    return;
  }
  accountStyles();
  const key = `${route.name}:${route.token ?? ''}`;
  // Both halves matter. The key alone said "I have rendered this", which is not
  // the same as "it is on the page" — and on a real page it is not the same at
  // all: this module runs before `app.js` finishes asking who is signed in, so
  // it renders into an empty `#app` and then `renderLogin()` overwrites it. The
  // observer fired on that write, the key matched, and this returned without
  // doing anything. The screen was simply gone, on the live instance, while
  // every test passed — because no test ran `app.js` alongside it.
  if (rendered === key && document.querySelector('#kg-account-card')) return;
  rendered = key;

  if (route.name === 'signup') return renderSignup(root);
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
