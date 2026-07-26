import { requireUser } from './auth.mjs';
import { audit, uid } from './db.mjs';
import {
  createNotification,
  migrateNotifications,
  notifyEmailAddress,
} from './notifications.mjs';
import {
  normalizeRepositoryPermission,
  requireRepositoryAccess,
} from './repository-access.mjs';
import {
  hashToken,
  httpError,
  normalizeEmail,
  originAllowed,
  randomToken,
} from './security.mjs';

const TOKEN_PREFIX = 'kgr_';
const TOKEN_PATTERN = /^kgr_[A-Za-z0-9_-]{32,128}$/;
const EXPIRY_DAYS = new Set([7, 14, 30]);
const MAX_BODY_BYTES = 64 * 1024;

export function migrateRepositoryInvitations(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS repository_invitations (
      id TEXT PRIMARY KEY,
      repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
      email TEXT NOT NULL,
      permission TEXT NOT NULL CHECK(permission IN ('read','triage','write','maintain','admin')),
      token_hash TEXT NOT NULL UNIQUE,
      token_prefix TEXT NOT NULL,
      invited_by TEXT NOT NULL REFERENCES users(id),
      expires_at TEXT NOT NULL,
      accepted_at TEXT,
      accepted_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      revoked_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_repository_invitations_repo
      ON repository_invitations(repository_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_repository_invitations_email
      ON repository_invitations(email, expires_at);
  `);
}

function htmlEscape(value = '') {
  return String(value).replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[character]);
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
  return true;
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw httpError(413, 'Request body is too large.', 'REPOSITORY_INVITATION_REQUEST_TOO_LARGE');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw httpError(400, 'Invalid JSON request body.', 'INVALID_JSON'); }
}

function routeMatch(pathname, pattern) {
  const keys = [];
  const regex = new RegExp('^' + pattern.replace(/:([A-Za-z0-9_]+)/g, (_, key) => {
    keys.push(key);
    return '([^/]+)';
  }) + '$');
  const match = pathname.match(regex);
  if (!match) return null;
  try { return Object.fromEntries(keys.map((key, index) => [key, decodeURIComponent(match[index + 1])])); }
  catch { throw httpError(400, 'Invalid request path.', 'INVALID_PATH'); }
}

function invitationDto(row) {
  return {
    id: row.id,
    email: row.email,
    permission: row.permission,
    tokenPrefix: row.tokenPrefix,
    invitedByName: row.invitedByName,
    expiresAt: row.expiresAt,
    acceptedAt: row.acceptedAt,
    acceptedByName: row.acceptedByName,
    revokedAt: row.revokedAt,
    createdAt: row.createdAt,
    status: row.acceptedAt
      ? 'accepted'
      : row.revokedAt
        ? 'revoked'
        : new Date(row.expiresAt).getTime() <= Date.now()
          ? 'expired'
          : 'pending',
  };
}

function listInvitations(db, repositoryId) {
  return db.prepare(`
    SELECT i.id, i.email, i.permission, i.token_prefix AS tokenPrefix,
      i.expires_at AS expiresAt, i.accepted_at AS acceptedAt,
      i.revoked_at AS revokedAt, i.created_at AS createdAt,
      inviter.display_name AS invitedByName,
      accepted.display_name AS acceptedByName
    FROM repository_invitations i
    JOIN users inviter ON inviter.id = i.invited_by
    LEFT JOIN users accepted ON accepted.id = i.accepted_by
    WHERE i.repository_id = ?
    ORDER BY i.created_at DESC
    LIMIT 250
  `).all(repositoryId).map(invitationDto);
}

function invitationMessage(config, repository, invitation, inviter) {
  const expiry = new Date(invitation.expiresAt).toLocaleString('en-IN', {
    dateStyle: 'medium', timeStyle: 'short',
  });
  const repositoryLabel = `${repository.orgSlug}/${repository.slug}`;
  const subject = `Invitation to collaborate on ${repositoryLabel}`;
  const text = `${inviter.displayName} invited you to collaborate on ${repositoryLabel} with ${invitation.permission} permission.\n\nAccept invitation: ${invitation.acceptanceUrl}\n\nThis secure link expires on ${expiry}. Sign in with ${invitation.email}. Accepting this invitation grants access only to this repository and does not add you to the organization.`;
  const html = `<!doctype html><html><body style="font-family:Arial,sans-serif;color:#132033;line-height:1.6"><div style="max-width:620px;margin:0 auto;padding:28px"><h1 style="font-size:24px">Collaborate on ${htmlEscape(repositoryLabel)}</h1><p><b>${htmlEscape(inviter.displayName)}</b> invited you with <b>${htmlEscape(invitation.permission)}</b> permission.</p><p><a href="${htmlEscape(invitation.acceptanceUrl)}" style="display:inline-block;padding:12px 18px;background:#1598ff;color:#fff;text-decoration:none;border-radius:8px">Accept repository invitation</a></p><p>This secure link expires on ${htmlEscape(expiry)}. Sign in with <b>${htmlEscape(invitation.email)}</b>.</p><p style="color:#637083;font-size:13px">This invitation grants access only to this repository. It does not add you to the organization.</p></div></body></html>`;
  return { subject, text, html };
}

function deliverInvitation(db, config, repository, invitation, inviter) {
  migrateNotifications(db);
  const existingUser = db.prepare('SELECT id FROM users WHERE email = ?').get(invitation.email);
  const message = invitationMessage(config, repository, invitation, inviter);
  if (existingUser) {
    createNotification(db, config, {
      userId: existingUser.id,
      category: 'organization',
      title: `Invitation to ${repository.orgSlug}/${repository.slug}`,
      body: `${inviter.displayName} invited you with ${invitation.permission} repository permission.`,
      link: `#/accept-repo-invite?token=${encodeURIComponent(invitation.token)}`,
      dedupeKey: `repository-invitation:${invitation.id}`,
      metadata: {
        invitationId: invitation.id,
        repositoryId: repository.id,
        permission: invitation.permission,
        expiresAt: invitation.expiresAt,
      },
      email: { ...message, dedupeKey: `email:repository-invitation:${invitation.id}` },
    });
    return { existingUser: true };
  }
  notifyEmailAddress(db, config, {
    to: invitation.email,
    category: 'organization',
    ...message,
    dedupeKey: `email:repository-invitation:${invitation.id}`,
  });
  return { existingUser: false };
}

