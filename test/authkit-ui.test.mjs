import test from 'node:test';
import assert from 'node:assert/strict';
import { installBrowser, importFresh } from '../test-support/browser.mjs';

/**
 * The One Kuklabs Account sign-in card, from the browser's side.
 *
 * This is the only screen a signed-out stranger ever sees, so it is the one
 * that must not leak. The tests are about what it does with a password, what it
 * shows when identity is down, and that a wrong code does not turn into a
 * message that tells an attacker which half of the guess was right.
 */

// `statusResponse` is the whole HTTP answer; `status` is only its body.
// Conflating them is how a 503 arrives as a 200 whose body contains the number
// 503 — the same mistake that once made a request-storm test pass without its
// guard.
function page(t, { status = { mode: 'authkit', google: { enabled: false } }, statusResponse, login, otp, signup } = {}) {
  const sent = [];
  const browser = installBrowser({
    hash: '#/',
    // A plain card, the way app.js renders it. The module sets
    // `data-authkit` itself once it has taken the card over, and treats that
    // attribute as "already done" — so a fixture that pre-sets it is a fixture
    // the module ignores entirely.
    html: '<div id="app"><main class="login-page"><section class="login-card"></section></main></div><div id="toast-root"></div>',
    routes: {
      'GET /api/auth/status': statusResponse ?? { body: status },
      'POST /api/auth/login': (request) => {
        sent.push({ to: 'login', body: JSON.parse(request.init.body) });
        // A code being required arrives as a *refusal* carrying OTP_REQUIRED,
        // not as a successful body — the account is not signed in yet.
        return login ?? { status: 401, body: { error: { code: 'OTP_REQUIRED', message: 'A verification code is required.', identifier: 'amit@kuklabs.com' } } };
      },
      'POST /api/auth/signup': (request) => {
        sent.push({ to: 'signup', body: JSON.parse(request.init.body) });
        return signup ?? { status: 401, body: { error: { code: 'OTP_REQUIRED', message: 'A verification code is required.' } } };
      },
      'POST /api/auth/otp/verify': (request) => {
        sent.push({ to: 'verify', body: JSON.parse(request.init.body) });
        return otp ?? { body: { ok: true } };
      },
      'POST /api/auth/otp/request': (request) => {
        sent.push({ to: 'resend', body: JSON.parse(request.init.body) });
        return { body: { ok: true } };
      },
      '*': { status: 404, body: { error: { message: 'Not found.' } } },
    },
  });
  t.after(() => browser.restore());
  browser.sent = sent;
  return browser;
}

test('the card offers sign in and sign up, and says whose identity it is', async (t) => {
  const browser = page(t);
  await importFresh('../public/authkit-ui.js');
  await browser.settle();

  assert.match(browser.html(), /One Kuklabs Account/);
  assert.equal(browser.document.querySelectorAll('[data-auth-mode]').length, 2);
  assert.equal(browser.present('#kg-authkit-form'), true);
});

test('the password field is a password field, and asks for the right autofill', async (t) => {
  const browser = page(t);
  await importFresh('../public/authkit-ui.js');
  await browser.settle();

  const password = browser.document.querySelector('#kg-authkit-form [name="password"]');
  // A text input here puts somebody's password on screen in a meeting room,
  // and tells their password manager to save it as a username.
  assert.equal(password.getAttribute('type'), 'password');
  assert.equal(password.getAttribute('autocomplete'), 'current-password');
});

test('switching to sign up asks for a name and a new password', async (t) => {
  const browser = page(t);
  await importFresh('../public/authkit-ui.js');
  await browser.settle();

  browser.document.querySelectorAll('[data-auth-mode]').find((tab) => tab.dataset.authMode === 'signup').click();
  await browser.settle();

  assert.equal(browser.present('#kg-authkit-form [name="fullName"]'), true);
  // `new-password` is what stops a manager filling in the existing one and
  // makes it offer to generate a strong one instead.
  assert.equal(browser.document.querySelector('#kg-authkit-form [name="password"]').getAttribute('autocomplete'), 'new-password');
});

test('Google is offered only when the instance has it configured', async (t) => {
  const browser = page(t);
  await importFresh('../public/authkit-ui.js');
  await browser.settle();
  // A button that leads to a provider nobody set up is a dead end presented as
  // a choice.
  assert.equal(browser.present('#kg-authkit-google'), false);
});

