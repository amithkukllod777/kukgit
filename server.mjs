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
import { openDatabase, seedCore, withSchemaLock } from './src/db.mjs';
import { smtpConfigured } from './src/email-transport.mjs';
import { migrateEmailProviderEvents } from './src/email-provider-events.mjs';
import { createEmailProviderEventsApiHandler } from './src/email-provider-events-safe.mjs';
import {
  createExternalAccessExpiryGuard,
  createExternalAccessHistoryApiHandler,
  migrateExternalAccessExpiryGuard,
} from './src/external-access-expiry-guard.mjs';
import { createExternalAccessInvitationDurationApiHandler } from './src/external-access-invitation-duration.mjs';
import {
  createExternalAccessReviewsApiHandler,
  migrateExternalAccessReviews,
  startExternalAccessReviewWorker,
} from './src/external-access-reviews.mjs';
import { createExternalCollaboratorAccessPrivacyApiHandler } from './src/external-collaborator-access-privacy.mjs';
import { createExternalCollaboratorDiscoveryApiHandler } from './src/external-collaborator-discovery.mjs';
import { createExternalCollaboratorLifecycleGuard } from './src/external-collaborator-lifecycle-guard.mjs';
import { ensureGitAvailable } from './src/git.mjs';
import { createGitLfsHandler, migrateGitLfs } from './src/git-lfs-safe.mjs';
import {
  createInstanceAdminApiHandlerSafe,
  instanceAdminEmails,
  migrateInstanceAdminSafe,
} from './src/instance-admin-safe.mjs';
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
import { createPostgresqlRuntimeObserver } from './src/postgresql-runtime-observer.mjs';
import {
  createPullRequestDiffsApiHandler,
  migratePullRequestDiffs,
} from './src/pull-request-diffs-safe.mjs';
import { createOperationsHealthApiHandler } from './src/operations-health.mjs';
import { createRateLimitGuard } from './src/rate-limit.mjs';
import { createSecretsApiHandler, migrateSecrets } from './src/secrets-vault.mjs';
import { createRunnersApiHandler, migrateRunners } from './src/runners.mjs';
import { createWorkflowDispatchCapture, observeDispatch } from './src/workflow-dispatch.mjs';
import { migrateJobLeases } from './src/job-leases.mjs';
import { createDrainState, createRequestTracker, drainAndClose } from './src/graceful-shutdown.mjs';
import { migrateNotificationFanout } from './src/notification-fanout.mjs';
import {
  createSecretScanningApiHandler,
  migrateSecretScanning,
  scanPushedContent,
} from './src/secret-scanning.mjs';
import { createPushProtectionApiHandler, markBypassesUsed, migratePushProtection } from './src/push-protection.mjs';
import { createTenantLifecycleApiHandler, migrateTenantLifecycle } from './src/tenant-lifecycle.mjs';
import { createTenantExportApiHandler, migrateTenantExport } from './src/tenant-export.mjs';
import { migrateTenantImport } from './src/tenant-import.mjs';
import { createSupportAccessApiHandler, migrateSupportAccess, registerSupportOperators } from './src/support-access.mjs';
import { publishRunCheck } from './src/workflow-checks.mjs';
import { observeRunChanges } from './src/workflow-runs.mjs';
import { createWorkflowLogsApiHandler, migrateWorkflowLogs, startStalledJobWorker } from './src/workflow-logs.mjs';
import { migrateWorkflowRuns } from './src/workflow-runs.mjs';
import { createWorkflowStorageApiHandler, migrateWorkflowStorage, startStorageRetentionWorker } from './src/workflow-storage.mjs';
import {
  createWorkflowTriggersApiHandler,
  dispatchClosedPullRequests,
  migrateWorkflowTriggers,
  startScheduleWorker,
  syncSchedules,
} from './src/workflow-triggers.mjs';
import { createRealtimeNotificationServer } from './src/realtime-notifications.mjs';
import { KUKGIT_VERSION } from './src/version.mjs';
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
import {
  createRuntimeReadService,
  registerRuntimeReadService,
  unregisterRuntimeReadService,
} from './src/runtime-read-service.mjs';
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
// Seeding writes rows rather than schema, but it happens under the same lock:
// two instances both seeding would both try to create the founder account.
let seeded = { seeded: false };
// Every schema change runs with the writer lock held, so two instances starting
// at the same instant cannot both run `ALTER TABLE … ADD COLUMN` and leave one
// of them dead with `duplicate column name`. The second simply waits and then
// finds everything already applied.
withSchemaLock(db, () => {
  migrateAuthKitIdentity(db);
  migrateCollaboration(db);
  migrateOrganizationOnboarding(db);
  migrateRepositoryAccess(db);
  migrateSupportAccess(db);
  migrateRepositoryInvitations(db);
  migrateExternalAccessReviews(db);
  migrateExternalAccessExpiryGuard(db);
  migrateBranchGovernance(db);
  migrateReviewThreads(db);
  migratePullRequestDiffs(db);
  migrateStatusChecks(db);
  migrateWebhooks(db);
  migrateSecrets(db);
  migrateWorkflowRuns(db);
  migrateWorkflowLogs(db);
  migrateJobLeases(db);
  migrateWorkflowStorage(db);
  migrateWorkflowTriggers(db);
  migrateRunners(db);
  migrateRepositoryLifecycle(db);
  migrateSshKeys(db);
  migrateGitLfs(db);
  migrateInstanceAdminSafe(db);
  seeded = config.authMode === 'local' ? seedCore(db, config) : { seeded: false };
  if (config.authMode === 'authkit') ensureAuthKitCoreOrganization(db);
  migrateNotifications(db);
  migrateNotificationFanout(db);
  migrateSecretScanning(db);
  migratePushProtection(db);
  migrateTenantLifecycle(db);
  migrateTenantExport(db);
  migrateTenantImport(db);
  migrateEmailProviderEvents(db);
});

