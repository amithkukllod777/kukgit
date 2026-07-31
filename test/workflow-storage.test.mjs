import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { openDatabase, seedCore, uid } from '../src/db.mjs';
import { migrateSecrets } from '../src/secrets-vault.mjs';
import { migrateWorkflowRuns } from '../src/workflow-runs.mjs';
import {
  blobPath,
  collectUnreferencedBlobs,
  evictCacheToQuota,
  expireArtifacts,
  listArtifacts,
  migrateWorkflowStorage,
  putArtifact,
  putBlob,
  readArtifact,
  restoreCache,
  saveCache,
  STORAGE_LIMITS,
  storageUsage,
} from '../src/workflow-storage.mjs';

function setup(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-storage-test-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const config = loadConfig({
    dataDir,
    databasePath: path.join(dataDir, 'kukgit.db'),
    repositoriesDir: path.join(dataDir, 'repos'),
    tempDir: path.join(dataDir, 'tmp'),
    nodeEnv: 'test',
    baseUrl: 'http://127.0.0.1:8787',
    adminEmail: 'owner@example.com',
    adminPassword: 'secure-owner-password',
    adminName: 'Owner',
    secretsEncryptionKey: 'kukgit-storage-test-key-long-enough-here',
  });
  const db = openDatabase(config);
  t.after(() => db.close());
  migrateSecrets(db);
  migrateWorkflowRuns(db);
  migrateWorkflowStorage(db);
  const { userId, orgId } = seedCore(db, config);

  const repositoryId = uid('repo');
  db.prepare(`
    INSERT INTO repositories (id, organization_id, slug, name, description, visibility, default_branch, created_by)
    VALUES (?, ?, 'app', 'App', '', 'private', 'main', ?)
  `).run(repositoryId, orgId, userId);

  const runId = uid('run');
  db.prepare(`
    INSERT INTO workflow_runs (id, repository_id, workflow_path, event, ref, commit_sha, actor_id)
    VALUES (?, ?, '.kukgit/workflows/ci.yml', 'push', 'refs/heads/main', ?, ?)
  `).run(runId, repositoryId, 'a'.repeat(40), userId);

  return { config, db, userId, orgId, repositoryId, runId };
}

test('identical content is stored once and shared', (t) => {
  const context = setup(t);
  const content = Buffer.from('the same bytes from two branches');

  const first = putBlob(context.db, context.config, content);
  const second = putBlob(context.db, context.config, content);
  assert.equal(first.digest, second.digest);
  assert.equal(second.deduplicated, true);

  // The same dependency cache is written by every branch. Storing it once per
  // branch would multiply the quota by branches rather than by content.
  assert.equal(context.db.prepare('SELECT COUNT(*) AS count FROM workflow_blobs').get().count, 1);
  assert.ok(fs.existsSync(blobPath(context.config, first.digest)));
});

test('an artifact round-trips and is listed without its content', (t) => {
  const context = setup(t);
  const stored = putArtifact(context.db, context.config, {
    repositoryId: context.repositoryId,
    runId: context.runId,
    name: 'test-report',
    content: Buffer.from('<report>passed</report>'),
  });
  assert.equal(stored.name, 'test-report');
  assert.equal(stored.retentionDays, STORAGE_LIMITS.defaultRetentionDays);

  const listed = listArtifacts(context.db, { repositoryId: context.repositoryId, runId: context.runId });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].content, undefined, 'a listing carries metadata, not payloads');
  assert.equal(listed[0].sizeBytes, 23);

  const read = readArtifact(context.db, context.config, { repositoryId: context.repositoryId, artifactId: stored.id });
  assert.equal(read.content.toString(), '<report>passed</report>');

  // Another repository cannot address it, even with the right id.
  assert.throws(
    () => readArtifact(context.db, context.config, { repositoryId: 'repo_other', artifactId: stored.id }),
    (error) => error.code === 'ARTIFACT_NOT_FOUND',
  );
});

