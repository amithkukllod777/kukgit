import test from 'node:test';
import assert from 'node:assert/strict';
import { importFresh, installBrowser } from '../test-support/browser.mjs';
import { accountRoute } from '../public/account-screens-ui.js';

/**
 * The screens somebody reaches from an email.
 *
 * Every one of them is used by a person who is *not* signed in — that is what
 * they are for — so none of them can rely on a session, and all of them have to
 * work on a page that would otherwise be showing the sign-in form.
 *
 * Two things are worth testing beyond "does it render":
 *
 * **The token leaves the address bar once it is spent.** It is in the fragment
 * so it never reaches a server log, but it is still in history, and a person
 * who presses Back on a link that just worked should not be told it has already
 * been used.
 *
 * **The reset request says one thing.** The server deliberately answers the
 * same way for a registered address and an unknown one; a screen that said "no
 * account found" would give away what the server refused to.
 */

const LOGIN_FORM = '<form class="login-card" id="login-form"><input name="email" /></form>';

function page(t, { hash = '#/', routes = {}, html = LOGIN_FORM } = {}) {
  const browser = installBrowser({
    hash,
    html: `<div id="app">${html}</div><div id="toast-root"></div>`,
    routes: { '*': { status: 404, body: {} }, ...routes },
  });
  t.after(() => browser.restore());
  return browser;
}

async function screen(t, options) {
  const browser = page(t, options);
  await importFresh('../public/account-screens-ui.js');
  await browser.settle();
  return browser;
}

/* ---------------------------------------------------------------- routing */

test('only these four fragments are claimed, and the token comes off the query', async () => {
  assert.deepEqual(accountRoute('#/signup'), { name: 'signup', token: null });
  assert.deepEqual(accountRoute('#/verify-email?token=abc'), { name: 'verify-email', token: 'abc' });
  assert.deepEqual(accountRoute('#/reset-password?token=xyz'), { name: 'reset-password', token: 'xyz' });
  assert.deepEqual(accountRoute('#/forgot-password'), { name: 'forgot-password', token: null });
  // Everything else belongs to the application.
  for (const hash of ['#/', '#/repo/kuklabs/kukgit', '#/settings', '#/sign-in?error=state_invalid']) {
    assert.equal(accountRoute(hash), null, hash);
  }
});

test('the rest of the application is left alone', async (t) => {
  const browser = await screen(t, { hash: '#/', html: '<div class="app-shell">the shell</div>' });
  assert.match(browser.html(), /the shell/);
  assert.equal(browser.present('.kg-account'), false);
});

/* ----------------------------------------------------------------- signup */

/** An instance that takes signups, which is what the GET on that path says. */
const SIGNUP_OPEN = { 'GET /api/account/signup': { body: { available: true } } };

/**
 * Fills the form the way somebody in front of it would, and presses the button.
 *
 * Every field, every time, unless a test overrides one — a test that fills only
 * what it is interested in stops testing what it meant to the moment another
 * field becomes required, which is exactly what happened when the name stopped
 * being optional.
 */
function fillSignup(browser, values = {}) {
  const form = browser.document.querySelector('#kg-signup-form');
  const fields = {
    displayName: 'Newcomer',
    email: 'newcomer@example.com',
    password: 'a-real-enough-password',
    confirm: 'a-real-enough-password',
    ...values,
  };
  for (const [name, value] of Object.entries(fields)) form.querySelector(`[name="${name}"]`).value = value;
  return browser.submit('#kg-signup-form');
}

test('the signup form asks for a name, an address, a password, and it twice', async (t) => {
  const browser = await screen(t, { hash: '#/signup', routes: SIGNUP_OPEN });
  assert.match(browser.html(), /Create your KukGit account/);
  for (const field of ['email', 'password', 'confirm', 'displayName']) {
    const input = browser.document.querySelector(`#kg-signup-form [name="${field}"]`);
    assert.ok(input, field);
    // Including the name. It is what everybody else in an organization sees
    // next to a commit, and an address is not one.
    assert.ok(input.hasAttribute('required'), `${field} is required`);
  }
});

