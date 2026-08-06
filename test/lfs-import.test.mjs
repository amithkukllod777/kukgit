import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadConfig } from '../src/config.mjs';
import { openDatabase, seedCore, uid } from '../src/db.mjs';
import { createBareRepository } from '../src/git.mjs';
import { migrateGitLfs } from '../src/git-lfs.mjs';
import {
  findLfsPointers,
  importLfsObjects,
  lfsEndpointFor,
  parseLfsPointer,
  requestLfsBatch,
} from '../src/lfs-import.mjs';

/**
 * Fetching the files a mirror clone did not bring.
 *
 * A repository using Git LFS does not contain its large files — it contains
 * 130-byte text files naming them. So an imported repository looks complete,
 * clones fine, and hands whoever checks it out a pointer where their model
 * weights used to be. These cover finding those pointers, and refusing anything
 * the far end sends that is not what the pointer promised.
 */

function pointerText(oid, size) {
  return `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${size}\n`;
}

function workspace(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-lfs-import-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const config = loadConfig({
    dataDir,
    databasePath: path.join(dataDir, 'test.db'),
    repositoriesDir: path.join(dataDir, 'repos'),
    tempDir: path.join(dataDir, 'tmp'),
    lfsDir: path.join(dataDir, 'lfs'),
    nodeEnv: 'test',
    adminEmail: 'founder@kuklabs.com',
    adminPassword: 'secure-test-password',
    adminName: 'Founder',
  });
  const db = openDatabase(config);
  t.after(() => db.close());
  seedCore(db, config);
  migrateGitLfs(db);
  const organization = db.prepare("SELECT id, slug FROM organizations WHERE slug = 'kuklabs'").get();
  const actor = db.prepare('SELECT id FROM users LIMIT 1').get();
  const repositoryId = uid('repo');
  db.prepare('INSERT INTO repositories (id, organization_id, slug, name, visibility, created_by) VALUES (?, ?, ?, ?, ?, ?)')
    .run(repositoryId, organization.id, 'weights', 'Weights', 'private', actor.id);
  createBareRepository(config, organization.slug, 'weights');
  const repository = { id: repositoryId, slug: 'weights', orgSlug: organization.slug };
  return { config, db, organization, actor, repository, dataDir };
}

/** Commits files into the bare repository the importer will scan. */
function commit(config, dataDir, files) {
  const work = fs.mkdtempSync(path.join(dataDir, 'work-'));
  execFileSync('git', ['init', '-q', '--initial-branch=main', work]);
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(work, name)), { recursive: true });
    fs.writeFileSync(path.join(work, name), content);
  }
  const env = { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@kuklabs.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@kuklabs.com' };
  execFileSync('git', ['add', '-A'], { cwd: work, env });
  execFileSync('git', ['commit', '-qm', 'files'], { cwd: work, env });
  execFileSync('git', ['push', '-q', path.join(config.repositoriesDir, 'kuklabs', 'weights.git'), 'main'], { cwd: work, env });
}

test('a pointer is read, and anything pointer-ish is not', async () => {
  const oid = 'a'.repeat(64);
  assert.deepEqual(parseLfsPointer(pointerText(oid, 4096)), { oid, size: 4096 });

  // A blob that merely mentions the words is a file somebody committed.
  // Treating it as a pointer replaces their file with whatever an LFS server
  // returns for that OID.
  assert.equal(parseLfsPointer('# See https://git-lfs.github.com/spec/v1 for details\n'), null);
  assert.equal(parseLfsPointer(`${pointerText(oid, 10)}extra line\n`), null);
  assert.equal(parseLfsPointer(`version https://git-lfs.github.com/spec/v1\noid sha256:${'g'.repeat(64)}\nsize 10\n`), null);
  assert.equal(parseLfsPointer(`version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize -1\n`), null);
  assert.equal(parseLfsPointer('x'.repeat(400)), null);
  assert.equal(parseLfsPointer(''), null);
});

test('the endpoint follows the Git LFS convention, over HTTPS only', async () => {
  assert.equal(lfsEndpointFor('https://github.com/acme/thing.git'), 'https://github.com/acme/thing.git/info/lfs');
  assert.equal(lfsEndpointFor('https://github.com/acme/thing'), 'https://github.com/acme/thing.git/info/lfs');
  // An SSH remote authenticates at the transport layer and has no batch API to
  // point a token at.
  assert.throws(() => lfsEndpointFor('git@github.com:acme/thing.git'), /only be fetched over HTTPS/);
});

