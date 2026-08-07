import test from 'node:test';
import assert from 'node:assert/strict';
import { importFresh, installBrowser } from '../test-support/browser.mjs';

test('direct signup route does not offer KukGit-local signup in AuthKit mode', async (t) => {
  const browser = installBrowser({
    hash: '#/signup',
    html: '<div id="app"><form class="login-card" id="login-form"></form></div><div id="toast-root"></div>',
    routes: {
      '/api/auth/status': { body: { ok: true, mode: 'authkit', contract: 'kuklabs-authkit-rest/1' } },
      '*': { status: 404, body: {} },
    },
  });
  t.after(() => browser.restore());

  await importFresh('../public/signup-ui.js');
  await browser.settle();

  assert.equal(browser.present('#kg-signup-form'), false);
  assert.match(browser.html(), /Signup is not available here/);
  assert.equal(browser.calls.filter((entry) => String(entry.url).includes('/api/account/signup')).length, 0);
});
