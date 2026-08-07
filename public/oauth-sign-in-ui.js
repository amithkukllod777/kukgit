/**
 * The provider buttons on the sign-in screen.
 *
 * Deliberately a separate file that attaches itself to the form rather than
 * part of `renderLogin`. The sign-in screen is the one page every customer sees
 * and the one page that must keep working when something else is broken, so the
 * password form is not rewritten to add this: if this file fails to load, the
 * form is still there and people can still sign in.
 *
 * Two rules run through everything here.
 *
 * **Only providers the server says it has.** The buttons are drawn from
 * `/api/auth/providers`, never hard-coded. A self-hosted instance with no
 * GitHub credentials shows no GitHub button, instead of one that leads to an
 * error page on GitHub's domain and reads as "KukGit is broken".
 *
 * **Nothing from the URL is put on the page as-is.** The failure code comes
 * back in the fragment, and a fragment is something anybody can put in a link.
 * It is matched against a fixed list of messages; a code that is not on the
 * list produces the generic one. Echoing it would be a way to write text of
 * somebody else's choosing onto our own sign-in page, which is most of what a
 * phishing page needs.
 */

const PROVIDER_MARK = {
  // Inline, because a sign-in page that fetches an icon from a provider tells
  // that provider about everybody who opens it, signed in or not.
  github: '<svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.4 7.4 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/></svg>',
  google: '<svg viewBox="0 0 18 18" width="18" height="18" aria-hidden="true"><path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62Z"/><path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.81.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18Z"/><path fill="#FBBC05" d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33Z"/><path fill="#EA4335" d="M9 3.58c1.32 0 2.5.46 3.44 1.35l2.58-2.58C13.46.9 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58Z"/></svg>',
};

/**
 * What each failure means, in words somebody can act on.
 *
 * A fixed table. The server sends a code from a fixed list and this turns it
 * into a sentence; neither end passes a provider's own message through, because
 * that is text somebody else controls arriving on our origin.
 */
const FAILURE_MESSAGE = {
  access_denied: 'Sign-in was cancelled. Nothing has changed.',
  state_invalid: 'That sign-in attempt expired or was already used. Start again.',
  email_conflict: 'An account here already uses that email address. Sign in with your password, then link this provider from account settings.',
  already_linked: 'That account is already linked to a different KukGit user.',
  provider_taken: 'This KukGit account already has one linked. Remove it from account settings first.',
  provider_unavailable: 'That sign-in method is not available on this instance.',
  provider_error: 'The provider could not complete the sign-in. Try again in a moment.',
  server_error: 'Something went wrong on our side. Try again, and tell us if it keeps happening.',
};

