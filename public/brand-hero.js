/**
 * The page somebody sees before they are signed in.
 *
 * There are five of them — sign in, create an account, ask for a reset link,
 * choose a new password, confirm an address — and until now only the first one
 * looked like KukGit. The other four rendered a bare card in the middle of an
 * empty page, because they were written as "a screen that takes over" rather
 * than as "a page of this product". Somebody arriving from an email, or from
 * the sign-in form's own link, went from a designed page to a floating box.
 *
 * So the frame lives here, once, and both `app.js` and `account-screens-ui.js`
 * render into it. Copying the markup into the second file would have been
 * fewer lines today and two pages that drift apart the first time anybody edits
 * the wording.
 *
 * Nothing here reads state or talks to a server. It is markup and it stays
 * markup, so importing it cannot make either page fail to render.
 */

function markHtml() {
  return '<span class="brand-logo mk-mark" aria-hidden="true"><img src="/assets/kukgit-logo.jpg" alt="" /></span>';
}

function sunHtml() {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>';
}

function shieldHtml() {
  return '<svg class="mk-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 13c0 5-3.5 7.5-8 9-4.5-1.5-8-4-8-9V5l8-3 8 3v8Z"/><path d="m9 12 2 2 4-4"/></svg>';
}

function codeVisualHtml() {
  return `<div class="login-dev-visual" aria-label="KukGit code review preview">
      <div class="login-code-window">
        <div class="login-code-toolbar">
          <span class="login-window-dots" aria-hidden="true"><i></i><i></i><i></i></span>
          <code>src/auth/session-policy.ts</code>
          <span class="login-code-branch">main</span>
        </div>
        <div class="login-code-body">
          <div class="login-code-lines" aria-hidden="true">
            <div><span>1</span><code><b>export async function</b> verifySession(token) {</code></div>
            <div><span>2</span><code>&nbsp; <b>const</b> session = <em>await</em> auth.verify(token);</code></div>
            <div><span>3</span><code>&nbsp; enforce(<u>session.twoFactorVerified</u>);</code></div>
            <div class="code-add"><span>4</span><code>+ rotateIfUntrusted(session.device);</code></div>
            <div><span>5</span><code>&nbsp; <b>return</b> session;</code></div>
            <div><span>6</span><code>}</code></div>
          </div>
          <div class="login-review-card">
            <span class="login-review-icon">&#10003;</span>
            <span><b>KukAI review passed</b><small>Session rotation and 2FA policy verified</small></span>
          </div>
        </div>
      </div>
      <div class="login-check-chip"><span>&#10003;</span> All checks passed</div>
    </div>`;
}

/** The right column from the approved Lovable authentication prototype. */
export function heroHtml() {
  return `<section class="login-hero">
      <div class="mk-grid-lines" aria-hidden="true"></div>
      <div class="login-hero-inner">
        ${codeVisualHtml()}
        <div class="login-copy">
          ${shieldHtml()}
          <h1>One account for every Kuklabs product.</h1>
          <p>Enforced two-factor authentication, device and session management, SSO for organisations and a full audit trail — configured once, applied everywhere.</p>
          <div class="login-points">
            <div class="login-point"><b>SAML &amp; OIDC single sign-on</b></div>
            <div class="login-point"><b>Passkey and TOTP second factors</b></div>
            <div class="login-point"><b>Session revocation across devices</b></div>
            <div class="login-point"><b>Recovery codes stored offline</b></div>
          </div>
        </div>
      </div>
    </section>`;
}

/**
 * The whole two-column frame, with `panel` in the right-hand column.
 *
 * One `<main>`, always. Two of them on a page means two modules are rendering
 * the same route — see `test/public-page-routes.test.mjs`, which counts them.
 */
export function signedOutPage(panel) {
  return `<main class="login-page"><section class="login-panel">
    <div class="login-top"><a class="brand-lockup" href="/">${markHtml()}<span><b>KukGit</b><small>Powered by Kuklabs</small></span></a><button class="login-theme-toggle" type="button" aria-label="Switch theme">${sunHtml()}</button></div>
    <div class="login-form-wrap">${panel}</div>
    <p class="login-legal">© 2026 Kuklabs Inc. · <u>Terms</u> · <u>Privacy</u></p>
  </section>${heroHtml()}</main>`;
}

if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
  document.addEventListener('click', (event) => {
    const button = event.target?.closest?.('.login-theme-toggle');
    if (!button) return;
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('kukgit-theme', next); } catch { /* Storage can be blocked. */ }
  });
}
