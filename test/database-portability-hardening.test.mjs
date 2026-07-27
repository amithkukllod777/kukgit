import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  buildSqliteManifest,
  createSqliteExport,
  readSqliteExport,
} from '../src/database-portability.mjs';

function stableValue(value) {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return { $binary: Buffer.from(value).toString('base64') };
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  if (typeof value === 'bigint') return { $bigint: value.toString() };
  return value;
}

function checksum(value) {
  return crypto.createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex');
}

function database(rows) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON; CREATE TABLE samples (id TEXT PRIMARY KEY, value TEXT NOT NULL);');
  const insert = db.prepare('INSERT INTO samples (id, value) VALUES (?, ?)');
  for (const row of rows) insert.run(row.id, row.value);
  return db;
}

test('manifest fingerprint is independent of insertion order and locale collation', () => {
  const rows = [
    { id: 'z', value: 'Zulu' },
    { id: 'accent', value: 'Éclair' },
    { id: 'devanagari', value: 'कुकलैब्स' },
    { id: 'emoji', value: '🚀' },
  ];
  const first = database(rows);
  const second = database([...rows].reverse());
  try {
    assert.equal(buildSqliteManifest(first).fingerprint, buildSqliteManifest(second).fingerprint);
  } finally {
    first.close();
    second.close();
  }
});

test('export verification rejects duplicate and internally inconsistent tables even with a recomputed bundle checksum', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-db-hardening-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const target = path.join(directory, 'metadata.kgdb.json');
  const db = database([{ id: 'one', value: 'One' }]);
  try {
    createSqliteExport(db, target);
  } finally {
    db.close();
  }

  const duplicate = JSON.parse(fs.readFileSync(target, 'utf8'));
  duplicate.tables.push(structuredClone(duplicate.tables[0]));
  delete duplicate.bundleChecksum;
  duplicate.bundleChecksum = checksum(duplicate);
  fs.writeFileSync(target, JSON.stringify(duplicate));
  assert.throws(() => readSqliteExport(target), /duplicate table/i);

  const cleanDb = database([{ id: 'one', value: 'One' }]);
  try {
    createSqliteExport(cleanDb, target);
  } finally {
    cleanDb.close();
  }
  const inconsistent = JSON.parse(fs.readFileSync(target, 'utf8'));
  inconsistent.source.manifest.tables[0].schema += ' ';
  delete inconsistent.bundleChecksum;
  inconsistent.bundleChecksum = checksum(inconsistent);
  fs.writeFileSync(target, JSON.stringify(inconsistent));
  assert.throws(() => readSqliteExport(target), /schema checksum mismatch/i);
});
