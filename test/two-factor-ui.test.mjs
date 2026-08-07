import test from 'node:test';
import assert from 'node:assert/strict';
import { importFresh, installBrowser } from '../test-support/browser.mjs';
import { groupSecret, statusPanelHtml } from '../public/two-factor-settings-ui.js';

/**
 * The two screens without which a second factor is a trap.
 *
 * This file exists because the API shipped before either of them did, and that
 * combination is worse than having no 2FA at all:
 *
 * `/api/auth/login` answers a 2FA account with `twoFactorRequired` and a
 * challenge, and **sets no cookie**. The sign-in page ignored the body and went
 * straight to `bootstrap()`, which found no session and re-rendered the sign-in
 * form with nothing said. Anybody who turned 2FA on could never sign in again.
 *
 * And there was no way to turn it on except by hand-writing a request — which
 * hands somebody a second factor with no recovery codes on screen and no way
 * back off.
 */

const SHELL = '<div class="app-shell"><div class="content"><section class="card">settings</section></div></div>';
const OFF = { '/api/account/two-factor': { body: { enabled: false, pending: false, recoveryCodesRemaining: 0 } } };
const ON = { '/api/account/two-factor': { body: { enabled: true, pending: false, recoveryCodesRemaining: 7 } } };

function page(t, { hash = '#/settings', routes = {}, html = SHELL } = {}) {
  const browser = installBrowser({
    hash,
    html: `<div id="app">${html}</div><div id="toast-root"></div>`,
    routes: { '*': { status: 404, body: {} }, ...routes },
  });
  t.after(() => browser.restore());
  return browser;
}

async function settings(t, options) {
  const browser = page(t, options);
  await importFresh('../public/two-factor-settings-ui.js');
  await browser.settle();
  return browser;
}

/* ------------------------------------------------------- signing in with one */

const LOGIN_WORLD = (overrides = {}) => ({
  '/api/auth/sign-in-hints': { body: { demoAccount: null } },
  '/api/auth/me': { body: { user: null } },
  '/api/dashboard': { body: {} },
  '*': { status: 404, body: {} },
  ...overrides,
});

async function signInPage(t, routes) {
  const browser = installBrowser({
    hash: '#/',
    html: '<div id="app"></div><div id="toast-root"></div>',
    routes: LOGIN_WORLD(routes),
  });
  t.after(() => browser.restore());
  await importFresh('../public/app.js');
  await browser.settle();
  return browser;
}

test('a password that needs a second factor asks for one instead of silently failing', async (t) => {
  const browser = await signInPage(t, {
    '/api/auth/login': { body: { twoFactorRequired: true, challenge: 'chal-123' } },
  });

  browser.document.querySelector('#login-form input[name="email"]').value = 'owner@kuklabs.com';
  browser.document.querySelector('#login-form input[name="password"]').value = 'a-real-enough-password';
  await browser.submit('#login-form');
  await browser.settle();

  // Before this, `bootstrap()` ran, found no session, and re-rendered the same
  // sign-in form — which reads as "wrong password" for a password that was
  // right.
  assert.equal(browser.present('#second-factor-form'), true);
  assert.equal(browser.present('#login-form'), false);
  assert.match(browser.html(), /One more step/);
  // The recovery route is named where somebody whose phone is gone will see it.
  assert.match(browser.html(), /recovery codes/i);
});

test('the challenge finishes the sign-in and is never written onto the page', async (t) => {
  const browser = await signInPage(t, {
    '/api/auth/login': { body: { twoFactorRequired: true, challenge: 'chal-123' } },
    '/api/auth/two-factor': { body: { user: { id: 'usr_1', email: 'owner@kuklabs.com' }, recoveryCodesRemaining: 10 } },
  });
  browser.document.querySelector('#login-form input[name="email"]').value = 'owner@kuklabs.com';
  browser.document.querySelector('#login-form input[name="password"]').value = 'pw';
  await browser.submit('#login-form');
  await browser.settle();

  // A copy in the page or the URL is a copy in browser history on a shared
  // machine.
  assert.ok(!browser.html().includes('chal-123'));
  assert.ok(!browser.location.hash.includes('chal-123'));

  browser.document.querySelector('#second-factor-form input[name="code"]').value = '123456';
  await browser.submit('#second-factor-form');
  await browser.settle();

  const call = browser.calls.find((entry) => String(entry.url).includes('/api/auth/two-factor'));
  assert.ok(call, 'the second step was sent');
  assert.equal(JSON.parse(call.body).challenge, 'chal-123');
  assert.equal(JSON.parse(call.body).code, '123456');
  assert.ok(!String(call.url).includes('chal-123'), 'not in the request URL either');
});

