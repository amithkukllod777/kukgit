import { currentUser, requireUser } from './auth.mjs';
import { audit, orgAccess, uid } from './db.mjs';
import { createNotification, migrateNotifications, notifyEmailAddress } from './notifications.mjs';
import { hashToken, httpError, originAllowed, randomToken } from './security.mjs';

const INVITATION_PREFIX = 'kgi_';
const EXPIRY_DAYS = new Set([7, 14, 30]);
const MAX_BODY_BYTES = 32 * 1024;

function htmlEscape(value = '') {
  return String(value).replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character]));
}

function invitationEmail(config, { email, role, organizationName, inviterName, acceptanceUrl, expiresAt }) {
  const expiry = new Date(expiresAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
  const subject = `Invitation to join ${organizationName} on KukGit`;
  const text = `${inviterName} invited you to join ${organizationName} on KukGit as ${role}.\n\nAccept invitation: ${acceptanceUrl}\n\nThis secure link expires on ${expiry}. Sign in with ${email}. If you were not expecting this invitation, ignore this email.`;
  const html = `<!doctype html><html><body style="font-family:Arial,sans-serif;color:#132033;line-height:1.6"><div style="max-width:620px;margin:0 auto;padding:28px"><h1 style="font-size:24px">Join ${htmlEscape(organizationName)} on KukGit</h1><p><b>${htmlEscape(inviterName)}</b> invited you as <b>${htmlEscape(role)}</b>.</p><p><a href="${htmlEscape(acceptanceUrl)}" style="display:inline-block;padding:12px 18px;background:#1598ff;color:#fff;text-decoration:none;border-radius:8px">Accept invitation</a></p><p>This secure link expires on ${htmlEscape(expiry)}. Sign in with <b>${htmlEscape(email)}</b>.</p><p style="color:#637083;font-size:13px">If you were not expecting this invitation, ignore this email.</p></div></body></html>`;
  return { subject, text, html };
}

export function deliverOrganizationInvitation(db, config, invitation) {
  migrateNotifications(db);
  const organization = db.prepare('SELECT id, slug, name FROM organizations WHERE id = ?').get(invitation.organizationId);
  const inviter = db.prepare('SELECT id, email, display_name AS displayName FROM users WHERE id = ?').get(invitation.invitedBy);
  if (!organization || !inviter) return { queued: false };
  const existingUser = db.prepare('SELECT id FROM users WHERE email = ?').get(invitation.email);
  const template = invitationEmail(config, {
    email: invitation.email,
    role: invitation.role,
    organizationName: organization.name,
    inviterName: inviter.displayName,
    acceptanceUrl: invitation.acceptanceUrl,
    expiresAt: invitation.expiresAt,
  });
  if (existingUser) {
    createNotification(db, config, {
      userId: existingUser.id,
      category: 'organization',
      title: `Invitation to join ${organization.name}`,
      body: `${inviter.displayName} invited you as ${invitation.role}. The invitation expires on ${new Date(invitation.expiresAt).toLocaleDateString('en-IN')}.`,
      link: `#/accept-invite?token=${encodeURIComponent(invitation.token)}`,
      dedupeKey: `organization-invitation:${invitation.id}`,
      metadata: { invitationId: invitation.id, organizationId: organization.id, role: invitation.role, expiresAt: invitation.expiresAt },
      email: { ...template, dedupeKey: `email:organization-invitation:${invitation.id}` },
    });
    return { queued: true, existingUser: true };
  }
  notifyEmailAddress(db, config, {
    to: invitation.email,
    category: 'organization',
    ...template,
    dedupeKey: `email:organization-invitation:${invitation.id}`,
  });
  return { queued: true, existingUser: false };
}

export function notifyInvitationAccepted(db, config, { invitationId, acceptedUserId }) {
  migrateNotifications(db);
  const invitation = db.prepare(`
    SELECT i.id, i.invited_by AS invitedBy, i.role, i.organization_id AS organizationId,
      o.name AS organizationName, o.slug AS organizationSlug,
      u.display_name AS acceptedName, u.email AS acceptedEmail
    FROM organization_invitations i
    JOIN organizations o ON o.id = i.organization_id
    JOIN users u ON u.id = ?
    WHERE i.id = ?
  `).get(acceptedUserId, invitationId);
  if (!invitation) return 0;
  let created = 0;
  if (invitation.invitedBy !== acceptedUserId) {
    const result = createNotification(db, config, {
      userId: invitation.invitedBy,
      category: 'organization',
      title: `${invitation.acceptedName} joined ${invitation.organizationName}`,
      body: `${invitation.acceptedEmail} accepted the ${invitation.role} invitation.`,
      link: '#/organizations',
      dedupeKey: `organization-invitation-accepted:${invitation.id}:inviter`,
      metadata: { invitationId: invitation.id, organizationId: invitation.organizationId, acceptedUserId },
      email: {
        subject: `${invitation.acceptedName} joined ${invitation.organizationName} on KukGit`,
        text: `${invitation.acceptedName} (${invitation.acceptedEmail}) accepted your invitation to join ${invitation.organizationName} as ${invitation.role}.\n\nOpen KukGit: ${config.baseUrl}/#/organizations`,
      },
    });
    if (result.notification || result.email) created += 1;
  }
  const welcome = createNotification(db, config, {
    userId: acceptedUserId,
    category: 'organization',
    title: `You joined ${invitation.organizationName}`,
    body: `Your ${invitation.role} membership is active.`,
    link: '#/organizations',
    dedupeKey: `organization-invitation-accepted:${invitation.id}:member`,
    metadata: { invitationId: invitation.id, organizationId: invitation.organizationId },
    email: {
      subject: `You joined ${invitation.organizationName} on KukGit`,
      text: `Your ${invitation.role} membership in ${invitation.organizationName} is now active.\n\nOpen KukGit: ${config.baseUrl}/#/organizations`,
    },
  });
  if (welcome.notification || welcome.email) created += 1;
  return created;
}

function captureJsonResponse(res) {
  const chunks = [];
  let size = 0;
  const originalWrite = res.write.bind(res);
  const originalEnd = res.end.bind(res);
  res.write = (chunk, encoding, callback) => {
    if (chunk && size < 256 * 1024) {
      const value = Buffer.from(chunk);
      chunks.push(value);
      size += value.length;
    }
    return originalWrite(chunk, encoding, callback);
  };
  res.end = (chunk, encoding, callback) => {
    if (chunk && size < 256 * 1024) {
      const value = Buffer.from(chunk);
      chunks.push(value);
      size += value.length;
    }
    return originalEnd(chunk, encoding, callback);
  };
  return () => {
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { return null; }
  };
}

export function createCollaborationNotificationCapture({ config, db, next }) {
  return async function collaborationNotificationCapture(req, res) {
    const url = new URL(req.url, config.baseUrl);
    const actor = currentUser(db, req);
    const payloadReader = captureJsonResponse(res);
    res.once('finish', () => {
      if (res.statusCode < 200 || res.statusCode >= 300 || req.method !== 'POST') return;
      const payload = payloadReader();
      try {
        const created = url.pathname.match(/^\/api\/collaboration\/orgs\/([^/]+)\/invitations$/);
        if (created && payload?.invitation?.id && payload.invitation.token && actor) {
          const organization = db.prepare('SELECT id FROM organizations WHERE slug = ?').get(decodeURIComponent(created[1]));
          if (organization) deliverOrganizationInvitation(db, config, {
            id: payload.invitation.id,
            organizationId: organization.id,
            email: payload.invitation.email,
            role: payload.invitation.role,
            token: payload.invitation.token,
            acceptanceUrl: payload.invitation.acceptanceUrl,
            expiresAt: payload.invitation.expiresAt,
            invitedBy: actor.id,
          });
          return;
        }
        if (url.pathname === '/api/collaboration/invitations/accept' && payload?.invitation?.id && actor) {
          notifyInvitationAccepted(db, config, { invitationId: payload.invitation.id, acceptedUserId: actor.id });
        }
      } catch (error) {
        console.error(`[notifications] collaboration capture: ${String(error.message || error).slice(0, 1000)}`);
      }
    });
    return next(req, res);
  };
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
    if (size > MAX_BODY_BYTES) throw httpError(413, 'Request body is too large.', 'INVITATION_RESEND_REQUEST_TOO_LARGE');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw httpError(400, 'Invalid JSON request body.', 'INVALID_JSON'); }
}

