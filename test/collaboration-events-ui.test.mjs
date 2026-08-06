import test from 'node:test';
import assert from 'node:assert/strict';
import { installBrowser, importFresh } from '../test-support/browser.mjs';

/**
 * Copying an invitation link.
 *
 * The link is shown once and never again, so the copy button is the only way
 * most people will ever get it off the screen. It is delegated from the
 * document rather than bound to the button, because the panel it lives in is
 * re-rendered by another module — a listener bound to the button would stop
 * working the moment that happened, silently.
 */

const LINK = 'https://git.kuklabs.com/invite/kgi_LiveTokenNobodyMaySeeTwice';

function page(t, { html } = {}) {
  const browser = installBrowser({
    hash: '#/organizations',
    html: html ?? `<div id="app"><div class="app-shell"><main class="content">
      <code id="kg-invitation-url">${LINK}</code>
      <button id="kg-copy-invitation">Copy invitation link</button>
    </main></div></div><div id="toast-root"></div>`,
    routes: { '*': { status: 404, body: {} } },
  });
  t.after(() => browser.restore());
  return browser;
}

test('clicking copy puts the link on the clipboard and says so', async (t) => {
  const browser = page(t);
  await importFresh('../public/collaboration-events.js');
  browser.document.querySelector('#kg-copy-invitation').click();
  await browser.settle();

  assert.deepEqual(browser.clipboard, [LINK]);
  // Silent success on a one-time secret leaves somebody unsure whether they
  // have it, and the only way to check is to lose it.
  assert.match(browser.html(), /Invitation copied/);
});

test('a button rendered after the listener was installed still works', async (t) => {
  const browser = page(t, {
    html: '<div id="app"><div class="app-shell"><main class="content"></main></div></div><div id="toast-root"></div>',
  });
  await importFresh('../public/collaboration-events.js');
  // The panel this button lives in is rendered by a different module, after
  // this one has loaded. A listener bound to the button itself would never
  // exist, and the button would do nothing with no error anywhere.
  browser.document.querySelector('.content').insertAdjacentHTML('beforeend',
    `<code id="kg-invitation-url">${LINK}</code><button id="kg-copy-invitation">Copy</button>`);
  await browser.settle();

  browser.document.querySelector('#kg-copy-invitation').click();
  await browser.settle();
  assert.deepEqual(browser.clipboard, [LINK]);
});

test('clicking anything else copies nothing', async (t) => {
  const browser = page(t);
  await importFresh('../public/collaboration-events.js');
  browser.document.querySelector('.content').insertAdjacentHTML('beforeend', '<button id="something-else">Other</button>');
  await browser.settle();
  browser.document.querySelector('#something-else').click();
  await browser.settle();

  assert.deepEqual(browser.clipboard, []);
  assert.equal(browser.html().includes('Invitation copied'), false);
});

test('with no link on the page, nothing is copied and nothing is claimed', async (t) => {
  const browser = page(t, {
    html: '<div id="app"><div class="app-shell"><main class="content"><button id="kg-copy-invitation">Copy</button></main></div></div><div id="toast-root"></div>',
  });
  await importFresh('../public/collaboration-events.js');
  browser.document.querySelector('#kg-copy-invitation').click();
  await browser.settle();

  // "Copied" when nothing was copied is the worst outcome for a secret shown
  // once: somebody navigates away believing they have it.
  assert.deepEqual(browser.clipboard, []);
  assert.equal(browser.html().includes('Invitation copied'), false);
});
