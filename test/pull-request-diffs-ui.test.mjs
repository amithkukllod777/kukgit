import test from 'node:test';
import assert from 'node:assert/strict';
import { installBrowser, importFresh } from '../test-support/browser.mjs';

/**
 * The changed-files view, from the browser's side.
 *
 * A diff is what somebody approves. If it is computed against the wrong base,
 * or a file is shown from a stale fetch after the reader moved on, they approve
 * something other than what they read. The screen also carries the whitespace
 * toggle, which is the difference between a reviewable diff and eight hundred
 * lines of re-indentation.
 */

const PULLS = '#/repo/kuklabs/demo/pulls';

function summary(overrides = {}) {
  return {
    totals: { files: 2, additions: 40, deletions: 12, truncated: false },
    refs: { mergeBase: 'abcdef1234567890', head: 'fedcba0987654321', base: 'main' },
    ...overrides,
  };
}

// The listing payload is the summary — `totals` and `refs` sit at its top
// level, not under a `summary` key. Nesting them tested a shape the server
// never sends.
function listing(overrides = {}) {
  return {
    ...summary(),
    files: [
      { path: 'src/app.mjs', additions: 30, deletions: 10, status: 'modified' },
      { path: 'README.md', additions: 10, deletions: 2, status: 'modified' },
    ],
    nextOffset: null,
    canComment: true,
    ...overrides,
  };
}

function fileView(path, overrides = {}) {
  return {
    ...summary(),
    files: listing().files,
    nextOffset: null,
    canComment: true,
    // `selectedFile` wraps `file` and carries the patch beside it — the
    // metadata and the hunks are siblings, not one inside the other.
    selectedFile: {
      file: { path, additions: 30, deletions: 10, status: 'modified' },
      rawPatch: `--- a/${path}\n+++ b/${path}\n@@ -1,2 +1,2 @@\n-old line\n+new line\n`,
      binary: false,
      tooLarge: false,
      hunks: [{ header: '@@ -1,2 +1,2 @@', lines: [
        { type: 'deletion', content: 'old line', oldLine: 1, newLine: null },
        { type: 'addition', content: 'new line', oldLine: null, newLine: 1 },
      ] }],
    },
    ...overrides,
  };
}

function page(t, { pullRequests = [{ number: 4, title: 'Add the importer', status: 'open' }], files = listing(), view = fileView('src/app.mjs') } = {}) {
  const asked = [];
  const browser = installBrowser({
    hash: PULLS,
    html: '<div id="app"><div class="app-shell"><main class="content"></main></div></div><div id="toast-root"></div>',
    routes: {
      'GET /api/governance/kuklabs/demo': { body: { pullRequests } },
      '*': (request) => {
        if (request.path.startsWith('/api/pull-request-diffs/kuklabs/demo/pulls/')) {
          // `request.url` is a URL object, not a string — the search is where
          // this module says which file and which whitespace mode it wants.
          asked.push(`${request.path}${request.url.search}`);
          return { body: request.url.searchParams.has('path') ? view : files };
        }
        if (request.path.startsWith('/api/review-threads/')) return { body: { pullRequest: { reviewThreads: { threads: [] } } } };
        return { status: 404, body: { error: { message: 'Not found.' } } };
      },
    },
  });
  t.after(() => browser.restore());
  browser.asked = asked;
  return browser;
}

test('the file list, the totals and the merge base are all shown', async (t) => {
  const browser = page(t);
  await importFresh('../public/pull-request-diffs-ui.js');
  await browser.settle();

  assert.match(browser.html(), /src\/app\.mjs/);
  assert.match(browser.html(), /README\.md/);
  assert.match(browser.html(), /2 files/);
  // Which base the diff was computed against decides what the reader is
  // actually approving.
  assert.match(browser.html(), /Merge base abcdef1/);
});

