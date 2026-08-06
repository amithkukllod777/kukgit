import test from 'node:test';
import assert from 'node:assert/strict';
import { installBrowser, importFresh } from '../test-support/browser.mjs';

/**
 * Branch protection, from the browser's side.
 *
 * This screen decides whether `main` can be pushed to directly and how many
 * approvals a merge needs. Getting a checkbox backwards here does not look like
 * a bug — it looks like a repository that was never protected, and nobody finds
 * out until somebody force-pushes over a release.
 *
 * The interesting assertions are all about the boxes: an unticked box has to
 * arrive as `false`, not as absent-and-therefore-default.
 */

const SETTINGS = '#/repo/kuklabs/demo/settings';

function governance(overrides = {}) {
  return {
    canManage: true,
    rules: [
      { branch: 'main', requirePullRequest: true, requiredApprovals: 2, dismissStaleApprovals: true, blockDirectPushes: true },
    ],
    pullRequests: [],
    ...overrides,
  };
}

function page(t, { data = governance(), save, hash = SETTINGS } = {}) {
  const sent = [];
  const browser = installBrowser({
    hash,
    html: '<div id="app"><div class="app-shell"><main class="content"></main></div></div><div id="toast-root"></div>',
    routes: {
      'GET /api/governance/kuklabs/demo': { body: data },
      'GET /api/repos/kuklabs/demo/branches': { body: { branches: [{ name: 'main' }, { name: 'release' }] } },
      'PUT /api/governance/kuklabs/demo/rules/main': (request) => {
        sent.push({ to: 'save:main', body: JSON.parse(request.init.body) });
        return save ?? { body: { ok: true } };
      },
      'PUT /api/governance/kuklabs/demo/rules/release': (request) => {
        sent.push({ to: 'save:release', body: JSON.parse(request.init.body) });
        return save ?? { body: { ok: true } };
      },
      'DELETE /api/governance/kuklabs/demo/rules/main': () => {
        sent.push({ to: 'delete:main' });
        return { body: { ok: true } };
      },
      '*': { status: 404, body: { error: { message: 'Not found.' } } },
    },
  });
  t.after(() => browser.restore());
  browser.sent = sent;
  return browser;
}

test('an existing rule is shown as it actually is', async (t) => {
  const browser = page(t);
  await importFresh('../public/branch-governance-ui.js');
  await browser.settle();

  const card = browser.document.querySelector('[data-rule-branch="main"]');
  assert.ok(card, 'the rule for main is rendered');
  // Somebody comes to this page to find out what is enforced. Rendering the
  // policy wrong is worse than not rendering it.
  assert.match(card.innerHTML, /Required approvals<\/span><b>2<\/b>/);
  assert.match(card.innerHTML, /Block direct pushes<\/span><b>Yes<\/b>/);
});

test('the form starts fully protective', async (t) => {
  const browser = page(t);
  await importFresh('../public/branch-governance-ui.js');
  await browser.settle();

  const form = browser.document.querySelector('#kg-rule-form');
  // A protection form that starts with everything off protects nothing for
  // whoever presses Save without reading it.
  for (const name of ['requirePullRequest', 'dismissStaleApprovals', 'blockDirectPushes']) {
    assert.equal(form.querySelector(`[name="${name}"]`).checked, true, name);
  }
  assert.equal(form.querySelector('[name="requiredApprovals"]').value, '1');
});

test('an unticked box is sent as false, not left out', async (t) => {
  const browser = page(t);
  await importFresh('../public/branch-governance-ui.js');
  await browser.settle();

  const form = browser.document.querySelector('#kg-rule-form');
  form.querySelector('[name="blockDirectPushes"]').checked = false;
  form.querySelector('[name="requiredApprovals"]').value = '3';
  form.dispatchEvent({ type: 'submit', target: form });
  await browser.settle();

  // An unchecked box is absent from a form submission, so this is the one place
  // where "not sent" and "false" have to be turned back into the same thing.
  // Getting it wrong leaves direct pushes blocked when somebody just unblocked
  // them, or the reverse.
  assert.deepEqual(browser.sent, [{
    to: 'save:main',
    body: { requiredApprovals: 3, requirePullRequest: true, dismissStaleApprovals: true, blockDirectPushes: false },
  }]);
});