test('an artifact name is written once per run', (t) => {
  const context = setup(t);
  putArtifact(context.db, context.config, {
    repositoryId: context.repositoryId, runId: context.runId, name: 'report', content: Buffer.from('first'),
  });

  // A job that could overwrite an artifact could replace evidence after the fact.
  assert.throws(
    () => putArtifact(context.db, context.config, {
      repositoryId: context.repositoryId, runId: context.runId, name: 'report', content: Buffer.from('second'),
    }),
    (error) => error.code === 'ARTIFACT_NAME_TAKEN' && error.status === 409,
  );

  const read = readArtifact(context.db, context.config, {
    repositoryId: context.repositoryId,
    artifactId: listArtifacts(context.db, { repositoryId: context.repositoryId, runId: context.runId })[0].id,
  });
  assert.equal(read.content.toString(), 'first', 'the original survives the attempt');
});

test('artifact names, sizes and retention are validated', (t) => {
  const context = setup(t);
  const base = { repositoryId: context.repositoryId, runId: context.runId, content: Buffer.from('x') };

  for (const name of ['', '  ', '../escape', 'has/slash', 'a'.repeat(STORAGE_LIMITS.maxNameLength + 1)]) {
    assert.throws(() => putArtifact(context.db, context.config, { ...base, name }), (error) => error.status === 400);
  }
  assert.throws(
    () => putArtifact(context.db, context.config, { ...base, name: 'empty', content: Buffer.alloc(0) }),
    (error) => error.code === 'ARTIFACT_EMPTY',
  );

  // Retention is clamped rather than refused: an unreasonable number is a
  // mistake in a workflow, not a reason to lose the artifact.
  assert.equal(putArtifact(context.db, context.config, { ...base, name: 'long', retentionDays: 9999 }).retentionDays,
    STORAGE_LIMITS.maxRetentionDays);
  assert.equal(putArtifact(context.db, context.config, { ...base, name: 'short', retentionDays: 0 }).retentionDays,
    STORAGE_LIMITS.defaultRetentionDays);
});

test('expired artifacts are removed and their content reclaimed only when unreferenced', (t) => {
  const context = setup(t);
  const shared = Buffer.from('shared build output');
  const doomed = putArtifact(context.db, context.config, {
    repositoryId: context.repositoryId, runId: context.runId, name: 'doomed', content: shared,
  });

  const otherRun = uid('run');
  context.db.prepare(`
    INSERT INTO workflow_runs (id, repository_id, workflow_path, event, ref, commit_sha, actor_id)
    VALUES (?, ?, 'x.yml', 'push', 'refs/heads/main', ?, ?)
  `).run(otherRun, context.repositoryId, 'b'.repeat(40), context.userId);
  putArtifact(context.db, context.config, {
    repositoryId: context.repositoryId, runId: otherRun, name: 'kept', content: shared,
  });

  context.db.prepare("UPDATE workflow_artifacts SET expires_at = datetime('now', '-1 day') WHERE id = ?").run(doomed.id);
  const swept = expireArtifacts(context.db, context.config);
  assert.equal(swept.expired, 1);

  // Deletion is by reference count. Content shared with a live artifact must
  // survive, and content-addressing makes that sharing invisible to the delete.
  assert.equal(swept.removed, 0);
  assert.ok(fs.existsSync(blobPath(context.config, doomed.digest)));
  assert.equal(readArtifact(context.db, context.config, {
    repositoryId: context.repositoryId,
    artifactId: listArtifacts(context.db, { repositoryId: context.repositoryId })[0].id,
  }).content.toString(), 'shared build output');

  context.db.prepare('DELETE FROM workflow_artifacts').run();
  const collected = collectUnreferencedBlobs(context.db, context.config);
  assert.equal(collected.removed, 1);
  assert.equal(fs.existsSync(blobPath(context.config, doomed.digest)), false);
});

test('the artifact quota refuses rather than evicting', (t) => {
  const context = setup(t);
  const chunk = Buffer.alloc(1024, 0x41);
  putArtifact(context.db, context.config, {
    repositoryId: context.repositoryId, runId: context.runId, name: 'first', content: chunk,
  });
  context.db.prepare('UPDATE workflow_artifacts SET size_bytes = ?').run(STORAGE_LIMITS.artifactQuotaBytes);

  // An artifact is evidence somebody may be about to download. Deleting one to
  // make room would lose it without anyone asking.
  assert.throws(
    () => putArtifact(context.db, context.config, {
      repositoryId: context.repositoryId, runId: context.runId, name: 'second', content: chunk,
    }),
    (error) => error.code === 'ARTIFACT_QUOTA_EXCEEDED' && error.status === 507,
  );
  assert.equal(listArtifacts(context.db, { repositoryId: context.repositoryId }).length, 1);
});