export function createInvitationResendApiHandler({ config, db }) {
  return async function invitationResendApi(req, res) {
    const url = new URL(req.url, config.baseUrl);
    const match = url.pathname.match(/^\/api\/collaboration\/orgs\/([^/]+)\/invitations\/([^/]+)\/resend$/);
    if (!match || req.method !== 'POST') return false;
    const requestId = uid('req');
    res.setHeader('X-Request-Id', requestId);
    try {
      if (!originAllowed(req, config.baseUrl)) throw httpError(403, 'Request origin is not allowed.', 'CSRF_BLOCKED');
      const user = requireUser(db, req);
      const orgSlug = decodeURIComponent(match[1]);
      const invitationId = decodeURIComponent(match[2]);
      const organization = orgAccess(db, user.id, orgSlug, 'admin');
      if (!organization) throw httpError(403, 'Organization Admin permission is required.', 'FORBIDDEN');
      const old = db.prepare(`
        SELECT id, email, role, accepted_at AS acceptedAt, revoked_at AS revokedAt
        FROM organization_invitations WHERE id = ? AND organization_id = ?
      `).get(invitationId, organization.id);
      if (!old) throw httpError(404, 'Invitation not found.', 'INVITATION_NOT_FOUND');
      if (old.acceptedAt) throw httpError(409, 'Accepted invitations cannot be resent.', 'INVITATION_ALREADY_ACCEPTED');
      const body = await readJson(req);
      const expiresInDays = Number(body.expiresInDays ?? 14);
      if (!EXPIRY_DAYS.has(expiresInDays)) throw httpError(400, 'Invitation expiry must be 7, 14 or 30 days.', 'INVITATION_EXPIRY_INVALID');
      db.prepare('UPDATE organization_invitations SET revoked_at = COALESCE(revoked_at, CURRENT_TIMESTAMP) WHERE id = ?').run(old.id);
      const token = `${INVITATION_PREFIX}${randomToken(32)}`;
      const replacement = {
        id: uid('inv'),
        organizationId: organization.id,
        email: old.email,
        role: old.role,
        token,
        tokenPrefix: token.slice(0, 12),
        expiresAt: new Date(Date.now() + expiresInDays * 86400000).toISOString(),
        invitedBy: user.id,
      };
      db.prepare(`
        INSERT INTO organization_invitations
          (id, organization_id, email, role, token_hash, token_prefix, invited_by, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(replacement.id, replacement.organizationId, replacement.email, replacement.role, hashToken(token), replacement.tokenPrefix, user.id, replacement.expiresAt);
      replacement.acceptanceUrl = `${config.baseUrl}/#/accept-invite?token=${encodeURIComponent(token)}`;
      deliverOrganizationInvitation(db, config, replacement);
      audit(db, {
        organizationId: organization.id,
        userId: user.id,
        action: 'organization_invitation.resent',
        targetType: 'organization_invitation',
        targetId: replacement.id,
        metadata: { replacedInvitationId: old.id, email: old.email, role: old.role, expiresAt: replacement.expiresAt },
      });
      return sendJson(res, 201, { invitation: replacement });
    } catch (error) {
      const status = Number(error.status) || 500;
      if (status >= 500) console.error(`[${requestId}] invitation resend`, error);
      if (!res.headersSent) sendJson(res, status, { error: { code: error.code || 'INTERNAL_ERROR', message: status >= 500 ? 'An unexpected server error occurred.' : error.message, requestId } });
      else res.end();
    }
    return true;
  };
}