// Every run-state change publishes a commit status, so a branch rule can require
// a workflow the same way it requires any other check.
observeRunChanges((runId) => publishRunCheck(db, config, runId));
// Schedules are re-read whenever a request could have changed the default
// branch, and a pull request that closed gets the `closed` run it is owed. Both
// are asked as questions about state, so neither depends on catching an event.
observeDispatch(({ repository, actorId, changes, git }) => {
  syncSchedules(db, config, { repository });
  dispatchClosedPullRequests(db, config, { repository, actorId });
  // Runs after the push has been accepted, so a scanner failure can never turn
  // into a rejected push. Blocking a push before it lands is push protection,
  // which is a separate control with its own bypass — see docs/SECRET_SCANNING.md.
  if (changes?.length) {
    scanPushedContent(config, db, {
      repository,
      changes,
      spawnGit: git,
      onFindings: ({ repositoryId, fingerprints }) => markBypassesUsed(db, repositoryId, fingerprints),
    });
  }
});
installExistingBranchProtectionHooks(config, db);

const postgresqlRuntimeObserver = createPostgresqlRuntimeObserver({ config });
const runtimeReadService = registerRuntimeReadService(
  db,
  createRuntimeReadService({ sqlite: db, observer: postgresqlRuntimeObserver }),
);

