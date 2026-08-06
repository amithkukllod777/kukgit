import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { openDatabase, seedCore, uid } from '../src/db.mjs';
import { createBareRepository } from '../src/git.mjs';
import { listIssueComments, migrateIssueComments } from '../src/issue-comments.mjs';
import { labelsForIssue, listLabels, listMilestones } from '../src/issue-taxonomy.mjs';
import {
  ISSUE_IMPORT_LIMITS,
  importForgeIssues,
  listForgeIssues,
  migrateImportedIssues,
  sqliteTime,
} from '../src/forge-issues.mjs';

/**
 * Bringing an issue tracker across.
 *
 * A mirror clone moves every commit and none of the argument about why. These
 * cover the parts that decide whether the argument survives intact: that pull
 * requests do not end up in the bug tracker, that comments find their issue,
 * that nobody is invented to own them, and that a number in an imported body
 * still means what it meant.
 */

function issue(number, overrides = {}) {
  return {
    number,
    title: `Issue ${number}`,
    body: `Body of ${number}`,
    state: 'open',
    user: { login: 'octocat' },
    created_at: '2024-03-01T09:00:00Z',
    updated_at: '2024-03-02T09:00:00Z',
    labels: [],
    milestone: null,
    assignee: null,
    ...overrides,
  };
}

function comment(number, body, login = 'hubber') {
  return {
    issue_url: `https://api.github.com/repos/acme/thing/issues/${number}`,
    body,
    user: { login },
    created_at: '2024-03-03T09:00:00Z',
  };
}

function forge(handler) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const result = handler(url, calls.length);
    return new Response(JSON.stringify(result.body ?? []), {
      status: result.status ?? 200,
      headers: { 'Content-Type': 'application/json', ...(result.headers ?? {}) },
    });
  };
  return { fetchImpl, calls };
}

function workspace(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-issue-import-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
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
  migrateIssueComments(db);
  migrateImportedIssues(db);
  const organization = db.prepare("SELECT id, slug FROM organizations WHERE slug = 'kuklabs'").get();
  const actor = db.prepare('SELECT id FROM users LIMIT 1').get();
  const repositoryId = uid('repo');
  db.prepare('INSERT INTO repositories (id, organization_id, slug, name, visibility, created_by) VALUES (?, ?, ?, ?, ?, ?)')
    .run(repositoryId, organization.id, 'thing', 'Thing', 'private', actor.id);
  createBareRepository(config, organization.slug, 'thing');
  return { config, db, organization, actor, repositoryId };
}

test('GitHub time becomes SQLite time', async () => {
  // Storing ISO 8601 in a column whose other rows are `YYYY-MM-DD HH:MM:SS`
  // makes every comparison and sort silently wrong.
  assert.equal(sqliteTime('2024-03-01T09:00:00Z'), '2024-03-01 09:00:00');
  assert.equal(sqliteTime('not a date'), null);
  assert.equal(sqliteTime(null), null);
});

test('pull requests are counted and left behind', async () => {
  const { fetchImpl } = forge((url) => {
    if (url.includes('/issues?')) {
      return { body: [issue(1), { ...issue(2), pull_request: { url: 'x' } }, issue(3)] };
    }
    return { body: [] };
  });

  const listing = await listForgeIssues({ forge: 'github', owner: 'acme', repo: 'thing' }, { fetchImpl });

  // They share a number space with issues, and a pull request whose branches
  // are long gone cannot become a KukGit pull request. Putting it in the bug
  // tracker instead would be worse than leaving it.
  assert.deepEqual(listing.issues.map((entry) => entry.number), [1, 3]);
  assert.equal(listing.pullRequests, 1);
});

test('comments are read in one list and land on the right issue', async () => {
  const { fetchImpl, calls } = forge((url) => {
    if (url.includes('/issues?')) return { body: [issue(1), issue(2)] };
    if (url.includes('/issues/comments')) return { body: [comment(2, 'on two'), comment(1, 'on one'), comment(99, 'on a pull request')] };
    return { body: [] };
  });

  const listing = await listForgeIssues({ forge: 'github', owner: 'acme', repo: 'thing' }, { fetchImpl });

  assert.deepEqual(listing.issues.find((entry) => entry.number === 1).comments.map((c) => c.body), ['on one']);
  assert.deepEqual(listing.issues.find((entry) => entry.number === 2).comments.map((c) => c.body), ['on two']);
  // A comment whose issue is not in the list belongs to a pull request. There
  // is nothing to attach it to, and inventing somewhere would be worse.
  assert.equal(listing.commentCount, 2);
  // Two hundred issues must not cost two hundred requests.
  assert.equal(calls.filter((url) => url.includes('/issues/comments')).length, 1);
});

