import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { openDatabase, seedCore, uid } from '../src/db.mjs';
import { getEffectiveRepositoryAccess, migrateRepositoryAccess, requireRepositoryAccess } from '../src/repository-access.mjs';
import { surfaceForRequest } from '../src/rate-limit.mjs';
import { handleGitHttp, repositoryDisabled } from '../src/git-http.mjs';
import { listNotifications } from '../src/notifications.mjs';
import {
  answerAppeal,
  appealDisable,
  disabledRepositories,
  fileAbuseReport,
  listAbuseAppeals,
  listAbuseCases,
  migrateAbuseReports,
  reinstateRepository,
  resolveAbuseCase,
} from '../src/abuse-reports.mjs';

async function migrateEverything(db) {
  const dir = new URL('../src/', import.meta.url);
  const files = fs.readdirSync(dir).filter((name) => name.endsWith('.mjs')).sort();
  const deferred = [];
  for (const file of files) {
    let module;
    try { module = await import(new URL(file, dir).href); } catch { continue; }
    for (const [name, value] of Object.entries(module)) {
      if (!/^migrate[A-Z]/.test(name) || typeof value !== 'function' || value.length !== 1) continue;
      try { value(db); } catch { deferred.push(value); }
    }
  }
  for (const migrate of deferred) {
    try { migrate(db); } catch { /* not applicable */ }
  }
}

async function setup(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-abuse-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const config = loadConfig({
    dataDir,
    databasePath: path.join(dataDir, 'kukgit.db'),
    repositoriesDir: path.join(dataDir, 'repos'),
    tempDir: path.join(dataDir, 'tmp'),
    nodeEnv: 'test',
    adminEmail: 'owner@example.com',
    adminPassword: 'secure-owner-password',
    adminName: 'Owner',
  });
  const db = openDatabase(config);
  t.after(() => db.close());
  await migrateEverything(db);
  migrateRepositoryAccess(db);
  migrateAbuseReports(db);
  const { userId: ownerId } = seedCore(db, config);

  const orgId = uid('org');
  db.prepare('INSERT INTO organizations (id, slug, name, created_by) VALUES (?, ?, ?, ?)').run(orgId, 'acme', 'Acme', ownerId);
  db.prepare("INSERT INTO org_members (organization_id, user_id, role) VALUES (?, ?, 'owner')").run(orgId, ownerId);
  const repositoryId = uid('repo');
  db.prepare(`
    INSERT INTO repositories (id, organization_id, slug, name, description, visibility, default_branch, created_by)
    VALUES (?, ?, 'app', 'App', '', 'private', 'main', ?)
  `).run(repositoryId, orgId, ownerId);

  return { config, db, ownerId, orgId, repositoryId };
}

// A report arrives from somebody with no session, which is the case that matters.
function anonymousRequest(address = '203.0.113.7') {
  return { headers: {}, socket: { remoteAddress: address } };
}

const detail = 'This repository is serving a fake bank login page at /assets/index.html.';

function report(context, overrides = {}) {
  return fileAbuseReport(context.db, context.config, overrides.req ?? anonymousRequest(), {
    orgSlug: 'acme', repoSlug: 'app', category: 'phishing', detail, ...overrides,
  });
}

test('a report needs no account, and says nothing back about the target', async (t) => {
  const context = await setup(t);

  const filed = report(context);
  assert.equal(filed.received, true);

  // The same answer for a repository that does not exist. Otherwise the form is
  // an existence oracle for every private repository here, usable by anybody.
  const missing = report(context, { repoSlug: 'not-a-real-repository' });
  assert.equal(missing.received, true);
  const cases = listAbuseCases(context.db);
  assert.equal(cases.length, 2);
  assert.equal(cases.find((record) => record.target.label === 'acme/not-a-real-repository').target.type, 'unknown');
});