test('pointers are found across the repository, and ordinary files are not', async (t) => {
  const { config, dataDir } = workspace(t);
  const oidOne = crypto.createHash('sha256').update('one').digest('hex');
  const oidTwo = crypto.createHash('sha256').update('two').digest('hex');
  commit(config, dataDir, {
    'model.bin': pointerText(oidOne, 3),
    'nested/video.mp4': pointerText(oidTwo, 3),
    // Same file, second path: one object, not two.
    'copy.bin': pointerText(oidOne, 3),
    'README.md': '# Weights\n\nStored with Git LFS.\n',
    'big.txt': 'x'.repeat(5000),
  });

  const pointers = await findLfsPointers(config, 'kuklabs', 'weights');
  assert.deepEqual(pointers.map((pointer) => pointer.oid).sort(), [oidOne, oidTwo].sort());
});

test('a repository with no pointers costs nothing and asks nobody', async (t) => {
  const { config, db, repository, dataDir } = workspace(t);
  commit(config, dataDir, { 'README.md': '# Nothing large here\n' });
  let asked = false;
  const result = await importLfsObjects(db, config, { repository, sourceUrl: 'https://github.com/acme/weights.git' }, {
    fetchImpl: async () => { asked = true; throw new Error('should not be called'); },
  });
  assert.deepEqual(result, { found: 0, imported: 0, alreadyHeld: 0, bytes: 0, failures: [] });
  assert.equal(asked, false);
});

function lfsServer({ contents = {}, batchStatus = 200, refuse = {} } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(url);
    if (url.endsWith('/objects/batch')) {
      if (batchStatus !== 200) return new Response('{}', { status: batchStatus });
      const body = JSON.parse(init.body);
      return new Response(JSON.stringify({
        objects: body.objects.map(({ oid, size }) => (refuse[oid]
          ? { oid, size, error: { code: 404, message: refuse[oid] } }
          : { oid, size, actions: { download: { href: `https://cdn.example.com/${oid}`, header: { Authorization: 'Bearer signed' } } } })),
      }), { status: 200, headers: { 'Content-Type': 'application/vnd.git-lfs+json' } });
    }
    const oid = url.split('/').pop();
    if (!(oid in contents)) return new Response('missing', { status: 404 });
    return new Response(contents[oid], { status: 200 });
  };
  return { fetchImpl, calls };
}

test('objects are fetched, verified and stored', async (t) => {
  const { config, db, repository, actor, dataDir } = workspace(t);
  const payload = 'the actual weights';
  const oid = crypto.createHash('sha256').update(payload).digest('hex');
  commit(config, dataDir, { 'model.bin': pointerText(oid, payload.length) });

  const { fetchImpl, calls } = lfsServer({ contents: { [oid]: payload } });
  const result = await importLfsObjects(db, config, {
    repository, sourceUrl: 'https://github.com/acme/weights.git', token: 'github_pat_VALUE', attachedBy: actor.id,
  }, { fetchImpl });

  assert.deepEqual({ found: result.found, imported: result.imported, failures: result.failures }, { found: 1, imported: 1, failures: [] });
  assert.equal(result.bytes, payload.length);

  const stored = db.prepare('SELECT oid, size, storage_path AS storagePath FROM lfs_objects').all()
    .map((row) => `${row.oid}:${row.size}:${row.storagePath}`);
  assert.deepEqual(stored, [`${oid}:${payload.length}:objects/${oid.slice(0, 2)}/${oid.slice(2, 4)}/${oid}`]);
  // Attached to this repository, or its own LFS listing shows nothing.
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM repository_lfs_objects WHERE repository_id = ?').get(repository.id).count, 1);
  // The bytes are on disk and are the bytes that were sent.
  assert.equal(fs.readFileSync(path.join(config.lfsDir, 'objects', oid.slice(0, 2), oid.slice(2, 4), oid), 'utf8'), payload);
  assert.ok(calls.some((url) => url.endsWith('/objects/batch')));
});

test('bytes that are not what the pointer promised are refused', async (t) => {
  const { config, db, repository, dataDir } = workspace(t);
  const payload = 'the actual weights';
  const oid = crypto.createHash('sha256').update(payload).digest('hex');
  commit(config, dataDir, { 'model.bin': pointerText(oid, payload.length) });

  // Same length, different content — so only the hash catches it.
  const { fetchImpl } = lfsServer({ contents: { [oid]: 'THE ACTUAL WEIGHTS' } });
  const result = await importLfsObjects(db, config, { repository, sourceUrl: 'https://github.com/acme/weights.git' }, { fetchImpl });

  assert.equal(result.imported, 0);
  assert.match(result.failures[0].reason, /does not match the SHA-256/);
  // Nothing kept. Storing it would have KukGit serve those bytes under a name
  // that promises otherwise.
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM lfs_objects').get().count, 0);
  assert.equal(fs.existsSync(path.join(config.lfsDir, 'objects', oid.slice(0, 2), oid.slice(2, 4), oid)), false);
  // And no temporary file left behind for the disk to fill up with.
  assert.deepEqual(fs.existsSync(config.tempDir) ? fs.readdirSync(config.tempDir).filter((name) => name.startsWith('lfs-import-')) : [], []);
});

