import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { openDatabase, seedCore, uid } from '../src/db.mjs';
import { createSession } from '../src/auth.mjs';
import { createBareRepository } from '../src/git.mjs';
import { migrateCollaboration } from '../src/collaboration.mjs';
import { migrateRepositoryAccess } from '../src/repository-access.mjs';
import {
  assignIssue,
  createIssueTaxonomyApiHandler,
  ensureLabel,
  ensureMilestone,
  labelsForIssue,
  listLabels,
  migrateIssueTaxonomy,
  normalizeColour,
  normalizeLabelName,
  setIssueLabels,
} from '../src/issue-taxonomy.mjs';

/**
 * Labels, milestones and who an issue is on.
 *
 * The tests that matter are the ones about scope. A label belongs to a
 * repository, and an id supplied by a caller must not be able to reach across
 * into another one — that is how one team's taxonomy ends up on another team's
 * issue. And an assignee has to be somebody who can open what they were given.
 */

function workspace(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-taxonomy-'));
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
  migrateCollaboration(db);
  migrateRepositoryAccess(db);
  migrateIssueTaxonomy(db);

  const organization = db.prepare("SELECT id, slug FROM organizations WHERE slug = 'kuklabs'").get();
  const founder = db.prepare('SELECT id FROM users LIMIT 1').get();

  const repository = (slug) => {
    const id = uid('repo');
    db.prepare('INSERT INTO repositories (id, organization_id, slug, name, visibility, created_by) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, organization.id, slug, slug, 'private', founder.id);
    createBareRepository(config, organization.slug, slug);
    return id;
  };
  const issue = (repositoryId, number = 1) => {
    const id = uid('iss');
    db.prepare('INSERT INTO issues (id, repository_id, number, title, body, author_id) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, repositoryId, number, `Issue ${number}`, '', founder.id);
    return id;
  };
  const member = (email, role) => {
    const id = uid('user');
    db.prepare("INSERT INTO users (id, email, display_name, password_hash) VALUES (?, ?, ?, '')").run(id, email, email.split('@')[0]);
    db.prepare('INSERT INTO org_members (organization_id, user_id, role) VALUES (?, ?, ?)').run(organization.id, id, role);
    return id;
  };
  return { config, db, organization, founder, repository, issue, member };
}

async function server(t, { config, db }) {
  const api = createIssueTaxonomyApiHandler({ config, db });
  const httpServer = http.createServer(async (req, res) => {
    if (await api(req, res)) return;
    res.writeHead(404).end();
  });
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => httpServer.close(resolve)));
  const origin = `http://127.0.0.1:${httpServer.address().port}`;
  const as = (userId) => ({ 'Content-Type': 'application/json', Cookie: `kukgit_session=${createSession(db, userId).token}` });
  return { origin, as };
}

test('a label name is checked, and a colour is normalized', async () => {
  assert.equal(normalizeLabelName('  needs design  '), 'needs design');
  assert.equal(normalizeLabelName('area/api'), 'area/api');
  assert.throws(() => normalizeLabelName(''), /needs a name/);
  assert.throws(() => normalizeLabelName('<script>'), /may contain/);
  assert.equal(normalizeColour('#D73A4A'), 'd73a4a');
  assert.equal(normalizeColour(''), '888888');
  assert.throws(() => normalizeColour('red'), /six hexadecimal/);
});

test('a label is created once per name, not once per use', async (t) => {
  const { db, repository } = workspace(t);
  const repositoryId = repository('one');
  const first = ensureLabel(db, repositoryId, { name: 'bug', colour: 'd73a4a' });
  const second = ensureLabel(db, repositoryId, { name: 'bug', colour: '000000' });
  // An import sees a label attached to every issue that carries it, not as a
  // list. One row per use would be one row per issue.
  assert.equal(first, second);
  assert.equal(listLabels(db, repositoryId).length, 1);
});

test("two repositories may both have a 'bug'", async (t) => {
  const { db, repository } = workspace(t);
  const one = repository('one');
  const two = repository('two');
  // Merging them by name would let one team's rename change another team's
  // tracker.
  assert.notEqual(ensureLabel(db, one, { name: 'bug' }), ensureLabel(db, two, { name: 'bug' }));
  assert.equal(listLabels(db, one).length, 1);
  assert.equal(listLabels(db, two).length, 1);
});

test("a label from another repository cannot be attached to this one's issue", async (t) => {
  const { db, repository, issue } = workspace(t);
  const mine = repository('mine');
  const theirs = repository('theirs');
  const issueId = issue(mine);
  const foreign = ensureLabel(db, theirs, { name: 'internal-only' });

  // The id comes from the caller. Without this check one team's taxonomy lands
  // on another team's issue.
  assert.throws(
    () => setIssueLabels(db, { issueId, repositoryId: mine, labelIds: [foreign] }),
    /does not belong to this repository/,
  );
  assert.deepEqual(labelsForIssue(db, issueId), []);
});

