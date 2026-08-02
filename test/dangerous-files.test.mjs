import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { openDatabase, seedCore, uid } from '../src/db.mjs';
import { Readable } from 'node:stream';
import { createGitLfsHandler, lfsObjectPath } from '../src/git-lfs.mjs';
import { putArtifact, readArtifact } from '../src/workflow-storage.mjs';
import {
  assertContentAllowed,
  blockContent,
  contentBlocked,
  listBlockedContent,
  migrateDangerousFiles,
  unblockContent,
} from '../src/dangerous-files.mjs';

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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-danger-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const config = loadConfig({
    dataDir,
    databasePath: path.join(dataDir, 'kukgit.db'),
    repositoriesDir: path.join(dataDir, 'repos'),
    tempDir: path.join(dataDir, 'tmp'),
    lfsDir: path.join(dataDir, 'lfs'),
    nodeEnv: 'test',
    adminEmail: 'owner@example.com',
    adminPassword: 'secure-owner-password',
    adminName: 'Owner',
  });
  const db = openDatabase(config);
  t.after(() => db.close());
  await migrateEverything(db);
  migrateDangerousFiles(db);
  const { userId } = seedCore(db, config);

  const orgId = uid('org');
  db.prepare('INSERT INTO organizations (id, slug, name, created_by) VALUES (?, ?, ?, ?)').run(orgId, 'acme', 'Acme', userId);
  db.prepare("INSERT INTO org_members (organization_id, user_id, role) VALUES (?, ?, 'owner')").run(orgId, userId);
  const repositoryId = uid('repo');
  db.prepare(`
    INSERT INTO repositories (id, organization_id, slug, name, description, visibility, default_branch, created_by)
    VALUES (?, ?, 'app', 'App', '', 'private', 'main', ?)
  `).run(repositoryId, orgId, userId);
  const runId = uid('run');
  db.prepare(`
    INSERT INTO workflow_runs (id, repository_id, workflow_path, workflow_name, event, ref, commit_sha, status, actor_id)
    VALUES (?, ?, '.kukgit/workflows/ci.yml', 'ci', 'push', 'refs/heads/main', ?, 'success', ?)
  `).run(runId, repositoryId, 'a'.repeat(40), userId);

  return { config, db, userId, orgId, repositoryId, runId };
}

const reason = 'Confirmed trojan dropper, reported in abuse case abc_1 and verified by hand.';

function trojan(context) {
  const content = Buffer.from('pretend this is a trojan payload\n');
  const oid = crypto.createHash('sha256').update(content).digest('hex');
  fs.mkdirSync(path.dirname(lfsObjectPath(context.config, oid)), { recursive: true });
  fs.writeFileSync(lfsObjectPath(context.config, oid), content);
  context.db.prepare('INSERT INTO lfs_objects (oid, size, storage_path) VALUES (?, ?, ?)')
    .run(oid, content.length, `objects/${oid.slice(0, 2)}/${oid.slice(2, 4)}/${oid}`);
  context.db.prepare('INSERT INTO repository_lfs_objects (repository_id, oid) VALUES (?, ?)')
    .run(context.repositoryId, oid);
  return { content, oid };
}

test('a block is by content hash and shows what it touches before it lands', async (t) => {
  const context = await setup(t);
  const { oid } = trojan(context);

  const placed = blockContent(context.db, { digest: oid, reason, userId: context.userId });
  // "This hash" is opaque; "this hash, attached to these repositories" is a
  // decision an operator can weigh — and afterwards, the list of who to tell.
  assert.deepEqual(placed.affected.lfsRepositories, ['acme/app']);
  assert.ok(contentBlocked(context.db, oid));
  assert.equal(contentBlocked(context.db, 'f'.repeat(64)), null);
});

test('blocked content is refused, with a refusal that names nothing but the hash', async (t) => {
  const context = await setup(t);
  const { oid } = trojan(context);
  blockContent(context.db, { digest: oid, reason, userId: context.userId });

  try {
    assertContentAllowed(context.db, oid, { context: 'Git LFS object' });
    assert.fail('should have thrown');
  } catch (error) {
    assert.equal(error.status, 451);
    assert.equal(error.code, 'CONTENT_BLOCKED');
    // Whoever fetches a blocked payload is as likely to be the attacker
    // checking whether it still serves as a victim. The refusal carries the
    // truncated hash and nothing else — not the reason, not the case, not who
    // decided.
    assert.doesNotMatch(error.message, /trojan|abuse case|verified/);
    assert.match(error.message, new RegExp(oid.slice(0, 12)));
  }
});

