import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

/**
 * The founder account a checkout starts with. Published in this repository, in
 * `.env.example` and in the README — which is exactly why nothing may show it
 * to a caller unless the instance is still using it. See
 * `signInHints` in `src/app.mjs`.
 */
export const PUBLISHED_DEV_CREDENTIALS = Object.freeze({
  email: 'admin@kuklabs.local',
  password: 'KukGit@2026',
});

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
  // Kept on the config rather than read from `process.env` wherever it is
  // needed. A harness that builds a config with `nodeEnv: 'test'` is asking for
  // an instance that behaves as a test instance, and code reaching around the
  // config to the environment quietly gives it a production one.
  const nodeEnv = String(overrides.nodeEnv ?? process.env.NODE_ENV ?? 'development');
  const isProduction = nodeEnv === 'production';
  const baseUrl = overrides.baseUrl ?? process.env.KUKGIT_BASE_URL ?? `http://localhost:${overrides.port ?? process.env.PORT ?? 8787}`;
  const cookieSecure = booleanValue(overrides.cookieSecure ?? process.env.KUKGIT_COOKIE_SECURE, isProduction);
  const authMode = String(overrides.authMode ?? process.env.KUKGIT_AUTH_MODE ?? (isProduction ? 'authkit' : 'local')).toLowerCase();
  // The Firebase project whose ID tokens this instance will accept. Public —
  // it is in every browser bundle that talks to Firebase — but it is the value
  // that decides *whose* tokens are believed, so it is configuration rather
  // than a constant, and an instance that has not set it does not offer phone
  // verification at all.
  const firebaseProjectId = String(overrides.firebaseProjectId ?? process.env.KUKGIT_FIREBASE_PROJECT_ID ?? '').trim();
  // Also public, and also configuration rather than a constant: a Firebase web
  // API key is a project identifier, not a secret — it is in every browser
  // bundle Google ships. What protects the project is the authorised-domain
  // list and App Check, neither of which lives here.
  const firebaseApiKey = String(overrides.firebaseApiKey ?? process.env.KUKGIT_FIREBASE_API_KEY ?? '').trim();
  // Where the sign-in handler lives. Defaults to Google's, and is worth setting
  // to a domain of your own once one exists — the default puts a Google-branded
  // host in front of a customer mid-flow.
  const firebaseAuthDomain = String(
    overrides.firebaseAuthDomain ?? process.env.KUKGIT_FIREBASE_AUTH_DOMAIN
    ?? (firebaseProjectId ? `${firebaseProjectId}.firebaseapp.com` : ''),
  ).trim();
  const authkitBaseUrlRaw = String(overrides.authkitBaseUrl ?? process.env.KUKGIT_AUTHKIT_BASE_URL ?? '').trim();
  const authkitProductId = String(overrides.authkitProductId ?? process.env.KUKGIT_AUTHKIT_PRODUCT_ID ?? 'kukgit').trim().toLowerCase();
  const authkitEncryptionKey = overrides.authkitEncryptionKey ?? process.env.KUKGIT_AUTHKIT_ENCRYPTION_KEY ?? (isProduction ? '' : 'kukgit-development-authkit-encryption-key-change-me');
  const authkitTimeoutMs = boundedInteger(overrides.authkitTimeoutMs ?? process.env.KUKGIT_AUTHKIT_TIMEOUT_MS ?? 8000, 'KUKGIT_AUTHKIT_TIMEOUT_MS', 500, 30000);
  const authkitRefreshTtlDays = boundedInteger(overrides.authkitRefreshTtlDays ?? process.env.KUKGIT_AUTHKIT_REFRESH_TTL_DAYS ?? 60, 'KUKGIT_AUTHKIT_REFRESH_TTL_DAYS', 1, 365);
  // How long a validated bridge session is trusted before AuthKit is asked
  // again.
  //
  // This used to be zero — every protected browser request asked AuthKit three
  // separate questions. The live service rate-limits `/v1/auth/*` to twenty
  // requests a minute *per source IP*, and KukGit calls it server-to-server, so
  // every user of the instance shares one bucket: twenty requests a minute for
  // the whole product, or about six page loads. See ONE_KUKLABS_ACCOUNT.md.
  //
  // Five minutes is the trade. A device revoked centrally keeps working for at
  // most that long, which is the cost of the instance working at all.
  const authkitSessionCheckSeconds = boundedInteger(overrides.authkitSessionCheckSeconds ?? process.env.KUKGIT_AUTHKIT_SESSION_CHECK_SECONDS ?? 300, 'KUKGIT_AUTHKIT_SESSION_CHECK_SECONDS', 0, 3600);
  // Rate limiting. Defaults are deliberately generous enough for normal
  // interactive use and tight enough that credential stuffing and invitation
  // spam are not free. `burst` is the bucket capacity: the size of a momentary
  // spike a caller may spend before being held to the sustained per-minute rate.
  const rateLimitEnabled = booleanValue(
    overrides.rateLimitEnabled ?? process.env.KUKGIT_RATE_LIMIT_ENABLED,
    true,
  );
  const rateLimitTrustProxy = booleanValue(
    overrides.rateLimitTrustProxy ?? process.env.KUKGIT_TRUST_PROXY,
    false,
  );
  const rateLimit = (name, envKey, perMinuteDefault, burstDefault) => ({
    perMinute: boundedInteger(
      overrides[`${name}PerMinute`] ?? process.env[`KUKGIT_RATE_LIMIT_${envKey}_PER_MINUTE`] ?? perMinuteDefault,
      `KUKGIT_RATE_LIMIT_${envKey}_PER_MINUTE`, 1, 100000,
    ),
    burst: boundedInteger(
      overrides[`${name}Burst`] ?? process.env[`KUKGIT_RATE_LIMIT_${envKey}_BURST`] ?? burstDefault,
      `KUKGIT_RATE_LIMIT_${envKey}_BURST`, 1, 100000,
    ),
  });
  const rateLimits = {
    // Password, OTP and Google exchange. Keyed by address for anonymous callers,
    // so this is the brute-force and credential-stuffing control.
    auth: rateLimit('rateLimitAuth', 'AUTH', 20, 10),
    // General authenticated browser API.
    api: rateLimit('rateLimitApi', 'API', 600, 120),
    // Git smart HTTP. Clones are chatty, so this is the loosest surface.
    git: rateLimit('rateLimitGit', 'GIT', 1200, 240),
    // Invitation creation and resend — the surface with real email-spam cost.
    invitation: rateLimit('rateLimitInvitation', 'INVITATION', 30, 10),
    // Webhook create, ping and redeliver, which can be pointed at third parties.
    webhook: rateLimit('rateLimitWebhook', 'WEBHOOK', 60, 20),
    // Abuse reports, which are accepted without an account. Tight, because the
    // form is reachable by anybody and a flood of reports against one
    // repository is itself a way to attack it.
    abuse: rateLimit('rateLimitAbuse', 'ABUSE', 10, 5),
  };

  const organizationOwnerLimit = positiveNumber(overrides.organizationOwnerLimit ?? process.env.KUKGIT_ORGANIZATION_OWNER_LIMIT ?? 5, 'KUKGIT_ORGANIZATION_OWNER_LIMIT');
  const runtimeWriteServiceEnabled = booleanValue(
    overrides.runtimeWriteServiceEnabled ?? process.env.KUKGIT_RUNTIME_WRITE_SERVICE_ENABLED,
    !isProduction,
  );
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

  const objectStorageDriver = (overrides.objectStorageDriver ?? process.env.KUKGIT_OBJECT_STORAGE_DRIVER ?? 'filesystem').toLowerCase();
  if (!['filesystem', 's3'].includes(objectStorageDriver)) {
    throw new Error("KUKGIT_OBJECT_STORAGE_DRIVER must be 'filesystem' or 's3'.");
  }
  if (objectStorageDriver === 's3') {
    // Checked here rather than at the first upload. An instance that starts
    // happily and then fails on the first `git push` of a large file has already
    // told its users it is working.
    const missing = [
      ['KUKGIT_OBJECT_STORAGE_BUCKET', overrides.objectStorageBucket ?? process.env.KUKGIT_OBJECT_STORAGE_BUCKET],
      ['KUKGIT_OBJECT_STORAGE_ACCESS_KEY_ID', overrides.objectStorageAccessKeyId ?? process.env.KUKGIT_OBJECT_STORAGE_ACCESS_KEY_ID],
      ['KUKGIT_OBJECT_STORAGE_SECRET_ACCESS_KEY', overrides.objectStorageSecretAccessKey ?? process.env.KUKGIT_OBJECT_STORAGE_SECRET_ACCESS_KEY],
    ].filter(([, value]) => !value).map(([name]) => name);
    if (missing.length) {
      throw new Error(`Object storage is enabled but ${missing.join(', ')} ${missing.length > 1 ? 'are' : 'is'} not set.`);
    }
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
    // Where Git LFS object bytes live. Filesystem is the default and stays the
    // default: switching an instance whose objects are on a volume to a bucket
    // would make every existing object unreadable, so moving them is a
    // migration rather than a configuration change.
    objectStorage: {
      driver: (overrides.objectStorageDriver ?? process.env.KUKGIT_OBJECT_STORAGE_DRIVER ?? 'filesystem').toLowerCase(),
      bucket: overrides.objectStorageBucket ?? process.env.KUKGIT_OBJECT_STORAGE_BUCKET ?? '',
      region: overrides.objectStorageRegion ?? process.env.KUKGIT_OBJECT_STORAGE_REGION ?? 'us-east-1',
      endpoint: overrides.objectStorageEndpoint ?? process.env.KUKGIT_OBJECT_STORAGE_ENDPOINT ?? '',
      prefix: overrides.objectStoragePrefix ?? process.env.KUKGIT_OBJECT_STORAGE_PREFIX ?? '',
      accessKeyId: overrides.objectStorageAccessKeyId ?? process.env.KUKGIT_OBJECT_STORAGE_ACCESS_KEY_ID ?? '',
      secretAccessKey: overrides.objectStorageSecretAccessKey ?? process.env.KUKGIT_OBJECT_STORAGE_SECRET_ACCESS_KEY ?? '',
      sessionToken: overrides.objectStorageSessionToken ?? process.env.KUKGIT_OBJECT_STORAGE_SESSION_TOKEN ?? null,
      forcePathStyle: String(overrides.objectStorageForcePathStyle ?? process.env.KUKGIT_OBJECT_STORAGE_FORCE_PATH_STYLE ?? 'true') !== 'false',
    },
    tempDir: overrides.tempDir ?? path.join(dataDir, 'tmp'),
    backupsDir: path.resolve(overrides.backupsDir ?? process.env.KUKGIT_BACKUPS_DIR ?? path.join(dataDir, 'backups')),
    backupRetentionCount: Number(overrides.backupRetentionCount ?? process.env.KUKGIT_BACKUP_RETENTION_COUNT ?? 14),
    backupRetentionDays: Number(overrides.backupRetentionDays ?? process.env.KUKGIT_BACKUP_RETENTION_DAYS ?? 30),
    // Saturation alerting thresholds. They live here rather than in the
    // monitoring system so every deployment alerts on the same numbers, and so a
    // rehearsal or a support session can read the same values the alerts use.
    // Rollout draining. See docs/OPERATIONS_BOUNDARY.md — the readiness delay is
    // the one that must exceed the load balancer's probe interval, or the socket
    // closes while traffic is still being sent to it.
    drain: {
      readinessDelayMs: Number(overrides.drainReadinessDelayMs ?? process.env.KUKGIT_DRAIN_READINESS_DELAY_MS ?? 8000),
      requestDrainMs: Number(overrides.drainRequestMs ?? process.env.KUKGIT_DRAIN_REQUEST_MS ?? 30000),
      gitDrainMs: Number(overrides.drainGitMs ?? process.env.KUKGIT_DRAIN_GIT_MS ?? 300000),
    },
    saturation: {
      queueDepthWarning: Number(overrides.saturationQueueDepthWarning ?? process.env.KUKGIT_SATURATION_QUEUE_DEPTH_WARNING ?? 100),
      queueDepthCritical: Number(overrides.saturationQueueDepthCritical ?? process.env.KUKGIT_SATURATION_QUEUE_DEPTH_CRITICAL ?? 1000),
      queueAgeWarningSeconds: Number(overrides.saturationQueueAgeWarningSeconds ?? process.env.KUKGIT_SATURATION_QUEUE_AGE_WARNING_SECONDS ?? 900),
      queueAgeCriticalSeconds: Number(overrides.saturationQueueAgeCriticalSeconds ?? process.env.KUKGIT_SATURATION_QUEUE_AGE_CRITICAL_SECONDS ?? 3600),
      stuckProcessingMinutes: Number(overrides.saturationStuckProcessingMinutes ?? process.env.KUKGIT_SATURATION_STUCK_PROCESSING_MINUTES ?? 15),
      quotaWarningPercent: Number(overrides.saturationQuotaWarningPercent ?? process.env.KUKGIT_SATURATION_QUOTA_WARNING_PERCENT ?? 75),
      quotaCriticalPercent: Number(overrides.saturationQuotaCriticalPercent ?? process.env.KUKGIT_SATURATION_QUOTA_CRITICAL_PERCENT ?? 90),
      diskFreeWarningPercent: Number(overrides.saturationDiskFreeWarningPercent ?? process.env.KUKGIT_SATURATION_DISK_FREE_WARNING_PERCENT ?? 20),
      diskFreeCriticalPercent: Number(overrides.saturationDiskFreeCriticalPercent ?? process.env.KUKGIT_SATURATION_DISK_FREE_CRITICAL_PERCENT ?? 10),
      databaseWarningBytes: Number(overrides.saturationDatabaseWarningBytes ?? process.env.KUKGIT_SATURATION_DATABASE_WARNING_BYTES ?? 8 * 1024 * 1024 * 1024),
      databaseCriticalBytes: Number(overrides.saturationDatabaseCriticalBytes ?? process.env.KUKGIT_SATURATION_DATABASE_CRITICAL_BYTES ?? 20 * 1024 * 1024 * 1024),
      backupAgeWarningSeconds: Number(overrides.saturationBackupAgeWarningSeconds ?? process.env.KUKGIT_SATURATION_BACKUP_AGE_WARNING_SECONDS ?? 36 * 3600),
      backupAgeCriticalSeconds: Number(overrides.saturationBackupAgeCriticalSeconds ?? process.env.KUKGIT_SATURATION_BACKUP_AGE_CRITICAL_SECONDS ?? 72 * 3600),
    },
    // The vault key is separate from every other application secret. Reusing the
    // AuthKit, webhook or LFS key would mean one compromised key opens more than
    // one kind of stored material.
    secretsEncryptionKey: overrides.secretsEncryptionKey ?? process.env.KUKGIT_SECRETS_ENCRYPTION_KEY ?? (isProduction ? '' : 'kukgit-development-secrets-vault-key-change-me'),
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
    publicDir: path.resolve(overrides.publicDir ?? process.env.KUKGIT_PUBLIC_DIR ?? path.join(root, 'public')),
    nodeEnv,
    isProduction,
    cookieSecure,
    authMode,
    authkitBaseUrl,
    authkitProductId,
    authkitEncryptionKey,
    authkitTimeoutMs,
    authkitRefreshTtlDays,
    authkitSessionCheckSeconds,
    firebaseProjectId,
    firebaseApiKey,
    firebaseAuthDomain,
    organizationOwnerLimit,
    runtimeWriteServiceEnabled,
    realtimeHeartbeatMs,
    realtimeAuthRevalidateMs,
    realtimeMaxConnectionsPerUser,
    realtimeMaxConnections,
    realtimeMaxMessageBytes,
    adminEmail: overrides.adminEmail ?? process.env.KUKGIT_ADMIN_EMAIL ?? PUBLISHED_DEV_CREDENTIALS.email,
    adminPassword: overrides.adminPassword ?? process.env.KUKGIT_ADMIN_PASSWORD ?? PUBLISHED_DEV_CREDENTIALS.password,
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
    rateLimitEnabled,
    rateLimitTrustProxy,
    rateLimits,
    aiEndpoint: overrides.aiEndpoint ?? process.env.KUKGIT_AI_ENDPOINT ?? '',
    aiApiKey: overrides.aiApiKey ?? process.env.KUKGIT_AI_API_KEY ?? '',
  };
}
