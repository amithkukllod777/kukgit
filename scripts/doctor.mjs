import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { loadConfig } from '../src/config.mjs';

const config = loadConfig();
const checks = [];
function check(name, fn) {
  try { checks.push({ name, ok: true, detail: fn() }); }
  catch (error) { checks.push({ name, ok: false, detail: error.message }); }
}
check('Node.js', () => process.version);
check('Git', () => {
  const result = spawnSync('git', ['--version'], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error('Git CLI not found');
  return result.stdout.trim();
});
check('Data directory', () => {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.accessSync(config.dataDir, fs.constants.R_OK | fs.constants.W_OK);
  return config.dataDir;
});
check('Repository directory', () => {
  fs.mkdirSync(config.repositoriesDir, { recursive: true });
  fs.accessSync(config.repositoriesDir, fs.constants.R_OK | fs.constants.W_OK);
  return config.repositoriesDir;
});
check('Production password', () => !config.isProduction || config.adminPassword !== 'KukGit@2026' ? 'configured' : (() => { throw new Error('KUKGIT_ADMIN_PASSWORD must be changed'); })());
check('Git HTTP token', () => config.gitToken && config.gitToken !== 'kukgit-dev-token-change-me' ? 'configured' : 'development default — change before sharing');
for (const item of checks) console.log(`${item.ok ? '✓' : '✗'} ${item.name}: ${item.detail}`);
if (checks.some((item) => !item.ok)) process.exitCode = 1;