const app = createApp({ config, db });
const statusGuardedApp = createStatusCheckMergeGuard({ config, db, app });
const reviewThreadGuardedApp = createReviewThreadMergeGuard({ config, db, app: statusGuardedApp });
const governedApp = createBranchGovernanceGuard({ config, db, app: reviewThreadGuardedApp });
const secureAuthKitLoginApi = createSecureAuthKitLoginApiHandler({ config, db });
const authKitApi = createAuthKitApiHandler({ config, db });
const emailProviderEventsApi = createEmailProviderEventsApiHandler({ config, db });
const instanceAdminApi = createInstanceAdminApiHandlerSafe({ config, db });
// The WebSocket server is created after this chain, so the health handler reads it
// through a getter rather than holding a null reference for the process lifetime.
const drainState = createDrainState();
const operationsHealthApi = createOperationsHealthApiHandler({
  config, db, realtime: () => realtimeNotifications, draining: () => drainState.isDraining(),
});
const secretsApi = createSecretsApiHandler({ config, db });
// Registered before the logs handler, which claims the same two path prefixes
// and answers unknown routes under them with a 404.
const workflowStorageApi = createWorkflowStorageApiHandler({ config, db });
const workflowTriggersApi = createWorkflowTriggersApiHandler({ config, db });
const secretScanningApi = createSecretScanningApiHandler({ config, db });
const pushProtectionApi = createPushProtectionApiHandler({ config, db });
// Deleting a tenant destroys other people's work. An organization owner may ask;
// only the operator running the instance carries it out, and the record of who
// did which is the reason that distinction is worth keeping.
const isInstanceAdmin = (settings, user) => instanceAdminEmails(settings).includes(String(user.email || '').toLowerCase());
const tenantLifecycleApi = createTenantLifecycleApiHandler({ config, db, isInstanceAdmin });
// Registered before the lifecycle handler, which claims the whole
// `/api/instance-admin/tenants` prefix and answers anything unknown under it
// with a 404 — including these routes, if it saw them first.
const tenantExportApi = createTenantExportApiHandler({ config, db, isInstanceAdmin });
const workflowLogsApi = createWorkflowLogsApiHandler({ config, db });
const runnersApi = createRunnersApiHandler({ config, db });
const tokenApi = createTokenApiHandler({ config, db });
const notificationsApi = createNotificationsApiHandler({ config, db });
const externalDiscoveryApi = createExternalCollaboratorDiscoveryApiHandler({ config, db });
const collaborationApi = createCollaborationApiHandler({ config, db });
const onboardingApi = createOrganizationOnboardingApiHandler({ config, db });
const invitationResendApi = createInvitationResendApiHandler({ config, db });
const externalAccessInvitationDurationApi = createExternalAccessInvitationDurationApiHandler({ config, db });
const externalAccessHistoryApi = createExternalAccessHistoryApiHandler({ config, db });
const externalAccessReviewsApi = createExternalAccessReviewsApiHandler({ config, db });
const repositoryInvitationsApi = createRepositoryInvitationsApiHandler({ config, db });
const backupsApi = createLfsAwareBackupsApiHandler({ config, db });
const gitLfsApi = createGitLfsHandler({ config, db });
const externalLifecycleGuard = createExternalCollaboratorLifecycleGuard({ config, db });
const externalAccessPrivacyApi = createExternalCollaboratorAccessPrivacyApiHandler({ config, db });
const repositoryAccessApi = createRepositoryAccessApiHandler({ config, db });
const supportAccessApi = createSupportAccessApiHandler({ config, db, isInstanceAdmin });
// Registered so a support grant can be honoured at all. Without this the
// resolver has no way to tell an operator from anybody else, and it fails
// closed — which is the right default for every other embedding of this code.
registerSupportOperators(db, (user) => isInstanceAdmin(config, user));
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
  if (await emailProviderEventsApi(req, res)) return;
  if (await operationsHealthApi(req, res)) return;
  if (await secretsApi(req, res)) return;
  if (await workflowStorageApi(req, res)) return;
  if (await workflowTriggersApi(req, res)) return;
  if (await secretScanningApi(req, res)) return;
  if (await pushProtectionApi(req, res)) return;
  if (await tenantExportApi(req, res)) return;
  if (await tenantLifecycleApi(req, res)) return;
  if (await workflowLogsApi(req, res)) return;
  if (await runnersApi(req, res)) return;
  if (await instanceAdminApi(req, res)) return;
  if (await tokenApi(req, res)) return;
  if (await notificationsApi(req, res)) return;
  if (await externalDiscoveryApi(req, res)) return;
  if (await invitationResendApi(req, res)) return;
  if (await collaborationApi(req, res)) return;
  if (await onboardingApi(req, res)) return;
  if (await externalAccessInvitationDurationApi(req, res)) return;
  if (await externalAccessHistoryApi(req, res)) return;
  if (await externalAccessReviewsApi(req, res)) return;
  if (await repositoryInvitationsApi(req, res)) return;
  if (await backupsApi(req, res)) return;
  if (await gitLfsApi(req, res)) return;
  if (await externalLifecycleGuard(req, res)) return;
  if (await supportAccessApi(req, res)) return;
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
const workflowDispatch = createWorkflowDispatchCapture({ config, db, next: operationsNotificationDispatch });
const capturedDispatch = createWebhookEventCapture({ config, db, next: workflowDispatch });
const externalAccessExpiryDispatch = createExternalAccessExpiryGuard({ config, db, next: capturedDispatch });
const authKitBootstrapDispatch = createAuthKitBootstrapGuard({ config, db, next: externalAccessExpiryDispatch });
const centralSessionDispatch = createAuthKitCentralSessionGuard({ config, db, next: authKitBootstrapDispatch });
// Sits after identity resolution so an authenticated caller is limited as a
// person rather than as an address, and before the central session check so a
// flood cannot force one AuthKit network round trip per request.
const rateLimitDispatch = createRateLimitGuard({ config, next: centralSessionDispatch });
const identityDispatch = createAuthKitIdentityMiddleware({ config, db, next: rateLimitDispatch });
// Every background worker runs behind a named lease, so two instances against
// the same volume own one job each rather than both doing all of them. Leases
// are per job, not per instance: email can run on one node while webhooks run
// on another.
const stopWebhookWorker = startWebhookWorker(db, config);
const stopNotificationWorker = startNotificationWorker(db, config);
const stopStalledJobWorker = startStalledJobWorker(db);
const stopStorageRetentionWorker = startStorageRetentionWorker(db, config);
const stopScheduleWorker = startScheduleWorker(db, config);
const stopOperationalNotificationWorker = startOperationalNotificationWorker(db, config);
const stopExternalAccessReviewWorker = startExternalAccessReviewWorker(db, config);
// Counts in-flight requests so a shutdown can wait for them. Outermost, so it
// sees every request including the ones a guard rejects.
const trackedDispatch = createRequestTracker({ next: identityDispatch });
const server = http.createServer(trackedDispatch);
const realtimeNotifications = createRealtimeNotificationServer({ server, config, db });

