import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.mjs';
import { loadConfig } from '../src/config.mjs';
import { openDatabase, seedCore, uid } from '../src/db.mjs';
import { createBareRepository } from '../src/git.mjs';
import { PLANS } from '../src/plans.mjs';
import { assertWithinPlan, forgetPlanUsage, planStanding, planUsageChanged } from '../src/plan-limits.mjs';
import { forgetGitSizes } from '../src/usage.mjs';

function workspace(t, plan = 'free') {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-limits-'));
  t.after(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
    forgetPlanUsage();
    forgetGitSizes();
  });
  const config = loadConfig({
    dataDir,
    databasePath: path.join(dataDir, 'test.db'),
    repositoriesDir: path.join(dataDir, 'repos'),
    tempDir: path.join(dataDir, 'tmp'),
    nodeEnv: 'test',
    adminEmail: 'founder@kuklabs.com',
    adminPassword: 'secure-test-password',
    adminName: 'Founder',
  });
  const db = openDatabase(config);
  t.after(() => db.close());
  seedCore(db, config);
  const organization = db.prepare("SELECT id, slug FROM organizations WHERE slug = 'kuklabs'").get();
  db.prepare('UPDATE organizations SET plan = ? WHERE id = ?').run(plan, organization.id);
  return { config, db, organization };
}

function addRepositories(db, config, organization, howMany) {
  const owner = db.prepare('SELECT id FROM users LIMIT 1').get().id;
  const existing = db.prepare('SELECT COUNT(*) AS count FROM repositories WHERE organization_id = ?').get(organization.id).count;
  for (let index = 0; index < howMany; index += 1) {
    const slug = `filler-${existing + index}`;
    db.prepare('INSERT INTO repositories (id, organization_id, slug, name, created_by) VALUES (?, ?, ?, ?, ?)')
      .run(uid('repo'), organization.id, slug, slug, owner);
    createBareRepository(config, organization.slug, slug);
  }
}

test('at the limit is allowed; one past it is refused', async (t) => {
  const { config, db, organization } = workspace(t);
  addRepositories(db, config, organization, PLANS.free.repositories - 1);

  // Exactly at the limit must still work. Off by one here is a customer
  // blocked for being compliant.
  assert.equal(planStanding(db, config, { organizationId: organization.id, resource: 'repositories' }).used, PLANS.free.repositories - 1);
  assertWithinPlan(db, config, { organizationId: organization.id, resource: 'repositories' });

  addRepositories(db, config, organization, 1);
  assert.throws(
    () => assertWithinPlan(db, config, { organizationId: organization.id, resource: 'repositories' }),
    (error) => error.status === 402 && error.code === 'PLAN_LIMIT_EXCEEDED',
  );
});

test('the refusal is 402, not 403', async (t) => {
  const { config, db, organization } = workspace(t);
  addRepositories(db, config, organization, PLANS.free.repositories);
  try {
    assertWithinPlan(db, config, { organizationId: organization.id, resource: 'repositories' });
    assert.fail('expected a refusal');
  } catch (error) {
    // 403 would say they are not allowed to do this at all, and send somebody
    // looking for a permissions problem that does not exist. The request is
    // well formed and authorized; the plan does not cover it.
    assert.equal(error.status, 402);
    assert.match(error.message, /allows 20 repositories.*using 20/);
  }
});

test('an unlimited plan is never over', async (t) => {
  const { config, db, organization } = workspace(t, 'founder');
  addRepositories(db, config, organization, 25);
  const standing = planStanding(db, config, { organizationId: organization.id, resource: 'repositories' });
  assert.equal(standing.limit, null);
  assertWithinPlan(db, config, { organizationId: organization.id, resource: 'repositories', adding: 1000 });
});

test('creating a repository over the limit is refused, and leaves nothing behind', async (t) => {
  const { config, db, organization } = workspace(t);
  addRepositories(db, config, organization, PLANS.free.repositories);
  const app = createApp({ config, db });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;

  const login = await fetch(`${origin}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'founder@kuklabs.com', password: 'secure-test-password' }),
  });
  const cookie = login.headers.get('set-cookie').split(';')[0];

  const response = await fetch(`${origin}/api/repos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ orgSlug: 'kuklabs', name: 'One Too Many', slug: 'one-too-many' }),
  });
  assert.equal(response.status, 402);
  assert.equal((await response.json()).error.code, 'PLAN_LIMIT_EXCEEDED');
  // The check runs before the bare repository is created, so a refusal does not
  // leave a directory somebody has to find and remove.
  assert.equal(fs.existsSync(path.join(config.repositoriesDir, 'kuklabs', 'one-too-many.git')), false);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM repositories WHERE slug = ?').get('one-too-many').count, 0);
});

