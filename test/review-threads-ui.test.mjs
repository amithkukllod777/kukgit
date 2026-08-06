import test from 'node:test';
import assert from 'node:assert/strict';
import { installBrowser, importFresh } from '../test-support/browser.mjs';

/**
 * Review threads, from the browser's side.
 *
 * A review thread is a blocking objection: while one is open the policy can
 * refuse the merge. So the screen has to be exact about which thread it is
 * replying to and resolving — resolving the wrong one clears somebody else's
 * objection and lets a merge through that they were holding.
 */

const SETTINGS = '#/repo/kuklabs/demo/settings';
const PULLS = '#/repo/kuklabs/demo/pulls';

function settings(overrides = {}) {
  return {
    canManage: true,
    policies: [{ branch: 'main', requireResolvedThreads: true }],
    ...overrides,
  };
}

function thread(id, overrides = {}) {
  return {
    id,
    path: 'src/app.mjs',
    line: 42,
    headSha: 'abcdef1234567890',
    authorName: 'Priya',
    resolved: false,
    outdated: false,
    comments: [{ id: `${id}_c1`, authorName: 'Priya', body: 'This drops the error.', createdAt: '2026-08-01T00:00:00.000Z' }],
    ...overrides,
  };
}

// The shape the server actually sends: the summary and the threads hang off
// the pull request, and the changed-file list comes with it so a new thread can
// be anchored to a real path.
function pullItem({ threads = [thread('thr_1'), thread('thr_2', { resolved: true })], ...overrides } = {}) {
  return {
    pullRequest: {
      number: 4,
      title: 'Add the importer',
      headBranch: 'feature/import',
      baseBranch: 'main',
      authorName: 'Amit',
      comparison: { files: [{ path: 'src/app.mjs' }] },
      reviewThreads: {
        policy: { branch: 'main', requireResolvedThreads: true },
        mergeAllowed: false,
        mergeBlockReason: 'one review thread is still open',
        activeUnresolvedCount: 1,
        resolvedCount: 1,
        outdatedCount: 0,
        totalThreads: threads.length,
        threads,
      },
    },
    canComment: true,
    canResolve: true,
    ...overrides,
  };
}

function page(t, { hash = PULLS, data = settings(), item = pullItem() } = {}) {
  const sent = [];
  const browser = installBrowser({
    hash,
    html: '<div id="app"><div class="app-shell"><main class="content"></main></div></div><div id="toast-root"></div>',
    routes: {
      'GET /api/review-threads/kuklabs/demo': { body: data },
      'GET /api/repos/kuklabs/demo/branches': { body: { branches: [{ name: 'main' }, { name: 'release' }] } },
      'GET /api/governance/kuklabs/demo': { body: { pullRequests: [{ number: 4 }] } },
      'GET /api/review-threads/kuklabs/demo/pulls/4': { body: item },
      'PUT /api/review-threads/kuklabs/demo/policies/main': (request) => {
        sent.push({ to: 'policy', branch: 'main', body: JSON.parse(request.init.body) });
        return { body: data };
      },
      'DELETE /api/review-threads/kuklabs/demo/policies/main': () => { sent.push({ to: 'delete-policy' }); return { body: data }; },
      'POST /api/review-threads/kuklabs/demo/pulls/4/threads/thr_1/replies': (request) => {
        sent.push({ to: 'reply', thread: 'thr_1', body: JSON.parse(request.init.body) });
        return { body: item };
      },
      'POST /api/review-threads/kuklabs/demo/pulls/4/threads/thr_2/replies': (request) => {
        sent.push({ to: 'reply', thread: 'thr_2', body: JSON.parse(request.init.body) });
        return { body: item };
      },
      'POST /api/review-threads/kuklabs/demo/pulls/4/threads/thr_1/resolve': () => { sent.push({ to: 'resolve', thread: 'thr_1' }); return { body: item }; },
      'POST /api/review-threads/kuklabs/demo/pulls/4/threads/thr_2/reopen': () => { sent.push({ to: 'reopen', thread: 'thr_2' }); return { body: item }; },
      '*': { status: 404, body: { error: { message: 'Not found.' } } },
    },
  });
  t.after(() => browser.restore());
  browser.sent = sent;
  return browser;
}

test('a policy is listed with what it requires', async (t) => {
  const browser = page(t, { hash: SETTINGS });
  await importFresh('../public/review-threads-ui.js');
  await browser.settle();

  assert.match(browser.html(), /main/);
  assert.match(browser.html(), /Require active threads resolved: Yes/);
});

test('somebody without admin is told why, and shown no policy form', async (t) => {
  const browser = page(t, { hash: SETTINGS, data: settings({ canManage: false }) });
  await importFresh('../public/review-threads-ui.js');
  await browser.settle();

  assert.equal(browser.present('#kg-thread-policy-form'), false);
  assert.match(browser.html(), /Admin permission is required/);
  // The policy itself stays readable: what blocks your merge is not privileged.
  assert.match(browser.html(), /Require active threads resolved/);
});