test('a cache is restored by exact key on its own ref', (t) => {
  const context = setup(t);
  saveCache(context.db, context.config, {
    repositoryId: context.repositoryId, ref: 'refs/heads/main', key: 'npm-abc123', content: Buffer.from('node_modules'),
  });

  const hit = restoreCache(context.db, context.config, {
    repositoryId: context.repositoryId, ref: 'refs/heads/main', key: 'npm-abc123',
  });
  assert.equal(hit.exact, true);
  assert.equal(hit.content.toString(), 'node_modules');

  assert.equal(restoreCache(context.db, context.config, {
    repositoryId: context.repositoryId, ref: 'refs/heads/main', key: 'npm-different',
  }), null);
});

test('a branch may read the default branch cache but can never write it', (t) => {
  const context = setup(t);
  saveCache(context.db, context.config, {
    repositoryId: context.repositoryId, ref: 'refs/heads/main', key: 'npm-lock', content: Buffer.from('trusted'),
  });

  // Reading across is what makes a cache useful on a new branch.
  const restored = restoreCache(context.db, context.config, {
    repositoryId: context.repositoryId, ref: 'refs/heads/feature', key: 'npm-lock', defaultRef: 'refs/heads/main',
  });
  assert.equal(restored.content.toString(), 'trusted');
  assert.equal(restored.ref, 'refs/heads/main');

  // Writing across is the dangerous direction, and the ref comes from the run
  // record rather than the request, so a feature branch simply writes its own.
  saveCache(context.db, context.config, {
    repositoryId: context.repositoryId, ref: 'refs/heads/feature', key: 'npm-lock', content: Buffer.from('poisoned'),
  });

  const mainSees = restoreCache(context.db, context.config, {
    repositoryId: context.repositoryId, ref: 'refs/heads/main', key: 'npm-lock', defaultRef: 'refs/heads/main',
  });
  // Anyone who can open a pull request must not be able to hand the default
  // branch's build something it will restore and execute.
  assert.equal(mainSees.content.toString(), 'trusted');
  assert.equal(mainSees.ref, 'refs/heads/main');
});

test('restore keys match by prefix, newest first, and never across a wildcard', (t) => {
  const context = setup(t);
  const save = (key, content) => saveCache(context.db, context.config, {
    repositoryId: context.repositoryId, ref: 'refs/heads/main', key, content: Buffer.from(content),
  });
  save('npm-linux-aaa', 'older');
  save('npm-linux-bbb', 'newer');
  save('npm-macos-ccc', 'other platform');

  const hit = restoreCache(context.db, context.config, {
    repositoryId: context.repositoryId, ref: 'refs/heads/main', key: 'npm-linux-zzz', restoreKeys: ['npm-linux-'],
  });
  assert.equal(hit.exact, false);
  // A restore key names a family; the most recent member is the closest thing
  // to what was asked for.
  assert.equal(hit.content.toString(), 'newer');

  // `_` is legal in a cache key and is also SQL's single-character wildcard. An
  // unescaped `npm_%` would match all three keys saved above and hand this build
  // another platform's cache; escaped, it matches nothing, because no key so far
  // literally begins with `npm_`.
  assert.equal(restoreCache(context.db, context.config, {
    repositoryId: context.repositoryId, ref: 'refs/heads/main', key: 'miss', restoreKeys: ['npm_'],
  }), null);

  // The same restore key still matches a key that really does start with `npm_`.
  save('npm_literal', 'wildcard-literal');
  const literal = restoreCache(context.db, context.config, {
    repositoryId: context.repositoryId, ref: 'refs/heads/main', key: 'miss', restoreKeys: ['npm_'],
  });
  assert.equal(literal.content.toString(), 'wildcard-literal');

  assert.equal(restoreCache(context.db, context.config, {
    repositoryId: context.repositoryId, ref: 'refs/heads/main', key: 'miss', restoreKeys: ['pip-'],
  }), null);
});

