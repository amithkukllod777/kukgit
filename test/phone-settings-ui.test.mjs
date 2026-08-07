import test from 'node:test';
import assert from 'node:assert/strict';
import { importFresh, installBrowser } from '../test-support/browser.mjs';
import { phonePanelHtml } from '../public/phone-settings-ui.js';

/**
 * The phone panel on account settings.
 *
 * It links to `/account/phone` and never loads Firebase itself — which is the
 * point, because the application's Content-Security-Policy stays strict and
 * only that one separate document is allowed to reach Google.
 */

const SHELL = '<div class="app-shell"><div class="content"><section class="card">settings</section></div></div>';
const OFFERED = { '/api/account/phone/config': { body: { projectId: 'kukchat-b6402', apiKey: 'AIza', authDomain: 'x.firebaseapp.com', sdkVersion: '10.12.5' } } };

function page(t, { hash = '#/settings', routes = {}, html = SHELL } = {}) {
  const browser = installBrowser({
    hash,
    html: `<div id="app">${html}</div><div id="toast-root"></div>`,
    routes: { '/api/auth/identities': { body: { identities: [] } }, '*': { status: 404, body: {} }, ...routes },
  });
  t.after(() => browser.restore());
  return browser;
}

async function settings(t, options) {
  const browser = page(t, options);
  await importFresh('../public/phone-settings-ui.js');
  await browser.settle();
  return browser;
}

test('an account with no number is offered one', async (t) => {
  const browser = await settings(t, { routes: OFFERED });
  assert.equal(browser.present('#kg-phone-panel'), true);
  assert.equal(browser.document.querySelector('#kg-phone-panel a').getAttribute('href'), '/account/phone');
});

test('a verified number is shown, with a way to change or remove it', async (t) => {
  const browser = await settings(t, {
    routes: {
      ...OFFERED,
      '/api/auth/identities': { body: { identities: [{ provider: 'phone', providerLogin: '+919999900000', linkedAt: '2026-08-07' }] } },
    },
  });
  assert.match(browser.html(), /\+919999900000/);
  assert.equal(browser.present('#kg-phone-remove'), true);
});

test('an instance without Firebase shows no panel at all', async (t) => {
  const browser = await settings(t, { routes: { '/api/account/phone/config': { status: 404, body: {} } } });
  // A greyed-out control that can never work reads as broken rather than as
  // not offered.
  assert.equal(browser.present('#kg-phone-panel'), false);
});

test('the panel stays off every page except settings', async (t) => {
  const browser = await settings(t, { hash: '#/repo/kuklabs/kukgit', routes: OFFERED });
  assert.equal(browser.present('#kg-phone-panel'), false);
});

test('the panel is added once, not once per render', async (t) => {
  const browser = await settings(t, { routes: OFFERED });
  browser.document.querySelector('.content').innerHTML += '<p>something else rendered</p>';
  await browser.settle();
  assert.equal(browser.document.querySelectorAll('#kg-phone-panel').length, 1);
});

test('this panel never loads Firebase — that is what the separate page is for', async (t) => {
  const browser = await settings(t, { routes: OFFERED });
  const html = browser.html();
  assert.ok(!html.includes('gstatic'), 'no Firebase SDK inside the application');
  assert.ok(!/<script/i.test(html), 'the panel adds no script at all');
});

test('a number that came back from the server is escaped', async (t) => {
  const html = phonePanelHtml({ number: '"><img src=x onerror=alert(1)>' });
  assert.ok(!html.includes('<img src=x'));
  assert.match(html, /&lt;img|&quot;&gt;/);
});

test('removing says why when it is refused', async (t) => {
  const browser = await settings(t, {
    routes: {
      ...OFFERED,
      '/api/auth/identities': { body: { identities: [{ provider: 'phone', providerLogin: '+919999900000' }] } },
      '/api/account/phone/remove': {
        status: 409,
        body: { error: { code: 'IDENTITY_LAST_METHOD', message: 'This is the only way into this account.' } },
      },
    },
  });

  browser.document.querySelector('#kg-phone-remove').dispatchEvent({ type: 'click' });
  await browser.settle();

  // The panel stays: nothing was removed, and the message says what to do
  // first.
  assert.equal(browser.present('#kg-phone-panel'), true);
  assert.match(browser.html(), /only way into this account/);
});

test('after removing, what the panel shows is read back from the server', async (t) => {
  const browser = await settings(t, {
    routes: {
      ...OFFERED,
      '/api/auth/identities': { body: { identities: [{ provider: 'phone', providerLogin: '+919999900000' }] } },
      '/api/account/phone/remove': { body: { removed: true } },
    },
  });
  const before = browser.countPath('/api/auth/identities');

  browser.document.querySelector('#kg-phone-remove').dispatchEvent({ type: 'click' });
  await browser.settle();

  assert.equal(browser.countPath('/api/account/phone/remove'), 1);
  // The panel is not redrawn from what this file hoped happened. It asks
  // again — so a removal the server did not actually make does not leave a
  // screen saying the number is gone.
  assert.ok(browser.countPath('/api/auth/identities') > before, 'the panel re-reads the account');
  assert.ok(!browser.html().includes('Not removed'), 'no error was reported');
});

test('a page that is not settings costs no requests at all', async (t) => {
  const browser = await settings(t, { hash: '#/repo/kuklabs/kukgit', routes: OFFERED });
  // Not merely "no panel". Asking whether phone verification is configured on
  // every repository page anybody opens is a request per page view for an
  // answer that changes at deploy time.
  assert.equal(browser.countPath('/api/account/phone/config'), 0);
  assert.equal(browser.countPath('/api/auth/identities'), 0);
});

test('a re-render costs no further requests either', async (t) => {
  const browser = await settings(t, { routes: OFFERED });
  const asked = browser.countPath('/api/account/phone/config');

  browser.document.querySelector('.content').innerHTML += '<p>something else rendered</p>';
  await browser.settle();
  browser.document.querySelector('.content').innerHTML += '<p>and again</p>';
  await browser.settle();

  // The observer fires on every write anywhere in the app, including this
  // file's own. Without the guard the panel is correct and the network is not.
  assert.equal(browser.countPath('/api/account/phone/config'), asked);
});

test('the phone identity is picked out by provider, not by being first', async (t) => {
  const browser = await settings(t, {
    routes: {
      ...OFFERED,
      '/api/auth/identities': {
        body: {
          identities: [
            { provider: 'github', providerLogin: 'octocat', linkedAt: '2026-01-01' },
            { provider: 'phone', providerLogin: '+919999900000', linkedAt: '2026-08-07' },
          ],
        },
      },
    },
  });

  assert.match(browser.html(), /\+919999900000/);
  // A GitHub login rendered as somebody's phone number is a small bug with a
  // very confusing screen.
  assert.ok(!browser.html().includes('octocat'));
});

test('the panel is mounted once even while its own requests are in flight', async (t) => {
  const browser = await settings(t, { routes: OFFERED });
  // Two churns inside one settle: the second observer round starts before the
  // first has finished asking, so the guard has to hold across the awaits and
  // not only after them.
  browser.document.querySelector('.content').innerHTML += '<p>one</p>';
  browser.document.querySelector('.content').innerHTML += '<p>two</p>';
  await browser.settle();

  assert.equal(browser.document.querySelectorAll('#kg-phone-panel').length, 1);
  assert.equal(browser.countPath('/api/auth/identities'), 1);
});
