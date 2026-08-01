import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { openDatabase, withSchemaLock } from '../src/db.mjs';

function setup(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-schema-lock-'));
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
  return { config, db, dataDir };
}

test('a transaction inside a transaction becomes a savepoint', (t) => {
  const { db } = setup(t);
  db.exec('CREATE TABLE nesting (id INTEGER PRIMARY KEY, label TEXT)');
  const insert = (label) => db.prepare('INSERT INTO nesting (label) VALUES (?)').run(label);
  const labels = () => db.prepare('SELECT label FROM nesting ORDER BY id').all().map((row) => row.label);

  // SQLite refuses BEGIN inside BEGIN. Without savepoints, wrapping already
  // transactional work — which is what the schema lock does to every migration —
  // would fail at runtime.
  db.transaction(() => {
    insert('outer');
    db.transaction(() => insert('inner'))();
  })();
  assert.deepEqual(labels(), ['outer', 'inner']);

  // An inner failure unwinds only the inner work.
  db.transaction(() => {
    insert('kept');
    try {
      db.transaction(() => { insert('discarded'); throw new Error('inner failure'); })();
    } catch { /* handled by the outer transaction */ }
  })();
  assert.deepEqual(labels(), ['outer', 'inner', 'kept']);

  // An outer failure discards everything, including committed savepoints.
  assert.throws(() => db.transaction(() => {
    insert('outer-doomed');
    db.transaction(() => insert('inner-doomed'))();
    throw new Error('outer failure');
  })(), /outer failure/);
  assert.deepEqual(labels(), ['outer', 'inner', 'kept']);

  assert.equal(db.transactionDepth, 0, 'the depth counter returns to zero');
});

test('the schema lock raises the busy timeout only while it is held', (t) => {
  const { db } = setup(t);
  const timeout = () => db.prepare('PRAGMA busy_timeout').get().timeout;

  const inside = withSchemaLock(db, () => {
    db.exec('CREATE TABLE IF NOT EXISTS locked (id INTEGER PRIMARY KEY)');
    return timeout();
  });

  // A minute of waiting is right for a second instance starting up. Leaving it
  // raised would make every later contended write wait a minute before
  // reporting a problem.
  assert.ok(inside >= 60_000, `expected a raised timeout, got ${inside}`);
  assert.equal(timeout(), 5000);
});

test('the schema lock leaves the timeout restored even when the work throws', (t) => {
  const { db } = setup(t);
  assert.throws(() => withSchemaLock(db, () => { throw new Error('migration failed'); }), /migration failed/);
  assert.equal(db.prepare('PRAGMA busy_timeout').get().timeout, 5000);
  assert.equal(db.transactionDepth, 0);
});

test('a second connection opens against a database another instance created', (t) => {
  const { config, db } = setup(t);
  assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode.toLowerCase(), 'wal');

  // The second instance of a rolling deploy. It must not try to re-establish
  // WAL mode and must find every migration already applied.
  const second = openDatabase(config);
  t.after(() => second.close());
  assert.equal(second.prepare('PRAGMA journal_mode').get().journal_mode.toLowerCase(), 'wal');
  assert.ok(second.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'").get());
});