test('a repository with no open pull request says so instead of an empty frame', async (t) => {
  const browser = page(t, { pullRequests: [] });
  await importFresh('../public/pull-request-diffs-ui.js');
  await browser.settle();
  assert.match(browser.html(), /Open a pull request to review a Git patch/);
});

test('a closed pull request is not offered for review', async (t) => {
  const browser = page(t, { pullRequests: [{ number: 3, title: 'Old work', status: 'merged' }] });
  await importFresh('../public/pull-request-diffs-ui.js');
  await browser.settle();

  // Reviewing something already merged is reviewing a decision nobody can act
  // on.
  assert.match(browser.html(), /Open a pull request to review a Git patch/);
});

test('the whitespace toggle changes what is asked for, not just the label', async (t) => {
  const browser = page(t);
  await importFresh('../public/pull-request-diffs-ui.js');
  await browser.settle();

  const before = browser.asked.length;
  browser.document.querySelector('#kg-diff-whitespace').click();
  await browser.settle();

  // A toggle that only relabels itself leaves the reader with eight hundred
  // lines of re-indentation and a button that claims to have hidden them.
  const after = browser.asked.slice(before).join(' ');
  assert.match(after, /whitespace=ignore/);
});

test('switching between unified and side-by-side does not re-fetch the patch', async (t) => {
  const browser = page(t);
  await importFresh('../public/pull-request-diffs-ui.js');
  await browser.settle();

  const before = browser.asked.length;
  browser.document.querySelector('#kg-diff-side').click();
  await browser.settle();
  browser.document.querySelector('#kg-diff-unified').click();
  await browser.settle();

  // The same bytes arranged differently. Re-fetching to switch is a round trip
  // per click, on a patch that may be a megabyte — and it used to do exactly
  // that. Whitespace is not this: it changes what the server computes, so that
  // path still reloads, which the test above checks.
  assert.equal(browser.asked.length, before);
  assert.match(browser.html(), /Side-by-side/);
});

test('the patch is shown with its added and removed lines', async (t) => {
  const browser = page(t);
  await importFresh('../public/pull-request-diffs-ui.js');
  await browser.settle();

  assert.match(browser.html(), /old line/);
  assert.match(browser.html(), /new line/);
  assert.match(browser.html(), /@@ -1,2 \+1,2 @@/);
});

test('a truncated file list says so rather than looking complete', async (t) => {
  const totals = { files: 400, additions: 40, deletions: 12, truncated: true };
  const browser = page(t, {
    files: listing({ totals }),
    view: fileView('src/app.mjs', { totals }),
  });
  await importFresh('../public/pull-request-diffs-ui.js');
  await browser.settle();

  // A reviewer who thinks they have seen every file, and has not, approves the
  // ones they never opened.
  assert.match(browser.html(), /File list truncated/);
});

test('somebody who may not comment is offered no inline comment control', async (t) => {
  const browser = page(t, { view: { ...fileView('src/app.mjs'), canComment: false } });
  await importFresh('../public/pull-request-diffs-ui.js');
  await browser.settle();
  assert.equal(browser.present('#kg-file-review'), false);
});

test('a repository nobody may read is asked for once, not forever', async (t) => {
  const browser = installBrowser({
    hash: PULLS,
    html: '<div id="app"><div class="app-shell"><main class="content"></main></div></div><div id="toast-root"></div>',
    routes: {
      'GET /api/governance/kuklabs/demo': { status: 403, body: { error: { message: 'Repository read permission is required.' } } },
      '*': { status: 404, body: { error: { message: 'Not found.' } } },
    },
  });
  t.after(() => browser.restore());
  await importFresh('../public/pull-request-diffs-ui.js');
  await browser.settle();

  const before = browser.requests().length;
  for (let round = 0; round < 3; round += 1) {
    browser.document.querySelector('.content').insertAdjacentHTML('beforeend', `<p>render ${round}</p>`);
    await browser.settle();
  }
  assert.equal(browser.requests().length, before);
});
