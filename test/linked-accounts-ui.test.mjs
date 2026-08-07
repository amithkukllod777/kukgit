import test from 'node:test';
import assert from 'node:assert/strict';
import { importFresh, installBrowser } from '../test-support/browser.mjs';
import { identityRowHtml, linkedWhen, panelHtml } from '../public/linked-accounts-ui.js';

/**
 * The settings panel that makes an existing instruction followable.
 *
 * Somebody whose address already has a KukGit account, pressing "Continue with
 * Google", is sent back to the sign-in page with: *sign in with your password,
 * then link this provider from account settings.* There was no such thing in
 * account settings. The routes existed — `/api/auth/identities`, the unlink,
 * and a `start` that links rather than signs in when there is a session — and
 * the only way to reach them was to type a URL.
 *
 * Two properties carry most of the weight here.
 *
 * **Connecting is a navigation.** The flow is redirects all the way through;
 * `fetch` would follow them invisibly and land nobody anywhere. So the control
 * is an `<a>`, and a test that only checked "something happened when I clicked"
 * would pass on a version that is broken in a browser.
 *
 * **Disconnecting can lock somebody out.** An account made by a provider has no
 * usable password, so removing its only provider is permanent. The server
 * refuses it; this screen has to say so rather than swallow it.
 */

const PROVIDERS = { '/api/auth/providers': { body: { providers: [{ id: 'github' }, { id: 'google' }] } } };

const LINKED_GITHUB = {
  provider: 'github',
  providerLogin: 'amithkukllod777',
  email: 'amithkukllod@gmail.com',
  linkedAt: '2026-08-01T10:00:00.000Z',
};

function page(t, { hash = '#/settings', identities = [], routes = {} } = {}) {
  const browser = installBrowser({
    hash,
    html: '<div id="app"><div class="app-shell"><div class="content"></div></div></div><div id="toast-root"></div>',
    routes: {
      ...PROVIDERS,
      '/api/auth/identities': { body: { identities } },
      '*': { status: 404, body: {} },
      ...routes,
    },
  });
  t.after(() => browser.restore());
  return browser;
}

async function panel(t, options) {
  const browser = page(t, options);
  await importFresh('../public/linked-accounts-ui.js');
  await browser.settle();
  return browser;
}

/* ------------------------------------------------------------- the markup */

test('a linked provider shows who it is linked to; an unlinked one offers to connect', () => {
  const linked = identityRowHtml('github', LINKED_GITHUB);
  assert.match(linked, /amithkukllod777/);
  assert.match(linked, /data-unlink="github"/);

  const free = identityRowHtml('google', null);
  assert.match(free, /Not connected/);
  // A plain link, not a button. The whole flow is redirects.
  assert.match(free, /<a class="btn" href="\/api\/auth\/google\/start\?redirect_to=%23%2Fsettings"/);
  assert.ok(!free.includes('data-unlink'), 'nothing to disconnect');
});

test('what the provider said about somebody is escaped', () => {
  const row = identityRowHtml('github', { ...LINKED_GITHUB, providerLogin: '<img src=x onerror=alert(1)>' });
  assert.ok(!row.includes('<img'), 'the login is text, not markup');
  assert.match(row, /&lt;img/);
});

test('a date reads as a length of time, not a timestamp', () => {
  const now = new Date('2026-08-08T00:00:00.000Z');
  assert.equal(linkedWhen('2026-08-08T09:00:00.000Z', now), '', 'the future is not a length of time');
  assert.equal(linkedWhen('2026-08-07T23:00:00.000Z', now), 'today');
  assert.equal(linkedWhen('2026-08-06T20:00:00.000Z', now), 'yesterday');
  assert.equal(linkedWhen('2026-07-30T00:00:00.000Z', now), '9 days ago');
  // Past a month it stops being useful as a relative phrase.
  assert.equal(linkedWhen('2026-01-04T00:00:00.000Z', now), '2026-01-04');
  assert.equal(linkedWhen(undefined, now), '');
  assert.equal(linkedWhen('not a date', now), '');
});

test('every provider the instance offers gets a row, linked or not', () => {
  const html = panelHtml([{ id: 'github' }, { id: 'google' }], [LINKED_GITHUB]);
  assert.match(html, /data-unlink="github"/);
  assert.match(html, /\/api\/auth\/google\/start/);
  assert.ok(!html.includes('/api/auth/github/start'), 'an already-linked provider is not offered again');
});

/* -------------------------------------------------------------- on a page */

