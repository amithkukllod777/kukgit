import {
  createCollaborationNotificationCapture as createCoreCapture,
  createInvitationResendApiHandler,
  deliverOrganizationInvitation,
  notifyInvitationAccepted,
} from './collaboration-notifications.mjs';

export { createInvitationResendApiHandler, deliverOrganizationInvitation, notifyInvitationAccepted };

function eligible(pathname, method) {
  if (method !== 'POST') return false;
  return pathname === '/api/collaboration/invitations/accept'
    || /^\/api\/collaboration\/orgs\/[^/]+\/invitations$/.test(pathname);
}

export function createCollaborationNotificationCapture({ config, db, next }) {
  const core = createCoreCapture({ config, db, next });
  return function scopedCollaborationNotificationCapture(req, res) {
    const pathname = new URL(req.url, config.baseUrl).pathname;
    return eligible(pathname, String(req.method || 'GET').toUpperCase()) ? core(req, res) : next(req, res);
  };
}