server.listen(config.port, config.host, () => {
  console.log(`\nKukGit v${KUKGIT_VERSION} is running at ${config.baseUrl}`);
  console.log(`${gitVersion}; data: ${config.dataDir}`);
  console.log(`Authentication: ${config.authMode === 'authkit' ? `One Kuklabs Account via ${config.authkitBaseUrl}` : 'local development mode'}`);
  console.log(`Instance administrators: ${instanceAdminEmails(config).join(', ') || 'none configured'}`);
  console.log(`Organization ownership limit: ${config.organizationOwnerLimit}`);
  console.log(`Backups: ${config.backupsDir}; retention: ${config.backupRetentionCount} snapshots / ${config.backupRetentionDays} days`);
  console.log(config.objectStorage.driver === 's3'
    ? `Git LFS: object storage ${config.objectStorage.bucket} (${config.objectStorage.region}); repository quota: ${config.lfsRepositoryQuotaBytes} bytes`
    : `Git LFS: ${config.lfsDir}; repository quota: ${config.lfsRepositoryQuotaBytes} bytes`);
  console.log(`Email delivery: ${smtpConfigured(config) ? `${config.smtpHost}:${config.smtpPort}` : 'disabled until SMTP is configured'}`);
  console.log(`Email provider events: /api/email-provider/events; soft-bounce threshold ${config.emailSoftBounceThreshold}/${config.emailSoftBounceWindowDays} days`);
  console.log(`Real-time notifications: WebSocket ${realtimeNotifications.path}`);
  console.log(config.rateLimitEnabled
    ? `Rate limits: auth ${config.rateLimits.auth.perMinute}/min, api ${config.rateLimits.api.perMinute}/min, git ${config.rateLimits.git.perMinute}/min${config.rateLimitTrustProxy ? '' : ' (X-Forwarded-For NOT trusted — set KUKGIT_TRUST_PROXY behind a proxy)'}`
    : 'Rate limits: disabled');
  console.log(`PostgreSQL runtime shadow: ${postgresqlRuntimeObserver ? 'enabled; SQLite remains authoritative' : 'disabled'}`);
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

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${signal} received. Draining KukGit...`);

  // Readiness fails first and the listener closes only after a delay, so the
  // load balancer removes this instance before its socket goes away. Workers are
  // stopped *after* the drain: a request still being served may queue an email
  // or a webhook, and stopping the worker first would strand it.
  const drain = await drainAndClose(server, {
    tracker: trackedDispatch,
    drainState,
    readinessDelayMs: config.drain.readinessDelayMs,
    requestDrainMs: config.drain.requestDrainMs,
    gitDrainMs: config.drain.gitDrainMs,
    onStep: ({ step, inFlight }) => console.log(`  ${step}${inFlight ? ` (api ${inFlight.api}, git ${inFlight.git})` : ''}`),
  });
  console.log(`  drained in ${drain.durationMs}ms${drain.apiDrained && drain.gitDrained ? '' : ' — some connections were cut short'}`);

  const hardStop = setTimeout(() => process.exit(1), 10000);
  hardStop.unref();
  stopWebhookWorker();
  stopNotificationWorker();
  stopStalledJobWorker();
  stopStorageRetentionWorker();
  stopScheduleWorker();
  stopOperationalNotificationWorker();
  stopExternalAccessReviewWorker();
  realtimeNotifications.stop();
  rateLimitDispatch.stop();
  try { await runtimeReadService.stop({ drainMs: 5000 }); } catch {}
  unregisterRuntimeReadService(db, runtimeReadService);
  try { db.close(); } catch {}
  clearTimeout(hardStop);
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
