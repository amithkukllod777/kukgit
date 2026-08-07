import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import { currentRepositoryAccess } from './access-context.mjs';
import { hashPassword } from './auth.mjs';
import { runRuntimeRead } from './runtime-read-service.mjs';
import { migrateTwoFactor } from './two-factor-schema.mjs';
import { ensureSqliteRuntimeWriteMigrations } from './runtime-write-migrations.mjs';
import {
  createRuntimeWriteService,
  registerRuntimeWriteService,
  runRuntimeWrite,
  runtimeWriteServiceFor,
} from './runtime-write-service.mjs';

/**
 * Adds `db.transaction`, nesting-aware.
 *
 * SQLite refuses `BEGIN` inside `BEGIN`, so a transaction opened while one is
 * already running uses a savepoint instead. Without this, any code that wanted
 * to run several already-transactional operations as one unit would fail at
 * runtime — which is exactly what wrapping the schema migrations needs to do.
 *
 * The depth counter is per connection, and a connection is used from one thread,
 * so it cannot drift.
 */
function installTransactionHelper(db) {
  if (typeof db.transaction === 'function') return;
  let depth = 0;
  Object.defineProperty(db, 'transactionDepth', {
    configurable: false, enumerable: false, get: () => depth,
  });
  Object.defineProperty(db, 'transaction', {
    configurable: false,
    enumerable: false,
    writable: false,
    value(work) {
      if (typeof work !== 'function') throw new TypeError('Transaction work must be a function.');
      return (...args) => {
        const nested = depth > 0;
        const savepoint = nested ? `kukgit_sp_${depth}` : null;
        if (nested) db.exec(`SAVEPOINT ${savepoint}`);
        else db.exec('BEGIN IMMEDIATE');
        depth += 1;
        try {
          const result = work(...args);
          if (result && typeof result.then === 'function') {
            // Rolled back before the error is thrown, because an async callback
            // would otherwise leave the transaction open for whatever ran next.
            depth -= 1;
            if (nested) db.exec(`ROLLBACK TO ${savepoint}`); else db.exec('ROLLBACK');
            if (nested) db.exec(`RELEASE ${savepoint}`);
            throw new TypeError('SQLite transaction callbacks must be synchronous.');
          }
          depth -= 1;
          if (nested) db.exec(`RELEASE ${savepoint}`); else db.exec('COMMIT');
          return result;
        } catch (error) {
          if (depth > 0) depth -= 1;
          try {
            if (nested) { db.exec(`ROLLBACK TO ${savepoint}`); db.exec(`RELEASE ${savepoint}`); }
            else db.exec('ROLLBACK');
          } catch { /* the connection is already unwinding */ }
          throw error;
        }
      };
    },
  });
}

// Long enough that a second instance waits for the first to finish migrating
// rather than exiting. Migrations are DDL on a small schema, so a real one takes
// well under a second; the margin is for a cold volume and a large WAL.
const MIGRATION_LOCK_TIMEOUT_MS = 60_000;

/**
 * Runs schema changes with every other instance locked out.
 *
 * `BEGIN IMMEDIATE` takes SQLite's writer lock for the whole block, so a second
 * instance starting at the same moment waits and then finds every migration
 * already applied — each one is `IF NOT EXISTS` or checks before it alters.
 *
 * Without this, two instances starting together both run `ALTER TABLE … ADD
 * COLUMN` and one exits with `duplicate column name`. That is not hypothetical:
 * it happened the first time two instances were started simultaneously to test
 * the job leases, and a rolling deploy is exactly when it would happen again.
 *
 * The timeout is raised only for the lock. Leaving it raised would make every
 * later contended write wait a minute before reporting a problem.
 */
/**
 * Puts the database in WAL mode, tolerating another instance doing it first.
 *
 * Switching journal mode needs an exclusive lock and does not wait for it the
 * way an ordinary write does, so a second instance starting while the first is
 * migrating gets `database is locked` and exits — which is precisely the
 * simultaneous start this is all about.
 *
 * Reading the current mode takes only a shared lock, so the answer to "does this
 * even need changing" is always available. On an existing database that is
 * already WAL there is nothing to do at all; on a new one, whichever instance
 * wins sets it and the rest observe the result.
 */
