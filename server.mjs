import fs from 'node:fs';
import http from 'node:http';
import { createApp } from './src/app.mjs';
import {
  createAuthKitBootstrapGuard,
  ensureAuthKitCoreOrganization,
} from './src/authkit-bootstrap.mjs';
import {
  createAuthKitApiHandler,
  createAuthKitIdentityMiddleware,
  migrateAuthKitIdentity,
} from './src/authkit-identity.mjs';
import { createSecureAuthKitLoginApiHandler } from './src/authkit-secure-login.mjs';
import { createAuthKitCentralSessionGuard } from './src/authkit-session-guard.mjs';
import { createMaintenanceGuard } from './src/backups.mjs';
import { createLfsAwareBackupsApiHandler } from './src/backups-lfs.mjs';
import {
  createBranchGovernanceApiHandler,
  createBranchGovernanceGuard,
  installExistingBranchProtectionHooks,
  migrateBranchGovernance,
} from './src/branch-governance.mjs';
import {
  createCollaborationNotificationCapture,
  createInvitationResendApiHandler,
} from './src/collaboration-notifications-safe.mjs';
import { createCollaborationApiHandler, migrateCollaboration } from './src/collaboration.mjs';
import { loadConfig } from './src/config.mjs';
import { openDatabase, seedCore } from './src/db.mjs';
import { smtpConfigured } from './src/email-transport.mjs';
import { createExternalCollaboratorAccessPrivacyApiHandler } from './src/external-collaborator-access-privacy.mjs';
import { createExternalCollaboratorDiscoveryApiHandler } from './src/external-collaborator-discovery.mjs';
import { createExternalCollaboratorLifecycleGuard } from './src/external-collaborator-lifecycle-guard.mjs';
import { ensureGitAvailable } from './src/git.mjs';
import { createGitLfsHandler, migrateGitLfs } from './src/git-lfs-safe.mjs';
import { createNotificationEventCapture } from './src/notification-events-safe.mjs';
import {
  createNotificationsApiHandler,
  migrateNotifications,
  startNotificationWorker,
} from './src/notifications.mjs';
import {
  createOperationsNotificationCapture,
  startOperationalNotificationWorker,
} from './src/operations-notifications.mjs';
import {
  createOrganizationOnboardingApiHandler,
  migrateOrganizationOnboarding,
} from './src/organization-onboarding.mjs';
import {
  createPullRequestDiffsApiHandler,
  migratePullRequestDiffs,
} from './src/pull-request-diffs-safe.mjs';
import {
  createRepositoryAccessApiHandler,
  createRepositoryAccessGuard,
  migrateRepositoryAccess,
} from './src/repository-access.mjs';
import {
  createRepositoryInvitationsApiHandler,
  migrateRepositoryInvitations,
} from './src/repository-invitations.mjs';
import {
  createRepositoryLifecycleApiHandler,
  createRepositoryLifecycleGuard,
  migrateRepositoryLifecycle,
} from './src/repository-lifecycle.mjs';
import {
  createReviewThreadMergeGuard,
  createReviewThreadsApiHandler,
  migrateReviewThreads,
} from './src/review-threads.mjs';
import { createSshKeysArchiveGuard } from './src/ssh-keys-archive-guard.mjs';
import { createSshKeysApiHandler, migrateSshKeys } from './src/ssh-keys.mjs';
import {
  createStatusCheckMergeGuard,
  createStatusChecksApiHandler,
  migrateStatusChecks,
} from './src/status-checks.mjs';
import { createTokenApiHandler } from './src/token-api.mjs';
import {
  createWebhookEventCapture,
  createWebhooksApiHandler,
  migrateWebhooks,
  startWebhookWorker,
} from './src/webhooks.mjs';

