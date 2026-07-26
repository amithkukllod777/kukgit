import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import { currentRepositoryAccess } from './access-context.mjs';
import { hashPassword } from './auth.mjs';

export function openDatabase(config) {
  fs.mkdirSync(path.dirname(config.databasePath), { recursive: true });
  const db = new DatabaseSync(config.databasePath);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrate(db);
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
  db.prepare(`INSERT INTO audit_logs (id, organization_id, user_id, action, target_type, target_id, metadata_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)`) 
    .run(uid('aud'), organizationId, userId, action, targetType, targetId, JSON.stringify(metadata));
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

  const row = db.prepare(`
    SELECT o.id, o.slug, o.name, o.plan, om.role
    FROM organizations o JOIN org_members om ON om.organization_id = o.id
    WHERE o.slug = ? AND om.user_id = ?
  `).get(orgSlug, userId);
  if (!row) return null;
  if (roleRank[row.role] < roleRank[minimumRole]) return null;
  return row;
}

export function findRepo(db, orgSlug, repoSlug) {
  return db.prepare(`
    SELECT r.*, o.slug AS org_slug, o.name AS org_name
    FROM repositories r JOIN organizations o ON o.id = r.organization_id
    WHERE o.slug = ? AND r.slug = ? AND r.deleted_at IS NULL
  `).get(orgSlug, repoSlug);
}
