import {
  createInstanceAdminApiHandler,
  instanceAdminEmails,
  isInstanceAdmin,
  migrateInstanceAdmin,
  requireInstanceAdmin,
} from './instance-admin.mjs';

function tableColumns(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
}

function ensureOrganizationWebsiteCompatibility(db) {
  const columns = tableColumns(db, 'organizations');
  if (!columns.has('website_url')) db.exec('ALTER TABLE organizations ADD COLUMN website_url TEXT');
  if (columns.has('website')) {
    db.prepare('UPDATE organizations SET website_url = website WHERE website_url IS NULL AND website IS NOT NULL').run();
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_instance_admin_org_website_insert
      AFTER INSERT ON organizations
      WHEN NEW.website IS NOT NULL
      BEGIN
        UPDATE organizations SET website_url = NEW.website WHERE id = NEW.id;
      END;
      CREATE TRIGGER IF NOT EXISTS trg_instance_admin_org_website_update
      AFTER UPDATE OF website ON organizations
      BEGIN
        UPDATE organizations SET website_url = NEW.website WHERE id = NEW.id;
      END;
    `);
  }
}

export function migrateInstanceAdminSafe(db) {
  migrateInstanceAdmin(db);
  ensureOrganizationWebsiteCompatibility(db);
}

export function createInstanceAdminApiHandlerSafe({ config, db }) {
  migrateInstanceAdminSafe(db);
  return createInstanceAdminApiHandler({ config, db });
}

export {
  instanceAdminEmails,
  isInstanceAdmin,
  requireInstanceAdmin,
};