test('setting labels replaces the set rather than adding to it', async (t) => {
  const { db, repository, issue } = workspace(t);
  const repositoryId = repository('one');
  const issueId = issue(repositoryId);
  const bug = ensureLabel(db, repositoryId, { name: 'bug' });
  const docs = ensureLabel(db, repositoryId, { name: 'documentation' });

  setIssueLabels(db, { issueId, repositoryId, labelIds: [bug, docs] });
  assert.deepEqual(labelsForIssue(db, issueId).map((label) => label.name), ['bug', 'documentation']);

  // Un-ticking a label in a form sends the remaining set, not a removal.
  setIssueLabels(db, { issueId, repositoryId, labelIds: [docs] });
  assert.deepEqual(labelsForIssue(db, issueId).map((label) => label.name), ['documentation']);
});

test('deleting a label takes it off every issue and leaves the issues alone', async (t) => {
  const { db, repository, issue } = workspace(t);
  const repositoryId = repository('one');
  const issueId = issue(repositoryId);
  const bug = ensureLabel(db, repositoryId, { name: 'bug' });
  setIssueLabels(db, { issueId, repositoryId, labelIds: [bug] });

  db.prepare('DELETE FROM issue_labels WHERE id = ?').run(bug);
  assert.deepEqual(labelsForIssue(db, issueId), []);
  // The issue is not a label's dependant.
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM issues WHERE id = ?').get(issueId).count, 1);
});

test('a milestone is created once per title and counts its issues', async (t) => {
  const { db, repository, issue } = workspace(t);
  const repositoryId = repository('one');
  const milestone = ensureMilestone(db, repositoryId, { title: 'v1.0', dueOn: '2026-12-01 00:00:00' });
  assert.equal(ensureMilestone(db, repositoryId, { title: 'v1.0' }), milestone);

  const open = issue(repositoryId, 1);
  const closed = issue(repositoryId, 2);
  db.prepare('UPDATE issues SET milestone_id = ? WHERE id IN (?, ?)').run(milestone, open, closed);
  db.prepare("UPDATE issues SET status = 'closed' WHERE id = ?").run(closed);

  const [row] = db.prepare('SELECT title FROM issue_milestones WHERE id = ?').all(milestone);
  assert.equal(row.title, 'v1.0');
});

test('deleting a milestone does not delete its issues', async (t) => {
  const { db, repository, issue } = workspace(t);
  const repositoryId = repository('one');
  const milestone = ensureMilestone(db, repositoryId, { title: 'v1.0' });
  const issueId = issue(repositoryId);
  db.prepare('UPDATE issues SET milestone_id = ? WHERE id = ?').run(milestone, issueId);

  db.prepare('DELETE FROM issue_milestones WHERE id = ?').run(milestone);
  const row = db.prepare('SELECT milestone_id AS milestoneId FROM issues WHERE id = ?').get(issueId);
  // A milestone being cancelled is not a reason to lose the work planned for it.
  assert.equal(row.milestoneId, null);
});

test('somebody who cannot see the repository cannot be assigned to its issues', async (t) => {
  const { db, repository, issue, organization } = workspace(t);
  const repositoryId = repository('one');
  const issueId = issue(repositoryId);
  const stranger = uid('user');
  db.prepare("INSERT INTO users (id, email, display_name, password_hash) VALUES (?, ?, 'Stranger', '')").run(stranger, 'stranger@example.com');

  // An assignee without access is a name on a screen that means nothing and an
  // issue whose owner cannot open it.
  assert.throws(
    () => assignIssue(db, { issueId, repositoryId, orgSlug: organization.slug, repoSlug: 'one', userId: stranger }),
    /cannot see this repository/,
  );
  assert.equal(db.prepare('SELECT assignee_id AS assigneeId FROM issues WHERE id = ?').get(issueId).assigneeId, null);
});

test('a member can be assigned, and unassigned', async (t) => {
  const { db, repository, issue, organization, member } = workspace(t);
  const repositoryId = repository('one');
  const issueId = issue(repositoryId);
  const developer = member('dev@kuklabs.com', 'developer');

  assignIssue(db, { issueId, repositoryId, orgSlug: organization.slug, repoSlug: 'one', userId: developer });
  assert.equal(db.prepare('SELECT assignee_id AS assigneeId FROM issues WHERE id = ?').get(issueId).assigneeId, developer);

  assignIssue(db, { issueId, repositoryId, orgSlug: organization.slug, repoSlug: 'one', userId: null });
  assert.equal(db.prepare('SELECT assignee_id AS assigneeId FROM issues WHERE id = ?').get(issueId).assigneeId, null);
});

