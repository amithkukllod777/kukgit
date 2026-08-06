import test from 'node:test';
import assert from 'node:assert/strict';
import { installBrowser, importFresh } from '../test-support/browser.mjs';
import { hardenAuthKitLoginCard } from '../public/authkit-form-hardening.js';

/**
 * Taking the form element off the AuthKit sign-in card.
 *
 * When identity is delegated, the card holds a link to One Kuklabs Account and
 * no credential fields at all. Leaving it as a `<form>` invites a browser or a
 * password manager to treat it as one — to offer autofill, to submit on Enter,
 * and to post to whatever the page's action resolves to. None of that is
 * wanted for a card whose only job is to send somebody somewhere else.
 */

function page(t, html) {
  const browser = installBrowser({
    hash: '#/',
    html: `<div id="app">${html}</div><div id="toast-root"></div>`,
    routes: { '*': { status: 404, body: {} } },
  });
  t.after(() => browser.restore());
  return browser;
}

test('an AuthKit card that is a form becomes a section', async (t) => {
  const browser = page(t, '<form class="login-card kg-authkit" data-authkit="true"><h2>Sign in</h2><a href="/authkit">Continue</a></form>');

  const result = hardenAuthKitLoginCard(browser.document);

  assert.equal(String(result.tagName).toUpperCase(), 'SECTION');
  assert.equal(browser.present('form.login-card'), false);
  // A card with no credential fields is not a form, and a browser that thinks
  // it is will offer to fill it in.
  assert.equal(browser.document.querySelectorAll('form').length, 0);
});

test('everything inside the card survives the swap', async (t) => {
  const browser = page(t, '<form class="login-card" data-authkit="true"><h2>One Kuklabs Account</h2><p>Continue to sign in.</p><a href="/authkit/start" id="kg-authkit-go">Continue</a></form>');

  hardenAuthKitLoginCard(browser.document);

  assert.match(browser.html(), /One Kuklabs Account/);
  assert.match(browser.html(), /Continue to sign in/);
  // The link is the entire point of the card. Losing it in the rewrite would
  // leave a sign-in page nobody can sign in from.
  assert.equal(browser.document.querySelector('#kg-authkit-go')?.getAttribute('href'), '/authkit/start');
});

test('the classes and an accessible name come with it', async (t) => {
  const browser = page(t, '<form class="login-card kg-authkit wide" data-authkit="true"><a href="/x">Go</a></form>');

  const result = hardenAuthKitLoginCard(browser.document);

  assert.equal(result.getAttribute('class'), 'login-card kg-authkit wide');
  // Replacing a form with a bare section removes the landmark a screen reader
  // announced; the label puts one back.
  assert.equal(result.getAttribute('aria-label'), 'One Kuklabs Account');
});

test('the local password form is left exactly as it is', async (t) => {
  const browser = page(t, '<form class="login-card" id="login-form"><input name="email" /><input type="password" name="password" /></form>');

  hardenAuthKitLoginCard(browser.document);

  // This one really is a form, and turning it into a section would break
  // submit-on-Enter and every password manager.
  assert.equal(browser.present('form#login-form'), true);
  assert.equal(browser.document.querySelectorAll('form').length, 1);
});

test('a card that is already a section is left alone', async (t) => {
  const browser = page(t, '<section class="login-card" data-authkit="true"><a href="/x">Go</a></section>');

  const result = hardenAuthKitLoginCard(browser.document);

  // Running twice — which the observer does — must not rebuild the card on
  // every DOM change, or every listener attached inside it is lost each time.
  assert.equal(String(result.tagName).toUpperCase(), 'SECTION');
  assert.equal(browser.document.querySelectorAll('.login-card').length, 1);
});

test('a page with no AuthKit card at all is untouched', async (t) => {
  const browser = page(t, '<div class="content"><p>Nothing here</p></div>');
  assert.equal(hardenAuthKitLoginCard(browser.document), null);
  assert.match(browser.html(), /Nothing here/);
});

test('a card rendered after load is hardened by the observer', async (t) => {
  const browser = page(t, '<div class="content"></div>');
  await importFresh('../public/authkit-form-hardening.js');

  // The sign-in page is rendered by app.js after this module loads, so a
  // one-shot pass at import time would never see the card it exists for.
  browser.document.querySelector('.content').insertAdjacentHTML('beforeend',
    '<form class="login-card" data-authkit="true"><a href="/authkit">Continue</a></form>');
  await browser.settle();

  assert.equal(browser.document.querySelectorAll('form').length, 0);
  assert.equal(browser.present('section.login-card'), true);
});
