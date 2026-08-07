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

test('only these three fragments are claimed, and the token comes off the query', async () => {
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
