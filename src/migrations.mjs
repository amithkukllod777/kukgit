import { migrateAuthKitIdentity } from './authkit-identity.mjs';
import { migrateBranchGovernance } from './branch-governance.mjs';
import { migrateCollaboration } from './collaboration.mjs';
import { migrateGitLfs } from './git-lfs-safe.mjs';
import { migrateNotifications } from './notifications.mjs';
import { migrateOrganizationOnboarding } from './organization-onboarding.mjs';
import { migratePullRequestDiffs } from './pull-request-diffs-safe.mjs';
import { migrateRepositoryAccess } from './repository-access.mjs';
import { migrateRepositoryInvitations } from './repository-invitations.mjs';
import { migrateRepositoryLifecycle } from './repository-lifecycle.mjs';
import { migrateReviewThreads } from './review-threads.mjs';
import { migrateSshKeys } from './ssh-keys.mjs';
import { migrateStatusChecks } from './status-checks.mjs';
import { migrateWebhooks } from './webhooks.mjs';

export const KUKGIT_SCHEMA_VERSION = '2026.07.27.1';

function migrateSchemaMetadata(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS kukgit_schema_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

function recordSchemaVersion(db) {
  migrateSchemaMetadata(db);
  db.prepare(`
    INSERT INTO kukgit_schema_metadata (key, value, updated_at)
    VALUES ('schema_version', ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = CURRENT_TIMESTAMP
  `).run(KUKGIT_SCHEMA_VERSION);
}

/**
 * Migrations that must exist before optional local-development seeding.
 *
 * Keep this order stable. Several later modules add foreign keys or backfill
 * data that depends on tables created by earlier modules.
 */
export function migrateApplicationSchema(db) {
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
  migrateSchemaMetadata(db);
}

/**
 * Post-seed migrations and data backfills.
 *
 * Notification migration inserts default preference rows for every existing
 * user, so it intentionally runs after local-development seeding.
 */
export function migratePostSeedSchema(db) {
  migrateNotifications(db);
  recordSchemaVersion(db);
}

export function migrateCompleteApplicationSchema(db) {
  migrateApplicationSchema(db);
  migratePostSeedSchema(db);
  return KUKGIT_SCHEMA_VERSION;
}

export function currentSchemaVersion(db) {
  try {
    return db.prepare("SELECT value FROM kukgit_schema_metadata WHERE key = 'schema_version'").get()?.value ?? null;
  } catch {
    return null;
  }
}