function enableWalMode(db, { attempts = 20, waitMs = 250 } = {}) {
  const currentMode = () => String(db.prepare('PRAGMA journal_mode').get().journal_mode ?? '').toLowerCase();
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (currentMode() === 'wal') return;
    try {
      db.exec('PRAGMA journal_mode = WAL');
      if (currentMode() === 'wal') return;
    } catch {
      // Somebody else holds the exclusive lock. They are either setting it to
      // WAL themselves or about to release, so the next loop re-reads rather
      // than assuming which.
    }
    // A short synchronous wait. This runs once at startup before the server
    // listens, so blocking here delays nothing a user can see.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs);
  }
  throw new Error('Could not put the metadata database into WAL mode; another instance may be stuck holding an exclusive lock.');
}

export function withSchemaLock(db, work) {
  db.exec(`PRAGMA busy_timeout = ${MIGRATION_LOCK_TIMEOUT_MS}`);
  try {
    return db.transaction(work)();
  } finally {
    db.exec('PRAGMA busy_timeout = 5000');
  }
}

export function openDatabase(config) {
  const requestedDriver = String(process.env.KUKGIT_DATABASE_DRIVER || 'sqlite').trim().toLowerCase();
  if (requestedDriver !== 'sqlite') {
    const error = new Error('PostgreSQL runtime is not available in the current KukGit stage. Keep KUKGIT_DATABASE_DRIVER=sqlite until the driver/import stage and verified cutover are delivered.');
    error.code = 'POSTGRESQL_RUNTIME_NOT_AVAILABLE';
    throw error;
  }
  fs.mkdirSync(path.dirname(config.databasePath), { recursive: true });
  const db = new DatabaseSync(config.databasePath);
  installTransactionHelper(db);
  // `busy_timeout` is set first and on its own. It was previously last in a
  // single statement, which meant `journal_mode = WAL` ran with a timeout of
  // zero — so a second instance starting while the first held the writer lock
  // died with `database is locked` before it reached any migration.
  // `busy_timeout` is set first and on its own. It was previously last in a
  // single statement, which meant everything before it ran with a timeout of
  // zero.
  db.exec(`PRAGMA busy_timeout = ${MIGRATION_LOCK_TIMEOUT_MS}`);
  enableWalMode(db);
  db.exec('PRAGMA foreign_keys = ON');
  withSchemaLock(db, () => migrate(db));
  if (config.runtimeWriteServiceEnabled) {
    ensureSqliteRuntimeWriteMigrations(db);
    registerRuntimeWriteService(db, createRuntimeWriteService({ sqlite: db }));
  }
  return db;
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      display_name TEXT NOT NULL,
      avatar_url TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS organizations (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      plan TEXT NOT NULL DEFAULT 'free',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS org_members (
      organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK(role IN ('owner','admin','maintainer','developer','viewer')),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (organization_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS personal_access_tokens (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      token_prefix TEXT NOT NULL,
      scopes_json TEXT NOT NULL,
      expires_at TEXT,
      last_used_at TEXT,
      revoked_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS repositories (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      slug TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      visibility TEXT NOT NULL DEFAULT 'private' CHECK(visibility IN ('public','private','internal')),
      default_branch TEXT NOT NULL DEFAULT 'main',
      archived_at TEXT,
      deleted_at TEXT,
      deleted_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      deleted_from_org_id TEXT REFERENCES organizations(id) ON DELETE SET NULL,
      deleted_original_slug TEXT,
      purge_after TEXT,
      created_by TEXT NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(organization_id, slug)
    );
    CREATE TABLE IF NOT EXISTS issues (
      id TEXT PRIMARY KEY,
      repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
      number INTEGER NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed')),
      priority TEXT NOT NULL DEFAULT 'medium' CHECK(priority IN ('low','medium','high','critical')),
      author_id TEXT NOT NULL REFERENCES users(id),
      assignee_id TEXT REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(repository_id, number)
    );
    CREATE TABLE IF NOT EXISTS pull_requests (
      id TEXT PRIMARY KEY,
      repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
      number INTEGER NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      base_branch TEXT NOT NULL,
      head_branch TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed','merged')),
      author_id TEXT NOT NULL REFERENCES users(id),
      merged_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(repository_id, number)
    );
    CREATE TABLE IF NOT EXISTS analyses (
      id TEXT PRIMARY KEY,
      repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
      ref TEXT NOT NULL,
      score INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
      organization_id TEXT REFERENCES organizations(id) ON DELETE CASCADE,
      user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      action TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_pat_user_created ON personal_access_tokens(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_repositories_org ON repositories(organization_id);
    CREATE INDEX IF NOT EXISTS idx_issues_repo_status ON issues(repository_id, status);
    CREATE INDEX IF NOT EXISTS idx_pr_repo_status ON pull_requests(repository_id, status);
    CREATE INDEX IF NOT EXISTS idx_audit_org_created ON audit_logs(organization_id, created_at DESC);
  `);
  // Here rather than in the optional-feature migrations, because sign-in reads
  // it on every attempt. A database without these tables is one where the
  // second factor silently stops being asked for — and a security check that
  // fails open when a migration is missing is worse than one that is absent.
  migrateTwoFactor(db);
}

export function uid(prefix) {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;
}

export function seedCore(db, config) {
  const existing = db.prepare('SELECT COUNT(*) AS count FROM users').get().count;
  if (existing > 0) return { seeded: false };
  if (config.isProduction && config.adminPassword === 'KukGit@2026') {
    throw new Error('Set KUKGIT_ADMIN_PASSWORD before starting KukGit in production.');
  }
  const userId = uid('usr');
  const orgId = uid('org');
  db.prepare('INSERT INTO users (id, email, password_hash, display_name) VALUES (?, ?, ?, ?)')
    .run(userId, config.adminEmail.toLowerCase(), hashPassword(config.adminPassword), config.adminName);
  db.prepare('INSERT INTO organizations (id, slug, name, plan) VALUES (?, ?, ?, ?)')
    .run(orgId, 'kuklabs', 'Kuklabs Inc.', 'founder');
  db.prepare('INSERT INTO org_members (organization_id, user_id, role) VALUES (?, ?, ?)')
    .run(orgId, userId, 'owner');
  return { seeded: true, userId, orgId };
}

export function audit(db, { organizationId = null, userId = null, action, targetType, targetId = null, metadata = {} }) {
  const id = uid('aud');
  const parameters = [id, organizationId, userId, action, targetType, targetId, JSON.stringify(metadata)];
  if (runtimeWriteServiceFor(db)) {
    runRuntimeWrite(db, 'audit_logs.insert', parameters);
  } else {
    db.prepare(`INSERT INTO audit_logs
      (id, organization_id, user_id, action, target_type, target_id, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(...parameters);
  }
  return id;
}

export function orgAccess(db, userId, orgSlug, minimumRole = 'viewer') {
  const roleRank = { viewer: 1, developer: 2, maintainer: 3, admin: 4, owner: 5 };
  const repositoryContext = currentRepositoryAccess();
  if (repositoryContext?.allowed && repositoryContext.userId === userId && repositoryContext.orgSlug === orgSlug) {
    const organization = db.prepare('SELECT id, slug, name, plan FROM organizations WHERE slug = ?').get(orgSlug);
    if (!organization) return null;
    return {
      ...organization,
      role: repositoryContext.organizationRole ?? null,
      repositoryPermission: repositoryContext.permission,
      externalRepositoryAccess: Boolean(repositoryContext.external),
    };
  }

  const row = runRuntimeRead(db, 'organizations.access_by_slug_and_user', [orgSlug, userId]);
  if (!row) return null;
  if (roleRank[row.role] < roleRank[minimumRole]) return null;
  return row;
}

export function findRepo(db, orgSlug, repoSlug) {
  return runRuntimeRead(db, 'repositories.find_by_slug', [orgSlug, repoSlug]) ?? undefined;
}
