import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

export function loadConfig(overrides = {}) {
  const dataDir = path.resolve(overrides.dataDir ?? process.env.KUKGIT_DATA_DIR ?? path.join(root, 'data'));
  const isProduction = (overrides.nodeEnv ?? process.env.NODE_ENV) === 'production';
  const baseUrl = overrides.baseUrl ?? process.env.KUKGIT_BASE_URL ?? `http://localhost:${overrides.port ?? process.env.PORT ?? 8787}`;
  return {
    root,
    host: overrides.host ?? process.env.HOST ?? '0.0.0.0',
    port: Number(overrides.port ?? process.env.PORT ?? 8787),
    baseUrl,
    dataDir,
    databasePath: overrides.databasePath ?? path.join(dataDir, 'kukgit.db'),
    repositoriesDir: overrides.repositoriesDir ?? path.join(dataDir, 'repos'),
    lfsDir: path.resolve(overrides.lfsDir ?? process.env.KUKGIT_LFS_DIR ?? path.join(dataDir, 'lfs')),
    lfsMaxObjectBytes: Number(overrides.lfsMaxObjectBytes ?? process.env.KUKGIT_LFS_MAX_OBJECT_BYTES ?? 5 * 1024 * 1024 * 1024),
    lfsRepositoryQuotaBytes: Number(overrides.lfsRepositoryQuotaBytes ?? process.env.KUKGIT_LFS_REPOSITORY_QUOTA_BYTES ?? 20 * 1024 * 1024 * 1024),
    lfsInstanceQuotaBytes: Number(overrides.lfsInstanceQuotaBytes ?? process.env.KUKGIT_LFS_INSTANCE_QUOTA_BYTES ?? 100 * 1024 * 1024 * 1024),
    lfsUploadExpirySeconds: Number(overrides.lfsUploadExpirySeconds ?? process.env.KUKGIT_LFS_UPLOAD_EXPIRY_SECONDS ?? 3600),
    lfsAuthKey: overrides.lfsAuthKey ?? process.env.KUKGIT_LFS_AUTH_KEY ?? (isProduction ? '' : 'kukgit-development-lfs-auth-key-change-me'),
    tempDir: overrides.tempDir ?? path.join(dataDir, 'tmp'),
    backupsDir: path.resolve(overrides.backupsDir ?? process.env.KUKGIT_BACKUPS_DIR ?? path.join(dataDir, 'backups')),
    backupRetentionCount: Number(overrides.backupRetentionCount ?? process.env.KUKGIT_BACKUP_RETENTION_COUNT ?? 14),
    backupRetentionDays: Number(overrides.backupRetentionDays ?? process.env.KUKGIT_BACKUP_RETENTION_DAYS ?? 30),
    maintenancePath: path.resolve(overrides.maintenancePath ?? process.env.KUKGIT_MAINTENANCE_PATH ?? path.join(dataDir, 'maintenance.json')),
    backupLockPath: path.resolve(overrides.backupLockPath ?? process.env.KUKGIT_BACKUP_LOCK_PATH ?? path.join(dataDir, 'backup.lock')),
    publicDir: path.join(root, 'public'),
    isProduction,
    cookieSecure: String(overrides.cookieSecure ?? process.env.KUKGIT_COOKIE_SECURE ?? 'false') === 'true',
    adminEmail: overrides.adminEmail ?? process.env.KUKGIT_ADMIN_EMAIL ?? 'admin@kuklabs.local',
    adminPassword: overrides.adminPassword ?? process.env.KUKGIT_ADMIN_PASSWORD ?? 'KukGit@2026',
    adminName: overrides.adminName ?? process.env.KUKGIT_ADMIN_NAME ?? 'Amit Kumar Kuklod',
    gitToken: overrides.gitToken ?? process.env.KUKGIT_DEV_GIT_TOKEN ?? 'kukgit-dev-token-change-me',
    webhookEncryptionKey: overrides.webhookEncryptionKey ?? process.env.KUKGIT_WEBHOOK_ENCRYPTION_KEY ?? (isProduction ? '' : 'kukgit-development-webhook-key-change-me'),
    smtpHost: overrides.smtpHost ?? process.env.KUKGIT_SMTP_HOST ?? '',
    smtpPort: Number(overrides.smtpPort ?? process.env.KUKGIT_SMTP_PORT ?? 587),
    smtpSecure: String(overrides.smtpSecure ?? process.env.KUKGIT_SMTP_SECURE ?? 'false') === 'true',
    smtpStartTls: String(overrides.smtpStartTls ?? process.env.KUKGIT_SMTP_STARTTLS ?? 'true') === 'true',
    smtpRejectUnauthorized: String(overrides.smtpRejectUnauthorized ?? process.env.KUKGIT_SMTP_REJECT_UNAUTHORIZED ?? 'true') === 'true',
    smtpUser: overrides.smtpUser ?? process.env.KUKGIT_SMTP_USER ?? '',
    smtpPassword: overrides.smtpPassword ?? process.env.KUKGIT_SMTP_PASSWORD ?? '',
    emailFrom: overrides.emailFrom ?? process.env.KUKGIT_EMAIL_FROM ?? 'noreply@kuklabs.local',
    emailFromName: overrides.emailFromName ?? process.env.KUKGIT_EMAIL_FROM_NAME ?? 'KukGit',
    emailReplyTo: overrides.emailReplyTo ?? process.env.KUKGIT_EMAIL_REPLY_TO ?? '',
    emailWorkerIntervalMs: Number(overrides.emailWorkerIntervalMs ?? process.env.KUKGIT_EMAIL_WORKER_INTERVAL_MS ?? 30000),
    emailMaxAttempts: Number(overrides.emailMaxAttempts ?? process.env.KUKGIT_EMAIL_MAX_ATTEMPTS ?? 8),
    emailBatchSize: Number(overrides.emailBatchSize ?? process.env.KUKGIT_EMAIL_BATCH_SIZE ?? 20),
    sshHost: overrides.sshHost ?? process.env.KUKGIT_SSH_HOST ?? new URL(baseUrl).hostname,
    sshPort: Number(overrides.sshPort ?? process.env.KUKGIT_SSH_PORT ?? 22),
    sshUser: overrides.sshUser ?? process.env.KUKGIT_SSH_USER ?? 'git',
    nodeBinary: overrides.nodeBinary ?? process.env.KUKGIT_NODE_BINARY ?? process.execPath,
    sshCommandScript: overrides.sshCommandScript ?? process.env.KUKGIT_SSH_COMMAND_SCRIPT ?? path.join(root, 'scripts', 'ssh-command.mjs'),
    authorizedKeysPath: overrides.authorizedKeysPath ?? process.env.KUKGIT_AUTHORIZED_KEYS_PATH ?? path.join(dataDir, 'ssh', 'authorized_keys'),
    aiEndpoint: overrides.aiEndpoint ?? process.env.KUKGIT_AI_ENDPOINT ?? '',
    aiApiKey: overrides.aiApiKey ?? process.env.KUKGIT_AI_API_KEY ?? '',
  };
}