test('reporting does not disable anything', async (t) => {
  const context = await setup(t);
  for (let index = 0; index < 20; index += 1) report(context, { req: anonymousRequest(`198.51.100.${index}`) });

  // An automatic takedown on report is a weapon anybody can point at any
  // repository, and it would be used that way within a week.
  assert.equal(listAbuseCases(context.db)[0].reportCount, 20);
  assert.equal(getEffectiveRepositoryAccess(context.db, { userId: context.ownerId, orgSlug: 'acme', repoSlug: 'app' }).permission, 'admin');
  assert.deepEqual(disabledRepositories(context.db), []);
});

test('many reports about one thing are one case, and the sources are counted', async (t) => {
  const context = await setup(t);
  for (let index = 0; index < 5; index += 1) report(context);
  report(context, { req: anonymousRequest('198.51.100.42') });
  report(context, { category: 'malware', detail: 'The release binary in this repository is a known trojan dropper.' });

  const cases = listAbuseCases(context.db);
  // One case per target and category: five hundred reports about one repository
  // is one thing to look at, not five hundred.
  assert.equal(cases.length, 2);
  const phishing = cases.find((record) => record.category === 'phishing');
  assert.equal(phishing.reportCount, 6);
  // "Six reports" and "six reports from one place" must not read the same.
  assert.equal(phishing.distinctReporters, 2);
});

test('disabling makes a repository unreachable for everybody, owners included', async (t) => {
  const context = await setup(t);
  report(context);
  const [record] = listAbuseCases(context.db);

  resolveAbuseCase(context.db, context.config, {
    caseId: record.id, action: 'disable', resolution: 'Confirmed phishing page served from the default branch.', userId: context.ownerId,
  });

  const access = getEffectiveRepositoryAccess(context.db, { userId: context.ownerId, orgSlug: 'acme', repoSlug: 'app' });
  assert.equal(access.permission, 'none');
  assert.deepEqual(access.sources, []);
  assert.match(access.disabled.reason, /Confirmed phishing/);
  // A member is told what happened and why. A repository that stops working with
  // no message is indistinguishable from an outage, and its owner is the only
  // person who can fix what caused it.
  assert.throws(
    () => requireRepositoryAccess(context.db, context.ownerId, { orgSlug: 'acme', repoSlug: 'app' }),
    /disabled pending an abuse review\. Confirmed phishing/,
  );
  // A stranger gets the same 404 they would get for a private repository.
  // "Disabled for abuse" is not a fact to hand to somebody passing by.
  const stranger = uid('usr');
  context.db.prepare('INSERT INTO users (id, email, password_hash, display_name) VALUES (?, ?, ?, ?)')
    .run(stranger, 'stranger@example.com', 'x', 'Stranger');
  assert.throws(
    () => requireRepositoryAccess(context.db, stranger, { orgSlug: 'acme', repoSlug: 'app' }),
    /Repository not found/,
  );
  assert.equal(disabledRepositories(context.db)[0].repoSlug, 'app');
});

test('the owners are told, with the operator\'s reason in full', async (t) => {
  const context = await setup(t);
  report(context);
  resolveAbuseCase(context.db, context.config, {
    caseId: listAbuseCases(context.db)[0].id,
    action: 'disable',
    resolution: 'Confirmed phishing page served from the default branch.',
    userId: context.ownerId,
  });

  const [notice] = listNotifications(context.db, context.ownerId).notifications;
  assert.match(notice.title, /acme\/app has been disabled/);
  // Verbatim, because "policy violation" leaves somebody unable to fix
  // anything — and they are the only person who can.
  assert.match(notice.body, /Confirmed phishing page served from the default branch\./);
  assert.match(notice.body, /Nothing has been deleted/);
  assert.match(notice.body, /appeal/);

  reinstateRepository(context.db, context.config, {
    orgSlug: 'acme', repoSlug: 'app', reason: 'The owner removed the page within the hour.', userId: context.ownerId,
  });
  assert.match(listNotifications(context.db, context.ownerId).notifications[0].title, /is available again/);
});