test('a wrong code says so and offers the only thing that can work', async (t) => {
  const browser = await signInPage(t, {
    '/api/auth/login': { body: { twoFactorRequired: true, challenge: 'chal-123' } },
    '/api/auth/two-factor': { status: 401, body: { error: { code: 'TWO_FACTOR_CODE_INVALID', message: 'That code is not right.' } } },
  });
  browser.document.querySelector('#login-form input[name="email"]').value = 'a@b.com';
  browser.document.querySelector('#login-form input[name="password"]').value = 'pw';
  await browser.submit('#login-form');
  await browser.settle();

  browser.document.querySelector('#second-factor-form input[name="code"]').value = '000000';
  await browser.submit('#second-factor-form');
  await browser.settle();

  assert.match(browser.html(), /That code is not right/);
  // The challenge was spent by the attempt, so another code into this form
  // cannot work. The message has to send them back rather than let them keep
  // typing.
  assert.match(browser.html(), /Start again/);
  assert.equal(browser.present('#second-factor-form'), true);
});

test('a recovery code used at sign-in says how many are left', async (t) => {
  const browser = await signInPage(t, {
    '/api/auth/login': { body: { twoFactorRequired: true, challenge: 'chal-123' } },
    '/api/auth/two-factor': { body: { user: { id: 'usr_1' }, usedRecoveryCode: true, recoveryCodesRemaining: 2 } },
  });
  browser.document.querySelector('#login-form input[name="email"]').value = 'a@b.com';
  browser.document.querySelector('#login-form input[name="password"]').value = 'pw';
  await browser.submit('#login-form');
  await browser.settle();
  browser.document.querySelector('#second-factor-form input[name="code"]').value = 'ABCDE-FGHJK';
  await browser.submit('#second-factor-form');
  await browser.settle();

  // The one occasion somebody is certainly paying attention.
  assert.match(browser.html(), /2 left/);
});

test('an account without a second factor signs in the way it always did', async (t) => {
  const browser = await signInPage(t, {
    '/api/auth/login': { body: { user: { id: 'usr_1', email: 'a@b.com' } } },
  });
  browser.document.querySelector('#login-form input[name="email"]').value = 'a@b.com';
  browser.document.querySelector('#login-form input[name="password"]').value = 'pw';
  await browser.submit('#login-form');
  await browser.settle();

  assert.equal(browser.present('#second-factor-form'), false);
});

/* --------------------------------------------------------------- the panel */

test('an account without it is offered it', async (t) => {
  const browser = await settings(t, { routes: OFF });
  assert.equal(browser.present('#kg-2fa-panel'), true);
  assert.equal(browser.present('#kg-2fa-start'), true);
});

test('an account with it sees how many recovery codes are left', async (t) => {
  const browser = await settings(t, { routes: ON });
  assert.match(browser.html(), /7 recovery codes left/);
  assert.equal(browser.present('#kg-2fa-disable'), true);
});

test('running low is said loudly, because running out is losing the way back', async () => {
  const low = statusPanelHtml({ enabled: true, recoveryCodesRemaining: 1 });
  assert.match(low, /1 recovery code left/);
  assert.match(low, /Generate a new set/);

  const fine = statusPanelHtml({ enabled: true, recoveryCodesRemaining: 8 });
  assert.ok(!fine.includes('Generate a new set'));
});

test('enrolment shows the key and the codes before anything is switched on', async (t) => {
  const browser = await settings(t, {
    routes: {
      ...OFF,
      '/api/account/two-factor/start': {
        body: {
          secret: 'ABCDEFGHIJKLMNOP',
          otpauthUri: 'otpauth://totp/KukGit:a@b.com?secret=ABCDEFGHIJKLMNOP',
          recoveryCodes: ['AAAAA-BBBBB', 'CCCCC-DDDDD'],
        },
      },
    },
  });

  browser.document.querySelector('#kg-2fa-start input[name="password"]').value = 'pw';
  await browser.submit('#kg-2fa-start');
  await browser.settle();

  assert.match(browser.html(), /ABCD EFGH IJKL MNOP/);
  assert.match(browser.html(), /AAAAA-BBBBB/);
  assert.match(browser.html(), /shown once and never again/);
  // Not on yet. The code in step 3 is what proves the app has the right secret
  // and that the phone's clock agrees.
  assert.equal(browser.present('#kg-2fa-confirm'), true);
});

