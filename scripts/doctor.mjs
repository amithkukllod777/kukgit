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
check('Email provider events', () => {
  if (!config.emailProviderEventsEnabled) return 'disabled until a signed provider webhook secret is configured';
  if (String(config.emailProviderWebhookSecret || '').length < 32) throw new Error('KUKGIT_EMAIL_PROVIDER_WEBHOOK_SECRET must contain at least 32 characters');
  if (!Number.isInteger(config.emailProviderWebhookToleranceSeconds) || config.emailProviderWebhookToleranceSeconds < 30 || config.emailProviderWebhookToleranceSeconds > 3600) throw new Error('KUKGIT_EMAIL_PROVIDER_WEBHOOK_TOLERANCE_SECONDS must be between 30 and 3600');
  if (!Number.isInteger(config.emailSoftBounceThreshold) || config.emailSoftBounceThreshold < 2 || config.emailSoftBounceThreshold > 20) throw new Error('KUKGIT_EMAIL_SOFT_BOUNCE_THRESHOLD must be between 2 and 20');
  if (!Number.isInteger(config.emailSoftBounceWindowDays) || config.emailSoftBounceWindowDays < 1 || config.emailSoftBounceWindowDays > 90) throw new Error('KUKGIT_EMAIL_SOFT_BOUNCE_WINDOW_DAYS must be between 1 and 90');
  if (!Number.isInteger(config.emailSoftBounceSuppressionDays) || config.emailSoftBounceSuppressionDays < 1 || config.emailSoftBounceSuppressionDays > 365) throw new Error('KUKGIT_EMAIL_SOFT_BOUNCE_SUPPRESSION_DAYS must be between 1 and 365');
  return `signed webhook; threshold ${config.emailSoftBounceThreshold} in ${config.emailSoftBounceWindowDays} days; suppress ${config.emailSoftBounceSuppressionDays} days`;
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
