import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { openDatabase, seedCore, uid } from '../src/db.mjs';
import { createSession } from '../src/auth.mjs';
import { migrateCollaboration } from '../src/collaboration.mjs';
import { migrateRepositoryAccess } from '../src/repository-access.mjs';
import { migrateIssueComments, addIssueComment } from '../src/issue-comments.mjs';
import {
  REACTIONS,
  createIssueReactionsApiHandler,
  migrateIssueReactions,
  normalizeReaction,
  reactionsForIssue,
  toggleReaction,
} from '../src/issue-reactions.mjs';

/**
 * Reactions.
 *
 * The behaviour worth pinning down is not that a thumb appears. It is that the
 * set of them is closed, that the same person cannot appear twice, that a
 * reaction cannot be attached across a repository boundary, and that a KukGit
 * support operator — who has read access to a customer's repository through a
 * temporary grant — cannot leave one.
 */

function workspace(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-reactions-'));
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
  migrateIssueReactions(db);

  const organization = db.prepare("SELECT id, slug FROM organizations WHERE slug = 'kuklabs'").get();
  const founder = db.prepare('SELECT id FROM users LIMIT 1').get();

  const repository = (slug, visibility = 'private') => {
    const id = uid('repo');
    db.prepare('INSERT INTO repositories (id, organization_id, slug, name, visibility, created_by) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, organization.id, slug, slug, visibility, founder.id);
    return id;
  };
  const issue = (repositoryId, number, title = 'Login is slow') => {
    const id = uid('iss');
    db.prepare('INSERT INTO issues (id, repository_id, number, title, body, author_id) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, repositoryId, number, title, 'It takes eight seconds.', founder.id);
    return id;
  };
  const member = (email, role = 'developer') => {
    const id = uid('user');
    db.prepare("INSERT INTO users (id, email, display_name, password_hash) VALUES (?, ?, ?, '')").run(id, email, email.split('@')[0]);
    db.prepare('INSERT INTO org_members (organization_id, user_id, role) VALUES (?, ?, ?)').run(organization.id, id, role);
    return id;
  };
  const outsider = (email) => {
    const id = uid('user');
    db.prepare("INSERT INTO users (id, email, display_name, password_hash) VALUES (?, ?, ?, '')").run(id, email, email.split('@')[0]);
    return id;
  };

  const repositoryId = repository('thread');
  const issueId = issue(repositoryId, 1);

  return { config, db, organization, founder, repositoryId, issueId, repository, issue, member, outsider };
}

async function server(t, { config, db }) {
  const api = createIssueReactionsApiHandler({ config, db });
  const httpServer = http.createServer(async (req, res) => {
    if (await api(req, res)) return;
    res.writeHead(404).end();
  });
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => httpServer.close(resolve)));
  const base = `http://127.0.0.1:${httpServer.address().port}`;

  return async function call(method, url, { userId, body } = {}) {
    const headers = { Origin: config.baseUrl, 'Content-Type': 'application/json' };
    if (userId) headers.Cookie = `kukgit_session=${createSession(db, userId).token}`;
    const response = await fetch(`${base}${url}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  };
}

/* -------------------------------------------------------------- the set */

test('the set is closed, and it is stored by name rather than by character', async (t) => {
  const space = workspace(t);
  assert.equal(normalizeReaction('+1'), '+1');
  assert.throws(() => normalizeReaction('🔥'), { code: 'REACTION_UNKNOWN' });
  assert.throws(() => normalizeReaction('you are wrong and here is why'), { code: 'REACTION_UNKNOWN' });
  assert.throws(() => normalizeReaction(''), { code: 'REACTION_UNKNOWN' });

  // Names, not characters: `❤️` is two code points and `❤` is one, so storing
  // what the keyboard sent would let one person react twice with the same
  // thing and have both rows survive the uniqueness rule.
  for (const reaction of REACTIONS) assert.match(reaction.name, /^[a-z+-]+[0-9]?$/);
  toggleReaction(space.db, { issueId: space.issueId, userId: space.founder.id, reaction: 'heart' });
  assert.equal(space.db.prepare("SELECT reaction FROM issue_reactions").get().reaction, 'heart');
});

test('reacting twice takes it back', async (t) => {
  const space = workspace(t);
  assert.equal(toggleReaction(space.db, { issueId: space.issueId, userId: space.founder.id, reaction: '+1' }), 'added');
  assert.equal(toggleReaction(space.db, { issueId: space.issueId, userId: space.founder.id, reaction: '+1' }), 'removed');
  assert.equal(reactionsForIssue(space.db, space.issueId, space.founder.id).issue.length, 0);
});

test('the same person cannot appear twice on the same subject', async (t) => {
  const space = workspace(t);
  space.db.prepare('INSERT INTO issue_reactions (id, issue_id, comment_id, user_id, reaction) VALUES (?, ?, NULL, ?, ?)')
    .run(uid('rxn'), space.issueId, space.founder.id, '+1');
  // A single UNIQUE across four columns would not catch this: SQLite treats
  // every NULL as distinct, so `comment_id IS NULL` rows would never collide.
  assert.throws(() => space.db.prepare('INSERT INTO issue_reactions (id, issue_id, comment_id, user_id, reaction) VALUES (?, ?, NULL, ?, ?)')
    .run(uid('rxn'), space.issueId, space.founder.id, '+1'));
});

test('a comment and its issue count separately', async (t) => {
  const space = workspace(t);
  const commentId = addIssueComment(space.db, { issueId: space.issueId, authorId: space.founder.id, body: 'Reproduced.' });
  toggleReaction(space.db, { issueId: space.issueId, userId: space.founder.id, reaction: '+1' });
  toggleReaction(space.db, { issueId: space.issueId, commentId, userId: space.founder.id, reaction: '+1' });

  const summary = reactionsForIssue(space.db, space.issueId, space.founder.id);
  assert.equal(summary.issue[0].count, 1);
  assert.equal(summary.comments[commentId][0].count, 1);
});

test('the summary says how many, who, and whether it was me', async (t) => {
  const space = workspace(t);
  const priya = space.member('priya@kuklabs.com');
  toggleReaction(space.db, { issueId: space.issueId, userId: space.founder.id, reaction: '+1' });
  toggleReaction(space.db, { issueId: space.issueId, userId: priya, reaction: '+1' });

  const mine = reactionsForIssue(space.db, space.issueId, priya).issue[0];
  assert.equal(mine.count, 2);
  assert.equal(mine.mine, true);
  assert.deepEqual(mine.names.sort(), ['Founder', 'priya']);

  const theirs = reactionsForIssue(space.db, space.issueId, space.outsider('nobody@example.com')).issue[0];
  assert.equal(theirs.mine, false);
});

test('the row keeps the order the set is declared in', async (t) => {
  const space = workspace(t);
  // Ordering by count would rearrange the buttons under somebody's cursor as
  // other people react.
  const priya = space.member('priya@kuklabs.com');
  toggleReaction(space.db, { issueId: space.issueId, userId: space.founder.id, reaction: 'rocket' });
  toggleReaction(space.db, { issueId: space.issueId, userId: priya, reaction: 'rocket' });
  toggleReaction(space.db, { issueId: space.issueId, userId: space.founder.id, reaction: '+1' });

  // `rocket` has more of them and `+1` is declared first, so a list ordered by
  // count would come back the other way round.
  const names = reactionsForIssue(space.db, space.issueId, space.founder.id).issue.map((entry) => entry.reaction);
  assert.deepEqual(names, ['+1', 'rocket']);
});

test('deleting a comment takes its reactions with it', async (t) => {
  const space = workspace(t);
  const commentId = addIssueComment(space.db, { issueId: space.issueId, authorId: space.founder.id, body: 'Reproduced.' });
  toggleReaction(space.db, { issueId: space.issueId, commentId, userId: space.founder.id, reaction: '+1' });
  space.db.prepare('DELETE FROM issue_comments WHERE id = ?').run(commentId);

  assert.equal(space.db.prepare('SELECT COUNT(*) AS n FROM issue_reactions').get().n, 0);
});

/* ------------------------------------------------------------------ API */

test('a member reacts and the answer comes back with the new state', async (t) => {
  const space = workspace(t);
  const call = await server(t, space);
  const priya = space.member('priya@kuklabs.com');

  const added = await call('POST', '/api/issue-reactions/kuklabs/thread/1', { userId: priya, body: { reaction: '+1' } });
  assert.equal(added.status, 200);
  assert.equal(added.body.outcome, 'added');
  assert.equal(added.body.issue[0].count, 1);

  const removed = await call('POST', '/api/issue-reactions/kuklabs/thread/1', { userId: priya, body: { reaction: '+1' } });
  assert.equal(removed.body.outcome, 'removed');
  assert.deepEqual(removed.body.issue, []);
});

test('a reaction that is not in the set is refused', async (t) => {
  const space = workspace(t);
  const call = await server(t, space);
  const priya = space.member('priya@kuklabs.com');

  const response = await call('POST', '/api/issue-reactions/kuklabs/thread/1', { userId: priya, body: { reaction: 'a whole sentence' } });
  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, 'REACTION_UNKNOWN');
  assert.equal(space.db.prepare('SELECT COUNT(*) AS n FROM issue_reactions').get().n, 0);
});

test('a comment from another repository cannot be reacted to through this issue', async (t) => {
  const space = workspace(t);
  const call = await server(t, space);
  const otherRepo = space.repository('other');
  const otherIssue = space.issue(otherRepo, 1, 'Somebody else problem');
  const otherComment = addIssueComment(space.db, { issueId: otherIssue, authorId: space.founder.id, body: 'Private.' });
  const priya = space.member('priya@kuklabs.com');

  const response = await call('POST', '/api/issue-reactions/kuklabs/thread/1', { userId: priya, body: { reaction: '+1', commentId: otherComment } });
  assert.equal(response.status, 404);
  assert.equal(response.body.error.code, 'COMMENT_NOT_FOUND');
  assert.equal(space.db.prepare('SELECT COUNT(*) AS n FROM issue_reactions').get().n, 0);
});

test('somebody with no access is told the repository is not there', async (t) => {
  const space = workspace(t);
  const call = await server(t, space);
  const stranger = space.outsider('stranger@example.com');

  // 403 would confirm that kuklabs/thread exists, and its name is in the URL
  // that produced the answer.
  const read = await call('GET', '/api/issue-reactions/kuklabs/thread/1', { userId: stranger });
  assert.equal(read.status, 404);
  const write = await call('POST', '/api/issue-reactions/kuklabs/thread/1', { userId: stranger, body: { reaction: '+1' } });
  assert.equal(write.status, 404);
});

test('signing in is required', async (t) => {
  const space = workspace(t);
  const call = await server(t, space);
  const response = await call('GET', '/api/issue-reactions/kuklabs/thread/1');
  assert.equal(response.status, 401);
});

test('a request from another origin is refused', async (t) => {
  const space = workspace(t);
  const api = createIssueReactionsApiHandler(space);
  const httpServer = http.createServer(async (req, res) => { if (await api(req, res)) return; res.writeHead(404).end(); });
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => httpServer.close(resolve)));

  const priya = space.member('priya@kuklabs.com');
  const response = await fetch(`http://127.0.0.1:${httpServer.address().port}/api/issue-reactions/kuklabs/thread/1`, {
    method: 'POST',
    headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json', Cookie: `kukgit_session=${createSession(space.db, priya).token}` },
    body: JSON.stringify({ reaction: '+1' }),
  });
  assert.equal(response.status, 403);
});

