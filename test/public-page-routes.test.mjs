import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { importFresh, installBrowser } from '../test-support/browser.mjs';

/**
 * Every module the page actually loads, on one screen, at the same time.
 *
 * Each `public/*.js` file is tested on its own elsewhere, and every one of them
 * passes on its own. What no test held is the thing that only exists when they
 * are all on the page together: **a fragment has one owner.**
 *
 * Two modules both claiming `#/signup` do not fail — they take turns. Each one
 * writes the whole of `#app`; the other's `MutationObserver` fires on that
 * write, finds its own card gone, and writes it back. The page never settles,
 * the form is destroyed and rebuilt continuously, and anything typed into it
 * goes with it. That happened: `signup-ui.js` arrived on the route
 * `account-screens-ui.js` already owned, and both shipped.
 *
 * The assertion below is "the page stops rewriting itself", measured rather
 * than assumed: run the scheduler for a while, note how many mutations have
 * been delivered, run it again, and expect the number not to have moved. A
 * count that is still climbing is a page that never comes to rest.
 */

const here = path.dirname(url.fileURLToPath(import.meta.url));
const PUBLIC = path.join(here, '..', 'public');

/**
 * The modules `index.html` lists, in the order it lists them.
 *
 * Read from the file rather than hard-coded, so a module added tomorrow is
 * covered by this without anybody remembering to add it.
 */
const MODULES = [...fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8')
  .matchAll(/<script type="module" src="\/([^"]+\.js)"><\/script>/g)].map((match) => match[1]);

function world(hash) {
  return installBrowser({
    hash,
    html: '<div id="app"></div><div id="toast-root"></div>',
    routes: {
      // Enough of a signed-out instance for the account screens to have
      // something to draw. Everything else 404s, which is what a module that
      // has nothing to do on this route should be getting anyway.
      'GET /api/account/signup': { body: { available: true } },
      '/api/auth/me': { body: { user: null } },
      '/api/auth/status': { body: { mode: 'local' } },
      '/api/auth/providers': { body: { providers: [{ id: 'github' }, { id: 'google' }] } },
      '/api/auth/sign-in-hints': { body: { demoAccount: null } },
      '*': { status: 404, body: {} },
    },
  });
}

test('it lists modules at all', () => {
  // Guards the regex above. A change to how `index.html` writes these tags
  // would otherwise turn every test below into one that loads nothing and
  // passes.
  assert.ok(MODULES.length > 20, `found ${MODULES.length} modules in index.html`);
  assert.ok(MODULES.includes('app.js'));
  assert.ok(MODULES.includes('account-screens-ui.js'));
});

for (const hash of ['#/signup', '#/forgot-password', '#/']) {
  test(`the page comes to rest on ${hash}, with every module loaded`, async (t) => {
    const browser = world(hash);
    t.after(() => browser.restore());
    for (const name of MODULES) await importFresh(`../public/${name}`);

    await browser.settle(40);
    const settled = browser.mutationDeliveries;
    await browser.settle(40);

    assert.equal(
      browser.mutationDeliveries,
      settled,
      `the page was still rewriting itself after ${settled} mutations — two modules are taking turns on ${hash}`,
    );
    assert.equal(browser.looped, false);
  });
}

test('one card owns the signup screen, not two', async (t) => {
  const browser = world('#/signup');
  t.after(() => browser.restore());
  for (const name of MODULES) await importFresh(`../public/${name}`);
  await browser.settle(40);

  // Counted as takeover containers rather than by card id or class: every one
  // of these screens replaces the page with a single `<main>`, whatever it
  // calls the card inside, so two `<main>`s is two modules regardless of what
  // either of them is named. Class names would not do — the forms reuse the
  // card class for layout, which is how the first version of this assertion
  // reported two screens where there was one.
  const screens = browser.document.querySelectorAll('#app main');
  assert.equal(screens.length, 1, `${screens.length} screens rendered on #/signup`);
  assert.equal(browser.document.querySelectorAll('form[id$="signup-form"]').length, 1);
});

for (const [hash, where] of [['#/', 'the sign-in form'], ['#/signup', 'the signup form']]) {
  test(`the provider buttons reach ${where}`, async (t) => {
    const browser = world(hash);
    t.after(() => browser.restore());
    for (const name of MODULES) await importFresh(`../public/${name}`);
    await browser.settle(40);

    // A signup page offering only a password, on an instance whose sign-in page
    // offers Google, reads as the provider being unavailable rather than as a
    // page that forgot to ask. Two modules have to cooperate for this — one
    // renders the screen, the other owns the buttons — which is why it is
    // tested here rather than against either of them alone.
    for (const provider of ['github', 'google']) {
      assert.equal(
        browser.document.querySelectorAll(`a[href="/api/auth/${provider}/start"]`).length,
        1,
        `${provider} on ${hash}`,
      );
    }
  });
}

test('and one link to it on the sign-in form', async (t) => {
  const browser = world('#/');
  t.after(() => browser.restore());
  for (const name of MODULES) await importFresh(`../public/${name}`);
  await browser.settle(40);

  // Two modules adding their own produced two "Create an account" links side
  // by side — which they did not, only because they happened to share a flag
  // name on the form. That is luck, not a design.
  assert.equal(browser.document.querySelectorAll('a[href="#/signup"]').length, 1);
});
