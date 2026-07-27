import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inventoryDatabaseRuntimeSurface, safeRuntimeSurfaceReport } from '../src/database-runtime-surface.mjs';

function workspace(t, source) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-runtime-surface-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'sample.mjs'), source);
  return root;
}

test('runtime surface classifies static, dynamic, write and transaction calls', (t) => {
  const root = workspace(t, `
    db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    db.prepare(\`UPDATE users SET display_name = ? WHERE id = ?\`).run(name, id);
    db.prepare(\`SELECT * FROM \${table}\`).all();
    db.exec('CREATE TABLE demo (id TEXT)');
    db.transaction(() => {});
  `);
  const report = inventoryDatabaseRuntimeSurface(root);
  assert.equal(report.format, 'kukgit-database-runtime-surface/1');
  assert.equal(report.counts.calls, 5);
  assert.equal(report.counts.reads, 1);
  assert.equal(report.counts.writes, 1);
  assert.equal(report.counts.ddl, 1);
  assert.equal(report.counts.transactions, 1);
  assert.equal(report.counts.dynamic, 1);
  assert.match(report.calls[0].sqlFingerprint || '', /^[0-9a-f]{64}$/);
});

test('runtime surface fingerprint is independent of absolute source root', (t) => {
  const source = `db.prepare('SELECT id FROM users WHERE id = ?').get(id);`;
  const first = workspace(t, source);
  const second = workspace(t, source);
  const left = inventoryDatabaseRuntimeSurface(first);
  const right = inventoryDatabaseRuntimeSurface(second);
  assert.equal(left.fingerprint, right.fingerprint);
  const safe = safeRuntimeSurfaceReport(left);
  assert.equal('root' in safe.calls[0], false);
  assert.equal('roots' in safe, false);
  assert.equal(JSON.stringify(safe).includes(path.resolve(first)), false);
});

test('safe report rejects unsupported input', () => {
  assert.throws(() => safeRuntimeSurfaceReport({ format: 'other' }), /valid database runtime surface/i);
});
