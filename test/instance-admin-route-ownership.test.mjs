import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.mjs';
import { loadConfig } from '../src/config.mjs';
import { openDatabase, seedCore } from '../src/db.mjs';
import { createInstanceAdminApiHandlerSafe, instanceAdminEmails } from '../src/instance-admin-safe.mjs';
import { createAbuseReportsApiHandler, migrateAbuseReports } from '../src/abuse-reports.mjs';
import { createMaintenanceWindowsApiHandler, migrateMaintenanceWindows } from '../src/maintenance-windows.mjs';
import { createStatusPageApiHandler, migrateStatusPage } from '../src/status-page.mjs';
import { createSupportAccessApiHandler, migrateSupportAccess } from '../src/support-access.mjs';
import { createDangerousFilesApiHandler, migrateDangerousFiles } from '../src/dangerous-files.mjs';
import { migrateUsageHistory } from '../src/usage-history.mjs';
import { migrateBilling } from '../src/billing.mjs';
import { createBillingApiHandler } from '../src/billing-api.mjs';
import { createInstanceSettingsApiHandler, migrateInstanceSettings } from '../src/instance-settings.mjs';
import { createUsageApiHandler } from '../src/usage-api.mjs';

/**
 * The handler chain in the order `server.mjs` runs it.
 *
 * Each module's own tests call its handler directly, so all of them passed
 * while every one of these routes answered 404 on the real server: the generic
 * instance-admin handler runs first and ends with a 404 for anything it does
 * not recognise. Composition is the only place that shows up.
 */
async function instance(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-ownership-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const config = loadConfig({
    dataDir,
    databasePath: path.join(dataDir, 'test.db'),
    repositoriesDir: path.join(dataDir, 'repos'),
    tempDir: path.join(dataDir, 'tmp'),
    nodeEnv: 'test',
    adminEmail: 'operator@kuklabs.com',
    adminPassword: 'secure-test-password',
    adminName: 'Operator',
  });
  const db = openDatabase(config);
  t.after(() => db.close());
  seedCore(db, config);
  for (const migrate of [migrateAbuseReports, migrateMaintenanceWindows, migrateStatusPage, migrateSupportAccess, migrateDangerousFiles, migrateUsageHistory, migrateBilling, migrateInstanceSettings]) {
    migrate(db);
  }

  const isInstanceAdmin = (settings, user) => instanceAdminEmails(settings).includes(String(user.email || '').toLowerCase());
  const instanceAdminApi = createInstanceAdminApiHandlerSafe({ config, db });
  const delegated = [
    createSupportAccessApiHandler({ config, db, isInstanceAdmin }),
    createMaintenanceWindowsApiHandler({ config, db, isInstanceAdmin }),
    createStatusPageApiHandler({ config, db, isInstanceAdmin }),
    createAbuseReportsApiHandler({ config, db, isInstanceAdmin }),
    createDangerousFilesApiHandler({ config, db, isInstanceAdmin }),
    createUsageApiHandler({ config, db, isInstanceAdmin }),
    createBillingApiHandler({ config, db, isInstanceAdmin }),
    createInstanceSettingsApiHandler({ config, db, isInstanceAdmin }),
  ];
  const app = createApp({ config, db });

  const server = http.createServer(async (req, res) => {
    if (await instanceAdminApi(req, res)) return;
    for (const handler of delegated) if (await handler(req, res)) return;
    return app(req, res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const origin = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${origin}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'operator@kuklabs.com', password: 'secure-test-password' }),
  });
  assert.equal(login.status, 200);
  return { origin, cookie: login.headers.get('set-cookie').split(';')[0] };
}

const OPERATOR_ROUTES = [
  '/api/instance-admin/abuse/cases?status=open',
  '/api/instance-admin/abuse/appeals?status=open',
  '/api/instance-admin/abuse/disabled',
  '/api/instance-admin/maintenance/windows',
  '/api/instance-admin/status/incidents',
  '/api/instance-admin/support-access',
  '/api/instance-admin/blocked-content',
  '/api/instance-admin/usage',
  '/api/instance-admin/usage/history',
  '/api/instance-admin/billing/events',
  '/api/instance-admin/integrations',
];

test('every operator route reaches the handler that owns it', async (t) => {
  const { origin, cookie } = await instance(t);
  for (const route of OPERATOR_ROUTES) {
    const response = await fetch(`${origin}${route}`, { headers: { Cookie: cookie } });
    assert.equal(response.status, 200, `${route} answered ${response.status}`);
    const payload = await response.json();
    assert.ok(Object.keys(payload).length, `${route} returned nothing`);
  }
});

test('the panel keeps its own status route', async (t) => {
  // `/api/instance-admin/status` is how the panel finds out whether the session
  // is an operator. Only `status/incidents` belongs to the status page, and
  // delegating the shorter path would hide the panel from everybody.
  const { origin, cookie } = await instance(t);
  const response = await fetch(`${origin}/api/instance-admin/status`, { headers: { Cookie: cookie } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { instanceAdmin: true, email: 'operator@kuklabs.com' });
});

test('a genuinely unknown operator route is still a 404', async (t) => {
  // The delegation must not turn the chain into a catch-all that answers 200
  // for anything under the prefix.
  const { origin, cookie } = await instance(t);
  const response = await fetch(`${origin}/api/instance-admin/nothing-here`, { headers: { Cookie: cookie } });
  assert.equal(response.status, 404);
});

test('delegated routes still refuse a caller who is not an operator', async (t) => {
  const { origin } = await instance(t);
  for (const route of OPERATOR_ROUTES) {
    const response = await fetch(`${origin}${route}`);
    assert.equal(response.status, 401, `${route} answered ${response.status} while signed out`);
  }
});

test('the sign-in shell does not send the panel back to the dashboard', async () => {
  // `renderCurrentRoute` resets any route it does not recognise to `#/`. That
  // made the panel unreachable: the sidebar link set the hash, the reset put it
  // back, and nothing could paint. Source-level, because `app.js` boots on
  // import and there is no DOM harness here — but the reset is one line, and
  // deleting the guard above it is exactly how this returns.
  const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const guard = source.indexOf('EXTENSION_ROUTES.has(first)');
  const reset = source.indexOf("navigate('#/');");
  assert.ok(guard > 0, 'app.js no longer allows extension routes');
  assert.ok(guard < reset, 'the reset runs before the extension routes are allowed');
  assert.match(source, /EXTENSION_ROUTES = new Set\(\[[^\]]*'instance-admin'/);
});