test('the bytes are not deleted, and unblocking restores service', async (t) => {
  const context = await setup(t);
  const { content, oid } = trojan(context);
  blockContent(context.db, { digest: oid, reason, userId: context.userId });

  // Fifty tenants can hold the same digest and most are victims who cloned
  // something. Deleting by hash destroys evidence and their repositories in one
  // motion; a block makes the bytes unservable, which is the part that stops
  // the harm.
  assert.deepEqual(fs.readFileSync(lfsObjectPath(context.config, oid)), content);
  assert.equal(context.db.prepare('SELECT COUNT(*) AS count FROM lfs_objects WHERE oid = ?').get(oid).count, 1);

  unblockContent(context.db, { digest: oid, reason: 'False positive: the hash matched a legitimate installer.', userId: context.userId });
  assert.equal(contentBlocked(context.db, oid), null);
  assertContentAllowed(context.db, oid);

  // Re-blocking revives the row rather than replacing it; the record survives.
  blockContent(context.db, { digest: oid, reason, userId: context.userId });
  assert.equal(listBlockedContent(context.db, { includeRemoved: true }).length, 1);
});

test('an artifact with a blocked digest stops serving', async (t) => {
  const context = await setup(t);
  const artifact = putArtifact(context.db, context.config, {
    repositoryId: context.repositoryId, runId: context.runId, name: 'release-binary',
    content: Buffer.from('a build output that turns out to be malicious\n'),
  });
  assert.ok(readArtifact(context.db, context.config, { repositoryId: context.repositoryId, artifactId: artifact.id }).content);

  blockContent(context.db, { digest: artifact.digest, reason, userId: context.userId });
  // Same hash space as LFS: a trojan is blocked whether it arrived through a
  // push or out of a build.
  assert.throws(
    () => readArtifact(context.db, context.config, { repositoryId: context.repositoryId, artifactId: artifact.id }),
    /has been blocked/,
  );
});

test('the Git LFS batch route itself refuses a blocked object', async (t) => {
  const context = await setup(t);
  const { oid } = trojan(context);
  context.db.prepare("UPDATE repositories SET visibility = 'public' WHERE id = ?").run(context.repositoryId);
  blockContent(context.db, { digest: oid, reason, userId: context.userId });

  // Through the real handler rather than the helper, because a live run proving
  // this once is not the same as a test that keeps it true. Removing the check
  // from `git-lfs.mjs` has to fail something.
  const handler = createGitLfsHandler({ config: context.config, db: context.db });
  const body = JSON.stringify({ operation: 'download', transfers: ['basic'], objects: [{ oid, size: 33 }] });
  const req = Readable.from([Buffer.from(body)]);
  req.method = 'POST';
  req.url = '/git/acme/app.git/info/lfs/objects/batch';
  req.headers = { 'content-type': 'application/vnd.git-lfs+json' };
  req.socket = { remoteAddress: '127.0.0.1' };

  const chunks = [];
  const res = {
    writeHead() { return this; },
    setHeader() { return this; },
    end(payload) { if (payload) chunks.push(String(payload)); return this; },
  };
  await handler(req, res);
  const answer = JSON.parse(chunks.join(''));
  assert.equal(answer.objects[0].error.code, 451);
  assert.match(answer.objects[0].error.message, /has been blocked/);
});

test('a block needs a real digest and a written reason', async (t) => {
  const context = await setup(t);
  assert.throws(() => blockContent(context.db, { digest: 'deadbeef', reason, userId: context.userId }), /64-character SHA-256/);
  assert.throws(() => blockContent(context.db, { digest: 'a'.repeat(64), reason: 'bad', userId: context.userId }), /at least 20 characters/);
  assert.throws(() => unblockContent(context.db, { digest: 'a'.repeat(64), reason, userId: context.userId }), /not blocked/);

  blockContent(context.db, { digest: 'a'.repeat(64), reason, userId: context.userId });
  assert.throws(() => blockContent(context.db, { digest: 'A'.repeat(64), reason, userId: context.userId }), /already blocked/);
});