function createInvitationRecord(db, config, access, actor, input) {
  const email = normalizeEmail(input.email);
  const permission = normalizeRepositoryPermission(input.permission ?? 'read');
  const expiresInDays = Number(input.expiresInDays ?? 14);
  if (!EXPIRY_DAYS.has(expiresInDays)) {
    throw httpError(400, 'Invitation expiry must be 7, 14 or 30 days.', 'REPOSITORY_INVITATION_EXPIRY_INVALID');
  }
  if (email === actor.email) throw httpError(409, 'You cannot invite yourself.', 'REPOSITORY_INVITATION_SELF');

  const existingUser = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existingUser) {
    const current = db.prepare(`
      SELECT permission FROM repository_collaborators
      WHERE repository_id = ? AND user_id = ?
    `).get(access.repository.id, existingUser.id);
    if (current) throw httpError(409, 'This user already has direct repository access.', 'REPOSITORY_COLLABORATOR_EXISTS');
  }

  db.prepare(`
    UPDATE repository_invitations SET revoked_at = COALESCE(revoked_at, CURRENT_TIMESTAMP)
    WHERE repository_id = ? AND email = ? AND accepted_at IS NULL AND revoked_at IS NULL
  `).run(access.repository.id, email);

  const token = `${TOKEN_PREFIX}${randomToken(32)}`;
  const invitation = {
    id: uid('rpi'),
    repositoryId: access.repository.id,
    email,
    permission,
    token,
    tokenPrefix: token.slice(0, 12),
    invitedBy: actor.id,
    expiresAt: new Date(Date.now() + expiresInDays * 86400000).toISOString(),
  };
  db.prepare(`
    INSERT INTO repository_invitations
      (id, repository_id, email, permission, token_hash, token_prefix, invited_by, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    invitation.id,
    invitation.repositoryId,
    invitation.email,
    invitation.permission,
    hashToken(token),
    invitation.tokenPrefix,
    invitation.invitedBy,
    invitation.expiresAt,
  );
  invitation.acceptanceUrl = `${config.baseUrl}/#/accept-repo-invite?token=${encodeURIComponent(token)}`;
  deliverInvitation(db, config, access.repository, invitation, actor);
  audit(db, {
    organizationId: access.repository.organizationId,
    userId: actor.id,
    action: 'repository_invitation.created',
    targetType: 'repository_invitation',
    targetId: invitation.id,
    metadata: {
      repositoryId: access.repository.id,
      repository: access.repository.slug,
      email,
      permission,
      expiresAt: invitation.expiresAt,
    },
  });
  return invitation;
}