test('the API offers only people who could actually be assigned', async (t) => {
  const state = workspace(t);
  const { repository, member, organization } = state;
  repository('one');
  member('dev@kuklabs.com', 'developer');
  const { origin, as } = await server(t, state);

  const response = await fetch(`${origin}/api/issue-taxonomy/${organization.slug}/one`, { headers: as(state.founder.id) });
  assert.equal(response.status, 200);
  const payload = await response.json();
  // Offering somebody outside the organization is offering an assignment the
  // server will refuse four steps later.
  assert.deepEqual(payload.assignable.map((entry) => entry.name).sort(), ['Founder', 'dev'].sort());
  assert.equal(payload.canManage, true);
});

test('a viewer reads the taxonomy and cannot add to it', async (t) => {
  const state = workspace(t);
  const { repository, member, organization } = state;
  repository('one');
  const viewer = member('viewer@kuklabs.com', 'viewer');
  const { origin, as } = await server(t, state);

  const read = await fetch(`${origin}/api/issue-taxonomy/${organization.slug}/one`, { headers: as(viewer) });
  assert.equal(read.status, 200);
  assert.equal((await read.json()).canManage, false);

  const write = await fetch(`${origin}/api/issue-taxonomy/${organization.slug}/one/labels`, {
    method: 'POST', headers: as(viewer), body: JSON.stringify({ name: 'bug' }),
  });
  assert.equal(write.status, 403);
});

test('deleting a label needs maintain, not write', async (t) => {
  const state = workspace(t);
  const { db, repository, member, organization } = state;
  const repositoryId = repository('one');
  const developer = member('dev@kuklabs.com', 'developer');
  const maintainer = member('maint@kuklabs.com', 'maintainer');
  const bug = ensureLabel(db, repositoryId, { name: 'bug' });
  const { origin, as } = await server(t, state);

  // Deleting a label takes it off every issue that carried it, which is not the
  // same weight of decision as adding one.
  const byDeveloper = await fetch(`${origin}/api/issue-taxonomy/${organization.slug}/one/labels/${bug}`, { method: 'DELETE', headers: as(developer) });
  assert.equal(byDeveloper.status, 403);

  const byMaintainer = await fetch(`${origin}/api/issue-taxonomy/${organization.slug}/one/labels/${bug}`, { method: 'DELETE', headers: as(maintainer) });
  assert.equal(byMaintainer.status, 200);
  assert.equal(listLabels(db, repositoryId).length, 0);
});

test("a label id from another repository cannot be deleted through this one's path", async (t) => {
  const state = workspace(t);
  const { db, repository, organization, founder } = state;
  repository('mine');
  const theirs = repository('theirs');
  const foreign = ensureLabel(db, theirs, { name: 'internal-only' });
  const { origin, as } = await server(t, state);

  const response = await fetch(`${origin}/api/issue-taxonomy/${organization.slug}/mine/labels/${foreign}`, { method: 'DELETE', headers: as(founder.id) });
  assert.equal(response.status, 404);
  assert.equal(listLabels(db, theirs).length, 1);
});

test('an issue can be labelled, milestoned and assigned in one request', async (t) => {
  const state = workspace(t);
  const { db, repository, issue, member, organization, founder } = state;
  const repositoryId = repository('one');
  const issueId = issue(repositoryId, 7);
  const bug = ensureLabel(db, repositoryId, { name: 'bug' });
  const milestone = ensureMilestone(db, repositoryId, { title: 'v1.0' });
  const developer = member('dev@kuklabs.com', 'developer');
  const { origin, as } = await server(t, state);

  const response = await fetch(`${origin}/api/issue-taxonomy/${organization.slug}/one/issues/7`, {
    method: 'PATCH',
    headers: as(founder.id),
    body: JSON.stringify({ labelIds: [bug], milestoneId: milestone, assigneeId: developer }),
  });

  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).labels.map((label) => label.name), ['bug']);
  const row = db.prepare('SELECT milestone_id AS milestoneId, assignee_id AS assigneeId FROM issues WHERE id = ?').get(issueId);
  assert.equal(row.milestoneId, milestone);
  assert.equal(row.assigneeId, developer);
});

test("a milestone from another repository is refused", async (t) => {
  const state = workspace(t);
  const { db, repository, issue, organization, founder } = state;
  const mine = repository('mine');
  const theirs = repository('theirs');
  issue(mine, 7);
  const foreign = ensureMilestone(db, theirs, { title: 'their release' });
  const { origin, as } = await server(t, state);

  const response = await fetch(`${origin}/api/issue-taxonomy/${organization.slug}/mine/issues/7`, {
    method: 'PATCH', headers: as(founder.id), body: JSON.stringify({ milestoneId: foreign }),
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, 'MILESTONE_NOT_IN_REPOSITORY');
});