test('the panel appears in settings, with both providers', async (t) => {
  const browser = await panel(t, { identities: [LINKED_GITHUB] });
  assert.equal(browser.present('#kg-identities-panel'), true);
  assert.match(browser.html(), /Linked accounts/);
  assert.equal(browser.document.querySelectorAll('.kg-identity').length, 2);
});

test('and nowhere else', async (t) => {
  const browser = await panel(t, { hash: '#/repositories' });
  assert.equal(browser.present('#kg-identities-panel'), false);
  // Nor does it ask, which is what makes it free on every other page.
  assert.equal(browser.countPath('/api/auth/identities'), 0);
});

test('no providers, no panel — and nothing said about it', async (t) => {
  // An instance where Kuklabs Account owns the sessions answers 404 here.
  const browser = await panel(t, { routes: { '/api/auth/providers': { status: 404, body: {} } } });
  assert.equal(browser.present('#kg-identities-panel'), false);
  assert.equal(browser.document.querySelectorAll('.toast').length, 0, 'a missing feature is not an error');
});

test('signed out, there is nothing to draw and no complaint', async (t) => {
  const browser = await panel(t, {
    routes: { '/api/auth/identities': { status: 401, body: { error: { code: 'AUTH_REQUIRED', message: 'Sign in required.' } } } },
  });
  assert.equal(browser.present('#kg-identities-panel'), false);
  assert.equal(browser.document.querySelectorAll('.toast').length, 0);
});

test('disconnecting sends a DELETE for that provider and redraws from the server', async (t) => {
  let identities = [LINKED_GITHUB];
  const browser = page(t, {
    identities,
    routes: {
      '/api/auth/identities': () => ({ body: { identities } }),
      'DELETE /api/auth/identities/github': () => { identities = []; return { body: { removed: true } }; },
    },
  });
  await importFresh('../public/linked-accounts-ui.js');
  await browser.settle();

  browser.document.querySelector('[data-unlink="github"]').click();
  await browser.settle();

  assert.ok(browser.requests().includes('DELETE /api/auth/identities/github'));
  // Redrawn rather than patched: what is on screen is what is stored, which
  // also covers the row having gone in another tab.
  assert.equal(browser.present('[data-unlink="github"]'), false);
  assert.match(browser.html(), /\/api\/auth\/github\/start/, 'and it now offers to connect again');
});

test('the last way into an account is refused, and the refusal is what is shown', async (t) => {
  const browser = page(t, {
    identities: [LINKED_GITHUB],
    routes: {
      'DELETE /api/auth/identities/github': {
        status: 409,
        body: { error: { code: 'IDENTITY_LAST_METHOD', message: 'This is the only way into this account. Set a password first, or link another provider.' } },
      },
    },
  });
  await importFresh('../public/linked-accounts-ui.js');
  await browser.settle();

  browser.document.querySelector('[data-unlink="github"]').click();
  await browser.settle();

  // An account made by a provider has no usable password, so this refusal is
  // the difference between a settings page and a locked-out customer.
  assert.match(browser.html(), /only way into this account/);
  assert.equal(browser.present('[data-unlink="github"]'), true, 'the row stays');
  assert.equal(browser.document.querySelector('[data-unlink="github"]').disabled, false, 'and can be tried again');
});

test('one panel, and one pair of requests, however often the page redraws', async (t) => {
  const browser = await panel(t, { identities: [LINKED_GITHUB] });
  for (let round = 0; round < 3; round += 1) {
    browser.document.querySelector('.content').insertAdjacentHTML('afterbegin', '<p>something else rendered</p>');
    await browser.settle();
  }

  assert.equal(browser.document.querySelectorAll('#kg-identities-panel').length, 1);
  assert.equal(browser.countPath('/api/auth/providers'), 1);
  assert.equal(browser.countPath('/api/auth/identities'), 1);
  assert.equal(browser.looped, false);
});

test('leaving settings takes the panel with it, and coming back brings it once', async (t) => {
  const browser = await panel(t, { identities: [LINKED_GITHUB] });
  browser.navigate('#/repositories');
  browser.document.querySelector('.content').innerHTML = '<p>another page</p>';
  await browser.settle();
  assert.equal(browser.present('#kg-identities-panel'), false);

  browser.navigate('#/settings');
  await browser.settle();
  assert.equal(browser.document.querySelectorAll('#kg-identities-panel').length, 1);
  // The provider list is a deployment fact and stays cached; who is linked is
  // not, and is read again.
  assert.equal(browser.countPath('/api/auth/providers'), 1);
  assert.equal(browser.countPath('/api/auth/identities'), 2);
});