function oauthEscape(value = '') {
  return String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

/**
 * Reads the failure out of the fragment.
 *
 * Returns a message from the table above or nothing at all — never the value
 * from the URL. `provider` is only used to pick a label, and only when it is a
 * provider this build knows about.
 */
export function oauthFailureFromHash(hash = location.hash) {
  const query = String(hash).split('?')[1];
  if (!query) return null;
  const params = new URLSearchParams(query);
  const code = params.get('error');
  if (!code) return null;
  const provider = params.get('provider');
  const label = Object.prototype.hasOwnProperty.call(PROVIDER_MARK, provider) ? providerLabel(provider) : null;
  return {
    // An unknown code is treated as a bug on our side, not echoed back.
    message: FAILURE_MESSAGE[code] ?? FAILURE_MESSAGE.server_error,
    label,
  };
}

function providerLabel(id) {
  return id === 'github' ? 'GitHub' : 'Google';
}

/**
 * The failure box, as a string.
 *
 * Separate and exported so the escaping is something a test can actually
 * exercise. Today every value reaching it comes from a table in this file and
 * none of them contain a metacharacter, so escaping is belt-and-braces — but it
 * is the kind that stops mattering silently the day somebody adds a message
 * with a customer's address interpolated into it.
 */
export function failureBoxHtml(failure) {
  if (!failure) return '';
  return `<div class="kg-oauth-error" role="alert">${
    failure.label ? `<b>${oauthEscape(failure.label)}:</b> ` : ''
  }${oauthEscape(failure.message)}</div>`;
}

/**
 * One button, as a string. Empty for a provider this build does not know.
 *
 * The label is escaped even though `providerLabel` can only return one of two
 * words written above — no test can make that escaping matter, and it stays
 * because the day the label comes from anywhere else is the day nobody will
 * think to add it.
 */
export function providerButtonHtml(id) {
  const name = String(id);
  if (!Object.prototype.hasOwnProperty.call(PROVIDER_MARK, name)) return '';
  // A plain link, so it is a top-level navigation the browser performs. The
  // whole flow is redirects; doing it with `fetch` would follow them invisibly
  // and land the person nowhere.
  return `<a class="kg-oauth-btn" href="/api/auth/${encodeURIComponent(name)}/start" rel="nofollow">${
    PROVIDER_MARK[name]}<span>Continue with ${oauthEscape(providerLabel(name))}</span></a>`;
}

function oauthStyles() {
  if (document.querySelector('#kg-oauth-styles')) return;
  const style = document.createElement('style');
  style.id = 'kg-oauth-styles';
  style.textContent = `
    .kg-oauth { display:grid; gap:10px; margin:2px 0 4px; }
    .kg-oauth-divider { display:flex; align-items:center; gap:12px; color:var(--muted); font-size:12px; letter-spacing:.08em; text-transform:uppercase; margin:10px 0 4px; }
    .kg-oauth-divider::before, .kg-oauth-divider::after { content:''; flex:1; height:1px; background:var(--border); }
    .kg-oauth-btn { display:flex; align-items:center; justify-content:center; gap:10px; width:100%; padding:11px 14px; border:1px solid var(--border); border-radius:10px; background:transparent; color:inherit; font:inherit; font-weight:600; cursor:pointer; text-decoration:none; }
    .kg-oauth-btn:hover { border-color:var(--accent, #6c8cff); }
    .kg-oauth-error { border:1px solid #d9534f66; background:#d9534f14; border-radius:10px; padding:11px 13px; font-size:13px; line-height:1.5; }
  `;
  document.head.append(style);
}

async function providers() {
  const response = await fetch('/api/auth/providers', { credentials: 'same-origin' });
  // 404 is the honest answer on an instance where Kuklabs Account owns the
  // sessions. No buttons, no error on screen — there is nothing wrong.
  if (!response.ok) return [];
  const payload = await response.json().catch(() => ({}));
  return Array.isArray(payload.providers) ? payload.providers : [];
}

/**
 * Where the buttons go on this screen, and where the failure box goes.
 *
 * Two screens want them. The sign-in form has them above its own fields, which
 * is where they have always been. The signup screen leaves an empty slot for
 * them, because somebody creating an account wants the same one-click option
 * that somebody signing in gets — and a signup page offering only a password,
 * on an instance whose sign-in page offers Google, reads as the provider being
 * unavailable rather than as a page that forgot to ask.
 *
 * The slot is looked for first: on the signup screen there is no `#login-form`
 * at all, and on the sign-in screen there is no slot.
 */
function oauthTarget() {
  const slot = document.querySelector('#kg-oauth-slot');
  if (slot) return { host: slot, flag: 'kgOauth', position: 'beforeend' };
  const form = document.querySelector('#login-form');
  return form ? { host: form, flag: 'kgOauth', position: 'afterbegin' } : null;
}

async function mountOAuthButtons() {
  const target = oauthTarget();
  if (!target) return;
  const form = target.host;
  if (form.dataset[target.flag] === 'done') return;
  form.dataset[target.flag] = 'done';
  oauthStyles();

  const box = failureBoxHtml(oauthFailureFromHash());
  if (box) form.insertAdjacentHTML('afterbegin', box);

  const available = await providers();
  // The app re-renders on navigation, and it may have done so while the
  // provider list was in flight. Adding buttons to a host that is no longer the
  // one on screen puts them nowhere. No test kills this line — with or without
  // it the page ends up with no buttons — so it is here for what it says rather
  // than for what it prevents today.
  if (oauthTarget()?.host !== form) return;

  // Covers an empty list and a list of nothing this build recognises in one
  // check. The form is still on screen and still works either way.
  const buttons = available.map((provider) => providerButtonHtml(provider.id)).join('');
  if (!buttons) return;

  form.insertAdjacentHTML(target.position, `<div class="kg-oauth">${buttons}<div class="kg-oauth-divider">or</div></div>`);
}

let scheduled = false;
function scheduleOAuthButtons() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => requestAnimationFrame(async () => {
    scheduled = false;
    await mountOAuthButtons();
  }));
}

if (typeof document !== 'undefined' && document.querySelector('#app')) {
  window.addEventListener('hashchange', scheduleOAuthButtons);
  new MutationObserver(scheduleOAuthButtons).observe(document.querySelector('#app'), { childList: true, subtree: true });
  scheduleOAuthButtons();
}