test('an object longer than its pointer is cut off rather than swallowed', async (t) => {
  const { config, db, repository, dataDir } = workspace(t);
  const oid = crypto.createHash('sha256').update('small').digest('hex');
  commit(config, dataDir, { 'model.bin': pointerText(oid, 5) });

  const { fetchImpl } = lfsServer({ contents: { [oid]: 'x'.repeat(100000) } });
  const result = await importLfsObjects(db, config, { repository, sourceUrl: 'https://github.com/acme/weights.git' }, { fetchImpl });

  // Specifically the streaming ceiling, not the comparison at the end. Both
  // reject the object; only one of them stops before the disk has taken
  // whatever the far end felt like sending, and the difference between them is
  // invisible in the result unless the message is checked.
  assert.equal(result.failures[0].reason, 'The object is larger than its pointer declares.');
  assert.equal(result.imported, 0);
});

test('one object failing does not stop the others', async (t) => {
  const { config, db, repository, dataDir } = workspace(t);
  const good = 'weights that arrive';
  const goodOid = crypto.createHash('sha256').update(good).digest('hex');
  const goneOid = crypto.createHash('sha256').update('deleted from the source last year').digest('hex');
  commit(config, dataDir, {
    'good.bin': pointerText(goodOid, good.length),
    'gone.bin': pointerText(goneOid, 42),
  });

  const { fetchImpl } = lfsServer({ contents: { [goodOid]: good }, refuse: { [goneOid]: 'Object does not exist' } });
  const result = await importLfsObjects(db, config, { repository, sourceUrl: 'https://github.com/acme/weights.git' }, { fetchImpl });

  // A migration of four hundred files must not stop at the one deleted from the
  // source last year — and the one that did not come across must be named.
  assert.equal(result.imported, 1);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].oid, goneOid);
  assert.match(result.failures[0].reason, /does not exist/);
});

test('an object KukGit already holds is attached, not downloaded again', async (t) => {
  const { config, db, repository, actor, dataDir } = workspace(t);
  const payload = 'shared between two repositories';
  const oid = crypto.createHash('sha256').update(payload).digest('hex');
  commit(config, dataDir, { 'model.bin': pointerText(oid, payload.length) });
  db.prepare("INSERT INTO lfs_objects (oid, size, storage_path) VALUES (?, ?, ?)").run(oid, payload.length, `objects/${oid.slice(0, 2)}/${oid.slice(2, 4)}/${oid}`);

  const { fetchImpl, calls } = lfsServer({ contents: { [oid]: payload } });
  const result = await importLfsObjects(db, config, { repository, sourceUrl: 'https://github.com/acme/weights.git', attachedBy: actor.id }, { fetchImpl });

  assert.equal(result.alreadyHeld, 1);
  assert.equal(result.imported, 0);
  // Content-addressed storage means the bytes are already right. Fetching them
  // again would be paying twice for the same file.
  assert.deepEqual(calls, []);
  // But it still has to be attached here, or this repository's LFS listing is
  // empty for a file it points at.
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM repository_lfs_objects WHERE repository_id = ?').get(repository.id).count, 1);
});

test('a rejected token is reported as a token problem', async (t) => {
  const { config, db, repository, dataDir } = workspace(t);
  const oid = crypto.createHash('sha256').update('x').digest('hex');
  commit(config, dataDir, { 'model.bin': pointerText(oid, 1) });

  const { fetchImpl } = lfsServer({ batchStatus: 401 });
  const result = await importLfsObjects(db, config, { repository, sourceUrl: 'https://github.com/acme/weights.git' }, { fetchImpl });

  // The reason belongs against every object the failed batch covered, not
  // thrown away with the batch.
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0].reason, /rejected the access token/);
});

test('the batch request carries the token and asks for downloads', async (t) => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ objects: [] }), { status: 200 });
  };
  await requestLfsBatch({
    endpoint: 'https://github.com/acme/thing.git/info/lfs',
    token: 'github_pat_VALUE',
    objects: [{ oid: 'a'.repeat(64), size: 10 }],
  }, { fetchImpl });

  assert.equal(seen[0].url, 'https://github.com/acme/thing.git/info/lfs/objects/batch');
  assert.equal(seen[0].body.operation, 'download');
  const decoded = Buffer.from(String(seen[0].headers.Authorization).replace('Basic ', ''), 'base64').toString('utf8');
  assert.equal(decoded, 'x-access-token:github_pat_VALUE');
  assert.equal(seen[0].headers.Accept, 'application/vnd.git-lfs+json');
});