test('approvals are sent as a number, not the string from the input', async (t) => {
  const browser = page(t);
  await importFresh('../public/branch-governance-ui.js');
  await browser.settle();

  const form = browser.document.querySelector('#kg-rule-form');
  form.querySelector('[name="requiredApprovals"]').value = '0';
  form.dispatchEvent({ type: 'submit', target: form });
  await browser.settle();

  // `"0"` is truthy and `0` is not. A rule requiring no approvals has to be
  // expressible, and it is the one value where the difference bites.
  assert.equal(browser.sent[0].body.requiredApprovals, 0);
  assert.equal(typeof browser.sent[0].body.requiredApprovals, 'number');
});

test('the rule is saved against the branch that was chosen', async (t) => {
  const browser = page(t);
  await importFresh('../public/branch-governance-ui.js');
  await browser.settle();

  const form = browser.document.querySelector('#kg-rule-form');
  form.querySelector('[name="branch"]').value = 'release';
  form.dispatchEvent({ type: 'submit', target: form });
  await browser.settle();

  // Protecting the wrong branch leaves the one somebody meant to protect open.
  assert.equal(browser.sent[0].to, 'save:release');
});

test('somebody without admin sees the rules and no way to change them', async (t) => {
  const browser = page(t, { data: governance({ canManage: false }) });
  await importFresh('../public/branch-governance-ui.js');
  await browser.settle();

  assert.ok(browser.document.querySelector('[data-rule-branch="main"]'), 'the rules are still visible');
  assert.equal(browser.document.querySelector('#kg-rule-form'), null);
  assert.equal(browser.document.querySelectorAll('.kg-delete-rule').length, 0);
  assert.match(browser.html(), /Repository Admin permission is required/);
});

test('deleting protection asks first', async (t) => {
  const browser = page(t);
  browser.confirmAnswer = false;
  await importFresh('../public/branch-governance-ui.js');
  await browser.settle();

  browser.document.querySelector('.kg-delete-rule').click();
  await browser.settle();

  assert.match(browser.confirmations.join(' '), /Delete protection for main/);
  // Removing protection is the change nobody notices until it matters.
  assert.deepEqual(browser.sent, []);

  browser.confirmAnswer = true;
  browser.document.querySelector('.kg-delete-rule').click();
  await browser.settle();
  assert.deepEqual(browser.sent.map((entry) => entry.to), ['delete:main']);
});

test('a refused save says why and leaves the form usable', async (t) => {
  const browser = page(t, {
    save: { status: 403, body: { error: { message: 'Repository admin permission is required.' } } },
  });
  await importFresh('../public/branch-governance-ui.js');
  await browser.settle();

  const form = browser.document.querySelector('#kg-rule-form');
  form.dispatchEvent({ type: 'submit', target: form });
  await browser.settle();

  assert.match(browser.html(), /Repository admin permission is required/);
  assert.equal(form.querySelector('button[type="submit"]').disabled, false);
});

test('no rules says so rather than showing an empty box', async (t) => {
  const browser = page(t, { data: governance({ rules: [] }) });
  await importFresh('../public/branch-governance-ui.js');
  await browser.settle();

  assert.match(browser.html(), /No protected branches yet/);
});

test('the panel stays off pages it does not belong on', async (t) => {
  const browser = page(t, { hash: '#/organizations' });
  await importFresh('../public/branch-governance-ui.js');
  await browser.settle();

  assert.equal(browser.document.querySelector('#kg-governance-panel'), null);
  assert.equal(browser.countPath('/api/governance/kuklabs/demo'), 0);
});
