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
    tempDir: overrides.tempDir ?? path.join(dataDir, 'tmp'),
    publicDir: path.join(root, 'public'),
    isProduction,
    cookieSecure: String(overrides.cookieSecure ?? process.env.KUKGIT_COOKIE_SECURE ?? 'false') === 'true',
    adminEmail: overrides.adminEmail ?? process.env.KUKGIT_ADMIN_EMAIL ?? 'admin@kuklabs.local',
    adminPassword: overrides.adminPassword ?? process.env.KUKGIT_ADMIN_PASSWORD ?? 'KukGit@2026',
    adminName: overrides.adminName ?? process.env.KUKGIT_ADMIN_NAME ?? 'Amit Kumar Kuklod',
    gitToken: overrides.gitToken ?? process.env.KUKGIT_DEV_GIT_TOKEN ?? 'kukgit-dev-token-change-me',
    webhookEncryptionKey: overrides.webhookEncryptionKey ?? process.env.KUKGIT_WEBHOOK_ENCRYPTION_KEY ?? (isProduction ? '' : 'kukgit-development-webhook-key-change-me'),
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
