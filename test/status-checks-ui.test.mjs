import test from 'node:test';
import assert from 'node:assert/strict';
import { installBrowser, importFresh } from '../test-support/browser.mjs';

/**
 * Required status checks, from the browser's side.
 *
 * This screen decides what may be merged. A policy saved with the wrong
 * contexts either blocks every pull request in the repository or blocks none of
 * them, and both failures look like "CI is being weird" from the outside — so
 * the tests are about what the form actually sends, and about deleting a policy
 * being a deliberate act.
 */

const SETTINGS = '#/repo/kuklabs/demo/settings';
const PULLS = '#/repo/kuklabs/demo/pulls';

function settings(overrides = {}) {
  return {
    canManage: true,
    branches: [{ name: 'main' }, { name: 'release' }],
    policies: [{ branch: 'main', contexts: ['build', 'test'] }],
    knownContexts: ['build', 'test', 'security/scan'],
    ...overrides,
  };
}

function pulls(overrides = {}) {
  return {
    canManage: true,
    knownContexts: ['build', 'test'],
    policies: [{ branch: 'main', contexts: ['build'] }],
    pullRequests: [
      {
        number: 4,
        title: 'Add the importer',
        headBranch: 'feature/import',
        baseBranch: 'main',
        authorName: 'Amit',
        // The shape the server actually sends: the check summary is nested,
        // not spread onto the pull request.
        statusChecks: {
          headSha: 'abcdef1234567890',
          policy: { branch: 'main', contexts: ['build'] },
          requiredChecks: [{ context: 'build', state: 'success', description: 'passed', targetUrl: null }],
          statuses: [{ context: 'build', state: 'success', description: 'passed', targetUrl: null }],
          requiredCount: 1,
          successCount: 1,
          pendingCount: 0,
          missingCount: 0,
          failureCount: 0,
          errorCount: 0,
          mergeAllowed: true,
          mergeBlockReasons: [],
        },
      },
    ],
    ...overrides,
  };
}

function page(t, { hash = SETTINGS, data = settings(), pullData = pulls(), save } = {}) {
  const sent = [];
  const browser = installBrowser({
    hash,
    html: '<div id="app"><div class="app-shell"><main class="content"></main></div></div><div id="toast-root"></div>',
    routes: {
      'GET /api/status-checks/kuklabs/demo': { body: hash === SETTINGS ? data : pullData },
      // The settings tab reads the branch list too, so the select can offer
      // real branches rather than whatever the policy happens to mention.
      'GET /api/repos/kuklabs/demo/branches': { body: { branches: [{ name: 'main' }, { name: 'release' }] } },
      'PUT /api/status-checks/kuklabs/demo/policies/main': (request) => {
        sent.push({ to: 'save', branch: 'main', body: JSON.parse(request.init.body) });
        return save ?? { body: data };
      },
      'PUT /api/status-checks/kuklabs/demo/policies/release': (request) => {
        sent.push({ to: 'save', branch: 'release', body: JSON.parse(request.init.body) });
        return save ?? { body: data };
      },
      'DELETE /api/status-checks/kuklabs/demo/policies/main': () => { sent.push({ to: 'delete', branch: 'main' }); return { body: data }; },
      'POST /api/status-checks/kuklabs/demo/commits/abcdef1234567890/statuses': (request) => {
        sent.push({ to: 'publish', body: JSON.parse(request.init.body) });
        return { body: pullData };
      },
      '*': { status: 404, body: { error: { message: 'Not found.' } } },
    },
  });
  t.after(() => browser.restore());
  browser.sent = sent;
  return browser;
}

test('an existing policy is listed with the contexts it requires', async (t) => {
  const browser = page(t);
  await importFresh('../public/status-checks-ui.js');
  await browser.settle();

  assert.match(browser.html(), /main/);
  assert.match(browser.html(), /build/);
  assert.match(browser.html(), /test/);
});

test('a repository with no policy says so rather than showing an empty list', async (t) => {
  const browser = page(t, { data: settings({ policies: [] }) });
  await importFresh('../public/status-checks-ui.js');
  await browser.settle();
  assert.match(browser.html(), /No branch requires status checks yet/);
});

test('somebody without admin is told why, and shown no form', async (t) => {
  const browser = page(t, { data: settings({ canManage: false }) });
  await importFresh('../public/status-checks-ui.js');
  await browser.settle();

  // A form that 403s after somebody has typed six context names is worse than
  // no form.
  assert.equal(browser.present('#kg-status-policy-form'), false);
  assert.match(browser.html(), /Admin permission is required/);
  // The policies themselves are still readable — knowing what blocks your merge
  // is not an administrative privilege.
  assert.match(browser.html(), /build/);
});

