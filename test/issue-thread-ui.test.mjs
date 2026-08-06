import test from 'node:test';
import assert from 'node:assert/strict';
import { installBrowser, importFresh } from '../test-support/browser.mjs';

/**
 * The issue thread, from the browser's side.
 *
 * The screen has to be honest about two things. A comment carried in from
 * another host must show the person who wrote it and say it was imported —
 * anything else attributes a stranger's words to whoever ran the import. And a
 * reader who cannot reply must be told that, rather than shown a box that will
 * refuse them after they have typed.
 */

const ROUTE = '#/repo/kuklabs/thread/issues?issue=1';

function thread(overrides = {}) {
  return {
    issue: {
      number: 1, title: 'Login is slow', body: 'It takes eight seconds.', status: 'open',
      authorName: 'Amit', createdAt: '2026-08-01 09:00:00',
      labels: [{ id: 'lbl_1', name: 'bug', colour: 'd73a4a' }],
      milestoneId: 'mst_1', milestoneTitle: 'v1.0',
      assigneeId: null, assigneeName: null, importedAssignee: 'octocat',
    },
    canComment: true,
    comments: [
      { id: 'c1', body: 'Reproduced on staging.', authorName: 'Priya', authorId: 'user_2', imported: false, importedFrom: null, editedAt: null, createdAt: '2026-08-02 09:00:00' },
      { id: 'c2', body: 'Same here.', authorName: 'octocat', authorId: null, imported: true, importedFrom: 'github.com/acme/thread', editedAt: null, createdAt: '2024-03-01 09:00:00' },
    ],
    ...overrides,
  };
}

function taxonomy(overrides = {}) {
  return {
    labels: [{ id: 'lbl_1', name: 'bug', colour: 'd73a4a' }, { id: 'lbl_2', name: 'enhancement', colour: 'a2eeef' }],
    milestones: [{ id: 'mst_1', title: 'v1.0' }, { id: 'mst_2', title: 'v1.1' }],
    assignable: [{ id: 'user_1', name: 'Amit' }, { id: 'user_2', name: 'Priya' }],
    canManage: true,
    ...overrides,
  };
}

function page(t, { data = thread(), response, post, patch, taxonomyBody = taxonomy(), taxonomyResponse } = {}) {
  const sent = [];
  const browser = installBrowser({
    hash: ROUTE,
    html: '<div id="app"><div class="app-shell"><main class="content"></main></div></div><div id="toast-root"></div>',
    routes: {
      // `response` is the whole HTTP answer; `data` is just its body. Conflating
      // them made a 403 arrive as a 200 whose body happened to contain the
      // number 403, and the storm test passed without the guard it was for.
      'GET /api/issue-comments/kuklabs/thread/1': response ?? { body: data },
      'POST /api/issue-comments/kuklabs/thread/1': (request) => {
        sent.push({ to: 'post', body: JSON.parse(request.init.body) });
        return post ?? { status: 201, body: thread({ comments: [...thread().comments, { id: 'c3', body: 'A new reply.', authorName: 'Amit', authorId: 'user_1', imported: false, editedAt: null, createdAt: '2026-08-06 09:00:00' }] }) };
      },
      'PATCH /api/issue-comments/kuklabs/thread/1/c1': (request) => {
        sent.push({ to: 'patch', body: JSON.parse(request.init.body) });
        return patch ?? { body: thread() };
      },
      'DELETE /api/issue-comments/kuklabs/thread/1/c1': () => {
        sent.push({ to: 'delete' });
        return { body: thread({ comments: [] }) };
      },
      'GET /api/issue-taxonomy/kuklabs/thread': taxonomyResponse ?? { body: taxonomyBody },
      'PATCH /api/issue-taxonomy/kuklabs/thread/issues/1': (request) => {
        sent.push({ to: 'taxonomy', body: JSON.parse(request.init.body) });
        return { body: { labels: [] } };
      },
      '*': { status: 404, body: { error: { message: 'Not found.' } } },
    },
  });
  t.after(() => browser.restore());
  browser.sent = sent;
  return browser;
}