const config = loadConfig();
fs.mkdirSync(config.repositoriesDir, { recursive: true });
fs.mkdirSync(config.tempDir, { recursive: true });
fs.mkdirSync(config.backupsDir, { recursive: true });
fs.mkdirSync(config.lfsDir, { recursive: true, mode: 0o700 });
const gitVersion = ensureGitAvailable();
const db = openDatabase(config);
migrateAuthKitIdentity(db);
migrateCollaboration(db);
migrateOrganizationOnboarding(db);
migrateRepositoryAccess(db);
migrateRepositoryInvitations(db);
migrateBranchGovernance(db);
migrateReviewThreads(db);
migratePullRequestDiffs(db);
migrateStatusChecks(db);
migrateWebhooks(db);
migrateRepositoryLifecycle(db);
migrateSshKeys(db);
migrateGitLfs(db);
const seeded = config.authMode === 'local' ? seedCore(db, config) : { seeded: false };
if (config.authMode === 'authkit') ensureAuthKitCoreOrganization(db);
migrateNotifications(db);
installExistingBranchProtectionHooks(config, db);
const app = createApp({ config, db });
const statusGuardedApp = createStatusCheckMergeGuard({ config, db, app });
const reviewThreadGuardedApp = createReviewThreadMergeGuard({ config, db, app: statusGuardedApp });
const governedApp = createBranchGovernanceGuard({ config, db, app: reviewThreadGuardedApp });
const secureAuthKitLoginApi = createSecureAuthKitLoginApiHandler({ config, db });
const authKitApi = createAuthKitApiHandler({ config, db });
const tokenApi = createTokenApiHandler({ config, db });
const notificationsApi = createNotificationsApiHandler({ config, db });
const externalDiscoveryApi = createExternalCollaboratorDiscoveryApiHandler({ config, db });
const collaborationApi = createCollaborationApiHandler({ config, db });
const onboardingApi = createOrganizationOnboardingApiHandler({ config, db });
const invitationResendApi = createInvitationResendApiHandler({ config, db });
const repositoryInvitationsApi = createRepositoryInvitationsApiHandler({ config, db });
const backupsApi = createLfsAwareBackupsApiHandler({ config, db });
const gitLfsApi = createGitLfsHandler({ config, db });
const externalLifecycleGuard = createExternalCollaboratorLifecycleGuard({ config, db });
const externalAccessPrivacyApi = createExternalCollaboratorAccessPrivacyApiHandler({ config, db });
const repositoryAccessApi = createRepositoryAccessApiHandler({ config, db });
const repositoryLifecycleApi = createRepositoryLifecycleApiHandler({ config, db });
const sshKeysApi = createSshKeysApiHandler({ config, db });
const branchGovernanceApi = createBranchGovernanceApiHandler({ config, db });
const pullRequestDiffsApi = createPullRequestDiffsApiHandler({ config, db });
const reviewThreadsApi = createReviewThreadsApiHandler({ config, db });
const statusChecksApi = createStatusChecksApiHandler({ config, db });
const webhooksApi = createWebhooksApiHandler({ config, db });
const repositoryAccessGuard = createRepositoryAccessGuard({ config, db, app: governedApp });

async function dispatch(req, res) {
  if (await secureAuthKitLoginApi(req, res)) return;
  if (await authKitApi(req, res)) return;
  if (await tokenApi(req, res)) return;
  if (await notificationsApi(req, res)) return;
  if (await externalDiscoveryApi(req, res)) return;
  if (await invitationResendApi(req, res)) return;
  if (await collaborationApi(req, res)) return;
  if (await onboardingApi(req, res)) return;
  if (await repositoryInvitationsApi(req, res)) return;
  if (await backupsApi(req, res)) return;
  if (await gitLfsApi(req, res)) return;
  if (await externalLifecycleGuard(req, res)) return;
  if (await repositoryLifecycleApi(req, res)) return;
  if (await sshKeysApi(req, res)) return;
  if (await externalAccessPrivacyApi(req, res)) return;
  if (await repositoryAccessApi(req, res)) return;
  if (await branchGovernanceApi(req, res)) return;
  if (await pullRequestDiffsApi(req, res)) return;
  if (await reviewThreadsApi(req, res)) return;
  if (await statusChecksApi(req, res)) return;
  if (await webhooksApi(req, res)) return;
  if (await repositoryAccessGuard(req, res)) return;
  return governedApp(req, res);
}