/* -------------------------------------------------------- support access */

/**
 * Gives an operator a live support grant on this organization.
 *
 * The grant is the whole point of the test below it: KukGit sells the promise
 * that support can diagnose a customer's problem without signing in as them and
 * without touching anything.
 */
function supportGrant(space, { migrateSupportAccess, registerSupportOperators }) {
  migrateSupportAccess(space.db);
  const operator = space.outsider('ops@kuklabs.com');
  registerSupportOperators(space.db, (user) => user.email === 'ops@kuklabs.com');
  space.db.prepare(`
    INSERT INTO support_access_grants (id, organization_id, repository_id, operator_user_id, operator_email, reason, expires_at)
    VALUES (?, ?, NULL, ?, 'ops@kuklabs.com', 'Customer reported a broken import', datetime('now', '+1 hour'))
  `).run(uid('sup'), space.organization.id, operator);
  return operator;
}

test('a support operator can read the reactions and cannot leave one', async (t) => {
  const supportAccess = await import('../src/support-access.mjs');
  const space = workspace(t);
  const call = await server(t, space);
  const operator = supportGrant(space, supportAccess);

  // Reading is what the grant is for.
  const read = await call('GET', '/api/issue-reactions/kuklabs/thread/1', { userId: operator });
  assert.equal(read.status, 200);
  // And the screen is told not to draw the buttons, rather than drawing them
  // and answering 403 when somebody presses one.
  assert.equal(read.body.canReact, false);

  const write = await call('POST', '/api/issue-reactions/kuklabs/thread/1', { userId: operator, body: { reaction: '+1' } });
  assert.equal(write.status, 403);
  assert.equal(write.body.error.code, 'REACTION_SUPPORT_READ_ONLY');
  assert.equal(space.db.prepare('SELECT COUNT(*) AS n FROM issue_reactions').get().n, 0);
});

test('an operator who is also a member of the organization reacts as a member', async (t) => {
  const supportAccess = await import('../src/support-access.mjs');
  const space = workspace(t);
  const call = await server(t, space);
  const operator = supportGrant(space, supportAccess);
  // They joined the organization properly. The support grant is now the
  // smaller of the two things granting them access, and refusing them would be
  // punishing them for holding a grant they do not need.
  space.db.prepare('INSERT INTO org_members (organization_id, user_id, role) VALUES (?, ?, ?)')
    .run(space.organization.id, operator, 'developer');

  const response = await call('POST', '/api/issue-reactions/kuklabs/thread/1', { userId: operator, body: { reaction: '+1' } });
  assert.equal(response.status, 200);
  assert.equal(response.body.outcome, 'added');
});
