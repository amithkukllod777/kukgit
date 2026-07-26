import { currentRequestIdentity } from './identity-context.mjs';
import { normalizeEmail } from './security.mjs';

const CORE_ORG_ID = 'org_kuklabs_core';

export function ensureAuthKitCoreOrganization(db) {
  db.prepare(`
    INSERT INTO organizations (id, slug, name, plan)
    VALUES (?, 'kuklabs', 'Kuklabs Inc.', 'founder')
    ON CONFLICT(slug) DO NOTHING
  `).run(CORE_ORG_ID);
  return db.prepare("SELECT id, slug, name, plan FROM organizations WHERE slug = 'kuklabs'").get();
}

export function ensureAuthKitFounderMembership(db, config, user) {
  if (!user?.id || !user?.email) return null;
  const founderEmail = normalizeEmail(config.adminEmail);
  if (normalizeEmail(user.email) !== founderEmail) return null;
  const organization = ensureAuthKitCoreOrganization(db);
  db.prepare(`
    INSERT INTO org_members (organization_id, user_id, role)
    VALUES (?, ?, 'owner')
    ON CONFLICT(organization_id, user_id) DO UPDATE SET role = 'owner'
  `).run(organization.id, user.id);
  return organization;
}

export function createAuthKitBootstrapGuard({ config, db, next }) {
  return async function authKitBootstrapGuard(req, res) {
    if (config.authMode === 'authkit') {
      const identity = currentRequestIdentity();
      if (identity?.user) ensureAuthKitFounderMembership(db, config, identity.user);
    }
    return next(req, res);
  };
}
