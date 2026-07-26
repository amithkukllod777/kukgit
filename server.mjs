import fs from 'node:fs';
import http from 'node:http';
import { createApp } from './src/app.mjs';
import {
  createBranchGovernanceApiHandler,
  createBranchGovernanceGuard,
  installExistingBranchProtectionHooks,
  migrateBranchGovernance,
} from './src/branch-governance.mjs';
import { createCollaborationApiHandler, migrateCollaboration } from './src/collaboration.mjs';
import { loadConfig } from './src/config.mjs';
import { openDatabase, seedCore } from './src/db.mjs';
import { ensureGitAvailable } from './src/git.mjs';
import {
  createRepositoryAccessApiHandler,
  createRepositoryAccessGuard,
  migrateRepositoryAccess,
} from './src/repository-access.mjs';
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
const gitVersion = ensureGitAvailable();
const db = openDatabase(config);
migrateCollaboration(db);
migrateRepositoryAccess(db);
migrateBranchGovernance(db);
migrateReviewThreads(db);
migrateStatusChecks(db);
migrateWebhooks(db);
migrateRepositoryLifecycle(db);
migrateSshKeys(db);
const seeded = seedCore(db, config);
installExistingBranchProtectionHooks(config, db);
const app = createApp({ config, db });
const statusGuardedApp = createStatusCheckMergeGuard({ config, db, app });
const reviewThreadGuardedApp = createReviewThreadMergeGuard({ config, db, app: statusGuardedApp });
const governedApp = createBranchGovernanceGuard({ config, db, app: reviewThreadGuardedApp });
const tokenApi = createTokenApiHandler({ config, db });
const collaborationApi = createCollaborationApiHandler({ config, db });
const repositoryAccessApi = createRepositoryAccessApiHandler({ config, db });
const repositoryLifecycleApi = createRepositoryLifecycleApiHandler({ config, db });
const sshKeysApi = createSshKeysApiHandler({ config, db });
const branchGovernanceApi = createBranchGovernanceApiHandler({ config, db });
const reviewThreadsApi = createReviewThreadsApiHandler({ config, db });
const statusChecksApi = createStatusChecksApiHandler({ config, db });
const webhooksApi = createWebhooksApiHandler({ config, db });
const repositoryAccessGuard = createRepositoryAccessGuard({ config, db, app: governedApp });

async function dispatch(req, res) {
  if (await tokenApi(req, res)) return;
  if (await collaborationApi(req, res)) return;
  if (await repositoryLifecycleApi(req, res)) return;
  if (await sshKeysApi(req, res)) return;
  if (await repositoryAccessApi(req, res)) return;
  if (await branchGovernanceApi(req, res)) return;
  if (await reviewThreadsApi(req, res)) return;
  if (await statusChecksApi(req, res)) return;
  if (await webhooksApi(req, res)) return;
  if (await repositoryAccessGuard(req, res)) return;
  return governedApp(req, res);
}

const lifecycleDispatch = createRepositoryLifecycleGuard({ config, db, next: dispatch });
const capturedDispatch = createWebhookEventCapture({ config, db, next: lifecycleDispatch });
const stopWebhookWorker = startWebhookWorker(db, config);
const server = http.createServer(capturedDispatch);

server.listen(config.port, config.host, () => {
  console.log(`\nKukGit v0.1.0 is running at ${config.baseUrl}`);
  console.log(`${gitVersion}; data: ${config.dataDir}`);
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
});

function shutdown(signal) {
  console.log(`\n${signal} received. Shutting down KukGit...`);
  stopWebhookWorker();
  server.close(() => {
    try { db.close(); } catch {}
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
