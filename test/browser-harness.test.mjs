import test from 'node:test';
import assert from 'node:assert/strict';
import { installBrowser, parseFragment } from '../test-support/browser.mjs';

/**
 * The harness, tested before anything is tested with it.
 *
 * A shim that quietly returns the wrong element turns every test written
 * against it into a passing test about nothing, which is worse than having no
 * front-end tests at all. So the parts the UI tests actually lean on — selector
 * matching, the mutation loop, the fetch recorder, the value a `<select>`
 * reports — get their own checks here.
 */

test('the parser keeps attributes, nesting and text', async (t) => {
  const browser = installBrowser();
  t.after(() => browser.restore());
  const [node] = parseFragment('<section class="card" data-org="kuklabs"><b>Hi &amp; bye</b></section>', browser.document);
  assert.equal(node.tagName, 'SECTION');
  assert.equal(node.getAttribute('data-org'), 'kuklabs');
  assert.equal(node.textContent, 'Hi & bye');
  assert.equal(node.children[0].tagName, 'B');
});

test('void and self-closing tags do not swallow what follows them', async (t) => {
  const browser = installBrowser();
  t.after(() => browser.restore());
  const [wrapper] = parseFragment('<div><input name="a" /><br />after</div>', browser.document);
  assert.equal(wrapper.children.length, 2);
  // `<input>` closing itself is exactly what stops "after" being parsed as its
  // child, which would hide it from every `.content > *` style assertion.
  assert.equal(wrapper.textContent, 'after');
});

test('a script or style body is text, not markup', async (t) => {
  const browser = installBrowser();
  t.after(() => browser.restore());
  const [style] = parseFragment('<style>.a{content:"<b>"}</style>', browser.document);
  assert.equal(style.children.length, 0);
  assert.match(style.textContent, /<b>/);
});

test('selectors match the shapes our own code uses', async (t) => {
  const local = installBrowser({
    html: `
      <div class="content">
        <section id="kg-collaboration-panel" data-org="kuklabs"></section>
        <article data-kg-org-card="kuklabs"></article>
        <article data-kg-org-card="other" data-kg-usage="true"></article>
        <form><button type="submit">Go</button></form>
      </div>`,
  });
  t.after(() => local.restore());
  assert.ok(local.document.querySelector('#kg-collaboration-panel[data-org]'));
  assert.equal(local.document.querySelectorAll('[data-kg-org-card]').length, 2);
  // `:not()` is what keeps a panel from being attached to the same card twice.
  assert.equal(local.document.querySelectorAll('[data-kg-org-card]:not([data-kg-usage])').length, 1);
  assert.equal(local.document.querySelector('button[type="submit"]').textContent, 'Go');
  assert.ok(local.document.querySelector('.content form button'));
});

test('a combinator fails loudly rather than matching the wrong thing', async (t) => {
  const browser = installBrowser({ html: '<div><b></b></div>' });
  t.after(() => browser.restore());
  assert.throws(() => browser.document.querySelector('div > b'), /combinator/);
});

test('closest walks up and stops at the first match', async (t) => {
  const browser = installBrowser({ html: '<div data-grant-user="u1"><span><button class="go"></button></span></div>' });
  t.after(() => browser.restore());
  const button = browser.document.querySelector('.go');
  assert.equal(button.closest('[data-grant-user]').dataset.grantUser, 'u1');
  assert.equal(button.closest('[data-missing]'), null);
});

test('a select reports the option the markup marked selected', async (t) => {
  const browser = installBrowser();
  t.after(() => browser.restore());
  const select = browser.document.createElement('select');
  select.innerHTML = '<option value="7">7 days</option><option value="90" selected>90 days</option>';
  // The default a template chose is the value the next request carries, so it
  // has to be readable without a click.
  assert.equal(select.value, '90');
  select.value = '30';
  assert.equal(select.value, '30');
});

test('a form yields its named fields to FormData', async (t) => {
  const browser = installBrowser({
    html: '<form id="f"><input name="name" value="Quarterly review" /><select name="dueInDays"><option value="7">7</option><option value="14" selected>14</option></select></form>',
  });
  t.after(() => browser.restore());
  const body = Object.fromEntries(new FormData(browser.document.querySelector('#f')));
  assert.deepEqual(body, { name: 'Quarterly review', dueInDays: '14' });
});