const sshArchiveDispatch = createSshKeysArchiveGuard({ config, db, next: dispatch });
const lifecycleDispatch = createRepositoryLifecycleGuard({ config, db, next: sshArchiveDispatch });
const maintenanceDispatch = createMaintenanceGuard({ config, next: lifecycleDispatch });
const collaborationNotificationDispatch = createCollaborationNotificationCapture({ config, db, next: maintenanceDispatch });
const notificationEventDispatch = createNotificationEventCapture({ config, db, next: collaborationNotificationDispatch });
const operationsNotificationDispatch = createOperationsNotificationCapture({ config, db, next: notificationEventDispatch });
const capturedDispatch = createWebhookEventCapture({ config, db, next: operationsNotificationDispatch });
const authKitBootstrapDispatch = createAuthKitBootstrapGuard({ config, db, next: capturedDispatch });
const centralSessionDispatch = createAuthKitCentralSessionGuard({ config, db, next: authKitBootstrapDispatch });
const identityDispatch = createAuthKitIdentityMiddleware({ config, db, next: centralSessionDispatch });
const stopWebhookWorker = startWebhookWorker(db, config);
const stopNotificationWorker = startNotificationWorker(db, config);
const stopOperationalNotificationWorker = startOperationalNotificationWorker(db, config);
const server = http.createServer(identityDispatch);

server.listen(config.port, config.host, () => {
  console.log(`\nKukGit v0.1.0 is running at ${config.baseUrl}`);
  console.log(`${gitVersion}; data: ${config.dataDir}`);
  console.log(`Authentication: ${config.authMode === 'authkit' ? `One Kuklabs Account via ${config.authkitBaseUrl}` : 'local development mode'}`);
  console.log(`Organization ownership limit: ${config.organizationOwnerLimit}`);
  console.log(`Backups: ${config.backupsDir}; retention: ${config.backupRetentionCount} snapshots / ${config.backupRetentionDays} days`);
  console.log(`Git LFS: ${config.lfsDir}; repository quota: ${config.lfsRepositoryQuotaBytes} bytes`);
  console.log(`Email delivery: ${smtpConfigured(config) ? `${config.smtpHost}:${config.smtpPort}` : 'disabled until SMTP is configured'}`);
  console.log(`SSH clone endpoint: ${config.sshUser}@${config.sshHost}:${config.sshPort}`);
  if (seeded.seeded && !config.isProduction) {
    console.log(`Development admin: ${config.adminEmail}`);
    console.log('Development password is configured from KUKGIT_ADMIN_PASSWORD (default documented in README).');
  }
  if (!config.isProduction && config.gitToken === 'kukgit-dev-token-change-me') {
    console.warn('WARNING: Set KUKGIT_DEV_GIT_TOKEN before sharing this server.');
  }
  if (config.isProduction && !config.webhookEncryptionKey) {
    console.warn('WARNING: KUKGIT_WEBHOOK_ENCRYPTION_KEY is required before creating production webhooks.');
  }
  if (config.isProduction && !config.lfsAuthKey) {
    console.warn('WARNING: KUKGIT_LFS_AUTH_KEY is required for Git LFS over SSH.');
  }
  if (config.isProduction && !smtpConfigured(config)) {
    console.warn('WARNING: SMTP is not configured; transactional email delivery is disabled.');
  }
});

function shutdown(signal) {
  console.log(`\n${signal} received. Shutting down KukGit...`);
  stopWebhookWorker();
  stopNotificationWorker();
  stopOperationalNotificationWorker();
  server.close(() => {
    try { db.close(); } catch {}
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
