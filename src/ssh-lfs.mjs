import { audit } from './db.mjs';
import { permissionAtLeast, requireRepositoryAccess } from './repository-access.mjs';
import { httpError } from './security.mjs';

const KEY_ID_PATTERN = /^(usk|dpk)_[a-f0-9]{32}$/i;
const REPOSITORY_PATH = '([a-z0-9][a-z0-9-]{1,62})/([a-z0-9][a-z0-9-]{1,62})\\.git';

export function parseLfsSshOriginalCommand(value) {
  const command = String(value ?? '').trim();
  const quoted = new RegExp(`^git-lfs-authenticate '${REPOSITORY_PATH}' (download|upload)$`).exec(command);
  const unquoted = quoted ? null : new RegExp(`^git-lfs-authenticate ${REPOSITORY_PATH} (download|upload)$`).exec(command);
  const match = quoted || unquoted;
  if (!match) {
    throw httpError(400, 'Only a valid Git LFS authenticate command is allowed.', 'SSH_LFS_COMMAND_REJECTED');
  }
  return {
    service: 'git-lfs-authenticate',
    orgSlug: match[1],
    repoSlug: match[2],
    operation: match[3],
    write: match[3] === 'upload',
  };
}

function activeRepository(db, orgSlug, repoSlug) {
  return db.prepare(`
    SELECT r.id, r.slug, r.name, r.visibility, r.organization_id AS organizationId,
      r.archived_at AS archivedAt, o.slug AS orgSlug, o.name AS orgName
    FROM repositories r JOIN organizations o ON o.id = r.organization_id
    WHERE o.slug = ? AND r.slug = ? AND r.deleted_at IS NULL
  `).get(orgSlug, repoSlug);
}

export function authorizeLfsSshAuthentication(db, { keyKind, keyId, originalCommand }) {
  if (!['user', 'deploy'].includes(keyKind) || !KEY_ID_PATTERN.test(String(keyId ?? ''))) {
    throw httpError(403, 'SSH key identity is invalid.', 'SSH_KEY_IDENTITY_INVALID');
  }
  const command = parseLfsSshOriginalCommand(originalCommand);
  const repository = activeRepository(db, command.orgSlug, command.repoSlug);
  if (!repository) throw httpError(404, 'Repository not found.', 'REPO_NOT_FOUND');
  if (repository.archivedAt && command.write) {
    throw httpError(409, 'Archived repositories reject Git LFS uploads.', 'REPOSITORY_ARCHIVED');
  }

  let actor;
  if (keyKind === 'user') {
    const key = db.prepare(`
      SELECT k.id, k.user_id AS userId, u.email, u.display_name AS displayName
      FROM user_ssh_keys k JOIN users u ON u.id = k.user_id
      WHERE k.id = ? AND k.revoked_at IS NULL
    `).get(keyId);
    if (!key) throw httpError(403, 'SSH key is revoked or unknown.', 'SSH_KEY_UNAUTHORIZED');
    const access = requireRepositoryAccess(db, key.userId, { repositoryId: repository.id }, command.write ? 'write' : 'read');
    if (!permissionAtLeast(access.permission, command.write ? 'write' : 'read')) {
      throw httpError(403, 'Repository permission is insufficient for Git LFS.', 'LFS_REPOSITORY_PERMISSION_DENIED');
    }
    actor = {
      kind: 'user',
      keyId: key.id,
      userId: key.userId,
      email: key.email,
      displayName: key.displayName,
      permission: access.permission,
    };
    db.prepare('UPDATE user_ssh_keys SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?').run(key.id);
  } else {
    const key = db.prepare(`
      SELECT id, repository_id AS repositoryId, title, can_write AS canWrite
      FROM repository_deploy_keys WHERE id = ? AND revoked_at IS NULL
    `).get(keyId);
    if (!key || key.repositoryId !== repository.id) {
      throw httpError(403, 'Deploy key does not authorize this repository.', 'DEPLOY_KEY_REPOSITORY_MISMATCH');
    }
    if (command.write && !key.canWrite) throw httpError(403, 'This deploy key is read-only.', 'DEPLOY_KEY_READ_ONLY');
    actor = { kind: 'deploy', keyId: key.id, title: key.title, canWrite: Boolean(key.canWrite) };
    db.prepare('UPDATE repository_deploy_keys SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?').run(key.id);
  }

  audit(db, {
    organizationId: repository.organizationId,
    userId: actor.userId ?? null,
    action: 'lfs.ssh.authenticate',
    targetType: 'repository',
    targetId: repository.id,
    metadata: {
      repository: repository.slug,
      keyKind,
      keyId,
      operation: command.operation,
    },
  });
  return { command, repository, actor };
}