test("GitHub's label, milestone and assignee shapes are read", async () => {
  const { fetchImpl } = forge((url) => {
    if (url.includes('/issues?')) {
      return {
        body: [issue(1, {
          labels: [{ name: 'bug', color: 'D73A4A', description: 'Something is broken' }, { name: 'area/api' }],
          milestone: { title: 'v1.0', description: 'First release', due_on: '2024-06-01T00:00:00Z', state: 'open' },
          assignee: { login: 'octocat' },
        })],
      };
    }
    return { body: [] };
  });

  const listing = await listForgeIssues({ forge: 'github', owner: 'acme', repo: 'thing' }, { fetchImpl });
  const [entry] = listing.issues;

  // GitHub spells it `color` and upper-cases it; KukGit stores `colour`, lower.
  assert.deepEqual(entry.labels.map((label) => `${label.name}:${label.colour}`), ['bug:d73a4a', 'area/api:']);
  assert.equal(entry.milestone.title, 'v1.0');
  assert.match(entry.milestone.dueOn, /^2024-06-01/);
  // A login, not an email — so there is nothing to match a KukGit account
  // against, and the name is carried as text instead.
  assert.equal(entry.assigneeLogin, 'octocat');
});

test('no issues means no comment request at all', async () => {
  const { fetchImpl, calls } = forge(() => ({ body: [] }));
  const listing = await listForgeIssues({ forge: 'github', owner: 'acme', repo: 'thing' }, { fetchImpl });
  assert.equal(listing.issues.length, 0);
  assert.equal(calls.some((url) => url.includes('/issues/comments')), false);
});

test('every page is read, and the page after the last is not asked for', async () => {
  const full = Array.from({ length: ISSUE_IMPORT_LIMITS.perPage }, (_, index) => issue(index + 1));
  const { fetchImpl, calls } = forge((url) => {
    if (url.includes('/issues?')) return url.includes('page=2') ? { body: [issue(999)] } : { body: full };
    return { body: [] };
  });

  const listing = await listForgeIssues({ forge: 'github', owner: 'acme', repo: 'thing' }, { fetchImpl });
  assert.equal(listing.issues.length, ISSUE_IMPORT_LIMITS.perPage + 1);
  assert.equal(calls.filter((url) => url.includes('/issues?') && url.includes('page=')).length, 2);
});

test('a rate limit and a missing repository are told apart', async () => {
  const limited = forge(() => ({ status: 403, body: {}, headers: { 'x-ratelimit-remaining': '0' } }));
  await assert.rejects(
    () => listForgeIssues({ forge: 'github', owner: 'acme', repo: 'thing' }, { fetchImpl: limited.fetchImpl }),
    (error) => { assert.equal(error.code, 'FORGE_RATE_LIMITED'); return true; },
  );

  const missing = forge(() => ({ status: 404, body: {} }));
  await assert.rejects(
    () => listForgeIssues({ forge: 'github', owner: 'acme', repo: 'thing' }, { fetchImpl: missing.fetchImpl }),
    (error) => { assert.equal(error.code, 'FORGE_REPOSITORY_NOT_FOUND'); return true; },
  );
});

test('an owner or repository name cannot escape the path', async () => {
  const { fetchImpl } = forge(() => ({ body: [] }));
  await assert.rejects(() => listForgeIssues({ forge: 'github', owner: 'acme/../../x', repo: 'thing' }, { fetchImpl }), /not valid/);
  await assert.rejects(() => listForgeIssues({ forge: 'github', owner: 'acme', repo: 'a b' }, { fetchImpl }), /not valid/);
});

test('GitLab is refused rather than half-attempted', async () => {
  const { fetchImpl } = forge(() => ({ body: [] }));
  await assert.rejects(
    () => listForgeIssues({ forge: 'gitlab', owner: 'acme', repo: 'thing' }, { fetchImpl }),
    /GitHub only so far/,
  );
});

