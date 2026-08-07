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
  addIssueComment,
  createIssueCommentsApiHandler,
  listIssueComments,
  migrateIssueComments,
  normalizeCommentBody,
} from '../src/issue-comments.mjs';

/**
 * Replying to an issue.
 *
 * KukGit has had issues since the beginning and never a way to answer one. The
 * tests here are about the two things that make a thread trustworthy: that only
 * the author can rewrite their own words, and that a comment carried in from
 * another host says who actually wrote it rather than borrowing the account of
 * whoever ran the import.
 */

function workspace(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-comments-'));
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
  migrateIssueComments(db);

  const organization = db.prepare("SELECT id, slug FROM organizations WHERE slug = 'kuklabs'").get();
  const founder = db.prepare('SELECT id FROM users LIMIT 1').get();
  const repositoryId = uid('repo');
  db.prepare('INSERT INTO repositories (id, organization_id, slug, name, visibility, created_by) VALUES (?, ?, ?, ?, ?, ?)')
    .run(repositoryId, organization.id, 'thread', 'Thread', 'private', founder.id);
  createBareRepository(config, organization.slug, 'thread');
  const issueId = uid('iss');
  db.prepare('INSERT INTO issues (id, repository_id, number, title, body, author_id) VALUES (?, ?, 1, ?, ?, ?)')
    .run(issueId, repositoryId, 'Login is slow', 'It takes eight seconds.', founder.id);

  const member = (email, role) => {
    const id = uid('user');
    db.prepare("INSERT INTO users (id, email, display_name, password_hash) VALUES (?, ?, ?, '')").run(id, email, email.split('@')[0]);
    db.prepare('INSERT INTO org_members (organization_id, user_id, role) VALUES (?, ?, ?)').run(organization.id, id, role);
    return id;
  };

  return { config, db, organization, founder, repositoryId, issueId, member };
}

async function server(t, { config, db }) {
  const api = createIssueCommentsApiHandler({ config, db });
  const httpServer = http.createServer(async (req, res) => {
    if (await api(req, res)) return;
    res.writeHead(404).end();
  });
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => httpServer.close(resolve)));
  const origin = `http://127.0.0.1:${httpServer.address().port}`;
  const as = (userId) => ({ 'Content-Type': 'application/json', Cookie: `kukgit_session=${createSession(db, userId).token}` });
  const url = (suffix = '') => `${origin}/api/issue-comments/kuklabs/thread/1${suffix}`;
  return { origin, as, url };
}

test('an empty comment is refused, and an enormous one too', async () => {
  assert.throws(() => normalizeCommentBody('   '), /cannot be empty/);
  assert.throws(() => normalizeCommentBody('x'.repeat(20001)), /at most/);
  assert.equal(normalizeCommentBody('  hello  '), 'hello');
});

test('an imported comment keeps its author and its date', async (t) => {
  const { db, founder, issueId } = workspace(t);
  addIssueComment(db, {
    issueId,
    authorId: founder.id,
    body: 'This is the same on my machine.',
    importedAuthor: 'octocat',
    importedFrom: 'github.com/acme/thread',
    createdAt: '2024-03-01 09:00:00',
  });

  const [comment] = listIssueComments(db, issueId);
  // The name shown is the person who wrote it. Creating a KukGit user for
  // `octocat` would be inventing somebody who can be assigned work and granted
  // access, and who cannot sign in to object.
  assert.equal(comment.authorName, 'octocat');
  assert.equal(comment.imported, true);
  assert.equal(comment.importedFrom, 'github.com/acme/thread');
  // And no user id, so nothing can @-mention or assign a person who is not here.
  assert.equal(comment.authorId, null);
  // A thread where every reply is dated today is a thread whose order is a lie.
  assert.match(comment.createdAt, /^2024-03-01/);
});

test('comments come back oldest first', async (t) => {
  const { db, founder, issueId } = workspace(t);
  addIssueComment(db, { issueId, authorId: founder.id, body: 'second', createdAt: '2024-03-02 09:00:00' });
  addIssueComment(db, { issueId, authorId: founder.id, body: 'first', createdAt: '2024-03-01 09:00:00' });
  assert.deepEqual(listIssueComments(db, issueId).map((comment) => comment.body), ['first', 'second']);
});

test('a developer can reply and the issue is touched', async (t) => {
  const workspaceState = workspace(t);
  const { db, member, issueId } = workspaceState;
  const { as, url } = await server(t, workspaceState);
  const developer = member('dev@kuklabs.com', 'developer');

  const before = db.prepare('SELECT updated_at AS updatedAt FROM issues WHERE id = ?').get(issueId).updatedAt;
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const response = await fetch(url(), { method: 'POST', headers: as(developer), body: JSON.stringify({ body: 'Reproduced on staging.' }) });

  assert.equal(response.status, 201);
  assert.deepEqual((await response.json()).comments.map((comment) => comment.body), ['Reproduced on staging.']);
  // An issue whose last reply was an hour ago and whose "updated" says last
  // week sorts to the bottom of every list that matters.
  assert.notEqual(db.prepare('SELECT updated_at AS updatedAt FROM issues WHERE id = ?').get(issueId).updatedAt, before);
});