test('every field says what it is for, and which of them can be skipped', async (t) => {
  const browser = await screen(t, { hash: '#/signup', routes: SIGNUP_OPEN });
  // A hint under the field it is about, rather than one paragraph at the bottom
  // covering all four. The name is the one worth explaining: somebody typing it
  // should know it goes next to their commits.
  const hints = browser.document.querySelectorAll('#kg-signup-form .field-hint');
  assert.ok(hints.length >= 3, `${hints.length} field hints`);
  assert.match(browser.html(), /next to your commits/);
  assert.match(browser.html(), new RegExp(`At least ${10} characters`));
  // And none of them can be skipped, which is said before it is enforced.
  assert.equal(browser.document.querySelectorAll('#kg-signup-form .field-required').length, 4);
});

test('the way back to sign in is at the top, where somebody in the wrong place looks', async (t) => {
  const browser = await screen(t, { hash: '#/signup', routes: SIGNUP_OPEN });
  const link = browser.document.querySelector('.kg-account-top a[href="#/"]');
  assert.ok(link, 'the sign-in link is above the form');
  assert.match(browser.html(), /Already have an account/);
});

test('it looks like the rest of KukGit, not like a box on an empty page', async (t) => {
  const browser = await screen(t, { hash: '#/signup', routes: SIGNUP_OPEN });
  // The same frame the sign-in page uses, from the same module, so the two
  // cannot drift: hero on the left, card in the panel on the right.
  assert.equal(browser.present('.login-page'), true);
  assert.equal(browser.present('.login-hero'), true);
  assert.equal(browser.present('.login-panel .login-card'), true);
  assert.match(browser.html(), /KukGit v0\.2\.0 · Private alpha/);
  assert.ok(browser.document.querySelector('.brand-lockup[href="/"]'));
});

test('a signup with no name is refused before the server hears about it', async (t) => {
  const browser = await screen(t, { hash: '#/signup', routes: SIGNUP_OPEN });
  await fillSignup(browser, { displayName: '   ' });

  assert.match(browser.html(), /what to call you/);
  assert.equal(browser.calls.filter((call) => call.method === 'POST').length, 0);
  assert.equal(browser.present('#kg-signup-form'), true, 'the form is still there to fill it in on');
});

test('what is typed is what is sent, and the answer is the one sentence', async (t) => {
  const browser = await screen(t, {
    hash: '#/signup',
    routes: {
      ...SIGNUP_OPEN,
      'POST /api/account/signup': { status: 202, body: { accepted: true, message: 'Check your inbox — if that address can be used, a link is on its way.' } },
    },
  });
  await fillSignup(browser);

  const sent = JSON.parse(browser.calls.find((call) => call.method === 'POST' && call.path === '/api/account/signup').body);
  assert.deepEqual(sent, { email: 'newcomer@example.com', password: 'a-real-enough-password', displayName: 'Newcomer' });
  assert.match(browser.html(), /Check your inbox/);
  // Signing up does not sign anybody in, and the screen says so rather than
  // leaving somebody waiting to be let in.
  assert.match(browser.html(), /not create an organization or a repository/);
});

test('the screen says the same thing whether or not the address is taken', async (t) => {
  // The server answers 202 either way; this is the assertion that the screen
  // does not add a distinction the server was careful not to make.
  for (const message of [undefined, 'Check your inbox — if that address can be used, a link to finish setting up is on its way.']) {
    const browser = await screen(t, {
      hash: '#/signup',
      routes: { ...SIGNUP_OPEN, 'POST /api/account/signup': { status: 202, body: { accepted: true, message } } },
    });
    await fillSignup(browser, { email: 'taken@example.com' });

    assert.match(browser.html(), /Check your inbox/);
    assert.ok(!/already|taken|exists/i.test(browser.html()), 'nothing on screen says whether the address is registered');
    browser.restore();
  }
});

