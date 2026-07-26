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
check('Webhook encryption key', () => {
  if (!config.webhookEncryptionKey) throw new Error('KUKGIT_WEBHOOK_ENCRYPTION_KEY must be configured');
  if (config.isProduction && config.webhookEncryptionKey.length < 32) throw new Error('KUKGIT_WEBHOOK_ENCRYPTION_KEY must be at least 32 characters in production');
  return config.isProduction ? 'configured' : 'development key — change before sharing';
});
check('SSH endpoint', () => {
  if (!/^[A-Za-z0-9.-]+$/.test(config.sshHost) || config.sshHost.startsWith('.') || config.sshHost.endsWith('.')) throw new Error('KUKGIT_SSH_HOST is invalid');
  if (!Number.isInteger(config.sshPort) || config.sshPort < 1 || config.sshPort > 65535) throw new Error('KUKGIT_SSH_PORT must be between 1 and 65535');
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(config.sshUser)) throw new Error('KUKGIT_SSH_USER is invalid');
  return `${config.sshUser}@${config.sshHost}:${config.sshPort}`;
});
check('SSH forced-command runtime', () => {
  fs.accessSync(config.nodeBinary, fs.constants.X_OK);
  fs.accessSync(config.sshCommandScript, fs.constants.R_OK);
  return `${config.nodeBinary} ${config.sshCommandScript}`;
});
for (const item of checks) console.log(`${item.ok ? '✓' : '✗'} ${item.name}: ${item.detail}`);
if (checks.some((item) => !item.ok)) process.exitCode = 1;
