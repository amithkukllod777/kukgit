import { withSchemaLock } from './db.mjs';
import { migrateAccountVerification } from './account-verification.mjs';
import { migratePhoneVerification } from './phone-verification.mjs';
import { migrateSignup } from './signup.mjs';
import { migrateTwoFactor } from './two-factor.mjs';
import { migrateUserIdentities } from './user-identities.mjs';
import { migrateOAuthSignIn } from './oauth-signin.mjs';
import { migrateAbuseReports } from './abuse-reports.mjs';
import { ensureAuthKitCoreOrganization } from './authkit-bootstrap.mjs';
import { migrateAuthKitIdentity } from './authkit-identity.mjs';
import { migrateBranchGovernance } from './branch-governance.mjs';
import { migrateCollaboration } from './collaboration.mjs';
import { migrateDangerousFiles } from './dangerous-files.mjs';
import { seedCore } from './db.mjs';
import { migrateEmailProviderEvents } from './email-provider-events.mjs';
import { migrateExternalAccessExpiryGuard } from './external-access-expiry-guard.mjs';
import { migrateExternalAccessReviews } from './external-access-reviews.mjs';
import { migrateGitLfs } from './git-lfs-safe.mjs';
import { migrateInstanceAdminSafe } from './instance-admin-safe.mjs';
import { migrateIssueComments } from './issue-comments.mjs';
import { migrateIssueReactions } from './issue-reactions.mjs';
import { migrateIssueTaxonomy } from './issue-taxonomy.mjs';
import { migrateJobLeases } from './job-leases.mjs';
import { migrateMaintenanceWindows } from './maintenance-windows.mjs';
import { migrateNotificationFanout } from './notification-fanout.mjs';
import { migrateNotifications } from './notifications.mjs';
import { migrateOrganizationOnboarding } from './organization-onboarding.mjs';
import { migratePullRequestDiffs } from './pull-request-diffs-safe.mjs';
import { migratePushProtection } from './push-protection.mjs';
import { migrateRepositoryAccess } from './repository-access.mjs';
import { migrateRepositoryImportJobs } from './repository-import-api.mjs';
import { migrateRepositoryInvitations } from './repository-invitations.mjs';
import { migrateRepositoryLifecycle } from './repository-lifecycle.mjs';
import { migrateReviewThreads } from './review-threads.mjs';
import { migrateRunners } from './runners.mjs';
import { migrateSecretScanning } from './secret-scanning.mjs';
import { migrateSecrets } from './secrets-vault.mjs';
import { migrateSshKeys } from './ssh-keys.mjs';
import { migrateStatusChecks } from './status-checks.mjs';
import { migrateStatusPage } from './status-page.mjs';
import { migrateSupportAccess } from './support-access.mjs';
import { migrateTenantExport } from './tenant-export.mjs';
import { migrateTenantImport } from './tenant-import.mjs';
import { migrateTenantLifecycle } from './tenant-lifecycle.mjs';
import { migrateWebhooks } from './webhooks.mjs';
import { migrateWorkflowLogs } from './workflow-logs.mjs';
import { migrateWorkflowRuns } from './workflow-runs.mjs';
import { migrateWorkflowStorage } from './workflow-storage.mjs';
import { migrateWorkflowTriggers } from './workflow-triggers.mjs';

/**
 * The whole schema, in the order it has to be applied.
 *
 * This used to be forty-two calls inline in `server.mjs`, which meant anything
 * else that wanted a real instance — a rehearsal, a drill, a restore — had to
 * copy the list and then quietly fall behind it. A harness testing a schema
 * nobody runs is a harness that certifies nothing, and the way that failure
 * shows up is a check passing against tables production does not have.
 *
 * Order matters in two places and is commented where it does. Everything else
 * is `IF NOT EXISTS` or checks before it alters, so running this twice is a
 * no-op.
 *
 * Every change runs with SQLite's writer lock held, so two instances starting
 * at the same instant cannot both run `ALTER TABLE … ADD COLUMN` and leave one
 * of them dead with `duplicate column name`. The second waits, then finds
 * everything already applied.
 *
 * @returns {{seeded: boolean}} whether this call created the founder account
 */
export function applySchema(db, config) {
  // Seeding writes rows rather than schema, but it happens under the same lock:
  // two instances both seeding would both try to create the founder account.
  let seeded = { seeded: false };
  withSchemaLock(db, () => {
  migrateAuthKitIdentity(db);
  migrateAccountVerification(db);
  // After it, because a linked identity hangs off a user row.
  migrateUserIdentities(db);
  migratePhoneVerification(db);
  migrateTwoFactor(db);
  migrateSignup(db);
  migrateOAuthSignIn(db);
  migrateCollaboration(db);
  migrateOrganizationOnboarding(db);
  migrateRepositoryAccess(db);
  migrateSupportAccess(db);
  migrateMaintenanceWindows(db);
  migrateStatusPage(db);
  migrateAbuseReports(db);
  migrateDangerousFiles(db);
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
  migrateRepositoryImportJobs(db);
  migrateIssueComments(db);
  // After comments: a reaction has a foreign key into one.
  migrateIssueReactions(db);
  migrateIssueTaxonomy(db);
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
  return seeded;
}
