import test from 'node:test';
import assert from 'node:assert/strict';
import { importFresh, installBrowser } from '../test-support/browser.mjs';
import { isSignupRoute } from '../public/signup-ui.js';

const LOGIN_FORM = `
  <form class="login-card" id="login-form">
    <input name="email" />
    <input name="password" />
    <button type="submit">Sign in</button>
  </form>`;

function page(t, { hash = '#/', routes = {}, html = LOGIN_FORM } = {}) {
  const browser = installBrowser({
    hash,
    html: `<div id="app">${html}</div><div id="toast-root"></div>`,
    routes: { '*': { status: 404, body: {} }, ...routes },
  });
  t.after(() => browser.restore());
  return browser;
}

async function screen(t, options = {}) {
  const browser = page(t, options);
  await importFresh('../public/signup-ui.js');
  await browser.settle();
  return browser;
}

function fillSignup(browser, {
  displayName = 'Outside Developer',
  email = 'developer@example.com',
  password = 'a-secure-password',
  confirm = password,
} = {}) {
  browser.document.querySelector('input[name="displayName"]').value = displayName;
  browser.document.querySelector('input[name="email"]').value = email;
  browser.document.querySelector('input[name="password"]').value = password;
  browser.document.querySelector('input[name="confirm"]').value = confirm;
}

test('only the signup fragment is claimed', () => {
  assert.equal(isSignupRoute('#/signup'), true);
  assert.equal(isSignupRoute('#/signup?source=login'), true);
  for (const hash of ['#/', '#/forgot-password', '#/verify-email?token=x', '#/settings']) {
    assert.equal(isSignupRoute(hash), false, hash);
  }
});

test('the sign-in form gets one discoverable create-account link', async (t) => {
  const browser = await screen(t, { hash: '#/' });
  assert.ok(browser.document.querySelector('#login-form a[href="#/signup"]'));

  browser.document.querySelector('#app').innerHTML += '<p>another render</p>';
  await browser.settle();
  assert.equal(browser.document.querySelectorAll('a[href="#/signup"]').length, 1);
});

test('the signup route renders the fields required by the existing API', async (t) => {
  const browser = await screen(t, { hash: '#/signup' });
  assert.equal(browser.present('#kg-signup-form'), true);
  assert.ok(browser.document.querySelector('input[name="displayName"]'));
  assert.ok(browser.document.querySelector('input[name="email"]'));
  assert.ok(browser.document.querySelector('input[name="password"]'));
  assert.ok(browser.document.querySelector('input[name="confirm"]'));
  assert.match(browser.html(), /does not sign you in/);
});

test('accepted signup always renders one browser-owned generic outcome', async (t) => {
  for (const serverBody of [
    { accepted: true, message: 'new account created' },
    { accepted: true, message: 'existing address' },
  ]) {
    const browser = await screen(t, {
      hash: '#/signup',
      routes: { '/api/account/signup': { status: 202, body: serverBody } },
    });
    fillSignup(browser);
    await browser.submit('#kg-signup-form');
    await browser.settle();

    assert.match(browser.html(), /Check your inbox/);
    assert.match(browser.html(), /if that address can be used/);
    assert.ok(!browser.html().includes(serverBody.message));

    const calls = browser.calls.filter((entry) => String(entry.url).includes('/api/account/signup'));
    assert.equal(calls.length, 1);
    const body = JSON.parse(calls[0].body);
    assert.deepEqual(body, {
      displayName: 'Outside Developer',
      email: 'developer@example.com',
      password: 'a-secure-password',
    });
    // The mode probe is allowed; signup is not login. Nothing here should ask
    // who is signed in or call a login/session-completing route after the 202.
    assert.equal(browser.calls.filter((entry) => {
      const url = String(entry.url);
      return url.includes('/api/auth/me')
        || url.includes('/api/auth/login')
        || url.includes('/api/auth/two-factor');
    }).length, 0);
    browser.restore();
  }
});

test('password mismatch is refused before the signup credential leaves the page', async (t) => {
  const browser = await screen(t, {
    hash: '#/signup',
    routes: { '/api/account/signup': { status: 202, body: { accepted: true } } },
  });
  fillSignup(browser, { password: 'first-password', confirm: 'second-password' });
  await browser.submit('#kg-signup-form');
  await browser.settle();

  assert.equal(browser.calls.filter((entry) => String(entry.url).includes('/api/account/signup')).length, 0);
  assert.match(browser.html(), /do not match/);
});

test('recoverable server validation keeps the form and typed safe fields in place', async (t) => {
  const browser = await screen(t, {
    hash: '#/signup',
    routes: {
      '/api/account/signup': {
        status: 400,
        body: { error: { code: 'SIGNUP_EMAIL_INVALID', message: 'That does not look like an email address.' } },
      },
    },
  });
  fillSignup(browser, { displayName: 'Amit Test', email: 'bad@example.com' });
  await browser.submit('#kg-signup-form');
  await browser.settle();

  assert.equal(browser.present('#kg-signup-form'), true);
  assert.match(browser.html(), /does not look like an email address/);
  assert.equal(browser.document.querySelector('input[name="displayName"]').value, 'Amit Test');
  assert.equal(browser.document.querySelector('input[name="email"]').value, 'bad@example.com');
});

test('an instance without signup presents an instance-wide unavailable state', async (t) => {
  const browser = await screen(t, {
    hash: '#/signup',
    routes: {
      '/api/account/signup': {
        status: 404,
        body: { error: { code: 'NOT_FOUND', message: 'Not found.' } },
      },
    },
  });
  fillSignup(browser);
  await browser.submit('#kg-signup-form');
  await browser.settle();

  assert.match(browser.html(), /Signup is not available here/);
  assert.match(browser.html(), /self-service email signup/);
  assert.ok(browser.document.querySelector('a[href="#/"]'));
});

test('server text is escaped when shown as a validation error', async (t) => {
  const browser = await screen(t, {
    hash: '#/signup',
    routes: {
      '/api/account/signup': {
        status: 400,
        body: { error: { code: 'SIGNUP_NAME_INVALID', message: '<script>alert(1)</script>' } },
      },
    },
  });
  fillSignup(browser);
  await browser.submit('#kg-signup-form');
  await browser.settle();

  // Validation errors are assigned through textContent, never interpolated.
  assert.ok(!browser.html().includes('<script>alert'));
  assert.match(browser.html(), /&lt;script/);
});

test('a signed-in application shell is never replaced by signup', async (t) => {
  const browser = await screen(t, {
    hash: '#/signup',
    html: '<div class="app-shell">signed in</div>',
  });
  assert.match(browser.html(), /signed in/);
  assert.equal(browser.present('#kg-signup-card'), false);
});

const APP_WORLD = (overrides = {}) => ({
  '/api/auth/me': async () => {
    for (let tick = 0; tick < 6; tick += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    return { body: { user: null } };
  },
  '/api/auth/sign-in-hints': { body: { demoAccount: null } },
  '/api/auth/providers': { body: { providers: [] } },
  '/api/dashboard': { body: {} },
  '*': { status: 404, body: {} },
  ...overrides,
});

test('the signup screen survives app.js drawing the sign-in page underneath it', async (t) => {
  const browser = installBrowser({
    hash: '#/signup',
    html: '<div id="app"></div><div id="toast-root"></div>',
    routes: APP_WORLD(),
  });
  t.after(() => browser.restore());

  await importFresh('../public/signup-ui.js');
  await importFresh('../public/app.js');
  await browser.settle();

  assert.equal(browser.present('#kg-signup-form'), true);
  assert.match(browser.html(), /Create your KukGit account/);
});