test('a click bubbles to a listener on an ancestor', async (t) => {
  const browser = installBrowser({ html: '<div id="outer"><button id="inner"></button></div>' });
  t.after(() => browser.restore());
  const seen = [];
  browser.document.querySelector('#outer').addEventListener('click', (event) => seen.push(event.target.id));
  browser.document.querySelector('#inner').click();
  assert.deepEqual(seen, ['inner']);
});

test('fetch records what it was asked, and answers by route', async (t) => {
  const browser = installBrowser({
    routes: {
      'GET /api/a': { body: { ok: true } },
      'POST /api/a': { status: 201, body: { created: true } },
      '*': { status: 404, body: { error: { code: 'NOT_FOUND', message: 'nope' } } },
    },
  });
  t.after(() => browser.restore());
  assert.deepEqual(await (await fetch('/api/a')).json(), { ok: true });
  assert.equal((await fetch('/api/a', { method: 'POST' })).status, 201);
  assert.equal((await fetch('/api/b')).status, 404);
  assert.deepEqual(browser.requests(), ['GET /api/a', 'POST /api/a', 'GET /api/b']);
  assert.equal(browser.countPath('/api/a'), 2);
  assert.deepEqual(browser.busiest(), ['/api/a', 2]);
});

test('a route can answer differently the second time', async (t) => {
  let calls = 0;
  const browser = installBrowser({
    routes: { '/api/status': () => (calls++ === 0 ? { status: 401, body: {} } : { body: { admin: true } }) },
  });
  t.after(() => browser.restore());
  assert.equal((await fetch('/api/status')).status, 401);
  // Signing in mid-test is the only way to prove a 401 was not remembered.
  assert.deepEqual(await (await fetch('/api/status')).json(), { admin: true });
});

test('a mutation observer fires once per batch of changes', async (t) => {
  const browser = installBrowser({ html: '<div id="root"></div>' });
  t.after(() => browser.restore());
  let fired = 0;
  new MutationObserver(() => { fired += 1; }).observe(browser.document.documentElement, { childList: true, subtree: true });
  const root = browser.document.querySelector('#root');
  root.insertAdjacentHTML('beforeend', '<b>1</b>');
  root.insertAdjacentHTML('beforeend', '<b>2</b>');
  await browser.settle(2);
  assert.equal(fired, 1);
  root.insertAdjacentHTML('beforeend', '<b>3</b>');
  await browser.settle(2);
  assert.equal(fired, 2);
});

test('a render loop is reported rather than hanging the run', async (t) => {
  const browser = installBrowser({ html: '<div id="root"></div>' });
  t.after(() => browser.restore());
  const root = browser.document.querySelector('#root');
  // An observer that changes the DOM it observes is the exact shape of the
  // storm. Without the cap this test would never return.
  new MutationObserver(() => root.insertAdjacentHTML('beforeend', '<b>x</b>')).observe(browser.document.documentElement, { childList: true, subtree: true });
  root.insertAdjacentHTML('beforeend', '<b>start</b>');
  await browser.settle(4);
  assert.equal(browser.looped, true);
});

test('navigating fires hashchange with the new hash already set', async (t) => {
  const browser = installBrowser({ hash: '#/' });
  t.after(() => browser.restore());
  const seen = [];
  window.addEventListener('hashchange', () => seen.push(location.hash));
  browser.navigate('#/org/kuklabs');
  assert.deepEqual(seen, ['#/org/kuklabs']);
});

test('reassigning window.fetch changes the bare fetch, as it does in a browser', async (t) => {
  const browser = installBrowser({ routes: { '*': { body: {} } } });
  t.after(() => browser.restore());
  const original = window.fetch.bind(window);
  let wrapped = 0;
  window.fetch = async (input, init) => { wrapped += 1; return original(input, init); };
  await fetch('/api/x');
  // `external-access-reviews-ui.js` wraps fetch this way to append the
  // invitation duration call. If the bare call did not follow, that wrapper
  // would look installed and never run.
  assert.equal(wrapped, 1);
});

test('restore leaves no globals behind', async () => {
  const before = ['document', 'location', 'MutationObserver', 'FormData', 'window', 'Element']
    .map((name) => Object.prototype.hasOwnProperty.call(globalThis, name));
  const browser = installBrowser();
  browser.restore();
  const after = ['document', 'location', 'MutationObserver', 'FormData', 'window', 'Element']
    .map((name) => Object.prototype.hasOwnProperty.call(globalThis, name));
  // A leaked `document` makes the next test file in this process behave like a
  // browser, which is how a green suite starts lying.
  assert.deepEqual(after, before);
});
