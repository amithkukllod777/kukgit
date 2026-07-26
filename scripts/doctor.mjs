import fs from 'node:fs';
import path from 'node:path';
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
check('Git LFS directory', () => {
  fs.mkdirSync(config.lfsDir, { recursive: true, mode: 0o700 });
  fs.accessSync(config.lfsDir, fs.constants.R_OK | fs.constants.W_OK);
  if (path.resolve(config.lfsDir) === path.resolve(config.repositoriesDir)) throw new Error('KUKGIT_LFS_DIR cannot equal the Git repository directory');
  if (path.resolve(config.lfsDir) === path.resolve(config.backupsDir)) throw new Error('KUKGIT_LFS_DIR cannot equal the backup directory');
  return config.lfsDir;
});
check('Git LFS limits', () => {
  const values = [
    ['KUKGIT_LFS_MAX_OBJECT_BYTES', config.lfsMaxObjectBytes],
    ['KUKGIT_LFS_REPOSITORY_QUOTA_BYTES', config.lfsRepositoryQuotaBytes],
    ['KUKGIT_LFS_INSTANCE_QUOTA_BYTES', config.lfsInstanceQuotaBytes],
  ];
  for (const [name, value] of values) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive safe integer`);
  }
  if (config.lfsMaxObjectBytes > config.lfsRepositoryQuotaBytes) throw new Error('Git LFS maximum object size cannot exceed the repository quota');
  if (config.lfsRepositoryQuotaBytes > config.lfsInstanceQuotaBytes) throw new Error('Git LFS repository quota cannot exceed the instance quota');
  if (!Number.isInteger(config.lfsUploadExpirySeconds) || config.lfsUploadExpirySeconds < 60 || config.lfsUploadExpirySeconds > 86400) {
    throw new Error('KUKGIT_LFS_UPLOAD_EXPIRY_SECONDS must be between 60 and 86400');
  }
  return `${config.lfsMaxObjectBytes} object / ${config.lfsRepositoryQuotaBytes} repository / ${config.lfsInstanceQuotaBytes} instance`;
});
check('Git LFS signing key', () => {
  if (!config.lfsAuthKey) throw new Error('KUKGIT_LFS_AUTH_KEY must be configured');
  if (config.isProduction && config.lfsAuthKey.length < 32) throw new Error('KUKGIT_LFS_AUTH_KEY must be at least 32 characters in production');
  return config.isProduction ? 'configured' : 'development key — change before sharing';
});
check('Backup directory', () => {
  fs.mkdirSync(config.backupsDir, { recursive: true, mode: 0o700 });
  fs.accessSync(config.backupsDir, fs.constants.R_OK | fs.constants.W_OK);
  if (path.resolve(config.backupsDir) === path.resolve(config.repositoriesDir)) throw new Error('KUKGIT_BACKUPS_DIR cannot equal the repository directory');
  return config.backupsDir;
});
check('Backup retention', () => {
  if (!Number.isInteger(config.backupRetentionCount) || config.backupRetentionCount < 1 || config.backupRetentionCount > 10000) throw new Error('KUKGIT_BACKUP_RETENTION_COUNT must be between 1 and 10000');
  if (!Number.isInteger(config.backupRetentionDays) || config.backupRetentionDays < 1 || config.backupRetentionDays > 36500) throw new Error('KUKGIT_BACKUP_RETENTION_DAYS must be between 1 and 36500');
  return `${config.backupRetentionCount} snapshots / ${config.backupRetentionDays} days`;
});
check('Maintenance and lock paths', () => {
  for (const value of [config.maintenancePath, config.backupLockPath]) {
    fs.mkdirSync(path.dirname(value), { recursive: true, mode: 0o700 });
    fs.accessSync(path.dirname(value), fs.constants.R_OK | fs.constants.W_OK);
  }
  if (path.resolve(config.maintenancePath) === path.resolve(config.backupLockPath)) throw new Error('Maintenance and backup lock paths must be different');
  return `${config.maintenancePath}; ${config.backupLockPath}`;
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