test('two passwords that do not match never reach the server', async (t) => {
  const browser = await screen(t, { hash: '#/signup', routes: SIGNUP_OPEN });
  await fillSignup(browser, { confirm: 'a-real-enough-passwort' });

  assert.match(browser.html(), /do not match/);
  // An account created with a mistyped password is fixed by a password reset on
  // an address that is not yet confirmed. Catching it here is worth a check the
  // server also makes.
  assert.equal(browser.calls.filter((call) => call.method === 'POST').length, 0);
  assert.equal(browser.present('#kg-signup-form'), true, 'the form is still there to fix it on');
});

test('a password the rules refuse is refused before an account exists', async (t) => {
  const browser = await screen(t, { hash: '#/signup', routes: SIGNUP_OPEN });
  await fillSignup(browser, { password: 'short', confirm: 'short' });

  assert.match(browser.html(), /at least 10 characters/);
  assert.equal(browser.calls.filter((call) => call.method === 'POST').length, 0);
  assert.equal(browser.document.querySelector('#kg-signup-form button').disabled, false, 'the button works again');
});

test("the server's own refusal is what goes on screen, escaped", async (t) => {
  const browser = await screen(t, {
    hash: '#/signup',
    routes: {
      ...SIGNUP_OPEN,
      'POST /api/account/signup': {
        status: 400,
        body: { error: { code: 'SIGNUP_EMAIL_INVALID', message: '<img src=x onerror=alert(1)> is not an address.' } },
      },
    },
  });
  await fillSignup(browser, { email: 'nonsense' });

  // Scoped to the card. The page has a real `<img>` in it now — the brand mark
  // in the hero — so asking whether the document contains one stopped being a
  // question about escaping and started being a question about the layout.
  assert.equal(browser.document.querySelectorAll('#kg-account-card img').length, 0, 'the message is text, not markup');
  assert.match(browser.html(), /is not an address/);
  assert.equal(browser.present('#kg-signup-form'), true);
});

test('where signup is not offered the screen says so instead of showing a form', async (t) => {
  // Reached by typing the address: there is no link to it on such an instance.
  // The default route table answers 404, which is what the server does.
  const browser = await screen(t, { hash: '#/signup' });
  await browser.settle();

  assert.match(browser.html(), /by invitation/);
  assert.equal(browser.present('#kg-signup-form'), false);
  assert.equal(browser.calls.filter((call) => call.method === 'POST').length, 0, 'nothing was submitted to find out');
});

test('a 404 on submit reads as policy, not as a broken site', async (t) => {
  // The gap between asking and submitting: an instance that stops offering
  // signup — its mail sender removed — while somebody has the form open.
  const browser = await screen(t, {
    hash: '#/signup',
    routes: { ...SIGNUP_OPEN, 'POST /api/account/signup': { status: 404, body: { error: { code: 'NOT_FOUND', message: 'Not found.' } } } },
  });
  await fillSignup(browser);

  assert.match(browser.html(), /by invitation/);
  assert.ok(!browser.html().includes('Not found.'));
});

/**
 * The availability check answers slowly, because on a real page it may.
 *
 * The form is drawn before the answer arrives — deliberately, because a screen
 * that waits for a round trip before drawing anything is a screen the sign-in
 * page renders over. That is the whole ordering the two tests below are about:
 * everything the late answer does has to be conditional on the screen it was
 * asked for still being the screen somebody is looking at.
 */