function pendingInvitation(db, repositoryId, invitationId) {
  const invitation = db.prepare(`
    SELECT id, repository_id AS repositoryId, email, permission,
      expires_at AS expiresAt, accepted_at AS acceptedAt,
      revoked_at AS revokedAt
    FROM repository_invitations WHERE id = ? AND repository_id = ?
  `).get(invitationId, repositoryId);
  if (!invitation) throw httpError(404, 'Repository invitation not found.', 'REPOSITORY_INVITATION_NOT_FOUND');
  if (invitation.acceptedAt) throw httpError(409, 'Accepted invitations cannot be changed.', 'REPOSITORY_INVITATION_ACCEPTED');
  return invitation;
}

function acceptInvitation(db, config, user, token) {
  const value = String(token ?? '').trim();
  if (!TOKEN_PATTERN.test(value)) throw httpError(400, 'Repository invitation token is invalid.', 'REPOSITORY_INVITATION_TOKEN_INVALID');
  const invitation = db.prepare(`
    SELECT i.id, i.repository_id AS repositoryId, i.email, i.permission,
      i.invited_by AS invitedBy, i.expires_at AS expiresAt,
      i.accepted_at AS acceptedAt, i.revoked_at AS revokedAt,
      r.slug, r.name, r.organization_id AS organizationId,
      o.slug AS orgSlug, o.name AS orgName,
      inviter.display_name AS inviterName
    FROM repository_invitations i
    JOIN repositories r ON r.id = i.repository_id
    JOIN organizations o ON o.id = r.organization_id
    JOIN users inviter ON inviter.id = i.invited_by
    WHERE i.token_hash = ? AND r.deleted_at IS NULL
  `).get(hashToken(value));
  if (!invitation) throw httpError(404, 'Repository invitation was not found.', 'REPOSITORY_INVITATION_NOT_FOUND');
  if (invitation.revokedAt) throw httpError(410, 'Repository invitation was revoked.', 'REPOSITORY_INVITATION_REVOKED');
  if (invitation.acceptedAt) throw httpError(409, 'Repository invitation was already accepted.', 'REPOSITORY_INVITATION_ALREADY_ACCEPTED');
  if (new Date(invitation.expiresAt).getTime() <= Date.now()) throw httpError(410, 'Repository invitation expired.', 'REPOSITORY_INVITATION_EXPIRED');
  if (normalizeEmail(user.email) !== invitation.email) {
    throw httpError(403, 'Sign in with the exact email address that was invited.', 'REPOSITORY_INVITATION_EMAIL_MISMATCH');
  }

  db.exec('BEGIN IMMEDIATE');
  try {
    const claimed = db.prepare(`
      UPDATE repository_invitations
      SET accepted_at = CURRENT_TIMESTAMP, accepted_by = ?
      WHERE id = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > CURRENT_TIMESTAMP
    `).run(user.id, invitation.id);
    if (!claimed.changes) throw httpError(409, 'Repository invitation is no longer available.', 'REPOSITORY_INVITATION_UNAVAILABLE');
    db.prepare(`
      INSERT INTO repository_collaborators (repository_id, user_id, permission, added_by)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(repository_id, user_id) DO UPDATE SET
        permission = excluded.permission,
        added_by = excluded.added_by,
        updated_at = CURRENT_TIMESTAMP
    `).run(invitation.repositoryId, user.id, invitation.permission, invitation.invitedBy);
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  }

  audit(db, {
    organizationId: invitation.organizationId,
    userId: user.id,
    action: 'repository_invitation.accepted',
    targetType: 'repository',
    targetId: invitation.repositoryId,
    metadata: {
      invitationId: invitation.id,
      repository: invitation.slug,
      permission: invitation.permission,
      invitedBy: invitation.invitedBy,
    },
  });

  if (invitation.invitedBy !== user.id) {
    createNotification(db, config, {
      userId: invitation.invitedBy,
      category: 'organization',
      title: `${user.displayName} joined ${invitation.orgSlug}/${invitation.slug}`,
      body: `${user.email} accepted ${invitation.permission} repository access.`,
      link: `#/repo/${invitation.orgSlug}/${invitation.slug}/settings`,
      dedupeKey: `repository-invitation-accepted:${invitation.id}:inviter`,
      metadata: { invitationId: invitation.id, repositoryId: invitation.repositoryId, acceptedUserId: user.id },
      email: {
        subject: `${user.displayName} accepted repository access`,
        text: `${user.displayName} (${user.email}) accepted ${invitation.permission} access to ${invitation.orgSlug}/${invitation.slug}.\n\nOpen KukGit: ${config.baseUrl}/#/repo/${invitation.orgSlug}/${invitation.slug}/settings`,
      },
    });
  }
  createNotification(db, config, {
    userId: user.id,
    category: 'organization',
    title: `Repository access active`,
    body: `You now have ${invitation.permission} access to ${invitation.orgSlug}/${invitation.slug}.`,
    link: `#/repo/${invitation.orgSlug}/${invitation.slug}/code`,
    dedupeKey: `repository-invitation-accepted:${invitation.id}:member`,
    metadata: { invitationId: invitation.id, repositoryId: invitation.repositoryId, permission: invitation.permission },
  });

  return {
    invitationId: invitation.id,
    repository: {
      id: invitation.repositoryId,
      orgSlug: invitation.orgSlug,
      orgName: invitation.orgName,
      slug: invitation.slug,
      name: invitation.name,
    },
    permission: invitation.permission,
  };
}