test('contexts are sent as a list, however they were typed', async (t) => {
  const browser = page(t);
  await importFresh('../public/status-checks-ui.js');
  await browser.settle();

  const form = browser.document.querySelector('#kg-status-policy-form');
  form.querySelector('[name="contexts"]').value = 'build\n test ,security/scan\n\n';
  form.dispatchEvent({ type: 'submit', target: form });
  await browser.settle();

  const sent = browser.sent.find((entry) => entry.to === 'save');
  // Newlines, commas and stray spaces are how people actually type a list. A
  // context with a leading space is a context that never matches, and the pull
  // request blocks forever on a check nobody is publishing.
  assert.deepEqual(sent.body.contexts, ['build', 'test', 'security/scan']);
});

test('the policy is saved against the branch that was chosen', async (t) => {
  const browser = page(t);
  await importFresh('../public/status-checks-ui.js');
  await browser.settle();

  const form = browser.document.querySelector('#kg-status-policy-form');
  form.querySelector('[name="branch"]').value = 'release';
  form.querySelector('[name="contexts"]').value = 'build';
  form.dispatchEvent({ type: 'submit', target: form });
  await browser.settle();

  // Saving `release`'s policy onto `main` would silently change what gates the
  // branch everybody merges into.
  assert.equal(browser.sent.find((entry) => entry.to === 'save').branch, 'release');
});

test('an empty list is allowed, and is not the same as no policy', async (t) => {
  const browser = page(t);
  await importFresh('../public/status-checks-ui.js');
  await browser.settle();

  const form = browser.document.querySelector('#kg-status-policy-form');
  form.querySelector('[name="contexts"]').value = '   ';
  form.dispatchEvent({ type: 'submit', target: form });
  await browser.settle();

  const sent = browser.sent.find((entry) => entry.to === 'save');
  assert.deepEqual(sent.body.contexts, []);
});

test('deleting a policy asks first', async (t) => {
  const browser = page(t);
  browser.confirmAnswer = false;
  await importFresh('../public/status-checks-ui.js');
  await browser.settle();

  browser.document.querySelector('.kg-delete-status-policy')?.click();
  await browser.settle();

  // Removing the policy unblocks every open pull request on that branch at
  // once, which is exactly what somebody does not want on a mis-click.
  assert.match(browser.confirmations.join(' '), /Delete required status checks for main/);
  assert.deepEqual(browser.sent, []);
});

test('a pull request shows whether it may merge, and on which check', async (t) => {
  const browser = page(t, { hash: PULLS });
  await importFresh('../public/status-checks-ui.js');
  await browser.settle();

  assert.match(browser.html(), /#4 Add the importer/);
  assert.match(browser.html(), /build/);
  // The head commit is what the statuses were published against; a screen that
  // does not show it cannot be checked against what CI actually reported.
  assert.match(browser.html(), /abcdef1/);
});

test('a blocked pull request says it is blocked, and why', async (t) => {
  const blocked = pulls();
  const summary = blocked.pullRequests[0].statusChecks;
  summary.mergeAllowed = false;
  summary.successCount = 0;
  summary.failureCount = 1;
  summary.requiredChecks = [{ context: 'build', state: 'failure', description: 'exit 1', targetUrl: null }];
  summary.mergeBlockReasons = ['build reported failure'];
  const browser = page(t, { hash: PULLS, pullData: blocked });
  await importFresh('../public/status-checks-ui.js');
  await browser.settle();

  assert.match(browser.html(), /Checks block merge/);
  // "Blocked" without the reason sends somebody to read CI logs to find out
  // which of six checks it was.
  assert.match(browser.html(), /build reported failure/);
});

test('a repository nobody may read is asked for once, not forever', async (t) => {
  const browser = installBrowser({
    hash: SETTINGS,
    html: '<div id="app"><div class="app-shell"><main class="content"></main></div></div><div id="toast-root"></div>',
    routes: {
      'GET /api/status-checks/kuklabs/demo': { status: 403, body: { error: { message: 'Repository read permission is required.' } } },
      '*': { status: 404, body: { error: { message: 'Not found.' } } },
    },
  });
  t.after(() => browser.restore());
  await importFresh('../public/status-checks-ui.js');
  await browser.settle();

  const before = browser.requests().length;
  for (let round = 0; round < 3; round += 1) {
    browser.document.querySelector('.content').insertAdjacentHTML('beforeend', `<p>render ${round}</p>`);
    await browser.settle();
  }
  assert.equal(browser.requests().length, before);
});