test('the issue and its replies are shown, oldest at the top', async (t) => {
  const browser = page(t);
  await importFresh('../public/issue-thread-ui.js');
  await browser.settle();

  assert.match(browser.html(), /#1 Login is slow/);
  assert.match(browser.html(), /It takes eight seconds/);
  const bodies = browser.document.querySelectorAll('.kg-thread-body').map((node) => node.textContent);
  assert.deepEqual(bodies, ['It takes eight seconds.', 'Reproduced on staging.', 'Same here.']);
});

test('an imported comment is attributed to whoever wrote it, and marked', async (t) => {
  const browser = page(t);
  await importFresh('../public/issue-thread-ui.js');
  await browser.settle();

  const imported = browser.document.querySelectorAll('.kg-thread-comment')
    .find((node) => node.innerHTML.includes('octocat'));
  assert.ok(imported, 'the imported comment is missing');
  // Not "Amit said Same here" — attributing a stranger's words to the person
  // who ran the import is the one thing an import must never do.
  assert.match(imported.innerHTML, /imported from github\.com\/acme\/thread/);
  // And it offers no Edit, because there is nobody here who wrote it.
  assert.equal(imported.querySelector('.kg-thread-edit'), null);
});

test('a reader who cannot reply is told so instead of shown a box', async (t) => {
  const browser = page(t, { data: thread({ canComment: false }) });
  await importFresh('../public/issue-thread-ui.js');
  await browser.settle();

  assert.equal(browser.document.querySelector('#kg-thread-form'), null);
  assert.match(browser.html(), /follow the discussion but not reply/);
  // And no controls on anybody's comment either.
  assert.equal(browser.document.querySelector('.kg-thread-delete'), null);
});

test('posting sends what was typed and clears the box', async (t) => {
  const browser = page(t);
  await importFresh('../public/issue-thread-ui.js');
  await browser.settle();

  const textarea = browser.document.querySelector('#kg-thread-form [name="body"]');
  textarea.value = 'I will look at it today.';
  browser.document.querySelector('#kg-thread-submit').click();
  await browser.settle();

  assert.deepEqual(browser.sent, [{ to: 'post', body: { body: 'I will look at it today.' } }]);
  assert.equal(textarea.value, '');
  assert.match(browser.html(), /A new reply/);
});

test('an empty reply is refused here rather than at the server', async (t) => {
  const browser = page(t);
  await importFresh('../public/issue-thread-ui.js');
  await browser.settle();

  browser.document.querySelector('#kg-thread-form [name="body"]').value = '   ';
  browser.document.querySelector('#kg-thread-submit').click();
  await browser.settle();

  assert.deepEqual(browser.sent, []);
  assert.match(browser.html(), /Write something before commenting/);
});

test('a refused post says why and leaves what was typed', async (t) => {
  const browser = page(t, { post: { status: 403, body: { error: { message: 'Repository write permission is required.' } } } });
  await importFresh('../public/issue-thread-ui.js');
  await browser.settle();

  const textarea = browser.document.querySelector('#kg-thread-form [name="body"]');
  textarea.value = 'a careful reply somebody spent five minutes on';
  browser.document.querySelector('#kg-thread-submit').click();
  await browser.settle();

  assert.match(browser.html(), /write permission is required/);
  // Losing what somebody typed because the request failed is losing their work
  // for them.
  assert.equal(textarea.value, 'a careful reply somebody spent five minutes on');
  assert.equal(browser.document.querySelector('#kg-thread-submit').disabled, false);
});

test('deleting asks first, and cancelling deletes nothing', async (t) => {
  const browser = page(t);
  browser.confirmAnswer = false;
  await importFresh('../public/issue-thread-ui.js');
  await browser.settle();

  browser.document.querySelector('.kg-thread-delete').click();
  await browser.settle();

  assert.match(browser.confirmations.join(' '), /cannot be brought back/);
  assert.deepEqual(browser.sent, []);
});

test('editing sends the new text and shows the result', async (t) => {
  const browser = page(t);
  await importFresh('../public/issue-thread-ui.js');
  await browser.settle();

  browser.document.querySelector('.kg-thread-edit').click();
  await browser.settle();
  browser.document.querySelector('.kg-thread-editor').value = 'Reproduced on staging and production.';
  browser.document.querySelector('.kg-thread-save').click();
  await browser.settle();

  assert.deepEqual(browser.sent, [{ to: 'patch', body: { body: 'Reproduced on staging and production.' } }]);
});

test('cancelling an edit puts the original back', async (t) => {
  const browser = page(t);
  await importFresh('../public/issue-thread-ui.js');
  await browser.settle();

  browser.document.querySelector('.kg-thread-edit').click();
  await browser.settle();
  browser.document.querySelector('.kg-thread-cancel').click();
  await browser.settle();

  assert.deepEqual(browser.sent, []);
  assert.equal(browser.document.querySelectorAll('.kg-thread-body')[1].textContent, 'Reproduced on staging.');
});

test('the list route renders no thread at all', async (t) => {
  const browser = page(t);
  browser.location.hash = '#/repo/kuklabs/thread/issues';
  await importFresh('../public/issue-thread-ui.js');
  await browser.settle();
  // Without `?issue=` this is the table app.js renders. A panel here would be a
  // second, contradictory answer on the same screen.
  assert.equal(browser.document.querySelector('#kg-thread-panel'), null);
  assert.deepEqual(browser.requests(), []);
});

test('an issue nobody may read is asked for once, not forever', async (t) => {
  const browser = page(t, { response: { status: 403, body: { error: { message: 'Repository read permission is required.' } } } });
  await importFresh('../public/issue-thread-ui.js');
  await browser.settle();

  const before = browser.requests().length;
  for (let round = 0; round < 3; round += 1) {
    browser.document.querySelector('.content').insertAdjacentHTML('beforeend', `<p>render ${round}</p>`);
    await browser.settle();
  }
  // The "already rendered" guard tests for a panel, and a refusal renders none.
  // Growth, not a threshold: the defect is a count that never stops rising.
  assert.equal(browser.requests().length, before);
});

test("an issue's labels, milestone and assignee are on the page", async (t) => {
  const browser = page(t);
  await importFresh('../public/issue-thread-ui.js');
  await browser.settle();

  assert.match(browser.html(), /bug/);
  assert.match(browser.html(), /v1\.0/);
  // Somebody with no account here, named as text. Showing "Amit" — whoever ran
  // the import — would put the work on the wrong person.
  assert.match(browser.html(), /Assigned to octocat \(imported\)/);
});

test('a label colour that would be unreadable gets dark text instead', async (t) => {
  const light = thread();
  light.issue.labels = [{ id: 'lbl_x', name: 'pale', colour: 'ffffff' }];
  const browser = page(t, { data: light });
  await importFresh('../public/issue-thread-ui.js');
  await browser.settle();

  // A hex colour from another host is whatever somebody picked there. White on
  // white is a label nobody can read.
  const chip = browser.document.querySelectorAll('.kg-thread-label').find((node) => node.textContent.includes('pale'));
  assert.match(chip.getAttribute('style'), /color:#0b1220/);
});

test('somebody who cannot manage the taxonomy is not offered an Edit', async (t) => {
  const browser = page(t, { taxonomyBody: taxonomy({ canManage: false }) });
  await importFresh('../public/issue-thread-ui.js');
  await browser.settle();
  assert.equal(browser.document.querySelector('#kg-thread-edit-side'), null);
  // But the labels are still shown — reading them is not managing them.
  assert.match(browser.html(), /bug/);
});

test('editing sends the ticked labels, the milestone and the assignee', async (t) => {
  const browser = page(t);
  await importFresh('../public/issue-thread-ui.js');
  await browser.settle();

  browser.document.querySelector('#kg-thread-edit-side').click();
  await browser.settle();
  browser.document.querySelector('input[name="label"][value="lbl_2"]').checked = true;
  browser.document.querySelector('#kg-thread-milestone').value = 'mst_2';
  browser.document.querySelector('#kg-thread-assignee').value = 'user_2';
  browser.document.querySelector('#kg-thread-save-side').click();
  await browser.settle();

  const sent = browser.sent.find((entry) => entry.to === 'taxonomy');
  assert.deepEqual(sent.body.labelIds.sort(), ['lbl_1', 'lbl_2']);
  assert.equal(sent.body.milestoneId, 'mst_2');
  assert.equal(sent.body.assigneeId, 'user_2');
});

test('clearing the milestone and assignee sends null, not an empty string', async (t) => {
  const browser = page(t);
  await importFresh('../public/issue-thread-ui.js');
  await browser.settle();

  browser.document.querySelector('#kg-thread-edit-side').click();
  await browser.settle();
  browser.document.querySelector('input[name="label"][value="lbl_1"]').checked = false;
  browser.document.querySelector('#kg-thread-milestone').value = '';
  browser.document.querySelector('#kg-thread-assignee').value = '';
  browser.document.querySelector('#kg-thread-save-side').click();
  await browser.settle();

  const sent = browser.sent.find((entry) => entry.to === 'taxonomy');
  // An empty string is a value; the server would look for a milestone whose id
  // is "".
  assert.deepEqual(sent.body, { labelIds: [], milestoneId: null, assigneeId: null });
});

test('cancelling an edit sends nothing', async (t) => {
  const browser = page(t);
  await importFresh('../public/issue-thread-ui.js');
  await browser.settle();

  browser.document.querySelector('#kg-thread-edit-side').click();
  await browser.settle();
  browser.document.querySelector('#kg-thread-cancel-side').click();
  await browser.settle();

  assert.equal(browser.sent.some((entry) => entry.to === 'taxonomy'), false);
  assert.ok(browser.document.querySelector('#kg-thread-edit-side'), 'the Edit button did not come back');
});

test('a taxonomy that cannot be read does not hide the conversation', async (t) => {
  const browser = page(t, { taxonomyResponse: { status: 500, body: { error: { message: 'boom' } } } });
  await importFresh('../public/issue-thread-ui.js');
  await browser.settle();

  // The thread is the point of the screen. Losing the label strip is a smaller
  // failure than losing the discussion.
  assert.match(browser.html(), /Reproduced on staging/);
  assert.equal(browser.document.querySelector('#kg-thread-side'), null);
});