test('an appeal reaches an operator even though the repository is disabled', async (t) => {
  const context = await setup(t);
  report(context);
  resolveAbuseCase(context.db, context.config, {
    caseId: listAbuseCases(context.db)[0].id, action: 'disable', resolution: 'Confirmed phishing page served from the default branch.', userId: context.ownerId,
  });

  // Authorized on the organization, not the repository. A route that resolved
  // repository access would be refused by the very disable it exists to answer.
  const appeal = appealDisable(context.db, {
    orgSlug: 'acme', repoSlug: 'app', body: 'That page is a security training exercise, documented in the README since March.', userId: context.ownerId,
  });
  assert.equal(appeal.status, 'open');
  assert.equal(listAbuseAppeals(context.db)[0].repository, 'acme/app');

  // Filing ten does not make anybody read it faster.
  assert.throws(() => appealDisable(context.db, {
    orgSlug: 'acme', repoSlug: 'app', body: 'Asking again in case somebody missed the first one entirely.', userId: context.ownerId,
  }), /already open/);

  answerAppeal(context.db, context.config, {
    appealId: appeal.id, answer: 'The README does document it, but the page still collects live credentials.', userId: context.ownerId,
  });
  assert.equal(listAbuseAppeals(context.db, { status: 'open' }).length, 0);
  assert.match(listNotifications(context.db, context.ownerId).notifications[0].title, /appeal about .* has been answered/);
});

test('reinstating answers the open appeal rather than leaving somebody waiting', async (t) => {
  const context = await setup(t);
  report(context);
  resolveAbuseCase(context.db, context.config, {
    caseId: listAbuseCases(context.db)[0].id, action: 'disable', resolution: 'Confirmed phishing page served from the default branch.', userId: context.ownerId,
  });
  appealDisable(context.db, {
    orgSlug: 'acme', repoSlug: 'app', body: 'That page is a security training exercise, documented in the README since March.', userId: context.ownerId,
  });

  reinstateRepository(context.db, context.config, {
    orgSlug: 'acme', repoSlug: 'app', reason: 'The appeal is right; the page is a documented exercise.', userId: context.ownerId,
  });
  const [answered] = listAbuseAppeals(context.db, { status: 'all' });
  // Waiting for a reply to a question already decided in your favour is the
  // worst outcome available here.
  assert.equal(answered.status, 'answered');
  assert.match(answered.answer, /documented exercise/);
});

test('only an organization admin may appeal', async (t) => {
  const context = await setup(t);
  report(context);
  resolveAbuseCase(context.db, context.config, {
    caseId: listAbuseCases(context.db)[0].id, action: 'disable', resolution: 'Confirmed phishing page served from the default branch.', userId: context.ownerId,
  });
  const stranger = uid('usr');
  context.db.prepare('INSERT INTO users (id, email, password_hash, display_name) VALUES (?, ?, ?, ?)')
    .run(stranger, 'stranger@example.com', 'x', 'Stranger');

  assert.throws(() => appealDisable(context.db, {
    orgSlug: 'acme', repoSlug: 'app', body: 'I would like this repository back even though it is not mine.', userId: stranger,
  }), /admin access is required/);
});

test('a disabled repository comes back, and the bytes were never touched', async (t) => {
  const context = await setup(t);
  report(context);
  resolveAbuseCase(context.db, context.config, {
    caseId: listAbuseCases(context.db)[0].id, action: 'disable', resolution: 'Confirmed phishing page served from the default branch.', userId: context.ownerId,
  });
  // The row is still there with everything on it. The alternative to a
  // reversible disable is doing nothing, or deleting somebody's work on the
  // strength of a report form.
  assert.equal(context.db.prepare('SELECT name FROM repositories WHERE id = ?').get(context.repositoryId).name, 'App');

  reinstateRepository(context.db, context.config, {
    orgSlug: 'acme', repoSlug: 'app', reason: 'The owner removed the page and the report was about a fork.', userId: context.ownerId,
  });
  assert.equal(getEffectiveRepositoryAccess(context.db, { userId: context.ownerId, orgSlug: 'acme', repoSlug: 'app' }).permission, 'admin');
  assert.deepEqual(disabledRepositories(context.db), []);
});

