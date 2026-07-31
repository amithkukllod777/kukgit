import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

function booleanValue(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return String(value).toLowerCase() === 'true';
}

function listValue(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  return String(value ?? '').split(',').map((item) => item.trim()).filter(Boolean);
}

function positiveNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`${label} must be a positive number.`);
  return number;
}

function boundedInteger(value, label, minimum, maximum) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}.`);
  }
  return number;
}

function validateAuthKitUrl(value, isProduction) {
  let url;
  try { url = new URL(value); }
  catch { throw new Error('KUKGIT_AUTHKIT_BASE_URL must be a valid absolute URL.'); }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('KUKGIT_AUTHKIT_BASE_URL must use HTTP or HTTPS.');
  }
  if (isProduction && url.protocol !== 'https:') {
    throw new Error('KUKGIT_AUTHKIT_BASE_URL must use HTTPS in production.');
  }
  if (url.username || url.password) {
    throw new Error('KUKGIT_AUTHKIT_BASE_URL must not contain embedded credentials.');
  }
  url.pathname = url.pathname.replace(/\/$/, '');
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

export function loadConfig(overrides = {}) {
  const dataDir = path.resolve(overrides.dataDir ?? process.env.KUKGIT_DATA_DIR ?? path.join(root, 'data'));
  const isProduction = (overrides.nodeEnv ?? process.env.NODE_ENV) === 'production';
  const baseUrl = overrides.baseUrl ?? process.env.KUKGIT_BASE_URL ?? `http://localhost:${overrides.port ?? process.env.PORT ?? 8787}`;
  const cookieSecure = booleanValue(overrides.cookieSecure ?? process.env.KUKGIT_COOKIE_SECURE, isProduction);
  const authMode = String(overrides.authMode ?? process.env.KUKGIT_AUTH_MODE ?? (isProduction ? 'authkit' : 'local')).toLowerCase();
  const authkitBaseUrlRaw = String(overrides.authkitBaseUrl ?? process.env.KUKGIT_AUTHKIT_BASE_URL ?? '').trim();
  const authkitProductId = String(overrides.authkitProductId ?? process.env.KUKGIT_AUTHKIT_PRODUCT_ID ?? 'kukgit').trim().toLowerCase();
  const authkitEncryptionKey = overrides.authkitEncryptionKey ?? process.env.KUKGIT_AUTHKIT_ENCRYPTION_KEY ?? (isProduction ? '' : 'kukgit-development-authkit-encryption-key-change-me');
  const authkitTimeoutMs = boundedInteger(overrides.authkitTimeoutMs ?? process.env.KUKGIT_AUTHKIT_TIMEOUT_MS ?? 8000, 'KUKGIT_AUTHKIT_TIMEOUT_MS', 500, 30000);
  const authkitRefreshTtlDays = boundedInteger(overrides.authkitRefreshTtlDays ?? process.env.KUKGIT_AUTHKIT_REFRESH_TTL_DAYS ?? 60, 'KUKGIT_AUTHKIT_REFRESH_TTL_DAYS', 1, 365);
  const organizationOwnerLimit = positiveNumber(overrides.organizationOwnerLimit ?? process.env.KUKGIT_ORGANIZATION_OWNER_LIMIT ?? 5, 'KUKGIT_ORGANIZATION_OWNER_LIMIT');
  const realtimeHeartbeatMs = boundedInteger(overrides.realtimeHeartbeatMs ?? process.env.KUKGIT_REALTIME_HEARTBEAT_MS ?? 25000, 'KUKGIT_REALTIME_HEARTBEAT_MS', 1000, 120000);
  const realtimeAuthRevalidateMs = boundedInteger(overrides.realtimeAuthRevalidateMs ?? process.env.KUKGIT_REALTIME_AUTH_REVALIDATE_MS ?? 60000, 'KUKGIT_REALTIME_AUTH_REVALIDATE_MS', 1000, 600000);
  const realtimeMaxConnectionsPerUser = boundedInteger(overrides.realtimeMaxConnectionsPerUser ?? process.env.KUKGIT_REALTIME_MAX_CONNECTIONS_PER_USER ?? 10, 'KUKGIT_REALTIME_MAX_CONNECTIONS_PER_USER', 1, 50);
  const realtimeMaxConnections = boundedInteger(overrides.realtimeMaxConnections ?? process.env.KUKGIT_REALTIME_MAX_CONNECTIONS ?? 5000, 'KUKGIT_REALTIME_MAX_CONNECTIONS', 10, 50000);
  const realtimeMaxMessageBytes = boundedInteger(overrides.realtimeMaxMessageBytes ?? process.env.KUKGIT_REALTIME_MAX_MESSAGE_BYTES ?? 4096, 'KUKGIT_REALTIME_MAX_MESSAGE_BYTES', 256, 65535);
  const emailProviderWebhookSecret = String(overrides.emailProviderWebhookSecret ?? process.env.KUKGIT_EMAIL_PROVIDER_WEBHOOK_SECRET ?? '').trim();
  const emailProviderEventsEnabled = booleanValue(
    overrides.emailProviderEventsEnabled ?? process.env.KUKGIT_EMAIL_PROVIDER_EVENTS_ENABLED,
    Boolean(emailProviderWebhookSecret),
  );
  const emailProviderWebhookToleranceSeconds = boundedInteger(overrides.emailProviderWebhookToleranceSeconds ?? process.env.KUKGIT_EMAIL_PROVIDER_WEBHOOK_TOLERANCE_SECONDS ?? 300, 'KUKGIT_EMAIL_PROVIDER_WEBHOOK_TOLERANCE_SECONDS', 30, 3600);
  const emailSoftBounceThreshold = boundedInteger(overrides.emailSoftBounceThreshold ?? process.env.KUKGIT_EMAIL_SOFT_BOUNCE_THRESHOLD ?? 3, 'KUKGIT_EMAIL_SOFT_BOUNCE_THRESHOLD', 2, 20);
  const emailSoftBounceWindowDays = boundedInteger(overrides.emailSoftBounceWindowDays ?? process.env.KUKGIT_EMAIL_SOFT_BOUNCE_WINDOW_DAYS ?? 7, 'KUKGIT_EMAIL_SOFT_BOUNCE_WINDOW_DAYS', 1, 90);
  const emailSoftBounceSuppressionDays = boundedInteger(overrides.emailSoftBounceSuppressionDays ?? process.env.KUKGIT_EMAIL_SOFT_BOUNCE_SUPPRESSION_DAYS ?? 30, 'KUKGIT_EMAIL_SOFT_BOUNCE_SUPPRESSION_DAYS', 1, 365);

  if (!['local', 'authkit'].includes(authMode)) {
    throw new Error('KUKGIT_AUTH_MODE must be local or authkit.');
  }
  if (isProduction && authMode === 'local') {
    throw new Error('Local KukGit password authentication is disabled in production. Use KUKGIT_AUTH_MODE=authkit.');
  }
  if (!/^[a-z0-9_-]{2,32}$/.test(authkitProductId)) {
    throw new Error('KUKGIT_AUTHKIT_PRODUCT_ID must contain 2-32 lowercase letters, numbers, underscores or hyphens.');
  }
  let authkitBaseUrl = '';
  if (authMode === 'authkit') {
    if (!authkitBaseUrlRaw) {
      throw new Error('KUKGIT_AUTHKIT_BASE_URL is required when AuthKit authentication is enabled.');
    }
    authkitBaseUrl = validateAuthKitUrl(authkitBaseUrlRaw, isProduction);
    if (String(authkitEncryptionKey).length < 32) {
      throw new Error('KUKGIT_AUTHKIT_ENCRYPTION_KEY must contain at least 32 characters.');
    }
    if (isProduction && !cookieSecure) {
      throw new Error('KUKGIT_COOKIE_SECURE must be true when AuthKit authentication is enabled in production.');
    }
  } else if (authkitBaseUrlRaw) {
    authkitBaseUrl = validateAuthKitUrl(authkitBaseUrlRaw, false);
  }
  if (emailProviderEventsEnabled && emailProviderWebhookSecret.length < 32) {
    throw new Error('KUKGIT_EMAIL_PROVIDER_WEBHOOK_SECRET must contain at least 32 characters when provider events are enabled.');
  }

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
    // Workflow policy. `allowedRunners` and `allowedActionOwners` are empty by
    // default, which means "no restriction" — an instance that offers hosted
    // runners is expected to set them, and an empty list is visible in the
    // rejection message rather than silently permissive.
    workflow: {
      allowedRunners: listValue(overrides.workflowAllowedRunners ?? process.env.KUKGIT_WORKFLOW_ALLOWED_RUNNERS),
      allowedActionOwners: listValue(overrides.workflowAllowedActionOwners ?? process.env.KUKGIT_WORKFLOW_ALLOWED_ACTION_OWNERS),
      maxJobs: Number(overrides.workflowMaxJobs ?? process.env.KUKGIT_WORKFLOW_MAX_JOBS ?? 50),
      defaultTimeoutMinutes: Number(overrides.workflowDefaultTimeoutMinutes ?? process.env.KUKGIT_WORKFLOW_DEFAULT_TIMEOUT_MINUTES ?? 60),
      maxTimeoutMinutes: Number(overrides.workflowMaxTimeoutMinutes ?? process.env.KUKGIT_WORKFLOW_MAX_TIMEOUT_MINUTES ?? 360),
    },
    maintenancePath: path.resolve(overrides.maintenancePath ?? process.env.KUKGIT_MAINTENANCE_PATH ?? path.join(dataDir, 'maintenance.json')),
    backupLockPath: path.resolve(overrides.backupLockPath ?? process.env.KUKGIT_BACKUP_LOCK_PATH ?? path.join(dataDir, 'backup.lock')),
    publicDir: path.join(root, 'public'),
    isProduction,
    cookieSecure,
    authMode,
    authkitBaseUrl,
    authkitProductId,
    authkitEncryptionKey,
    authkitTimeoutMs,
    authkitRefreshTtlDays,
    organizationOwnerLimit,
    realtimeHeartbeatMs,
    realtimeAuthRevalidateMs,
    realtimeMaxConnectionsPerUser,
    realtimeMaxConnections,
    realtimeMaxMessageBytes,
    adminEmail: overrides.adminEmail ?? process.env.KUKGIT_ADMIN_EMAIL ?? 'admin@kuklabs.local',
    adminPassword: overrides.adminPassword ?? process.env.KUKGIT_ADMIN_PASSWORD ?? 'KukGit@2026',
    adminName: overrides.adminName ?? process.env.KUKGIT_ADMIN_NAME ?? 'Amit Kumar Kuklod',
    gitToken: overrides.gitToken ?? process.env.KUKGIT_DEV_GIT_TOKEN ?? 'kukgit-dev-token-change-me',
    webhookEncryptionKey: overrides.webhookEncryptionKey ?? process.env.KUKGIT_WEBHOOK_ENCRYPTION_KEY ?? (isProduction ? '' : 'kukgit-development-webhook-key-change-me'),
    smtpHost: overrides.smtpHost ?? process.env.KUKGIT_SMTP_HOST ?? '',
    smtpPort: Number(overrides.smtpPort ?? process.env.KUKGIT_SMTP_PORT ?? 587),
    smtpSecure: booleanValue(overrides.smtpSecure ?? process.env.KUKGIT_SMTP_SECURE, false),
    smtpStartTls: booleanValue(overrides.smtpStartTls ?? process.env.KUKGIT_SMTP_STARTTLS, true),
    smtpRejectUnauthorized: booleanValue(overrides.smtpRejectUnauthorized ?? process.env.KUKGIT_SMTP_REJECT_UNAUTHORIZED, true),
    smtpUser: overrides.smtpUser ?? process.env.KUKGIT_SMTP_USER ?? '',
    smtpPassword: overrides.smtpPassword ?? process.env.KUKGIT_SMTP_PASSWORD ?? '',
    emailFrom: overrides.emailFrom ?? process.env.KUKGIT_EMAIL_FROM ?? 'noreply@kuklabs.local',
    emailFromName: overrides.emailFromName ?? process.env.KUKGIT_EMAIL_FROM_NAME ?? 'KukGit',
    emailReplyTo: overrides.emailReplyTo ?? process.env.KUKGIT_EMAIL_REPLY_TO ?? '',
    emailWorkerIntervalMs: Number(overrides.emailWorkerIntervalMs ?? process.env.KUKGIT_EMAIL_WORKER_INTERVAL_MS ?? 30000),
    emailMaxAttempts: Number(overrides.emailMaxAttempts ?? process.env.KUKGIT_EMAIL_MAX_ATTEMPTS ?? 8),
    emailBatchSize: Number(overrides.emailBatchSize ?? process.env.KUKGIT_EMAIL_BATCH_SIZE ?? 20),
    emailProviderEventsEnabled,
    emailProviderWebhookSecret,
    emailProviderWebhookToleranceSeconds,
    emailSoftBounceThreshold,
    emailSoftBounceWindowDays,
    emailSoftBounceSuppressionDays,
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