function listing(overrides = {}) {
  return {
    forge: 'github',
    source: 'github.com/acme/thing',
    pullRequests: 2,
    labelledIssues: 1,
    issues: [
      {
        number: 7, title: 'Login is slow', body: 'It takes eight seconds. See #9.', status: 'open',
        authorLogin: 'octocat', createdAt: '2024-03-01 09:00:00', updatedAt: '2024-03-02 09:00:00',
        labels: [{ name: 'bug', colour: 'd73a4a', description: 'Something is broken' }, { name: 'area/api', colour: '', description: '' }],
        milestone: { title: 'v1.0', description: 'First release', dueOn: '2024-06-01 00:00:00', status: 'open' },
        assigneeLogin: 'octocat',
        comments: [
          { issueNumber: 7, body: 'Reproduced.', authorLogin: 'hubber', createdAt: '2024-03-03 09:00:00' },
          { issueNumber: 7, body: '   ', authorLogin: 'hubber', createdAt: '2024-03-04 09:00:00' },
        ],
      },
      {
        number: 9, title: 'Closed one', body: '', status: 'closed',
        authorLogin: 'someone', createdAt: '2024-04-01 09:00:00', updatedAt: '2024-04-02 09:00:00',
        labels: [{ name: 'bug', colour: 'd73a4a', description: '' }], milestone: { title: 'v1.0' }, assigneeLogin: null,
        comments: [],
      },
    ],
    ...overrides,
  };
}

test('an empty repository keeps the original numbers', async (t) => {
  const { db, actor, repositoryId } = workspace(t);
  const result = importForgeIssues(db, { repositoryId, actorId: actor.id, listing: listing() });

  assert.equal(result.imported, 2);
  assert.equal(result.renumbered, false);
  assert.equal(result.note, null);
  // An imported body full of `#9` references is worth nothing if #9 here is a
  // different issue.
  const numbers = db.prepare('SELECT number FROM issues WHERE repository_id = ? ORDER BY number').all(repositoryId).map((row) => row.number);
  assert.deepEqual(numbers, [7, 9]);
});

test('a repository that already has issues renumbers, and says so', async (t) => {
  const { db, actor, repositoryId } = workspace(t);
  db.prepare('INSERT INTO issues (id, repository_id, number, title, body, author_id) VALUES (?, ?, 1, ?, ?, ?)')
    .run(uid('iss'), repositoryId, 'Ours', '', actor.id);

  const result = importForgeIssues(db, { repositoryId, actorId: actor.id, listing: listing() });

  assert.equal(result.renumbered, true);
  // Silently renumbering half a tracker without saying so is worse than either
  // choice on its own.
  assert.match(result.note, /still point at the old numbering/);
  const numbers = db.prepare('SELECT number FROM issues WHERE repository_id = ? ORDER BY number').all(repositoryId).map((row) => row.number);
  assert.deepEqual(numbers, [1, 2, 3]);
});

test('the original author is recorded and no account is created for them', async (t) => {
  const { db, actor, repositoryId } = workspace(t);
  const usersBefore = db.prepare('SELECT COUNT(*) AS count FROM users').get().count;

  importForgeIssues(db, { repositoryId, actorId: actor.id, listing: listing() });

  const row = db.prepare('SELECT author_id AS authorId, imported_author AS importedAuthor, imported_from AS importedFrom, created_at AS createdAt, status FROM issues WHERE repository_id = ? AND number = 7').get(repositoryId);
  // The row is owned by whoever ran the import; the name shown is whoever wrote
  // it. Creating a user for `octocat` would create somebody who can be assigned
  // work and granted access, and who cannot sign in to object.
  assert.equal(row.authorId, actor.id);
  assert.equal(row.importedAuthor, 'octocat');
  assert.equal(row.importedFrom, 'github.com/acme/thing');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM users').get().count, usersBefore);
  // And the issue keeps the day it was opened, not the day it was moved.
  assert.match(row.createdAt, /^2024-03-01/);
});

test('a closed issue arrives closed', async (t) => {
  const { db, actor, repositoryId } = workspace(t);
  importForgeIssues(db, { repositoryId, actorId: actor.id, listing: listing() });
  assert.equal(db.prepare('SELECT status FROM issues WHERE repository_id = ? AND number = 9').get(repositoryId).status, 'closed');
});