test('and is offered when it is', async (t) => {
  const browser = page(t, { status: { mode: 'authkit', google: { enabled: true } } });
  await importFresh('../public/authkit-ui.js');
  await browser.settle();
  assert.equal(browser.present('#kg-authkit-google'), true);
});

test('signing in sends the identifier and password, and moves to the code', async (t) => {
  const browser = page(t);
  await importFresh('../public/authkit-ui.js');
  await browser.settle();

  const form = browser.document.querySelector('#kg-authkit-form');
  form.querySelector('[name="identifier"]').value = 'amit@kuklabs.com';
  form.querySelector('[name="password"]').value = 'a-real-password';
  form.dispatchEvent({ type: 'submit', target: form });
  await browser.settle();

  assert.deepEqual(browser.sent.map((entry) => entry.to), ['login']);
  assert.equal(browser.sent[0].body.identifier, 'amit@kuklabs.com');
  assert.equal(browser.present('#kg-authkit-otp-form'), true);
});

test('the code screen names the account, not the password', async (t) => {
  const browser = page(t);
  await importFresh('../public/authkit-ui.js');
  await browser.settle();

  const form = browser.document.querySelector('#kg-authkit-form');
  form.querySelector('[name="identifier"]').value = 'amit@kuklabs.com';
  form.querySelector('[name="password"]').value = 'a-real-password';
  form.dispatchEvent({ type: 'submit', target: form });
  await browser.settle();

  assert.match(browser.html(), /amit@kuklabs\.com/);
  // Nothing anywhere on the page should carry it forward.
  assert.equal(browser.html().includes('a-real-password'), false);
});

test('a rejected sign-in shows the reason without re-rendering the password back', async (t) => {
  const browser = page(t, { login: { status: 401, body: { error: { message: 'Those details did not match an account.' } } } });
  await importFresh('../public/authkit-ui.js');
  await browser.settle();

  const form = browser.document.querySelector('#kg-authkit-form');
  form.querySelector('[name="identifier"]').value = 'amit@kuklabs.com';
  form.querySelector('[name="password"]').value = 'a-real-password';
  form.dispatchEvent({ type: 'submit', target: form });
  await browser.settle();

  assert.match(browser.html(), /did not match an account/);
  assert.equal(browser.html().includes('a-real-password'), false);
  assert.equal(browser.present('#kg-authkit-form'), true);
});

test('a wrong code can be retried without starting again', async (t) => {
  const browser = page(t, { otp: { status: 401, body: { error: { message: 'That code is not valid.' } } } });
  await importFresh('../public/authkit-ui.js');
  await browser.settle();

  const form = browser.document.querySelector('#kg-authkit-form');
  form.querySelector('[name="identifier"]').value = 'amit@kuklabs.com';
  form.querySelector('[name="password"]').value = 'a-real-password';
  form.dispatchEvent({ type: 'submit', target: form });
  await browser.settle();

  const otpForm = browser.document.querySelector('#kg-authkit-otp-form');
  otpForm.querySelector('[name="code"]').value = '000000';
  otpForm.dispatchEvent({ type: 'submit', target: otpForm });
  await browser.settle();

  assert.match(browser.html(), /not valid/);
  // Sending somebody back to the password screen for a mistyped digit makes
  // them type the password again, which is where they give up.
  assert.equal(browser.present('#kg-authkit-otp-form'), true);
});

test('a resend asks for a new code for the same account', async (t) => {
  const browser = page(t);
  await importFresh('../public/authkit-ui.js');
  await browser.settle();

  const form = browser.document.querySelector('#kg-authkit-form');
  form.querySelector('[name="identifier"]').value = 'amit@kuklabs.com';
  form.querySelector('[name="password"]').value = 'a-real-password';
  form.dispatchEvent({ type: 'submit', target: form });
  await browser.settle();

  browser.document.querySelector('#kg-authkit-resend').click();
  await browser.settle();

  const resend = browser.sent.find((entry) => entry.to === 'resend');
  assert.equal(resend.body.identifier, 'amit@kuklabs.com');
});

test('an identity service that is down says so instead of a broken form', async (t) => {
  const browser = page(t, { statusResponse: { status: 503, body: { error: { message: 'AuthKit is unreachable.' } } } });
  await importFresh('../public/authkit-ui.js');
  await browser.settle();

  // A form that cannot possibly work is worse than a message: somebody types
  // their password into it first.
  assert.match(browser.html(), /unavailable|unreachable/i);
  assert.equal(browser.present('#kg-authkit-form'), false);
});
