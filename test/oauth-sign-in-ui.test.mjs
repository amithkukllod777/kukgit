import test from 'node:test';
import assert from 'node:assert/strict';
import { importFresh, installBrowser } from '../test-support/browser.mjs';
import { failureBoxHtml, oauthFailureFromHash, providerButtonHtml } from '../public/oauth-sign-in-ui.js';

/**
 * The provider buttons on the sign-in screen.
 *
 * Two things are being tested, and both are about the sign-in page being the
 * one page that has to keep working.
 *
 * **It adds itself to the form; it does not replace it.** If the provider list
 * cannot be fetched, or the instance offers no providers, the password form is
 * still there and people can still sign in.
 *
 * **Nothing out of the URL reaches the page.** The failure code arrives in the
 * fragment, which is something anybody can put in a link they send you. It
 * picks a message from a fixed table — a page that echoed the value would be a
 * way to write text of somebody else's choosing onto our own sign-in screen,
 * which is most of what a phishing page needs.
 */

const LOGIN_FORM = '<form class="login-card" id="login-form"><input name="email" /><input type="password" name="password" /><button type="submit">Sign in</button></form>';

function page(t, { hash = '#/', routes = {}, html = LOGIN_FORM } = {}) {
  const browser = installBrowser({
    hash,
    html: `<div id="app">${html}</div><div id="toast-root"></div>`,
    routes: { '/api/auth/providers': { body: { providers: [] } }, '*': { status: 404, body: {} }, ...routes },
  });
  t.after(() => browser.restore());
  return browser;
}

const BOTH = { '/api/auth/providers': { body: { providers: [{ id: 'github', label: 'GitHub' }, { id: 'google', label: 'Google' }] } } };

/* ------------------------------------------------------------- the buttons */

test('a button appears for each provider the server says it has', async (t) => {
  const browser = page(t, { routes: BOTH });
  await importFresh('../public/oauth-sign-in-ui.js');
  await browser.settle();

  const links = browser.document.querySelectorAll('.kg-oauth-btn');
  assert.equal(links.length, 2);
  // A plain link, so the browser performs a top-level navigation. Doing the
  // flow with `fetch` would follow the redirects invisibly and land the person
  // nowhere at all.
  assert.equal(links[0].getAttribute('href'), '/api/auth/github/start');
  assert.equal(links[1].getAttribute('href'), '/api/auth/google/start');
  assert.match(browser.html(), /Continue with GitHub/);
});

test('an instance with no providers configured shows a working password form and nothing else', async (t) => {
  const browser = page(t);
  await importFresh('../public/oauth-sign-in-ui.js');
  await browser.settle();

  assert.equal(browser.present('.kg-oauth-btn'), false);
  // And no "or" either. A divider with nothing above it is a sign-in page that
  // looks like it failed to load half of itself.
  assert.equal(browser.present('.kg-oauth-divider'), false);
  // A button leading to GitHub with an empty client id produces an error page
  // on GitHub's domain, which reads as "KukGit is broken".
  assert.equal(browser.present('#login-form'), true);
});

test('a provider the server names but this build does not know gets no button', async (t) => {
  const browser = page(t, {
    routes: { '/api/auth/providers': { body: { providers: [{ id: 'evilcorp', label: '<img src=x onerror=alert(1)>' }] } } },
  });
  await importFresh('../public/oauth-sign-in-ui.js');
  await browser.settle();

  assert.equal(browser.present('.kg-oauth-btn'), false);
  assert.ok(!browser.html().includes('onerror'));
});

test('when the provider list cannot be fetched the form is untouched', async (t) => {
  const browser = page(t, { routes: { '/api/auth/providers': { status: 404, body: {} } } });
  await importFresh('../public/oauth-sign-in-ui.js');
  await browser.settle();

  // 404 is the honest answer where Kuklabs Account owns the sessions. No
  // buttons, and no error on screen — there is nothing wrong.
  assert.equal(browser.present('.kg-oauth-btn'), false);
  assert.equal(browser.present('.kg-oauth-error'), false);
  assert.equal(browser.present('#login-form'), true);
});

