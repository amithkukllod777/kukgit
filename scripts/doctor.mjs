import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadConfig } from '../src/config.mjs';
import { normalizeEmail } from '../src/security.mjs';

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
check('Authentication mode', () => {
  if (config.authMode === 'local') {
    if (config.isProduction) throw new Error('Production must use One Kuklabs Account/AuthKit');
    return 'local development fallback';
  }
  const endpoint = new URL(config.authkitBaseUrl);
  if (config.isProduction && endpoint.protocol !== 'https:') throw new Error('AuthKit must use HTTPS in production');
  if (String(config.authkitEncryptionKey || '').length < 32) throw new Error('KUKGIT_AUTHKIT_ENCRYPTION_KEY must contain at least 32 characters');
  if (!Number.isInteger(config.authkitTimeoutMs) || config.authkitTimeoutMs < 500 || config.authkitTimeoutMs > 30000) {
    throw new Error('KUKGIT_AUTHKIT_TIMEOUT_MS must be an integer between 500 and 30000');
  }
  if (!Number.isInteger(config.authkitRefreshTtlDays) || config.authkitRefreshTtlDays < 1 || config.authkitRefreshTtlDays > 365) {
    throw new Error('KUKGIT_AUTHKIT_REFRESH_TTL_DAYS must be an integer between 1 and 365');
  }
  if (config.isProduction && !config.cookieSecure) throw new Error('KUKGIT_COOKIE_SECURE must be true with AuthKit in production');
  return `One Kuklabs Account via ${config.authkitBaseUrl}; product ${config.authkitProductId}`;
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
check('Production password', () => {
  if (config.authMode === 'authkit') return 'not used — central AuthKit owns passwords';
  if (config.isProduction && config.adminPassword === 'KukGit@2026') throw new Error('KUKGIT_ADMIN_PASSWORD must be changed');
  return 'configured for local development';
});
check('Git HTTP token', () => config.gitToken && config.gitToken !== 'kukgit-dev-token-change-me' ? 'configured' : 'development default — change before sharing');
check('Webhook encryption key', () => {
  if (!config.webhookEncryptionKey) throw new Error('KUKGIT_WEBHOOK_ENCRYPTION_KEY must be configured');
  if (config.isProduction && config.webhookEncryptionKey.length < 32) throw new Error('KUKGIT_WEBHOOK_ENCRYPTION_KEY must be at least 32 characters in production');
  return config.isProduction ? 'configured' : 'development key — change before sharing';
});
check('Transactional email', () => {
  const configured = Boolean(String(config.smtpHost || '').trim());
  if (!configured) {
    if (config.isProduction) throw new Error('KUKGIT_SMTP_HOST must be configured in production');
    return 'disabled in development';
  }
  if (!/^[A-Za-z0-9.-]+$/.test(config.smtpHost) || config.smtpHost.startsWith('.') || config.smtpHost.endsWith('.')) throw new Error('KUKGIT_SMTP_HOST is invalid');
  if (!Number.isInteger(config.smtpPort) || config.smtpPort < 1 || config.smtpPort > 65535) throw new Error('KUKGIT_SMTP_PORT must be between 1 and 65535');
  normalizeEmail(config.emailFrom);
  if (config.emailReplyTo) normalizeEmail(config.emailReplyTo);
  if ((config.smtpUser && !config.smtpPassword) || (!config.smtpUser && config.smtpPassword)) throw new Error('KUKGIT_SMTP_USER and KUKGIT_SMTP_PASSWORD must be configured together');
  if (config.isProduction && !config.smtpSecure && !config.smtpStartTls) throw new Error('Production SMTP must use direct TLS or STARTTLS');
  if (config.smtpSecure && config.smtpStartTls) return `${config.smtpHost}:${config.smtpPort} direct TLS (STARTTLS setting ignored)`;
  return `${config.smtpHost}:${config.smtpPort} ${config.smtpSecure ? 'direct TLS' : config.smtpStartTls ? 'STARTTLS' : 'plaintext development'}`;
});
check('Notification worker', () => {
  if (!Number.isInteger(config.emailWorkerIntervalMs) || config.emailWorkerIntervalMs < 5000 || config.emailWorkerIntervalMs > 3600000) throw new Error('KUKGIT_EMAIL_WORKER_INTERVAL_MS must be between 5000 and 3600000');
  if (!Number.isInteger(config.emailMaxAttempts) || config.emailMaxAttempts < 1 || config.emailMaxAttempts > 20) throw new Error('KUKGIT_EMAIL_MAX_ATTEMPTS must be between 1 and 20');
  if (!Number.isInteger(config.emailBatchSize) || config.emailBatchSize < 1 || config.emailBatchSize > 100) throw new Error('KUKGIT_EMAIL_BATCH_SIZE must be between 1 and 100');
  return `${config.emailWorkerIntervalMs} ms / ${config.emailMaxAttempts} attempts / ${config.emailBatchSize} messages`;
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