export function createRepositoryInvitationsApiHandler({ config, db }) {
  return async function repositoryInvitationsApi(req, res) {
    const url = new URL(req.url, config.baseUrl);
    if (!url.pathname.startsWith('/api/repository-invitations')) return false;
    const requestId = uid('req');
    res.setHeader('X-Request-Id', requestId);
    res.setHeader('Referrer-Policy', 'no-referrer');
    try {
      if (!originAllowed(req, config.baseUrl)) throw httpError(403, 'Request origin is not allowed.', 'CSRF_BLOCKED');
      const user = requireUser(db, req);
      migrateRepositoryInvitations(db);

      if (url.pathname === '/api/repository-invitations/accept' && req.method === 'POST') {
        const body = await readJson(req);
        return sendJson(res, 200, { result: acceptInvitation(db, config, user, body.token) });
      }

      let params = routeMatch(url.pathname, '/api/repository-invitations/:org/:repo');
      if (params && req.method === 'GET') {
        const access = requireRepositoryAccess(db, user.id, { orgSlug: params.org, repoSlug: params.repo }, 'admin');
        return sendJson(res, 200, {
          repository: access.repository,
          invitations: listInvitations(db, access.repository.id),
        });
      }
      if (params && req.method === 'POST') {
        const access = requireRepositoryAccess(db, user.id, { orgSlug: params.org, repoSlug: params.repo }, 'admin');
        const body = await readJson(req);
        const invitation = createInvitationRecord(db, config, access, user, body);
        return sendJson(res, 201, { invitation });
      }

      params = routeMatch(url.pathname, '/api/repository-invitations/:org/:repo/:id/revoke');
      if (params && req.method === 'POST') {
        const access = requireRepositoryAccess(db, user.id, { orgSlug: params.org, repoSlug: params.repo }, 'admin');
        const invitation = pendingInvitation(db, access.repository.id, params.id);
        const result = db.prepare(`
          UPDATE repository_invitations SET revoked_at = CURRENT_TIMESTAMP
          WHERE id = ? AND revoked_at IS NULL
        `).run(invitation.id);
        if (!result.changes) throw httpError(409, 'Repository invitation is already revoked.', 'REPOSITORY_INVITATION_REVOKED');
        audit(db, {
          organizationId: access.repository.organizationId,
          userId: user.id,
          action: 'repository_invitation.revoked',
          targetType: 'repository_invitation',
          targetId: invitation.id,
          metadata: { repositoryId: access.repository.id, email: invitation.email, permission: invitation.permission },
        });
        return sendJson(res, 200, { revoked: true });
      }

      params = routeMatch(url.pathname, '/api/repository-invitations/:org/:repo/:id/resend');
      if (params && req.method === 'POST') {
        const access = requireRepositoryAccess(db, user.id, { orgSlug: params.org, repoSlug: params.repo }, 'admin');
        const previous = pendingInvitation(db, access.repository.id, params.id);
        const body = await readJson(req);
        db.prepare('UPDATE repository_invitations SET revoked_at = COALESCE(revoked_at, CURRENT_TIMESTAMP) WHERE id = ?').run(previous.id);
        const invitation = createInvitationRecord(db, config, access, user, {
          email: previous.email,
          permission: previous.permission,
          expiresInDays: body.expiresInDays ?? 14,
        });
        audit(db, {
          organizationId: access.repository.organizationId,
          userId: user.id,
          action: 'repository_invitation.resent',
          targetType: 'repository_invitation',
          targetId: invitation.id,
          metadata: { replacedInvitationId: previous.id, repositoryId: access.repository.id, email: previous.email, permission: previous.permission },
        });
        return sendJson(res, 201, { invitation });
      }

      params = routeMatch(url.pathname, '/api/repository-invitations/:org/:repo/collaborators/:userId');
      if (params && req.method === 'PATCH') {
        const access = requireRepositoryAccess(db, user.id, { orgSlug: params.org, repoSlug: params.repo }, 'admin');
        const body = await readJson(req);
        const permission = normalizeRepositoryPermission(body.permission);
        const collaborator = db.prepare(`
          SELECT u.id, u.email, u.display_name AS displayName,
            CASE WHEN om.user_id IS NULL THEN 1 ELSE 0 END AS isExternal
          FROM repository_collaborators c
          JOIN users u ON u.id = c.user_id
          LEFT JOIN org_members om ON om.organization_id = ? AND om.user_id = u.id
          WHERE c.repository_id = ? AND c.user_id = ?
        `).get(access.repository.organizationId, access.repository.id, params.userId);
        if (!collaborator) throw httpError(404, 'Repository collaborator not found.', 'REPOSITORY_COLLABORATOR_NOT_FOUND');
        db.prepare(`
          UPDATE repository_collaborators SET permission = ?, added_by = ?, updated_at = CURRENT_TIMESTAMP
          WHERE repository_id = ? AND user_id = ?
        `).run(permission, user.id, access.repository.id, params.userId);
        audit(db, {
          organizationId: access.repository.organizationId,
          userId: user.id,
          action: 'repository_collaborator.permission_updated',
          targetType: 'repository',
          targetId: access.repository.id,
          metadata: { collaboratorId: params.userId, email: collaborator.email, permission, external: Boolean(collaborator.isExternal) },
        });
        return sendJson(res, 200, { collaborator: { ...collaborator, isExternal: Boolean(collaborator.isExternal), permission } });
      }

      throw httpError(404, 'Repository invitation endpoint not found.', 'NOT_FOUND');
    } catch (error) {
      const status = Number(error.status) || 500;
      if (status >= 500) console.error(`[${requestId}] repository invitations`, error);
      if (!res.headersSent) sendJson(res, status, {
        error: {
          code: error.code || 'INTERNAL_ERROR',
          message: status >= 500 ? 'An unexpected server error occurred.' : error.message,
          requestId,
        },
      });
      else res.end();
    }
    return true;
  };
}
