import test from 'node:test';
import assert from 'node:assert/strict';
import { installBrowser, importFresh } from '../test-support/browser.mjs';

/**
 * Git LFS, from the browser's side.
 *
 * The screen has one genuinely dangerous control on it: orphan garbage
 * collection, which deletes stored bytes across the whole instance. Everything
 * else is a quota reading, and a quota reading that is wrong is a repository
 * somebody thinks has room when it does not.
 */

const SETTINGS = '#/repo/kuklabs/demo/settings';

function lfs(overrides = {}) {
  return {
    repository: { orgSlug: 'kuklabs', slug: 'demo' },
    objectCount: 2,
    usageBytes: 1024 * 1024 * 300,
    quotaBytes: 1024 * 1024 * 1024,
    remainingBytes: 1024 * 1024 * 724,
    instanceUsageBytes: 1024 * 1024 * 1024 * 2,
    instanceQuotaBytes: 1024 * 1024 * 1024 * 10,
    maxObjectBytes: 1024 * 1024 * 512,
    objects: [
      { oid: 'a'.repeat(64), size: 1024 * 1024 * 200, createdAt: '2026-08-01T00:00:00.000Z', lastVerifiedAt: '2026-08-02T00:00:00.000Z' },
      { oid: 'b'.repeat(64), size: 1024 * 1024 * 100, createdAt: '2026-08-01T00:00:00.000Z', lastVerifiedAt: null },
    ],
    ...overrides,
  };
}

function page(t, { data = lfs(), gc } = {}) {
  const sent = [];
  const browser = installBrowser({
    hash: SETTINGS,
    html: '<div id="app"><div class="app-shell"><main class="content"></main></div></div><div id="toast-root"></div>',
    routes: {
      'GET /api/lfs/kuklabs/demo': { body: data },
      'POST /api/lfs/gc': () => {
        sent.push({ to: 'gc' });
        return gc ?? { body: { result: { objectsRemoved: 3, bytesRemoved: 1024 * 1024 * 50 } } };
      },
      [`POST /api/lfs/kuklabs/demo/objects/${'a'.repeat(64)}/verify`]: () => { sent.push({ to: 'verify' }); return { body: { ok: true } }; },
      '*': { status: 404, body: { error: { message: 'Not found.' } } },
    },
  });
  t.after(() => browser.restore());
  browser.sent = sent;
  return browser;
}

test('both quotas are shown, not just the repository one', async (t) => {
  const browser = page(t);
  await importFresh('../public/git-lfs-ui.js');
  await browser.settle();

  assert.match(browser.html(), /Repository usage/);
  // An instance quota that is nearly full stops uploads for every repository,
  // and the repository's own bar says nothing about it.
  assert.match(browser.html(), /Instance usage/);
  assert.match(browser.html(), /Maximum object/);
});

test('sizes are human units, not raw bytes', async (t) => {
  const browser = page(t);
  await importFresh('../public/git-lfs-ui.js');
  await browser.settle();

  // "314572800" tells nobody whether they are near a limit.
  assert.match(browser.html(), /300\.0 MB/);
  assert.match(browser.html(), /1\.00 GB/);
});

test('an object that has never been verified says so', async (t) => {
  const browser = page(t);
  await importFresh('../public/git-lfs-ui.js');
  await browser.settle();

  // A blank cell reads as "verified, at some unknown time". "Never" is the
  // fact.
  assert.match(browser.html(), /Never/);
});

test('garbage collection asks first, and cancelling deletes nothing', async (t) => {
  const browser = page(t);
  browser.confirmAnswer = false;
  await importFresh('../public/git-lfs-ui.js');
  await browser.settle();

  browser.document.querySelector('#kg-lfs-gc').click();
  await browser.settle();

  // This deletes stored bytes across the whole instance, not just this
  // repository.
  assert.match(browser.confirmations.join(' '), /unreferenced Git LFS objects from this KukGit instance/);
  assert.deepEqual(browser.sent, []);
});

test('garbage collection reports what it removed', async (t) => {
  const browser = page(t);
  await importFresh('../public/git-lfs-ui.js');
  await browser.settle();

  browser.document.querySelector('#kg-lfs-gc').click();
  await browser.settle();

  assert.deepEqual(browser.sent.map((entry) => entry.to), ['gc']);
  // "Done" after deleting bytes is not an answer. How many, and how much.
  assert.match(browser.html(), /3 orphan object/);
});

test('a failed collection says why and leaves the button usable', async (t) => {
  const browser = page(t, { gc: { status: 409, body: { error: { message: 'A backup is in progress.' } } } });
  await importFresh('../public/git-lfs-ui.js');
  await browser.settle();

  browser.document.querySelector('#kg-lfs-gc').click();
  await browser.settle();

  assert.match(browser.html(), /backup is in progress/);
  assert.equal(browser.document.querySelector('#kg-lfs-gc').disabled, false);
});

test('a repository with no objects still explains how to start', async (t) => {
  const browser = page(t, { data: lfs({ objects: [], objectCount: 0, usageBytes: 0 }) });
  await importFresh('../public/git-lfs-ui.js');
  await browser.settle();

  // An empty list plus no instructions is a feature nobody can turn on.
  assert.match(browser.html(), /git lfs track/);
  assert.match(browser.html(), /\.gitattributes/);
});

test('a repository nobody may read is asked for once, not forever', async (t) => {
  const browser = installBrowser({
    hash: SETTINGS,
    html: '<div id="app"><div class="app-shell"><main class="content"></main></div></div><div id="toast-root"></div>',
    routes: {
      'GET /api/lfs/kuklabs/demo': { status: 403, body: { error: { message: 'Repository read permission is required.' } } },
      '*': { status: 404, body: { error: { message: 'Not found.' } } },
    },
  });
  t.after(() => browser.restore());
  await importFresh('../public/git-lfs-ui.js');
  await browser.settle();

  const before = browser.requests().length;
  for (let round = 0; round < 3; round += 1) {
    browser.document.querySelector('.content').insertAdjacentHTML('beforeend', `<p>render ${round}</p>`);
    await browser.settle();
  }
  assert.equal(browser.requests().length, before);
});
