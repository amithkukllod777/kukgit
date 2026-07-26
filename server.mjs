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
import { createTokenApiHandler } from './src/token-api.mjs';

const config = loadConfig();
fs.mkdirSync(config.repositoriesDir, { recursive: true });
fs.mkdirSync(config.tempDir, { recursive: true });
const gitVersion = ensureGitAvailable();
const db = openDatabase(config);
migrateCollaboration(db);
migrateRepositoryAccess(db);
migrateBranchGovernance(db);
const seeded = seedCore(db, config);
installExistingBranchProtectionHooks(config, db);
const app = createApp({ config, db });
const governedApp = createBranchGovernanceGuard({ config, db, app });
const tokenApi = createTokenApiHandler({ config, db });
const collaborationApi = createCollaborationApiHandler({ config, db });
const repositoryAccessApi = createRepositoryAccessApiHandler({ config, db });
const branchGovernanceApi = createBranchGovernanceApiHandler({ config, db });
const repositoryAccessGuard = createRepositoryAccessGuard({ config, db, app: governedApp });
const server = http.createServer(async (req, res) => {
  if (await tokenApi(req, res)) return;
  if (await collaborationApi(req, res)) return;
  if (await repositoryAccessApi(req, res)) return;
  if (await branchGovernanceApi(req, res)) return;
  if (await repositoryAccessGuard(req, res)) return;
  return governedApp(req, res);
});

server.listen(config.port, config.host, () => {
  console.log(`\nKukGit v0.1.0 is running at ${config.baseUrl}`);
  console.log(`${gitVersion}; data: ${config.dataDir}`);
  if (seeded.seeded && !config.isProduction) {
    console.log(`Development admin: ${config.adminEmail}`);
    console.log('Development password is configured from KUKGIT_ADMIN_PASSWORD (default documented in README).');
  }
  if (!config.isProduction && config.gitToken === 'kukgit-dev-token-change-me') {
    console.warn('WARNING: Set KUKGIT_DEV_GIT_TOKEN before sharing this server.');
  }
});

function shutdown(signal) {
  console.log(`\n${signal} received. Shutting down KukGit...`);
  server.close(() => {
    try { db.close(); } catch {}
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
