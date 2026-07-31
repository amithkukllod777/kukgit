import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  commitFile, createBareRepository, createBranch, createDemoCommit, listBranches, listCommits, listTree, readBlob,
} from '../src/git.mjs';

function tempConfig() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kukgit-git-test-'));
  return { dataDir, repositoriesDir: path.join(dataDir, 'repos'), tempDir: path.join(dataDir, 'tmp') };
}

test('creates, browses and updates a real bare Git repository', async (t) => {
  const config = tempConfig();
  t.after(() => fs.rmSync(config.dataDir, { recursive: true, force: true }));
  createBareRepository(config, 'kuklabs', 'demo-repo');
  await createDemoCommit(config, 'kuklabs', 'demo-repo');
  const branches = listBranches(config, 'kuklabs', 'demo-repo');
  assert.equal(branches[0].name, 'main');
  assert.equal(listCommits(config, 'kuklabs', 'demo-repo', 'main').length, 1);
  assert.ok(listTree(config, 'kuklabs', 'demo-repo', 'main').some((entry) => entry.name === 'README.md'));
  assert.match(readBlob(config, 'kuklabs', 'demo-repo', 'main', 'README.md').content, /KukGit Demo/);

  createBranch(config, 'kuklabs', 'demo-repo', 'feature/test', 'main');
  const commit = await commitFile(config, 'kuklabs', 'demo-repo', {
    branch: 'feature/test', filePath: 'src/new.js', content: 'export const ready = true;\n', message: 'Add test file',
    authorName: 'Test User', authorEmail: 'test@example.com',
  });
  assert.equal(commit.branch, 'feature/test');
  assert.equal(readBlob(config, 'kuklabs', 'demo-repo', 'feature/test', 'src/new.js').content, 'export const ready = true;\n');
});