test('a viewer can read the thread and cannot add to it', async (t) => {
  const workspaceState = workspace(t);
  const { member } = workspaceState;
  const { as, url } = await server(t, workspaceState);
  const viewer = member('viewer@kuklabs.com', 'viewer');

  const read = await fetch(url(), { headers: as(viewer) });
  assert.equal(read.status, 200);
  assert.equal((await read.json()).canComment, false);

  const write = await fetch(url(), { method: 'POST', headers: as(viewer), body: JSON.stringify({ body: 'me too' }) });
  assert.equal(write.status, 403);
});

test('somebody outside the organization sees nothing at all', async (t) => {
  const workspaceState = workspace(t);
  const { db } = workspaceState;
  const { as, url } = await server(t, workspaceState);
  const stranger = uid('user');
  db.prepare("INSERT INTO users (id, email, display_name, password_hash) VALUES (?, ?, 'Stranger', '')").run(stranger, 'stranger@example.com');

  const response = await fetch(url(), { headers: as(stranger) });
  // 404, not 403: whether a private repository exists is not something to
  // confirm to somebody who cannot see it, and its organization and slug are
  // in the URL that produced the answer. This test asked for 403 when it was
  // written, and recorded in docs/TODO.md that the answer was wrong; that has
  // now been fixed in `requireRepositoryAccess` for every route at once.
  assert.equal(response.status, 404);
  // Refused, and nothing of the conversation comes back with the refusal.
  const payload = await response.json();
  assert.equal(JSON.stringify(payload).includes('Login is slow'), false);
});

test('only the author may edit, and the edit is visible', async (t) => {
  const workspaceState = workspace(t);
  const { db, member, issueId, founder } = workspaceState;
  const { as, url } = await server(t, workspaceState);
  const developer = member('dev@kuklabs.com', 'developer');
  const maintainer = member('maint@kuklabs.com', 'maintainer');
  const commentId = addIssueComment(db, { issueId, authorId: developer, body: 'original wording' });

  const byMaintainer = await fetch(url(`/${commentId}`), { method: 'PATCH', headers: as(maintainer), body: JSON.stringify({ body: 'rewritten' }) });
  // Putting different words in somebody's mouth is not a moderation power any
  // role should have.
  assert.equal(byMaintainer.status, 403);
  assert.equal(listIssueComments(db, issueId)[0].body, 'original wording');

  const byAuthor = await fetch(url(`/${commentId}`), { method: 'PATCH', headers: as(developer), body: JSON.stringify({ body: 'clearer wording' }) });
  assert.equal(byAuthor.status, 200);
  const [comment] = listIssueComments(db, issueId);
  assert.equal(comment.body, 'clearer wording');
  // A thread where a reply can be silently rewritten after somebody acted on it
  // is a thread nobody can rely on.
  assert.ok(comment.editedAt, 'the edit is not marked');
  void founder;
});

test('a maintainer may delete a comment they did not write; a peer may not', async (t) => {
  const workspaceState = workspace(t);
  const { db, member, issueId } = workspaceState;
  const { as, url } = await server(t, workspaceState);
  const author = member('author@kuklabs.com', 'developer');
  const peer = member('peer@kuklabs.com', 'developer');
  const maintainer = member('maint@kuklabs.com', 'maintainer');
  const commentId = addIssueComment(db, { issueId, authorId: author, body: 'something regrettable' });

  assert.equal((await fetch(url(`/${commentId}`), { method: 'DELETE', headers: as(peer) })).status, 403);
  assert.equal(listIssueComments(db, issueId).length, 1);

  assert.equal((await fetch(url(`/${commentId}`), { method: 'DELETE', headers: as(maintainer) })).status, 200);
  assert.equal(listIssueComments(db, issueId).length, 0);
  // Who removed somebody else's words, and that it was not their own, is the
  // part somebody asks about later.
  const entry = db.prepare("SELECT metadata_json AS metadata FROM audit_logs WHERE action = 'issue.comment.deleted'").get();
  assert.equal(JSON.parse(entry.metadata).byAuthor, false);
});

test('an issue in another repository is not reachable by number', async (t) => {
  const workspaceState = workspace(t);
  const { db, organization, founder, config } = workspaceState;
  const { as, url } = await server(t, workspaceState);
  const otherId = uid('repo');
  db.prepare('INSERT INTO repositories (id, organization_id, slug, name, visibility, created_by) VALUES (?, ?, ?, ?, ?, ?)')
    .run(otherId, organization.id, 'other', 'Other', 'private', founder.id);
  createBareRepository(config, organization.slug, 'other');
  db.prepare('INSERT INTO issues (id, repository_id, number, title, body, author_id) VALUES (?, ?, 1, ?, ?, ?)')
    .run(uid('iss'), otherId, 'A different issue', '', founder.id);

  const response = await fetch(url(), { headers: as(founder.id) });
  const payload = await response.json();
  // Both repositories have an issue #1. The number is scoped to a repository,
  // and reading one through the other's path would be a cross-repository leak.
  assert.equal(payload.issue.title, 'Login is slow');
});

test('deleting an issue takes its conversation with it', async (t) => {
  const { db, founder, issueId } = workspace(t);
  addIssueComment(db, { issueId, authorId: founder.id, body: 'a reply' });
  db.prepare('DELETE FROM issues WHERE id = ?').run(issueId);
  // Orphan rows keep somebody's words in the database after the thing they were
  // about is gone, and nothing on any screen ever shows them again.
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM issue_comments').get().count, 0);
});
