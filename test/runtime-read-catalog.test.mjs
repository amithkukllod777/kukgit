import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compilePostgresqlParameters,
  parametersFromSample,
  runtimeReadCatalog,
  runtimeReadSpec,
} from '../src/runtime-read-catalog.mjs';

test('runtime read catalog contains named parameterized SELECT operations only', () => {
  const catalog = runtimeReadCatalog();
  assert.ok(catalog.length >= 8);
  assert.equal(new Set(catalog.map((item) => item.id)).size, catalog.length);
  for (const item of catalog) {
    assert.match(item.id, /^[a-z][a-z0-9_.-]+$/);
    assert.match(item.sqliteSql, /^SELECT\b/i);
    assert.match(item.postgresqlSql, /^SELECT\b/i);
    assert.equal(item.postgresqlSql.includes('?'), false);
    assert.equal(item.parameters.length, (item.postgresqlSql.match(/\$\d+/g) || []).length);
  }
});

test('placeholder compiler ignores question marks inside quoted strings', () => {
  const compiled = compilePostgresqlParameters("SELECT '?' AS literal, value FROM demo WHERE id = ? AND note = 'what?' AND flag = ?");
  assert.equal(compiled.parameterCount, 2);
  assert.equal(compiled.sql, "SELECT '?' AS literal, value FROM demo WHERE id = $1 AND note = 'what?' AND flag = $2");
});

test('placeholder compiler rejects comments and multiple statements', () => {
  assert.throws(() => compilePostgresqlParameters('SELECT 1; SELECT 2'), /multiple statements/i);
  assert.throws(() => compilePostgresqlParameters('SELECT 1 -- comment'), /comments/i);
  assert.throws(() => compilePostgresqlParameters('SELECT /* hidden */ 1'), /comments/i);
});

test('catalog lookup and sample parameters fail closed', () => {
  assert.throws(() => runtimeReadSpec('missing.operation'), /unknown runtime read/i);
  const spec = runtimeReadSpec('repositories.by_slug');
  assert.deepEqual(parametersFromSample(spec, { orgSlug: 'kuklabs', repoSlug: 'kukgit' }), ['kuklabs', 'kukgit']);
  assert.throws(() => parametersFromSample(spec, { orgSlug: 'kuklabs' }), /missing repoSlug/i);
});