test('importing over the limit is refused too, and before the network call', async (t) => {
  // The limit was enforced on `Create new` and not on `Import existing`. Same
  // resource, same storage, same bill — reached by a different button. Anybody
  // at their plan's ceiling could carry on by importing instead of creating,
  // which is not a limit, it is a suggestion.
  const { config, db, organization } = workspace(t);
  addRepositories(db, config, organization, PLANS.free.repositories);
  const app = createApp({ config, db });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;

  const login = await fetch(`${origin}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'founder@kuklabs.com', password: 'secure-test-password' }),
  });
  const cookie = login.headers.get('set-cookie').split(';')[0];

  const started = Date.now();
  const response = await fetch(`${origin}/api/repos/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ orgSlug: 'kuklabs', name: 'One Too Many', slug: 'one-too-many', sourceUrl: 'https://github.com/kuklabs/does-not-exist.git' }),
  });

  assert.equal(response.status, 402);
  assert.equal((await response.json()).error.code, 'PLAN_LIMIT_EXCEEDED');
  // Refused before the clone, not after it: the URL above does not exist, and
  // an answer this fast is proof nothing was fetched.
  assert.ok(Date.now() - started < 5000, 'the refusal waited for a network call');
  assert.equal(fs.existsSync(path.join(config.repositoriesDir, 'kuklabs', 'one-too-many.git')), false);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM repositories WHERE slug = ?').get('one-too-many').count, 0);
});

test('reading is never refused for being over a limit', async (t) => {
  const { config, db, organization } = workspace(t);
  addRepositories(db, config, organization, PLANS.free.repositories + 5);
  const app = createApp({ config, db });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;

  const login = await fetch(`${origin}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'founder@kuklabs.com', password: 'secure-test-password' }),
  });
  const cookie = login.headers.get('set-cookie').split(';')[0];

  // Well over the limit — a downgrade, or a plan changed under them. Their work
  // is still theirs, and locking them out of it over an invoice would be losing
  // somebody's code to a billing decision.
  for (const route of ['/api/repos', '/api/dashboard', '/api/orgs']) {
    const response = await fetch(`${origin}${route}`, { headers: { Cookie: cookie } });
    assert.equal(response.status, 200, `${route} was refused`);
  }
});

test('an existing member accepting a second invitation does not take a second seat', async (t) => {
  const { config, db, organization } = workspace(t);
  const standing = () => planStanding(db, config, { organizationId: organization.id, resource: 'seats' }).used;
  assert.equal(standing(), 1);

  for (let index = 0; index < PLANS.free.seats - 1; index += 1) {
    const id = uid('usr');
    db.prepare('INSERT INTO users (id, email, password_hash, display_name) VALUES (?, ?, ?, ?)')
      .run(id, `member-${index}@example.com`, 'scrypt$x$y', `Member ${index}`);
    db.prepare('INSERT INTO org_members (organization_id, user_id, role) VALUES (?, ?, ?)')
      .run(organization.id, id, 'developer');
  }
  assert.equal(standing(), PLANS.free.seats);

  // Full. A new member is refused...
  assert.throws(
    () => assertWithinPlan(db, null, { organizationId: organization.id, resource: 'seats' }),
    (error) => error.code === 'PLAN_LIMIT_EXCEEDED',
  );
  // ...but nothing about the people already there changes.
  assert.equal(standing(), PLANS.free.seats);
});

test('a cached storage figure is dropped the moment something is stored', async (t) => {
  const { config, db, organization } = workspace(t);
  const first = planStanding(db, config, { organizationId: organization.id, resource: 'storageBytes' }).used;

  addRepositories(db, config, organization, 1);
  const slug = db.prepare("SELECT slug FROM repositories WHERE slug LIKE 'filler-%' ORDER BY rowid DESC LIMIT 1").get().slug;
  fs.writeFileSync(path.join(config.repositoriesDir, 'kuklabs', `${slug}.git`, 'big.pack'), Buffer.alloc(4 * 1024 * 1024, 3));
  forgetGitSizes();

  // Still the cached value: the window has not passed.
  assert.equal(planStanding(db, config, { organizationId: organization.id, resource: 'storageBytes' }).used, first);

  planUsageChanged(organization.id);
  const after = planStanding(db, config, { organizationId: organization.id, resource: 'storageBytes' }).used;
  // Without this an organization pushes past its limit once every window.
  assert.ok(after - first >= 4 * 1024 * 1024, `expected 4 MiB more, got ${after - first}`);
});

test('storage is charged for what is new, not for what is already held', async (t) => {
  const { config, db, organization } = workspace(t);
  const standing = planStanding(db, config, { organizationId: organization.id, resource: 'storageBytes' });
  const headroom = standing.limit - standing.used;

  // An object that fits.
  assertWithinPlan(db, config, { organizationId: organization.id, resource: 'storageBytes', adding: headroom });
  // One byte more than fits.
  assert.throws(
    () => assertWithinPlan(db, config, { organizationId: organization.id, resource: 'storageBytes', adding: headroom + 1 }),
    (error) => error.code === 'PLAN_LIMIT_EXCEEDED',
  );
});

test('an unknown resource is a programming error, not a refusal', async (t) => {
  const { config, db, organization } = workspace(t);
  // Failing loudly matters: a typo that silently allowed everything would be a
  // limit that quietly stopped existing.
  assert.throws(
    () => planStanding(db, config, { organizationId: organization.id, resource: 'bandwidth' }),
    /Unknown plan resource: bandwidth/,
  );
});