const SLOW_CLOSED = {
  'GET /api/account/signup': async () => {
    for (let tick = 0; tick < 8; tick += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    return { status: 404, body: {} };
  },
};

test('a late "no signup here" does not land on a page somebody has moved to', async (t) => {
  const browser = page(t, { hash: '#/signup', routes: SLOW_CLOSED });
  await importFresh('../public/account-screens-ui.js');
  // Two animation frames — enough for the mount to ask, not enough for the
  // eight-tick answer. Without this the module has not run when the navigation
  // happens and the test exercises nothing.
  await browser.settle(3);
  assert.equal(browser.present('#kg-signup-form'), true, 'the form is drawn without waiting');

  browser.navigate('#/');
  await browser.settle();

  assert.ok(!browser.html().includes('by invitation'), 'the answer did not paint itself over where they went');
});

test('a late "no signup here" does not overwrite an account that was just made', async (t) => {
  const browser = page(t, {
    hash: '#/signup',
    routes: { ...SLOW_CLOSED, 'POST /api/account/signup': { status: 202, body: { accepted: true } } },
  });
  await importFresh('../public/account-screens-ui.js');
  await browser.settle(3);

  await fillSignup(browser);
  await browser.settle();

  // The request went through. Telling somebody their account is by invitation
  // a second after it was made is worse than either message on its own.
  assert.match(browser.html(), /Check your inbox/);
  assert.ok(!browser.html().includes('by invitation'));
});

test('the sign-in form offers a way to make an account, where there is one', async (t) => {
  const browser = await screen(t, { hash: '#/', routes: SIGNUP_OPEN });
  await browser.settle();
  assert.ok(browser.document.querySelector('#login-form a[href="#/signup"]'), 'the sign-in form has a signup link');
});

test('and offers nothing where accounts are by invitation', async (t) => {
  const browser = await screen(t, { hash: '#/' });
  await browser.settle();
  // A link to a form that collects a password and then says the route does not
  // exist is worse than no link.
  assert.equal(browser.present('a[href="#/signup"]'), false);
  // The rest of the sign-in page is untouched.
  assert.ok(browser.document.querySelector('#login-form a[href="#/forgot-password"]'));
});

test('the question is asked once, however many times the page is redrawn', async (t) => {
  const browser = await screen(t, { hash: '#/', routes: SIGNUP_OPEN });
  for (let round = 0; round < 3; round += 1) {
    browser.document.querySelector('#app').innerHTML += '<p>something else rendered</p>';
    await browser.settle();
  }
  assert.equal(browser.countPath('/api/account/signup'), 1);
  assert.equal(browser.document.querySelectorAll('a[href="#/signup"]').length, 1);
  assert.equal(browser.looped, false);
});

test('and once more when the sign-in form itself is rebuilt', async (t) => {
  const browser = await screen(t, { hash: '#/', routes: SIGNUP_OPEN });
  // The flag that stops a repeat check lives on the form, so a redraw that
  // replaces the form loses it — which is right, the new form has no link yet.
  // What must not happen is a second request every time the application
  // re-renders its sign-in page. The answer is a deployment fact and cannot
  // change while somebody is looking at the page.
  for (let round = 0; round < 3; round += 1) {
    browser.document.querySelector('#app').innerHTML = LOGIN_FORM;
    await browser.settle();
    assert.equal(browser.document.querySelectorAll('a[href="#/signup"]').length, 1, `round ${round}`);
  }
  assert.equal(browser.countPath('/api/account/signup'), 1);
});

/* ----------------------------------------------------------- verify email */

test('a verification link confirms the address and then drops out of the URL', async (t) => {
  const browser = await screen(t, {
    hash: '#/verify-email?token=good-token',
    routes: { '/api/account/verify-email/confirm': { body: { verified: true, email: 'amit@kuklabs.com' } } },
  });

  assert.match(browser.html(), /Address confirmed/);
  assert.match(browser.html(), /amit@kuklabs\.com/);
  // A spent token left in the address bar is one the person re-triggers by
  // pressing Back, landing on "already used" for a link that just worked.
  assert.equal(browser.location.hash, '#/verify-email');
});

test('the token travels in the body, never in the URL of the request', async (t) => {
  const browser = await screen(t, {
    hash: '#/verify-email?token=good-token',
    routes: { '/api/account/verify-email/confirm': { body: { verified: true, email: 'amit@kuklabs.com' } } },
  });

  const call = browser.calls.find((entry) => String(entry.url).includes('verify-email/confirm'));
  assert.ok(call, 'the confirm call was made');
  assert.equal(call.method, 'POST');
  // A token in a request URL is a token in an access log and in whatever sits
  // in front of this server.
  assert.ok(!String(call.url).includes('good-token'));
  assert.equal(JSON.parse(call.body).token, 'good-token');
});

test('a link that has expired says so, and says what to do', async (t) => {
  const browser = await screen(t, {
    hash: '#/verify-email?token=old',
    routes: {
      '/api/account/verify-email/confirm': {
        status: 400,
        body: { error: { code: 'ACCOUNT_TOKEN_INVALID', message: 'That link has expired or was already used.' } },
      },
    },
  });

  assert.match(browser.html(), /That link did not work/);
  assert.match(browser.html(), /expired or was already used/);
  assert.equal(browser.location.hash, '#/verify-email');
});

test('opening the page without a link asks for one instead of calling the server', async (t) => {
  const browser = await screen(t, { hash: '#/verify-email' });
  assert.match(browser.html(), /Nothing to confirm/);
  assert.equal(browser.calls.filter((entry) => String(entry.url).includes('/api/account/')).length, 0);
});

test('confirming happens once, not once per re-render', async (t) => {
  const browser = await screen(t, {
    hash: '#/verify-email?token=good-token',
    routes: { '/api/account/verify-email/confirm': { body: { verified: true, email: 'a@b.com' } } },
  });
  // The observer fires on this file's own writes. Without a key, confirming
  // would restart the moment it finished and the second attempt would report
  // the token as already used.
  await browser.settle();
  await browser.settle();

  assert.equal(browser.calls.filter((entry) => String(entry.url).includes('verify-email/confirm')).length, 1);
});

/* --------------------------------------------------------- reset request */

test('the reset request screen says one thing, whatever the server did', async (t) => {
  for (const route of [
    { '/api/account/password-reset/request': { status: 202, body: { accepted: true } } },
    { '/api/account/password-reset/request': { status: 429, body: { error: { code: 'RATE_LIMITED', message: 'Too many requests' } } } },
  ]) {
    const browser = await screen(t, { hash: '#/forgot-password', routes: route });
    browser.document.querySelector('input[name="email"]').value = 'someone@example.com';
    await browser.submit('#kg-forgot-form');
    await browser.settle();

    // Branching would answer the question the server refused to: for a Git
    // host, "is this address registered" is "does this company keep its code
    // here".
    assert.match(browser.html(), /If that address has a KukGit account/);
    assert.ok(!browser.html().includes('Too many requests'));
    browser.restore();
  }
});

test('the sign-in form gets a way to reach it', async (t) => {
  const browser = await screen(t, { hash: '#/' });
  const link = browser.document.querySelector('#login-form a[href="#/forgot-password"]');
  assert.ok(link, 'the sign-in form has a forgot-password link');
});

/* --------------------------------------------------------- reset password */

test('a new password is sent with the token and the outcome is spelled out', async (t) => {
  const browser = await screen(t, {
    hash: '#/reset-password?token=reset-token',
    routes: {
      '/api/account/password-reset/complete': {
        body: { reset: true, sessionsEnded: 3, message: 'Password changed. Every signed-in device has been signed out.' },
      },
    },
  });

  browser.document.querySelector('input[name="password"]').value = 'a-long-enough-new-password';
  browser.document.querySelector('input[name="confirm"]').value = 'a-long-enough-new-password';
  await browser.submit('#kg-reset-form');
  await browser.settle();

  assert.match(browser.html(), /Password changed/);
  // Said out loud, because it is surprising and it matters.
  assert.match(browser.html(), /3 signed-in devices were signed out/);
  assert.equal(browser.location.hash, '#/reset-password');

  const call = browser.calls.find((entry) => String(entry.url).includes('password-reset/complete'));
  assert.equal(JSON.parse(call.body).token, 'reset-token');
  assert.ok(!String(call.url).includes('reset-token'));
});

test('two passwords that do not match are caught before the token is spent', async (t) => {
  const browser = await screen(t, {
    hash: '#/reset-password?token=reset-token',
    routes: { '/api/account/password-reset/complete': { body: { reset: true, sessionsEnded: 0 } } },
  });

  browser.document.querySelector('input[name="password"]').value = 'one-password';
  browser.document.querySelector('input[name="confirm"]').value = 'a-different-one';
  await browser.submit('#kg-reset-form');
  await browser.settle();

  // A typo caught only after the token is spent leaves somebody locked out
  // holding a link that no longer works.
  assert.equal(browser.calls.filter((entry) => String(entry.url).includes('password-reset/complete')).length, 0);
  assert.match(browser.html(), /do not match/);
});

test('a password the rules refuse leaves the link usable and the form on screen', async (t) => {
  const browser = await screen(t, {
    hash: '#/reset-password?token=reset-token',
    routes: {
      '/api/account/password-reset/complete': {
        status: 422,
        body: { error: { code: 'PASSWORD_TOO_SHORT', message: 'Use at least 12 characters.' } },
      },
    },
  });

  browser.document.querySelector('input[name="password"]').value = 'short';
  browser.document.querySelector('input[name="confirm"]').value = 'short';
  await browser.submit('#kg-reset-form');
  await browser.settle();

  assert.match(browser.html(), /at least 12 characters/);
  // Nothing was spent, so the person gets to try again here rather than going
  // back to their inbox for another link.
  assert.equal(browser.location.hash, '#/reset-password?token=reset-token');
  assert.equal(browser.present('#kg-reset-form'), true);
});

test('the reset page without a link offers to send one', async (t) => {
  const browser = await screen(t, { hash: '#/reset-password' });
  assert.match(browser.html(), /This page needs a link/);
  assert.ok(browser.document.querySelector('a[href="#/forgot-password"]'));
});

/* ------------------------------------------------- what the server sends */

test('what comes back from the server is escaped before it goes on the page', async (t) => {
  const browser = await screen(t, {
    hash: '#/verify-email?token=good-token',
    routes: { '/api/account/verify-email/confirm': { body: { verified: true, email: '<img src=x onerror=alert(1)>' } } },
  });

  // The address is validated on the way in, so this is not reachable today.
  // It is also the value most likely to gain a path that does not validate.
  assert.ok(!browser.html().includes('<img src=x'));
  assert.match(browser.html(), /&lt;img/);
});

test('an error message from the server is escaped too', async (t) => {
  const browser = await screen(t, {
    hash: '#/verify-email?token=old',
    routes: {
      '/api/account/verify-email/confirm': {
        status: 400,
        body: { error: { code: 'ACCOUNT_TOKEN_INVALID', message: '<script>alert(1)</script>' } },
      },
    },
  });

  assert.ok(!browser.html().includes('<script>alert'));
  assert.match(browser.html(), /&lt;script/);
});

/* ---------------------------------------------------- the sign-in link */

test('the forgot-password link is added once, not once per render', async (t) => {
  const browser = await screen(t, { hash: '#/' });
  browser.document.querySelector('#app').innerHTML += '<p>something else rendered</p>';
  await browser.settle();

  assert.equal(browser.document.querySelectorAll('a[href="#/forgot-password"]').length, 1);
});

test('the link goes on the sign-in form or nowhere', async (t) => {
  const browser = await screen(t, { hash: '#/', html: '<div class="app-shell">signed in</div>' });
  // Somebody already signed in. A "forgot your password?" link loose on the
  // dashboard is not a feature, it is a stray element.
  assert.equal(browser.present('a[href="#/forgot-password"]'), false);
});

/*
 * With `app.js` running too, which is the only way this module ever actually
 * runs. Every test above mounts it against a hand-written page, and that is
 * exactly the blind spot the bug below lived in.
 */

/**
 * `/api/auth/me` answers slowly, because on a real page it does.
 *
 * That delay is the whole bug. This module schedules on two animation frames
 * and renders almost immediately; `app.js` cannot draw anything until it knows
 * who is signed in. So this module's screen lands first and `renderLogin()`
 * overwrites it — and whether the screen survives depends entirely on what
 * happens on the remount. An instant answer hides that ordering completely,
 * which is why every test in this file passed while the screen was missing on
 * the live instance.
 */
const APP_WORLD = (overrides = {}) => ({
  // Six macrotask ticks rather than a wall-clock delay: the scheduler here uses
  // two animation frames, and counting ticks orders the two renders the same way
  // every run, on every machine, without depending on timer resolution.
  '/api/auth/me': async () => {
    for (let tick = 0; tick < 6; tick += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    return { body: { user: null } };
  },
  '/api/auth/sign-in-hints': { body: { demoAccount: null } },
  '/api/dashboard': { body: {} },
  '*': { status: 404, body: {} },
  ...overrides,
});

async function realPage(t, { hash, routes = {} } = {}) {
  const browser = installBrowser({
    hash,
    html: '<div id="app"></div><div id="toast-root"></div>',
    routes: APP_WORLD(routes),
  });
  t.after(() => browser.restore());
  // This module first, then `app.js`. Not because `index.html` lists them that
  // way — it does not — but because that is the order the *renders* land in on
  // a real page: this module schedules on two animation frames, while `app.js`
  // has to wait for `/api/auth/me` before it draws anything. Whoever writes to
  // `#app` last wins, and on the live instance it was `app.js`.
  await importFresh('../public/account-screens-ui.js');
  await importFresh('../public/app.js');
  await browser.settle();
  return browser;
}

test('the signup screen survives the sign-in page rendering underneath it', async (t) => {
  const browser = await realPage(t, { hash: '#/signup', routes: SIGNUP_OPEN });

  // The same ordering that took the forgot-password screen off the live
  // instance: this module renders first, `renderLogin()` overwrites it, and
  // whether anything is left depends entirely on the remount.
  assert.equal(browser.present('#kg-signup-form'), true, 'the signup form is on the page');
  assert.match(browser.html(), /Create your KukGit account/);
});

test('the reset link sits beside the password box, not at the foot of the card', async (t) => {
  const browser = await realPage(t, { hash: '#/', routes: SIGNUP_OPEN });
  const link = browser.document.querySelector('#kg-forgot-slot a[href="#/forgot-password"]');
  // The moment somebody realises they cannot remember it is the moment they are
  // looking at that field. A link at the bottom is one they go looking for.
  assert.ok(link, 'the link is in the password label row');
  assert.equal(browser.document.querySelectorAll('a[href="#/forgot-password"]').length, 1, 'and only there');
});

test('the sign-in card still gets its links if the slot is missing', async (t) => {
  // This module does not own the sign-in card. A card without the slot — an
  // older deploy, or a future rewrite — should cost the link its position, not
  // its existence.
  const browser = await screen(t, { hash: '#/', html: '<form class="login-card" id="login-form"><input name="email" /></form>' });
  await browser.settle();
  assert.ok(browser.document.querySelector('#login-form a[href="#/forgot-password"]'));
});

test('the signup link is on the real sign-in page, once', async (t) => {
  const browser = await realPage(t, { hash: '#/', routes: SIGNUP_OPEN });
  assert.equal(browser.document.querySelectorAll('#login-form a[href="#/signup"]').length, 1);
  // `renderLogin` rebuilds the form, so the flag that stops a second check goes
  // with it. Asking again is right; asking the network again is not.
  assert.equal(browser.countPath('/api/account/signup'), 1);
});

/**
 * Clicked, not typed.
 *
 * Every test above opens the address directly, which is a page load: `app.js`
 * runs `bootstrap()`, sees nobody signed in, draws the sign-in page, and never
 * looks at the fragment. A *click* is a `hashchange`, and `app.js` listens for
 * that too — it parses the route, does not recognise the name, and sends the
 * hash back to `#/`. Nothing this module does can survive that, because the
 * address it would render from has already been changed.
 *
 * It is the same failure the instance administration panel had, and the comment
 * on `EXTENSION_ROUTES` in `app.js` describes it exactly. These routes were
 * never added.
 */
for (const [name, form] of [['signup', '#kg-signup-form'], ['forgot-password', '#kg-forgot-form']]) {
  test(`clicking through to ${name} from the sign-in page gets there`, async (t) => {
    const browser = await realPage(t, { hash: '#/', routes: SIGNUP_OPEN });
    assert.ok(browser.document.querySelector(`#login-form a[href="#/${name}"]`), 'the link is on the page');

    browser.navigate(`#/${name}`);
    await browser.settle();

    assert.equal(browser.location.hash, `#/${name}`, 'the address was not dragged back');
    assert.equal(browser.present(form), true, 'the screen is on the page');
  });
}

test('and the way back to the sign-in form works', async (t) => {
  const browser = await realPage(t, { hash: '#/', routes: SIGNUP_OPEN });
  browser.navigate('#/signup');
  await browser.settle();
  assert.equal(browser.present('#kg-signup-form'), true);

  // The link every one of these screens ends with. Leaving somebody on a
  // signup form with no way back to sign in is the other half of this bug.
  browser.navigate('#/');
  await browser.settle();

  assert.equal(browser.present('#login-form'), true, 'the sign-in form is back');
  assert.equal(browser.present('.kg-account'), false, 'and the signup card is gone');
});

test('the reset screen survives the sign-in page rendering underneath it', async (t) => {
  const browser = await realPage(t, { hash: '#/forgot-password' });

  // The bug: this module runs before `app.js` finishes asking who is signed in,
  // renders into an empty `#app`, and is then overwritten by `renderLogin()`.
  // The remount saw its own key and returned. On the live instance the screen
  // was simply never there, and every other test in this file passed.
  assert.equal(browser.present('#kg-forgot-form'), true, 'the reset form is on the page');
  assert.match(browser.html(), /Reset your password/);
});

test('a verification link still confirms with the whole application running', async (t) => {
  const browser = await realPage(t, {
    hash: '#/verify-email?token=good-token',
    routes: { '/api/account/verify-email/confirm': { body: { verified: true, email: 'amit@kuklabs.com' } } },
  });

  assert.match(browser.html(), /Address confirmed/);
  // And exactly once, however many times the page was redrawn underneath it.
  assert.equal(browser.countPath('/api/account/verify-email/confirm'), 1);
});

test('a token is never sent twice, even if the card is overwritten mid-flight', async (t) => {
  const browser = await realPage(t, {
    hash: '#/verify-email?token=good-token',
    routes: { '/api/account/verify-email/confirm': { body: { verified: true, email: 'a@b.com' } } },
  });

  // Whatever else redraws the page, the token has been spent and must not be
  // spent again — the second attempt would report a working link as used.
  browser.document.querySelector('#app').innerHTML = '<p>something else took the page</p>';
  await browser.settle();
  await browser.settle();

  assert.equal(browser.countPath('/api/account/verify-email/confirm'), 1);
});

test('the sign-in page is left alone on every other route', async (t) => {
  const browser = await realPage(t, { hash: '#/' });
  assert.equal(browser.present('#login-form'), true);
  assert.equal(browser.present('.kg-account'), false);
  // And the way to reach the reset screen is on it.
  assert.ok(browser.document.querySelector('#login-form a[href="#/forgot-password"]'));
});

test('navigating away mid-confirm does not have the result land on top of it', async (t) => {
  // Without `app.js`. What is being checked belongs to this module alone, and
  // dragging the whole application in makes the test fail for a reason of its
  // own: `renderCurrentRoute` reads `state.user.displayName`, so a signed-out
  // visitor who changes the hash before `/api/auth/me` answers crashes it. Real,
  // narrow, and not this.
  const browser = page(t, {
    hash: '#/verify-email?token=good-token',
    routes: {
      '/api/account/verify-email/confirm': async () => {
        for (let tick = 0; tick < 8; tick += 1) await new Promise((resolve) => setTimeout(resolve, 0));
        return { body: { verified: true, email: 'a@b.com' } };
      },
    },
  });
  await importFresh('../public/account-screens-ui.js');
  // Long enough for the mount to start the request — two animation frames — and
  // not long enough for the eight-tick answer to arrive. Without this the module
  // has not run at all when the navigation happens, and the test passes while
  // exercising nothing.
  await browser.settle(3);

  // Away before the answer comes back — a slow confirm and an impatient person.
  browser.navigate('#/');
  await browser.settle();

  // The confirmation must not paint itself over the page they went to.
  assert.ok(!browser.html().includes('Address confirmed'));
});
