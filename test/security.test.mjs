import test from 'node:test';
import assert from 'node:assert/strict';
import { assertBranch, assertSlug, safeRepoRelativePath, validateRemoteUrl } from '../src/security.mjs';

test('validates organization and repository slugs', () => {
  assert.equal(assertSlug('kuklabs'), 'kuklabs');
  assert.throws(() => assertSlug('../root'));
  assert.throws(() => assertSlug('UpperCase'));
});

test('validates branch and file paths', () => {
  assert.equal(assertBranch('feature/ai-review'), 'feature/ai-review');
  assert.equal(safeRepoRelativePath('src/app.js'), 'src/app.js');
  assert.throws(() => safeRepoRelativePath('../secret'));
  assert.throws(() => assertBranch('bad..branch'));
});

test('blocks unsafe import URLs', () => {
  assert.equal(validateRemoteUrl('https://github.com/openai/openai.git'), 'https://github.com/openai/openai.git');
  assert.throws(() => validateRemoteUrl('file:///etc/passwd'));
  assert.throws(() => validateRemoteUrl('http://localhost/repo.git'));
  assert.throws(() => validateRemoteUrl('https://user:token@example.com/repo.git'));
});