test('the policy is saved for the branch that was chosen', async (t) => {
  const browser = page(t, { hash: SETTINGS });
  await importFresh('../public/review-threads-ui.js');
  await browser.settle();

  const form = browser.document.querySelector('#kg-thread-policy-form');
  form.querySelector('[name="branch"]').value = 'main';
  form.querySelector('[name="requireResolvedThreads"]').value = 'false';
  form.dispatchEvent({ type: 'submit', target: form });
  await browser.settle();

  const sent = browser.sent.find((entry) => entry.to === 'policy');
  assert.equal(sent.branch, 'main');
  // The select's value is the string "false". Sending that as a truthy value
  // would turn "do not block merge" into "block every merge".
  assert.equal(sent.body.requireResolvedThreads, false);
});

test('an open thread and a resolved one are told apart', async (t) => {
  const browser = page(t);
  await importFresh('../public/review-threads-ui.js');
  await browser.settle();

  assert.match(browser.html(), /Open/);
  assert.match(browser.html(), /Resolved/);
  // The objection itself, not just its state.
  assert.match(browser.html(), /This drops the error/);
});

test('a reply goes to the thread it was typed under', async (t) => {
  const browser = page(t);
  await importFresh('../public/review-threads-ui.js');
  await browser.settle();

  const forms = browser.document.querySelectorAll('.kg-thread-reply');
  const second = forms[forms.length - 1];
  second.querySelector('[name="body"]').value = 'Fixed in the next commit.';
  second.dispatchEvent({ type: 'submit', target: second });
  await browser.settle();

  const sent = browser.sent.find((entry) => entry.to === 'reply');
  // Replying under the wrong thread answers an objection nobody made and
  // leaves the real one unanswered.
  assert.equal(sent.thread, 'thr_2');
  assert.equal(sent.body.body, 'Fixed in the next commit.');
});

test('resolving names the thread it resolves', async (t) => {
  const browser = page(t);
  await importFresh('../public/review-threads-ui.js');
  await browser.settle();

  browser.document.querySelector('.kg-resolve-thread').click();
  await browser.settle();

  // Resolving the wrong thread clears somebody else's objection and lets a
  // merge through that they were holding.
  assert.deepEqual(browser.sent, [{ to: 'resolve', thread: 'thr_1' }]);
});

test('a resolved thread offers Reopen, not Resolve', async (t) => {
  const browser = page(t);
  await importFresh('../public/review-threads-ui.js');
  await browser.settle();

  browser.document.querySelector('.kg-reopen-thread').click();
  await browser.settle();
  assert.deepEqual(browser.sent, [{ to: 'reopen', thread: 'thr_2' }]);
});

test('somebody who may not resolve is shown neither button', async (t) => {
  const browser = page(t, { item: pullItem({ canResolve: false }) });
  await importFresh('../public/review-threads-ui.js');
  await browser.settle();

  assert.equal(browser.present('.kg-resolve-thread'), false);
  assert.equal(browser.present('.kg-reopen-thread'), false);
  // But they can still reply — disagreeing is not the same power as clearing
  // the disagreement.
  assert.equal(browser.present('.kg-thread-reply'), true);
});

test('somebody who may not comment is shown no reply box either', async (t) => {
  const browser = page(t, { item: pullItem({ canComment: false }) });
  await importFresh('../public/review-threads-ui.js');
  await browser.settle();
  assert.equal(browser.present('.kg-thread-reply'), false);
});

test('an outdated thread is marked, because its line has moved', async (t) => {
  const browser = page(t, { item: pullItem({ threads: [thread('thr_1', { outdated: true })] }) });
  await importFresh('../public/review-threads-ui.js');
  await browser.settle();

  // A thread anchored to a line that a later commit rewrote is a comment about
  // code that is no longer there.
  assert.match(browser.html(), /Outdated/);
});

test('deleting a policy asks first', async (t) => {
  const browser = page(t, { hash: SETTINGS });
  browser.confirmAnswer = false;
  await importFresh('../public/review-threads-ui.js');
  await browser.settle();

  browser.document.querySelector('.kg-delete-thread-policy')?.click();
  await browser.settle();
  assert.deepEqual(browser.sent, []);
});

test('a repository nobody may read is asked for once, not forever', async (t) => {
  const browser = installBrowser({
    hash: PULLS,
    html: '<div id="app"><div class="app-shell"><main class="content"></main></div></div><div id="toast-root"></div>',
    routes: {
      'GET /api/governance/kuklabs/demo': { status: 403, body: { error: { message: 'Repository read permission is required.' } } },
      'GET /api/review-threads/kuklabs/demo': { status: 403, body: { error: { message: 'Forbidden.' } } },
      '*': { status: 404, body: { error: { message: 'Not found.' } } },
    },
  });
  t.after(() => browser.restore());
  await importFresh('../public/review-threads-ui.js');
  await browser.settle();

  const before = browser.requests().length;
  for (let round = 0; round < 3; round += 1) {
    browser.document.querySelector('.content').insertAdjacentHTML('beforeend', `<p>render ${round}</p>`);
    await browser.settle();
  }
  assert.equal(browser.requests().length, before);
});