test('comments arrive attributed, dated, and without the blank one', async (t) => {
  const { db, actor, repositoryId } = workspace(t);
  const result = importForgeIssues(db, { repositoryId, actorId: actor.id, listing: listing() });

  const issueId = db.prepare('SELECT id FROM issues WHERE repository_id = ? AND number = 7').get(repositoryId).id;
  const comments = listIssueComments(db, issueId);
  assert.equal(comments.length, 1);
  assert.equal(comments[0].authorName, 'hubber');
  assert.equal(comments[0].imported, true);
  assert.match(comments[0].createdAt, /^2024-03-03/);
  // A single blank reply must not fail an import of four hundred.
  assert.equal(result.comments, 2, 'the count reports what was offered');
});

test('labels arrive, once each, with their colours', async (t) => {
  const { db, actor, repositoryId } = workspace(t);
  const result = importForgeIssues(db, { repositoryId, actorId: actor.id, listing: listing() });

  // `bug` is on both issues. One label, two attachments — not two labels.
  const labels = listLabels(db, repositoryId);
  assert.deepEqual(labels.map((label) => label.name).sort(), ['area/api', 'bug']);
  assert.equal(labels.find((label) => label.name === 'bug').colour, 'd73a4a');
  assert.equal(labels.find((label) => label.name === 'bug').issues, 2);
  // A label with no colour on the far end gets the default rather than failing
  // the whole import.
  assert.equal(labels.find((label) => label.name === 'area/api').colour, '888888');
  assert.equal(result.labels, 2);

  const issueId = db.prepare('SELECT id FROM issues WHERE repository_id = ? AND number = 7').get(repositoryId).id;
  assert.deepEqual(labelsForIssue(db, issueId).map((label) => label.name), ['area/api', 'bug']);
});

test('a milestone shared by two issues is one milestone', async (t) => {
  const { db, actor, repositoryId } = workspace(t);
  const result = importForgeIssues(db, { repositoryId, actorId: actor.id, listing: listing() });

  const milestones = listMilestones(db, repositoryId);
  assert.deepEqual(milestones.map((milestone) => milestone.title), ['v1.0']);
  assert.equal(milestones[0].issues, 2);
  assert.match(milestones[0].dueOn, /^2024-06-01/);
  assert.equal(result.milestones, 1);
  // Both issues point at it.
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM issues WHERE repository_id = ? AND milestone_id IS NOT NULL').get(repositoryId).count, 2);
});

test('an assignee is recorded by name, and no account is created for them', async (t) => {
  const { db, actor, repositoryId } = workspace(t);
  const usersBefore = db.prepare('SELECT COUNT(*) AS count FROM users').get().count;
  const result = importForgeIssues(db, { repositoryId, actorId: actor.id, listing: listing() });

  const row = db.prepare('SELECT imported_assignee AS importedAssignee, assignee_id AS assigneeId FROM issues WHERE repository_id = ? AND number = 7').get(repositoryId);
  // A forge gives a login, not an email, so there is nothing to match a KukGit
  // account against. Inventing one would invent somebody who can be granted
  // access and cannot sign in to object.
  assert.equal(row.importedAssignee, 'octocat');
  assert.equal(row.assigneeId, null);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM users').get().count, usersBefore);
  assert.equal(result.assigneesRecorded, 1);
});

test('what could not come across is reported rather than dropped quietly', async (t) => {
  const { db, actor, repositoryId } = workspace(t);
  const result = importForgeIssues(db, { repositoryId, actorId: actor.id, listing: listing() });
  // KukGit has nowhere to put pull request history. Silence here reads as
  // "everything came across".
  assert.equal(result.pullRequestsSkipped, 2);
});

test('a failed import writes nothing at all', async (t) => {
  const { db, actor, repositoryId } = workspace(t);
  const broken = listing();
  // A comment long past the limit; `addIssueComment` refuses it partway through.
  broken.issues[1].comments = [{ issueNumber: 9, body: 'x'.repeat(20001), authorLogin: 'a', createdAt: '2024-04-03 09:00:00' }];

  assert.throws(() => importForgeIssues(db, { repositoryId, actorId: actor.id, listing: broken }));
  // Half a tracker is worse than none: somebody would re-run the import and get
  // the first half twice.
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM issues WHERE repository_id = ?').get(repositoryId).count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM issue_comments').get().count, 0);
});