test('every outcome needs writing down, including a dismissal', async (t) => {
  const context = await setup(t);
  report(context);
  const [record] = listAbuseCases(context.db);

  // "We looked and it was fine" is the sentence somebody needs when the same
  // repository is reported again next month.
  assert.throws(() => resolveAbuseCase(context.db, context.config, { caseId: record.id, action: 'dismiss', resolution: 'no', userId: context.ownerId }), /at least 20 characters/);
  assert.throws(() => resolveAbuseCase(context.db, context.config, { caseId: record.id, action: 'delete', resolution: 'A perfectly adequate written outcome.', userId: context.ownerId }), /Action must be one of/);

  const dismissed = resolveAbuseCase(context.db, context.config, {
    caseId: record.id, action: 'dismiss', resolution: 'The page is a security training exercise documented in the README.', userId: context.ownerId,
  });
  assert.equal(dismissed.status, 'dismissed');
  assert.throws(() => resolveAbuseCase(context.db, context.config, { caseId: record.id, action: 'disable', resolution: 'Changing my mind after the fact.', userId: context.ownerId }), /already resolved/);
  assert.equal(listAbuseCases(context.db, { status: 'open' }).length, 0);
  assert.equal(listAbuseCases(context.db, { status: 'all' }).length, 1);
});

test('a report is refused unless it says something', async (t) => {
  const context = await setup(t);
  assert.throws(() => report(context, { detail: 'bad' }), /at least 30 characters/);
  assert.throws(() => report(context, { category: 'annoying' }), /Category must be one of/);
  assert.throws(() => report(context, { orgSlug: '../../etc' }), /Name the organization/);
  assert.throws(() => report(context, { reporterEmail: 'not-an-address' }), /not valid/);
  assert.equal(listAbuseCases(context.db, { status: 'all' }).length, 0);
});

test('the reporter is a fingerprint, not an address', async (t) => {
  const context = await setup(t);
  report(context, { req: anonymousRequest('203.0.113.99'), reporterEmail: 'finder@example.com' });

  const [record] = listAbuseCases(context.db);
  const serialised = JSON.stringify(record);
  // An abuse queue full of raw addresses is a log of people who reported things,
  // which is a list worth stealing.
  assert.doesNotMatch(serialised, /203\.0\.113\.99/);
  assert.match(record.reports[0].reporter, /^[0-9a-f]{16}$/);
  // A contact address the reporter chose to give is kept for the operator, and
  // is never part of what the reported party would ever see.
  assert.equal(record.reports[0].reporterEmail, 'finder@example.com');
});

test('a disabled public repository is refused by Git itself, with no credential in play', async (t) => {
  const context = await setup(t);
  context.db.prepare("UPDATE repositories SET visibility = 'public' WHERE id = ?").run(context.repositoryId);
  report(context);
  resolveAbuseCase(context.db, context.config, {
    caseId: listAbuseCases(context.db)[0].id, action: 'disable', resolution: 'Confirmed phishing page served from the default branch.', userId: context.ownerId,
  });

  // Found on a live instance: a public repository is served over Git with no
  // authorization at all, so a check inside the permission resolver never ran
  // for the one case that matters most. Hosted malware is public on purpose.
  assert.equal(repositoryDisabled(context.db, context.repositoryId), true);

  const written = [];
  const res = {
    writeHead(status) { written.push(status); return this; },
    end(body) { written.push(String(body ?? '')); return this; },
    setHeader() { return this; },
  };
  await handleGitHttp(
    { method: 'GET', url: '/git/acme/app.git/info/refs?service=git-upload-pack', headers: {}, socket: {} },
    res,
    { config: context.config, db: context.db, pathname: '/git/acme/app.git/info/refs', queryString: 'service=git-upload-pack' },
  );
  assert.equal(written[0], 403);
  assert.match(written[1], /disabled pending an abuse review/);
});

test('the report form has its own rate-limit surface', async (t) => {
  await setup(t);
  // The general API surface is 600/min. A form reachable by anybody, where a
  // flood against one repository is itself the attack, does not belong there.
  assert.equal(surfaceForRequest('POST', '/api/abuse/reports'), 'abuse');
  assert.equal(surfaceForRequest('GET', '/api/abuse/reports'), 'abuse');
  assert.equal(surfaceForRequest('POST', '/api/repos/acme/app/issues'), 'api');
});