test('the buttons are added once, not once per render', async (t) => {
  const browser = page(t, { routes: BOTH });
  await importFresh('../public/oauth-sign-in-ui.js');
  await browser.settle();

  // The app re-renders on navigation and a `MutationObserver` is watching.
  browser.document.querySelector('#app').innerHTML += '<p>something else rendered</p>';
  await browser.settle();

  assert.equal(browser.document.querySelectorAll('.kg-oauth-btn').length, 2);
});

/* ------------------------------------------------------------- the failure */

test('a failure code becomes a message from a fixed table', async (t) => {
  const browser = page(t, { hash: '#/sign-in?error=email_conflict&provider=github', routes: BOTH });
  await importFresh('../public/oauth-sign-in-ui.js');
  await browser.settle();

  const box = browser.document.querySelector('.kg-oauth-error');
  assert.ok(box, 'the failure is shown');
  assert.match(box.innerHTML, /already uses that email address/);
  assert.match(box.innerHTML, /GitHub/);
});

test('a code nobody recognises is reported as our problem, not echoed', async (t) => {
  // The fragment is something anybody can put in a link they send you.
  const failure = oauthFailureFromHash('#/sign-in?error=%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E&provider=github');
  assert.equal(failure.message, 'Something went wrong on our side. Try again, and tell us if it keeps happening.');
  assert.ok(!failure.message.includes('img'));
});

test('a provider name from the URL is not put on the page either', async (t) => {
  const failure = oauthFailureFromHash('#/sign-in?error=state_invalid&provider=%3Cscript%3E');
  // Only a provider this build knows about produces a label, and the label is
  // this build's own text rather than the value from the URL.
  assert.equal(failure.label, null);

  assert.equal(oauthFailureFromHash('#/sign-in?error=state_invalid&provider=google').label, 'Google');
});

test('a page with no error in the fragment shows no error', async (t) => {
  assert.equal(oauthFailureFromHash('#/'), null);
  assert.equal(oauthFailureFromHash('#/sign-in'), null);
  assert.equal(oauthFailureFromHash('#/sign-in?provider=github'), null);
});

test('the error box does not appear on a page that has no sign-in form', async (t) => {
  const browser = page(t, { hash: '#/sign-in?error=state_invalid', routes: BOTH, html: '<div class="app-shell">signed in</div>' });
  await importFresh('../public/oauth-sign-in-ui.js');
  await browser.settle();

  // Somebody already signed in, following a stale link. Telling them a sign-in
  // failed would be false, and there is nothing for them to do about it.
  assert.equal(browser.present('.kg-oauth-error'), false);
});

test('the icons are inline, so opening the page tells no provider anything', async (t) => {
  const browser = page(t, { routes: BOTH });
  await importFresh('../public/oauth-sign-in-ui.js');
  await browser.settle();

  const html = browser.html();
  assert.match(html, /<svg/);
  // A sign-in page that fetches an icon from GitHub tells GitHub about every
  // person who opens it, signed in or not.
  assert.ok(!/<img[^>]+src="https?:/.test(html));
});

/* ------------------------------------------------------------- escaping */

test('the failure box escapes what it is given, whatever it is given', async () => {
  // Every value reaching it today comes from a table in this file and none of
  // them contain a metacharacter. This is the check that stops that from being
  // load-bearing the day a message gains a customer's address in it.
  const html = failureBoxHtml({ label: '<img src=x onerror=alert(1)>', message: '"><script>alert(2)</script>' });
  assert.ok(!html.includes('<img'));
  assert.ok(!html.includes('<script'));
  assert.match(html, /&lt;img/);
  assert.equal(failureBoxHtml(null), '');
});

test('a button escapes its label and its id', async () => {
  assert.equal(providerButtonHtml('<script>'), '');
  assert.equal(providerButtonHtml(undefined), '');
  const html = providerButtonHtml('github');
  assert.match(html, /href="\/api\/auth\/github\/start"/);
  assert.match(html, /Continue with GitHub/);
});

test('an error response carrying a provider list is still an error response', async (t) => {
  // A 500 whose body happens to parse as JSON with a `providers` array — a
  // proxy error page, a misrouted handler. The status is what decides.
  const browser = page(t, {
    routes: { '/api/auth/providers': { status: 500, body: { providers: [{ id: 'github', label: 'GitHub' }] } } },
  });
  await importFresh('../public/oauth-sign-in-ui.js');
  await browser.settle();

  assert.equal(browser.present('.kg-oauth-btn'), false);
  assert.equal(browser.present('#login-form'), true);
});
