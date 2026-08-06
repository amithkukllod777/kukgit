import test from 'node:test';
import assert from 'node:assert/strict';
import { installBrowser, importFresh } from '../test-support/browser.mjs';

/**
 * Backups, from the browser's side.
 *
 * The screen creates and verifies snapshots and prunes old ones — and the one
 * thing it deliberately does not do is restore, because a restore that can be
 * started from a browser tab is a restore somebody starts by accident. The
 * tests check that the checksum is shown, that pruning asks first, and that the
 * screen says where restore actually lives.
 */

const SETTINGS = '#/settings';

function backups(overrides = {}) {
  return {
    backups: [
      {
        filename: 'kukgit-20260806T162033Z-22069d76a627.kgbak',
        archiveSha256: '253bdbb565d88f4904529f068fec46f2721fe34be95bb8fbf567dae328726995',
        archiveSize: 2007837,
        createdAt: '2026-08-06T16:20:33.768Z',
        verifiedAt: '2026-08-06T16:20:35.894Z',
        available: true,
        totals: { repositories: 2, refs: 4 },
      },
    ],
    policy: { retentionCount: 7, retentionDays: 30 },
    maintenance: { enabled: false },
    ...overrides,
  };
}

function page(t, { data = backups(), create, prune } = {}) {
  const sent = [];
  const browser = installBrowser({
    hash: SETTINGS,
    html: '<div id="app"><div class="app-shell"><main class="content"></main></div></div><div id="toast-root"></div>',
    routes: {
      'GET /api/backups': { body: data },
      'POST /api/backups': () => { sent.push({ to: 'create' }); return create ?? { status: 201, body: data }; },
      'POST /api/backups/prune': (request) => {
        sent.push({ to: 'prune', body: JSON.parse(request.init.body) });
        return prune ?? { body: data };
      },
      'POST /api/backups/verify': (request) => {
        sent.push({ to: 'verify', body: JSON.parse(request.init.body) });
        return { body: { verification: { valid: true } } };
      },
      '*': { status: 404, body: { error: { message: 'Not found.' } } },
    },
  });
  t.after(() => browser.restore());
  browser.sent = sent;
  return browser;
}

test('a snapshot shows its checksum, not just its name', async (t) => {
  const browser = page(t);
  await importFresh('../public/backups-ui.js');
  await browser.settle();

  // The SHA-256 is what somebody compares against the file they copied off the
  // machine. A list of filenames proves nothing arrived intact.
  assert.match(browser.html(), /253bdbb565d88f4904529f068fec46f2721fe34be95bb8fbf567dae328726995/);
  assert.match(browser.html(), /kukgit-20260806T162033Z/);
});

test('a snapshot whose file has gone is marked, not listed as if it were there', async (t) => {
  const missing = backups();
  missing.backups[0].available = false;
  const browser = page(t, { data: missing });
  await importFresh('../public/backups-ui.js');
  await browser.settle();

  assert.match(browser.html(), /Missing/);
  // And it offers no Verify, because there is nothing to open.
  assert.equal(browser.present('.kg-verify-backup'), false);
});

test('the screen says restore is not here, and where it is', async (t) => {
  const browser = page(t);
  await importFresh('../public/backups-ui.js');
  await browser.settle();

  // A restore that can be started from a browser tab is a restore somebody
  // starts by accident, on the wrong instance, at the wrong time.
  assert.match(browser.html(), /CLI-only/);
  assert.match(browser.html(), /--dry-run/);
});

test('pruning asks first, and cancelling prunes nothing', async (t) => {
  const browser = page(t);
  browser.confirmAnswer = false;
  await importFresh('../public/backups-ui.js');
  await browser.settle();

  const form = browser.document.querySelector('#kg-prune-backups');
  form.dispatchEvent({ type: 'submit', target: form });
  await browser.settle();

  assert.match(browser.confirmations.join(' '), /Prune snapshots/);
  // Deleting the only copy of something is not a mis-click's business.
  assert.deepEqual(browser.sent, []);
});

test('pruning sends the retention numbers as typed', async (t) => {
  const browser = page(t);
  await importFresh('../public/backups-ui.js');
  await browser.settle();

  const form = browser.document.querySelector('#kg-prune-backups');
  form.querySelector('[name="keep"]').value = '14';
  form.querySelector('[name="days"]').value = '90';
  form.dispatchEvent({ type: 'submit', target: form });
  await browser.settle();

  const sent = browser.sent.find((entry) => entry.to === 'prune');
  assert.equal(Number(sent.body.keep), 14);
  assert.equal(Number(sent.body.days), 90);
});

test('the policy fields start at the policy in force', async (t) => {
  const browser = page(t);
  await importFresh('../public/backups-ui.js');
  await browser.settle();

  // Blank boxes on a prune form invite somebody to type a smaller number than
  // the instance is actually keeping.
  assert.equal(browser.document.querySelector('#kg-prune-backups [name="keep"]').getAttribute('value'), '7');
  assert.equal(browser.document.querySelector('#kg-prune-backups [name="days"]').getAttribute('value'), '30');
});

test('maintenance mode is on the screen when it is on', async (t) => {
  const browser = page(t, { data: backups({ maintenance: { enabled: true, reason: 'restoring from backup', enabledAt: '2026-08-06T10:00:00.000Z' } }) });
  await importFresh('../public/backups-ui.js');
  await browser.settle();

  // Somebody taking a backup during maintenance is taking a backup of a
  // half-stopped instance, and needs to know that before they trust it.
  assert.match(browser.html(), /Maintenance on/);
  assert.match(browser.html(), /restoring from backup/);
});

test('an instance with no backups says so rather than showing an empty box', async (t) => {
  const browser = page(t, { data: backups({ backups: [] }) });
  await importFresh('../public/backups-ui.js');
  await browser.settle();
  assert.match(browser.html(), /No verified backup snapshots exist yet/);
});

test('a refused create says why and leaves the button usable', async (t) => {
  const browser = page(t, { create: { status: 503, body: { error: { message: 'A backup is already running.' } } } });
  await importFresh('../public/backups-ui.js');
  await browser.settle();

  browser.document.querySelector('#kg-create-backup').click();
  await browser.settle();

  assert.match(browser.html(), /already running/);
  assert.equal(browser.document.querySelector('#kg-create-backup').disabled, false);
});

test('somebody who may not see backups is asked once, not forever', async (t) => {
  const browser = installBrowser({
    hash: SETTINGS,
    html: '<div id="app"><div class="app-shell"><main class="content"></main></div></div><div id="toast-root"></div>',
    routes: {
      'GET /api/backups': { status: 403, body: { error: { message: 'Instance administrator access is required.' } } },
      '*': { status: 404, body: { error: { message: 'Not found.' } } },
    },
  });
  t.after(() => browser.restore());
  await importFresh('../public/backups-ui.js');
  await browser.settle();

  const before = browser.requests().length;
  for (let round = 0; round < 3; round += 1) {
    browser.document.querySelector('.content').insertAdjacentHTML('beforeend', `<p>render ${round}</p>`);
    await browser.settle();
  }
  assert.equal(browser.requests().length, before);
});
