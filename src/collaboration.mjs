import { requireUser } from './auth.mjs';
import { audit, orgAccess, uid } from './db.mjs';
import {
  assertSlug,
  hashToken,
  httpError,
  normalizeEmail,
  originAllowed,
  randomToken,
} from './security.mjs';

const INVITATION_PREFIX = 'kgi_';
const INVITABLE_ROLES = new Set(['admin', 'maintainer', 'developer', 'viewer']);
const TEAM_ROLES = new Set(['maintainer', 'member']);
const INVITATION_EXPIRY_DAYS = new Set([7, 14, 30]);
const ROLE_RANK = Object.freeze({ viewer: 1, developer: 2, maintainer: 3, admin: 4, owner: 5 });
const MAX_BODY_BYTES = 64 * 1024;

export function migrateCollaboration(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS organization_invitations (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      email TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin','maintainer','developer','viewer')),
      token_hash TEXT NOT NULL UNIQUE,
      token_prefix TEXT NOT NULL,
      invited_by TEXT NOT NULL REFERENCES users(id),
      expires_at TEXT NOT NULL,
      accepted_by TEXT REFERENCES users(id),
      accepted_at TEXT,
      revoked_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS teams (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      slug TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      created_by TEXT NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(organization_id, slug)
    );
    CREATE TABLE IF NOT EXISTS team_members (
      team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('maintainer','member')),
      added_by TEXT NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (team_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_org_invitations_org_created
      ON organization_invitations(organization_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_org_invitations_email
      ON organization_invitations(email, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_teams_org
      ON teams(organization_id, name);
    CREATE INDEX IF NOT EXISTS idx_team_members_user
      ON team_members(user_id, team_id);
  `);
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
    if (size > MAX_BODY_BYTES) throw httpError(413, 'Request body is too large.', 'COLLABORATION_REQUEST_TOO_LARGE');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw httpError(400, 'Invalid JSON request body.', 'INVALID_JSON');
  }
}

function routeMatch(pathname, pattern) {
  const keys = [];
  const regex = new RegExp('^' + pattern.replace(/:([A-Za-z0-9_]+)/g, (_, key) => {
    keys.push(key);
    return '([^/]+)';
  }) + '$');
  const match = pathname.match(regex);
  if (!match) return null;
  try {
    return Object.fromEntries(keys.map((key, index) => [key, decodeURIComponent(match[index + 1])]));
  } catch {
    throw httpError(400, 'Invalid request path.', 'INVALID_PATH');
  }
}

function requireOrg(db, user, orgSlug, minimumRole = 'viewer') {
  const org = orgAccess(db, user.id, orgSlug, minimumRole);
  if (!org) throw httpError(403, 'You do not have permission for this organization.', 'FORBIDDEN');
  return org;
}

function requireTeam(db, organizationId, teamId) {
  const team = db.prepare(`
    SELECT id, organization_id AS organizationId, slug, name, description,
      created_at AS createdAt, updated_at AS updatedAt
    FROM teams WHERE id = ? AND organization_id = ?
  `).get(teamId, organizationId);
  if (!team) throw httpError(404, 'Team not found.', 'TEAM_NOT_FOUND');
  return team;
}

function invitationStatus(row) {
  if (row.acceptedAt) return 'accepted';
  if (row.revokedAt) return 'revoked';
  if (new Date(row.expiresAt).getTime() <= Date.now()) return 'expired';
  return 'pending';
}

function listMembers(db, organizationId) {
  return db.prepare(`
    SELECT u.id, u.email, u.display_name AS displayName, u.avatar_url AS avatarUrl,
      om.role, om.created_at AS joinedAt
    FROM org_members om JOIN users u ON u.id = om.user_id
    WHERE om.organization_id = ?
    ORDER BY CASE om.role
      WHEN 'owner' THEN 5 WHEN 'admin' THEN 4 WHEN 'maintainer' THEN 3
      WHEN 'developer' THEN 2 ELSE 1 END DESC, u.display_name
  `).all(organizationId);
}

function listInvitations(db, organizationId) {
  return db.prepare(`
    SELECT i.id, i.email, i.role, i.token_prefix AS tokenPrefix,
      i.expires_at AS expiresAt, i.accepted_at AS acceptedAt,
      i.revoked_at AS revokedAt, i.created_at AS createdAt,
      inviter.display_name AS invitedByName,
      accepted.display_name AS acceptedByName
    FROM organization_invitations i
    JOIN users inviter ON inviter.id = i.invited_by
    LEFT JOIN users accepted ON accepted.id = i.accepted_by
    WHERE i.organization_id = ?
    ORDER BY i.created_at DESC
    LIMIT 100
  `).all(organizationId).map((row) => ({ ...row, status: invitationStatus(row) }));
}

function listTeams(db, organizationId) {
  const teams = db.prepare(`
    SELECT id, slug, name, description, created_at AS createdAt, updated_at AS updatedAt
    FROM teams WHERE organization_id = ? ORDER BY name
  `).all(organizationId);
  if (!teams.length) return [];
  const byId = new Map(teams.map((team) => [team.id, { ...team, members: [] }]));
  const placeholders = teams.map(() => '?').join(',');
  const members = db.prepare(`
    SELECT tm.team_id AS teamId, tm.role AS teamRole, tm.created_at AS addedAt,
      u.id, u.email, u.display_name AS displayName, om.role AS organizationRole
    FROM team_members tm
    JOIN users u ON u.id = tm.user_id
    JOIN teams t ON t.id = tm.team_id
    JOIN org_members om ON om.organization_id = t.organization_id AND om.user_id = u.id
    WHERE tm.team_id IN (${placeholders})
    ORDER BY u.display_name
  `).all(...teams.map((team) => team.id));
  for (const member of members) byId.get(member.teamId)?.members.push(member);
  return [...byId.values()];
}

function createInvitation(db, config, user, org, body) {
  const email = normalizeEmail(body.email);
  const role = String(body.role ?? 'developer');
  if (!INVITABLE_ROLES.has(role)) throw httpError(400, 'Select a valid organization role.', 'INVITATION_ROLE_INVALID');
  const expiresInDays = Number(body.expiresInDays ?? 14);
  if (!INVITATION_EXPIRY_DAYS.has(expiresInDays)) {
    throw httpError(400, 'Invitation expiry must be 7, 14 or 30 days.', 'INVITATION_EXPIRY_INVALID');
  }

  const existingMember = db.prepare(`
    SELECT u.id FROM users u JOIN org_members om ON om.user_id = u.id
    WHERE om.organization_id = ? AND u.email = ?
  `).get(org.id, email);
  if (existingMember) throw httpError(409, 'This user is already an organization member.', 'ALREADY_ORG_MEMBER');

  db.prepare(`
    UPDATE organization_invitations SET revoked_at = CURRENT_TIMESTAMP
    WHERE organization_id = ? AND email = ? AND accepted_at IS NULL AND revoked_at IS NULL
  `).run(org.id, email);

  const token = `${INVITATION_PREFIX}${randomToken(32)}`;
  const invitation = {
    id: uid('inv'),
    email,
    role,
    token,
    tokenPrefix: token.slice(0, 12),
    expiresAt: new Date(Date.now() + expiresInDays * 86400000).toISOString(),
  };
  db.prepare(`
    INSERT INTO organization_invitations
      (id, organization_id, email, role, token_hash, token_prefix, invited_by, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    invitation.id,
    org.id,
    invitation.email,
    invitation.role,
    hashToken(invitation.token),
    invitation.tokenPrefix,
    user.id,
    invitation.expiresAt,
  );
  const acceptanceUrl = `${config.baseUrl}/#/accept-invite?token=${encodeURIComponent(invitation.token)}`;
  audit(db, {
    organizationId: org.id,
    userId: user.id,
    action: 'organization_invitation.created',
    targetType: 'organization_invitation',
    targetId: invitation.id,
    metadata: { email, role, expiresAt: invitation.expiresAt },
  });
  return { ...invitation, acceptanceUrl };
}

function acceptInvitation(db, user, token) {
  const value = String(token ?? '').trim();
  if (!value.startsWith(INVITATION_PREFIX) || value.length < 24) {
    throw httpError(400, 'Enter a valid KukGit invitation token.', 'INVITATION_TOKEN_INVALID');
  }
  const invitation = db.prepare(`
    SELECT i.*, o.slug AS orgSlug, o.name AS orgName
    FROM organization_invitations i JOIN organizations o ON o.id = i.organization_id
    WHERE i.token_hash = ?
  `).get(hashToken(value));
  if (!invitation) throw httpError(404, 'Invitation not found.', 'INVITATION_NOT_FOUND');
  if (invitation.revoked_at) throw httpError(409, 'This invitation was revoked.', 'INVITATION_REVOKED');
  if (invitation.accepted_at) throw httpError(409, 'This invitation was already accepted.', 'INVITATION_ACCEPTED');
  if (new Date(invitation.expires_at).getTime() <= Date.now()) throw httpError(409, 'This invitation has expired.', 'INVITATION_EXPIRED');
  if (invitation.email !== user.email) {
    throw httpError(403, `Sign in as ${invitation.email} to accept this invitation.`, 'INVITATION_EMAIL_MISMATCH');
  }

  db.exec('BEGIN IMMEDIATE');
  try {
    const existing = db.prepare('SELECT role FROM org_members WHERE organization_id = ? AND user_id = ?')
      .get(invitation.organization_id, user.id);
    const role = existing && ROLE_RANK[existing.role] > ROLE_RANK[invitation.role] ? existing.role : invitation.role;
    if (existing) {
      db.prepare('UPDATE org_members SET role = ? WHERE organization_id = ? AND user_id = ?')
        .run(role, invitation.organization_id, user.id);
    } else {
      db.prepare('INSERT INTO org_members (organization_id, user_id, role) VALUES (?, ?, ?)')
        .run(invitation.organization_id, user.id, role);
    }
    const update = db.prepare(`
      UPDATE organization_invitations
      SET accepted_by = ?, accepted_at = CURRENT_TIMESTAMP
      WHERE id = ? AND accepted_at IS NULL AND revoked_at IS NULL
    `).run(user.id, invitation.id);
    if (!update.changes) throw httpError(409, 'This invitation is no longer available.', 'INVITATION_UNAVAILABLE');
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  audit(db, {
    organizationId: invitation.organization_id,
    userId: user.id,
    action: 'organization_invitation.accepted',
    targetType: 'organization_invitation',
    targetId: invitation.id,
    metadata: { email: user.email, role: invitation.role },
  });
  return {
    id: invitation.id,
    organization: { id: invitation.organization_id, slug: invitation.orgSlug, name: invitation.orgName },
    role: invitation.role,
  };
}

function isCollaborationPath(pathname) {
  return pathname.startsWith('/api/collaboration/');
}

export function createCollaborationApiHandler({ config, db }) {
  return async function handleCollaborationApi(req, res) {
    const url = new URL(req.url, config.baseUrl);
    const pathname = url.pathname;
    if (!isCollaborationPath(pathname)) return false;

    const requestId = uid('req');
    res.setHeader('X-Request-Id', requestId);
    res.setHeader('Referrer-Policy', 'no-referrer');

    try {
      if (!originAllowed(req, config.baseUrl)) throw httpError(403, 'Request origin is not allowed.', 'CSRF_BLOCKED');
      const user = requireUser(db, req);

      if (req.method === 'POST' && pathname === '/api/collaboration/invitations/accept') {
        const body = await readJson(req);
        return sendJson(res, 200, { invitation: acceptInvitation(db, user, body.token) });
      }

      let params = routeMatch(pathname, '/api/collaboration/orgs/:org');
      if (req.method === 'GET' && params) {
        const org = requireOrg(db, user, params.org, 'viewer');
        const canManage = ROLE_RANK[org.role] >= ROLE_RANK.admin;
        return sendJson(res, 200, {
          organization: { id: org.id, slug: org.slug, name: org.name, plan: org.plan, role: org.role },
          canManage,
          members: listMembers(db, org.id),
          invitations: canManage ? listInvitations(db, org.id) : [],
          teams: listTeams(db, org.id),
        });
      }

      params = routeMatch(pathname, '/api/collaboration/orgs/:org/invitations');
      if (req.method === 'POST' && params) {
        const org = requireOrg(db, user, params.org, 'admin');
        const body = await readJson(req);
        return sendJson(res, 201, { invitation: createInvitation(db, config, user, org, body) });
      }

      params = routeMatch(pathname, '/api/collaboration/orgs/:org/invitations/:invitationId');
      if (req.method === 'DELETE' && params) {
        const org = requireOrg(db, user, params.org, 'admin');
        const result = db.prepare(`
          UPDATE organization_invitations SET revoked_at = COALESCE(revoked_at, CURRENT_TIMESTAMP)
          WHERE id = ? AND organization_id = ? AND accepted_at IS NULL
        `).run(params.invitationId, org.id);
        if (!result.changes) throw httpError(404, 'Pending invitation not found.', 'INVITATION_NOT_FOUND');
        audit(db, {
          organizationId: org.id,
          userId: user.id,
          action: 'organization_invitation.revoked',
          targetType: 'organization_invitation',
          targetId: params.invitationId,
        });
        return sendJson(res, 200, { revoked: true });
      }

      params = routeMatch(pathname, '/api/collaboration/orgs/:org/teams');
      if (req.method === 'POST' && params) {
        const org = requireOrg(db, user, params.org, 'admin');
        const body = await readJson(req);
        const slug = assertSlug(body.slug, 'team slug');
        const name = String(body.name ?? '').trim();
        if (!name || name.length > 100) throw httpError(400, 'Team name is required and must be 100 characters or fewer.', 'TEAM_NAME_INVALID');
        const description = String(body.description ?? '').trim().slice(0, 500);
        const id = uid('team');
        try {
          db.prepare(`INSERT INTO teams (id, organization_id, slug, name, description, created_by) VALUES (?, ?, ?, ?, ?, ?)`)
            .run(id, org.id, slug, name, description, user.id);
        } catch (error) {
          if (String(error.message).includes('UNIQUE')) throw httpError(409, 'A team with this slug already exists.', 'TEAM_SLUG_EXISTS');
          throw error;
        }
        db.prepare('INSERT INTO team_members (team_id, user_id, role, added_by) VALUES (?, ?, ?, ?)')
          .run(id, user.id, 'maintainer', user.id);
        audit(db, {
          organizationId: org.id,
          userId: user.id,
          action: 'team.created',
          targetType: 'team',
          targetId: id,
          metadata: { slug, name },
        });
        return sendJson(res, 201, { team: requireTeam(db, org.id, id) });
      }

      params = routeMatch(pathname, '/api/collaboration/orgs/:org/teams/:teamId');
      if (req.method === 'DELETE' && params) {
        const org = requireOrg(db, user, params.org, 'admin');
        const team = requireTeam(db, org.id, params.teamId);
        db.prepare('DELETE FROM teams WHERE id = ?').run(team.id);
        audit(db, {
          organizationId: org.id,
          userId: user.id,
          action: 'team.deleted',
          targetType: 'team',
          targetId: team.id,
          metadata: { slug: team.slug, name: team.name },
        });
        return sendJson(res, 200, { deleted: true });
      }

      params = routeMatch(pathname, '/api/collaboration/orgs/:org/teams/:teamId/members');
      if (req.method === 'POST' && params) {
        const org = requireOrg(db, user, params.org, 'admin');
        const team = requireTeam(db, org.id, params.teamId);
        const body = await readJson(req);
        const role = String(body.role ?? 'member');
        if (!TEAM_ROLES.has(role)) throw httpError(400, 'Select a valid team role.', 'TEAM_ROLE_INVALID');
        const member = db.prepare(`
          SELECT u.id, u.email, u.display_name AS displayName, om.role AS organizationRole
          FROM users u JOIN org_members om ON om.user_id = u.id
          WHERE u.id = ? AND om.organization_id = ?
        `).get(String(body.userId ?? ''), org.id);
        if (!member) throw httpError(404, 'Organization member not found.', 'ORG_MEMBER_NOT_FOUND');
        db.prepare(`
          INSERT INTO team_members (team_id, user_id, role, added_by) VALUES (?, ?, ?, ?)
          ON CONFLICT(team_id, user_id) DO UPDATE SET role = excluded.role, added_by = excluded.added_by
        `).run(team.id, member.id, role, user.id);
        audit(db, {
          organizationId: org.id,
          userId: user.id,
          action: 'team_member.added',
          targetType: 'team',
          targetId: team.id,
          metadata: { memberId: member.id, email: member.email, role },
        });
        return sendJson(res, 200, { member: { ...member, teamRole: role } });
      }

      params = routeMatch(pathname, '/api/collaboration/orgs/:org/teams/:teamId/members/:userId');
      if (req.method === 'DELETE' && params) {
        const org = requireOrg(db, user, params.org, 'admin');
        const team = requireTeam(db, org.id, params.teamId);
        const result = db.prepare('DELETE FROM team_members WHERE team_id = ? AND user_id = ?')
          .run(team.id, params.userId);
        if (!result.changes) throw httpError(404, 'Team member not found.', 'TEAM_MEMBER_NOT_FOUND');
        audit(db, {
          organizationId: org.id,
          userId: user.id,
          action: 'team_member.removed',
          targetType: 'team',
          targetId: team.id,
          metadata: { memberId: params.userId },
        });
        return sendJson(res, 200, { removed: true });
      }

      throw httpError(404, 'Collaboration API endpoint not found.', 'NOT_FOUND');
    } catch (error) {
      const status = Number(error.status) || 500;
      if (status >= 500) console.error(`[${requestId}] collaboration API`, error);
      if (!res.headersSent) {
        sendJson(res, status, {
          error: {
            code: error.code || 'INTERNAL_ERROR',
            message: status >= 500 ? 'An unexpected server error occurred.' : error.message,
            requestId,
          },
        });
      } else {
        res.end();
      }
    }
    return true;
  };
}
