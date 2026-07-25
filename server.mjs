import fs from 'node:fs';
import http from 'node:http';
import { createApp } from './src/app.mjs';
import { loadConfig } from './src/config.mjs';
import { openDatabase, seedCore } from './src/db.mjs';
import { ensureGitAvailable } from './src/git.mjs';

const config = loadConfig();
fs.mkdirSync(config.repositoriesDir, { recursive: true });
fs.mkdirSync(config.tempDir, { recursive: true });
const gitVersion = ensureGitAvailable();
const db = openDatabase(config);
const seeded = seedCore(db, config);
const server = http.createServer(createApp({ config, db }));

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