test('the setup key is grouped, because a run of thirty-two characters gets mistyped', async () => {
  assert.equal(groupSecret('ABCDEFGHIJKLMNOP'), 'ABCD EFGH IJKL MNOP');
  assert.equal(groupSecret('ABCDE'), 'ABCD E');
});

test('a wrong confirmation code leaves the codes on screen', async (t) => {
  const browser = await settings(t, {
    routes: {
      ...OFF,
      '/api/account/two-factor/start': { body: { secret: 'ABCDEFGH', recoveryCodes: ['AAAAA-BBBBB'] } },
      '/api/account/two-factor/confirm': { status: 400, body: { error: { code: 'TWO_FACTOR_CODE_INVALID', message: 'That code is not right.' } } },
    },
  });
  browser.document.querySelector('#kg-2fa-start input[name="password"]').value = 'pw';
  await browser.submit('#kg-2fa-start');
  await browser.settle();
  browser.document.querySelector('#kg-2fa-confirm input[name="code"]').value = '000000';
  await browser.submit('#kg-2fa-confirm');
  await browser.settle();

  // The codes are shown once. Clearing the screen on a mistyped code would
  // take them away from somebody who has not written them down yet.
  assert.match(browser.html(), /AAAAA-BBBBB/);
  assert.match(browser.html(), /not right/);
});

test('turning it off is refused loudly rather than silently', async (t) => {
  const browser = await settings(t, {
    routes: {
      ...ON,
      '/api/account/two-factor/disable': { status: 401, body: { error: { code: 'TWO_FACTOR_CODE_INVALID', message: 'That code is not right.' } } },
    },
  });
  browser.document.querySelector('#kg-2fa-manage input[name="code"]').value = '000000';
  browser.document.querySelector('#kg-2fa-disable').dispatchEvent({ type: 'click' });
  await browser.settle();

  assert.equal(browser.present('#kg-2fa-panel'), true);
  assert.match(browser.html(), /not right/);
});

test('no panel where Kuklabs Account owns the passwords', async (t) => {
  const browser = await settings(t, { routes: { '/api/account/two-factor': { status: 404, body: {} } } });
  // A second factor on top of a password KukGit does not hold is not a second
  // factor, and a control that can never work reads as broken.
  assert.equal(browser.present('#kg-2fa-panel'), false);
});

test('the panel stays off every page except settings, and costs nothing there', async (t) => {
  const browser = await settings(t, { hash: '#/repo/kuklabs/kukgit', routes: ON });
  assert.equal(browser.present('#kg-2fa-panel'), false);
  assert.equal(browser.countPath('/api/account/two-factor'), 0);
});

test('the panel is added once, not once per render', async (t) => {
  const browser = await settings(t, { routes: ON });
  browser.document.querySelector('.content').innerHTML += '<p>something else rendered</p>';
  await browser.settle();
  assert.equal(browser.document.querySelectorAll('#kg-2fa-panel').length, 1);
  assert.equal(browser.countPath('/api/account/two-factor'), 1);
});

test('recovery codes from the server are escaped before they go on the page', async () => {
  const html = statusPanelHtml({ enabled: true, recoveryCodesRemaining: '<img src=x onerror=alert(1)>' });
  assert.ok(!html.includes('<img src=x'));
});

test('what the server calls a recovery code is escaped before it goes on the page', async (t) => {
  const browser = await settings(t, {
    routes: {
      ...OFF,
      '/api/account/two-factor/start': {
        body: { secret: 'ABCDEFGH', recoveryCodes: ['<img src=x onerror=alert(1)>', 'AAAAA-BBBBB'] },
      },
    },
  });
  browser.document.querySelector('#kg-2fa-start input[name="password"]').value = 'pw';
  await browser.submit('#kg-2fa-start');
  await browser.settle();

  // Generated server-side from a fixed alphabet today, so this is not
  // reachable — and it is the value most likely to gain a path that is not.
  assert.ok(!browser.html().includes('<img src=x'));
  assert.match(browser.html(), /&lt;img/);
  assert.match(browser.html(), /AAAAA-BBBBB/);
});