test('an existing cache key is kept rather than overwritten', (t) => {
  const context = setup(t);
  saveCache(context.db, context.config, {
    repositoryId: context.repositoryId, ref: 'refs/heads/main', key: 'deps-v1', content: Buffer.from('original'),
  });
  const second = saveCache(context.db, context.config, {
    repositoryId: context.repositoryId, ref: 'refs/heads/main', key: 'deps-v1', content: Buffer.from('replacement'),
  });

  // A key is supposed to describe its own contents, so a second write under the
  // same key means the key is wrong; overwriting would hide that and hand later
  // runs something they did not ask for.
  assert.equal(second.stored, false);
  assert.match(second.reason, /already exists/);
  assert.equal(restoreCache(context.db, context.config, {
    repositoryId: context.repositoryId, ref: 'refs/heads/main', key: 'deps-v1',
  }).content.toString(), 'original');
});

test('the cache quota evicts least recently used, unlike artifacts', (t) => {
  const context = setup(t);
  for (const key of ['a', 'b', 'c']) {
    saveCache(context.db, context.config, {
      repositoryId: context.repositoryId, ref: 'refs/heads/main', key: `cache-${key}`, content: Buffer.from(`value-${key}`),
    });
  }
  // `cache-a` is old but every build still restores it.
  restoreCache(context.db, context.config, { repositoryId: context.repositoryId, ref: 'refs/heads/main', key: 'cache-a' });
  context.db.prepare("UPDATE workflow_caches SET last_used_at = datetime('now', '-10 days') WHERE cache_key = 'cache-b'").run();
  // Half the quota each: three rows sit at 1.5x, and dropping exactly one brings
  // the repository back under. Sizing them at a full quota each would make every
  // row evictable and the assertions below would pass for the wrong reason.
  context.db.prepare('UPDATE workflow_caches SET size_bytes = ?').run(Math.floor(STORAGE_LIMITS.cacheQuotaBytes / 2));

  const evicted = evictCacheToQuota(context.db, context.config, context.repositoryId);
  assert.equal(evicted.length, 1);

  // Losing a cache costs a slower build and nothing else, so eviction is right —
  // but least recently *used*, because an old cache every build restores is the
  // most valuable one there is.
  assert.ok(restoreCache(context.db, context.config, { repositoryId: context.repositoryId, ref: 'refs/heads/main', key: 'cache-a' }));
  assert.equal(restoreCache(context.db, context.config, { repositoryId: context.repositoryId, ref: 'refs/heads/main', key: 'cache-b' }), null);
});

test('a cache row whose content vanished becomes a clean miss', (t) => {
  const context = setup(t);
  const saved = saveCache(context.db, context.config, {
    repositoryId: context.repositoryId, ref: 'refs/heads/main', key: 'deps', content: Buffer.from('bytes'),
  });
  const digest = context.db.prepare('SELECT digest FROM workflow_caches WHERE id = ?').get(saved.id).digest;
  fs.rmSync(blobPath(context.config, digest));

  // A broken restore becomes a miss, which a build already knows how to handle.
  assert.equal(restoreCache(context.db, context.config, {
    repositoryId: context.repositoryId, ref: 'refs/heads/main', key: 'deps',
  }), null);
  assert.equal(context.db.prepare('SELECT COUNT(*) AS count FROM workflow_caches').get().count, 0);
});

test('usage is reported per repository against its quota', (t) => {
  const context = setup(t);
  putArtifact(context.db, context.config, {
    repositoryId: context.repositoryId, runId: context.runId, name: 'report', content: Buffer.alloc(100),
  });
  saveCache(context.db, context.config, {
    repositoryId: context.repositoryId, ref: 'refs/heads/main', key: 'deps', content: Buffer.alloc(200),
  });

  const usage = storageUsage(context.db, context.repositoryId);
  assert.equal(usage.artifacts.bytes, 100);
  assert.equal(usage.artifacts.count, 1);
  assert.equal(usage.caches.bytes, 200);
  assert.equal(usage.artifacts.quotaBytes, STORAGE_LIMITS.artifactQuotaBytes);
  assert.deepEqual(storageUsage(context.db, 'repo_other').artifacts, {
    bytes: 0, quotaBytes: STORAGE_LIMITS.artifactQuotaBytes, count: 0,
  });
});
